import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// The repository intentionally uses Node's built-in test runner.
// eslint-disable-next-line test/no-import-node-test
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(projectRoot, 'bin', 'cli.mjs')
const rollup = path.join(projectRoot, 'node_modules', 'rollup', 'dist', 'bin', 'rollup')
const temporaryDirectories = []

before(async () => {
  await execFile(process.execPath, [rollup, '-c', 'rollup.config.ts', '--configPlugin', 'typescript'], { cwd: projectRoot })
})

after(async () => {
  await Promise.all(temporaryDirectories.map(dir => rm(dir, { recursive: true, force: true })))
})

test('sync dry-runs, creates missing links, and is idempotent', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(target, 'alpha'))
  await mkdir(path.join(target, 'beta'))
  await mkdir(path.join(target, '.hidden'))

  const dryRun = await runCli('sync', source, target, '--dry-run')
  assert.match(dryRun.stdout, /would create 2 symlink\(s\)/)
  assert.equal(await exists(path.join(source, 'alpha')), false)

  await runCli('sync', source, target, '--yes')
  assert.equal((await lstat(path.join(source, 'alpha'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(source, 'alpha')), path.join(target, 'alpha'))
  assert.equal((await lstat(path.join(source, 'beta'))).isSymbolicLink(), true)
  assert.equal(await exists(path.join(source, '.hidden')), false)

  const repeated = await runCli('sync', source, target, '--yes')
  assert.match(repeated.stdout, /already have matching symlinks/)
})

test('sync requires confirmation and protects conflicting source entries', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(target, 'beta'))

  await assert.rejects(
    runCli('sync', source, target),
    (error) => {
      assert.match(commandOutput(error), /pass --yes to proceed non-interactively/)
      return true
    },
  )
  assert.equal(await exists(path.join(source, 'beta')), false)

  await mkdir(path.join(source, 'beta'))

  await assert.rejects(
    runCli('sync', source, target, '--yes'),
    (error) => {
      assert.match(commandOutput(error), /source entries conflict/)
      return true
    },
  )
  assert.equal((await lstat(path.join(source, 'beta'))).isDirectory(), true)

  await runCli('sync', source, target, '--force', '--yes')
  assert.equal((await lstat(path.join(source, 'beta'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(source, 'beta')), path.join(target, 'beta'))
})

test('sync rejects source and target aliases for the same real directory', async () => {
  const root = await createTemporaryDirectory()
  const realParent = path.join(root, 'real')
  const source = path.join(realParent, 'projects')
  const aliasParent = path.join(root, 'alias')
  const target = path.join(aliasParent, 'projects')
  await mkdir(path.join(source, 'alpha'), { recursive: true })
  await symlink(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(
    runCli('sync', source, target, '--force', '--yes'),
    (error) => {
      assert.match(commandOutput(error), /source and target must be separate/)
      return true
    },
  )
  assert.equal((await lstat(path.join(source, 'alpha'))).isDirectory(), true)
})

async function createParents() {
  const root = await createTemporaryDirectory()
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  await mkdir(source)
  await mkdir(target)
  return { source, target }
}

async function createTemporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-migrate-sync-'))
  temporaryDirectories.push(root)
  return root
}

async function runCli(...args) {
  return execFile(process.execPath, [cli, ...args], { cwd: projectRoot })
}

async function exists(filePath) {
  try {
    await lstat(filePath)
    return true
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function commandOutput(error) {
  if (error && typeof error === 'object') {
    const output = error
    return `${output.stdout ?? ''}${output.stderr ?? ''}`
  }
  return String(error)
}

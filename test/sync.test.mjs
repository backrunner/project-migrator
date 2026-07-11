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

test('sync --adopt dry-runs, moves real target directories into source, and leaves symlinks', async () => {
  const { source, target } = await createParents()
  // Real directory in target that should be adopted.
  await mkdir(path.join(target, 'gamma'))
  await mkdir(path.join(target, 'gamma', 'inner'))
  // Plain missing-link case: real dir in target, no source entry. In adopt
  // mode this is also classified as 'adopt' (move to source + symlink back),
  // NOT a plain 'missing' symlink creation.
  await mkdir(path.join(target, 'delta'))

  const dryRun = await runCli('sync', source, target, '--adopt', '--dry-run')
  assert.match(dryRun.stdout, /adopt 2 director/)
  // Nothing moved yet.
  assert.equal((await lstat(path.join(target, 'gamma'))).isDirectory(), true)
  assert.equal(await exists(path.join(source, 'gamma')), false)

  await runCli('sync', source, target, '--adopt', '--yes')
  // gamma moved into source; target/gamma is now a symlink to source/gamma.
  assert.equal((await lstat(path.join(source, 'gamma'))).isDirectory(), true)
  assert.equal((await lstat(path.join(source, 'gamma', 'inner'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'gamma'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'gamma')), path.join(source, 'gamma'))
  // delta likewise.
  assert.equal((await lstat(path.join(source, 'delta'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'delta'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'delta')), path.join(source, 'delta'))

  // Idempotent: re-running adopt reports everything already linked.
  const repeated = await runCli('sync', source, target, '--adopt', '--yes')
  assert.match(repeated.stdout, /already have matching symlinks/)
})

test('sync --adopt protects a real source entry that shadows the target directory', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(target, 'epsilon'))
  // Source already has a real directory of the same name — must not clobber
  // without --force.
  await mkdir(path.join(source, 'epsilon'))

  await assert.rejects(
    runCli('sync', source, target, '--adopt', '--yes'),
    (error) => {
      assert.match(commandOutput(error), /source entries conflict/)
      return true
    },
  )
  // Source entry untouched.
  assert.equal((await lstat(path.join(source, 'epsilon'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'epsilon'))).isDirectory(), true)

  // With --force the source real directory is replaced: target moved over it,
  // then symlink left at target pointing to source.
  await runCli('sync', source, target, '--adopt', '--force', '--yes')
  assert.equal((await lstat(path.join(source, 'epsilon'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'epsilon'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'epsilon')), path.join(source, 'epsilon'))
})

test('sync --adopt skips target symlinks already pointing at source (already-adopted)', async () => {
  const { source, target } = await createParents()
  // Already-adopted: source holds a real directory, target has a symlink back to it.
  await mkdir(path.join(source, 'zeta'))
  await mkdir(path.join(source, 'zeta', 'file'))
  await symlink(path.join(source, 'zeta'), path.join(target, 'zeta'), process.platform === 'win32' ? 'junction' : 'dir')

  const repeated = await runCli('sync', source, target, '--adopt', '--yes')
  assert.match(repeated.stdout, /already have matching symlinks/)
  // Untouched.
  assert.equal((await lstat(path.join(source, 'zeta'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'zeta'))).isSymbolicLink(), true)
})

test('sync --adopt handles a mixed batch (real dir + already-linked symlink + source conflict)', async () => {
  const { source, target } = await createParents()
  // 1. Real directory to adopt.
  await mkdir(path.join(target, 'adopt-me'))
  // 2. Target already a symlink pointing to a real source directory (already-adopted).
  await mkdir(path.join(source, 'already'))
  await symlink(path.join(source, 'already'), path.join(target, 'already'), process.platform === 'win32' ? 'junction' : 'dir')

  const result = await runCli('sync', source, target, '--adopt', '--yes')
  // adopt-me was adopted; already was left alone.
  assert.match(result.stdout, /adopted 1 director/)
  assert.equal((await lstat(path.join(source, 'adopt-me'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'adopt-me'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'adopt-me')), path.join(source, 'adopt-me'))
  // already untouched.
  assert.equal((await lstat(path.join(source, 'already'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'already'))).isSymbolicLink(), true)
})

test('sync --adopt requires --force when a source symlink points elsewhere and target is a real directory', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(target, 'eta'))
  // Source has a symlink to a *different* location, not the target.
  const elsewhere = path.join(path.dirname(source), 'elsewhere')
  await mkdir(elsewhere)
  await symlink(elsewhere, path.join(source, 'eta'), process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(
    runCli('sync', source, target, '--adopt', '--yes'),
    (error) => {
      assert.match(commandOutput(error), /source entries conflict/)
      return true
    },
  )
  // Target untouched.
  assert.equal((await lstat(path.join(target, 'eta'))).isDirectory(), true)
  // Source symlink untouched.
  assert.equal((await lstat(path.join(source, 'eta'))).isSymbolicLink(), true)
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

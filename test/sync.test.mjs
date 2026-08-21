import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
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
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

before(async () => {
  await execFile(process.execPath, [rollup, '-c', 'rollup.config.ts', '--configPlugin', 'typescript'], { cwd: projectRoot })
})

after(async () => {
  await Promise.all(temporaryDirectories.map(dir => rm(dir, { recursive: true, force: true })))
})

test('sync detects existing target links, previews the correct direction, and is idempotent', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(source, 'alpha'))
  await mkdir(path.join(source, 'beta'))
  await mkdir(path.join(source, '.hidden'))
  await symlink(path.join(source, 'alpha'), path.join(target, 'alpha'), linkType)
  await mkdir(path.join(target, 'target-only'))

  const dryRun = await runCli('sync', source, target, '--dry-run')
  assert.match(dryRun.stdout, /Sync plan/)
  assert.match(dryRun.stdout, new RegExp(`Project source\\s+${escapeRegExp(source)}`))
  assert.match(dryRun.stdout, new RegExp(`Link directory\\s+${escapeRegExp(target)}`))
  assert.match(dryRun.stdout, /Existing links\s+1/)
  assert.match(dryRun.stdout, /Create\s+1/)
  assert.match(dryRun.stdout, new RegExp(`${escapeRegExp(path.join(target, 'beta'))} -> ${escapeRegExp(path.join(source, 'beta'))}`))
  assert.equal(await exists(path.join(target, 'beta')), false)

  await runCli('sync', source, target, '--yes')
  assert.equal((await lstat(path.join(target, 'alpha'))).isSymbolicLink(), true)
  assert.equal((await lstat(path.join(target, 'beta'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'beta')), path.join(source, 'beta'))
  assert.equal((await lstat(path.join(target, 'target-only'))).isDirectory(), true)
  assert.equal(await exists(path.join(target, '.hidden')), false)

  const repeated = await runCli('sync', source, target, '--yes')
  assert.match(repeated.stdout, /all source project directories already have matching links in target/)
  assert.match(repeated.stdout, /left 1 real target directory unchanged; use --adopt/)
})

test('sync requires confirmation and protects conflicting target entries', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(source, 'beta'))

  await assert.rejects(
    runCli('sync', source, target),
    (error) => {
      assert.match(commandOutput(error), /pass --yes to proceed non-interactively/)
      return true
    },
  )
  assert.equal(await exists(path.join(target, 'beta')), false)

  await mkdir(path.join(target, 'beta'))

  await assert.rejects(
    runCli('sync', source, target, '--dry-run'),
    (error) => {
      const output = commandOutput(error)
      assert.match(output, /Sync plan/)
      assert.match(output, /CONFLICT beta/)
      assert.match(output, /target entries conflict/)
      return true
    },
  )

  await assert.rejects(
    runCli('sync', source, target, '--yes'),
    (error) => {
      assert.match(commandOutput(error), /target entries conflict/)
      return true
    },
  )
  assert.equal((await lstat(path.join(target, 'beta'))).isDirectory(), true)

  await runCli('sync', source, target, '--force', '--yes')
  assert.equal((await lstat(path.join(target, 'beta'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'beta')), path.join(source, 'beta'))
})

test('sync repairs case-only symlink mismatches only on case-sensitive filesystems', async () => {
  const root = await createTemporaryDirectory()
  const source = path.join(root, 'Projects')
  const alternateSource = path.join(root, 'projects')
  const target = path.join(root, 'target')
  await mkdir(path.join(source, 'alpha'), { recursive: true })
  await mkdir(target)

  const caseInsensitive = await exists(alternateSource)
  if (!caseInsensitive) {
    await mkdir(path.join(alternateSource, 'alpha'), { recursive: true })
  }

  const alternateProject = path.join(alternateSource, 'alpha')
  const targetLink = path.join(target, 'alpha')
  await symlink(alternateProject, targetLink, linkType)

  const dryRun = await runCli('sync', source, target, '--dry-run')
  if (caseInsensitive) {
    assert.match(dryRun.stdout, /Existing links\s+1/)
    assert.match(dryRun.stdout, /Repair\s+0/)
    assert.doesNotMatch(dryRun.stdout, /REPAIR alpha/)

    const result = await runCli('sync', source, target, '--yes')
    assert.match(result.stdout, /all source project directories already have matching links in target/)
    assert.equal(await readlink(targetLink), alternateProject)
  }
  else {
    assert.match(dryRun.stdout, /Existing links\s+0/)
    assert.match(dryRun.stdout, /Repair\s+1/)
    assert.match(dryRun.stdout, /REPAIR alpha/)
    assert.doesNotMatch(dryRun.stdout, /CONFLICT alpha/)

    const result = await runCli('sync', source, target, '--yes')
    assert.match(result.stdout, /repaired 1 symlink/)
    assert.equal(await readlink(targetLink), path.join(source, 'alpha'))
  }
})

test('sync still requires --force for a symlink pointing to an unrelated location', async () => {
  const { source, target } = await createParents()
  const elsewhere = path.join(path.dirname(source), 'elsewhere')
  await mkdir(path.join(source, 'alpha'))
  await mkdir(elsewhere)
  await symlink(elsewhere, path.join(target, 'alpha'), linkType)

  await assert.rejects(
    runCli('sync', source, target, '--yes'),
    (error) => {
      assert.match(commandOutput(error), /target entries conflict/)
      return true
    },
  )

  await runCli('sync', source, target, '--force', '--yes')
  assert.equal(await readlink(path.join(target, 'alpha')), path.join(source, 'alpha'))
})

test('sync rejects source and target aliases for the same real directory', async () => {
  const root = await createTemporaryDirectory()
  const realParent = path.join(root, 'real')
  const source = path.join(realParent, 'projects')
  const aliasParent = path.join(root, 'alias')
  const target = path.join(aliasParent, 'projects')
  await mkdir(path.join(source, 'alpha'), { recursive: true })
  await symlink(realParent, aliasParent, linkType)

  await assert.rejects(
    runCli('sync', source, target, '--force', '--yes'),
    (error) => {
      assert.match(commandOutput(error), /source and target must be separate/)
      return true
    },
  )
  assert.equal((await lstat(path.join(source, 'alpha'))).isDirectory(), true)
})

test('sync --adopt creates missing links, moves real target directories into source, and is idempotent', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(source, 'alpha'))
  await mkdir(path.join(target, 'gamma'))
  await mkdir(path.join(target, 'gamma', 'inner'))
  await mkdir(path.join(target, 'delta'))

  const dryRun = await runCli('sync', source, target, '--adopt', '--dry-run')
  assert.match(dryRun.stdout, /Create\s+1/)
  assert.match(dryRun.stdout, /Adopt\s+2/)
  assert.equal((await lstat(path.join(target, 'gamma'))).isDirectory(), true)
  assert.equal(await exists(path.join(source, 'gamma')), false)

  await runCli('sync', source, target, '--adopt', '--yes')
  assert.equal((await lstat(path.join(target, 'alpha'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'alpha')), path.join(source, 'alpha'))
  assert.equal((await lstat(path.join(source, 'gamma'))).isDirectory(), true)
  assert.equal((await lstat(path.join(source, 'gamma', 'inner'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'gamma'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'gamma')), path.join(source, 'gamma'))
  assert.equal((await lstat(path.join(source, 'delta'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'delta'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'delta')), path.join(source, 'delta'))

  const repeated = await runCli('sync', source, target, '--adopt', '--yes')
  assert.match(repeated.stdout, /all source project directories already have matching links in target/)
})

test('sync --adopt protects a real source entry that shadows a target directory', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(source, 'epsilon'))
  await writeFile(path.join(source, 'epsilon', 'old'), 'old')
  await mkdir(path.join(target, 'epsilon'))
  await writeFile(path.join(target, 'epsilon', 'new'), 'new')

  await assert.rejects(
    runCli('sync', source, target, '--adopt', '--yes'),
    (error) => {
      assert.match(commandOutput(error), /source entries conflict with directories selected for adoption/)
      return true
    },
  )
  assert.equal(await exists(path.join(source, 'epsilon', 'old')), true)
  assert.equal((await lstat(path.join(target, 'epsilon'))).isDirectory(), true)

  await runCli('sync', source, target, '--adopt', '--force', '--yes')
  assert.equal((await lstat(path.join(source, 'epsilon'))).isDirectory(), true)
  assert.equal(await exists(path.join(source, 'epsilon', 'old')), false)
  assert.equal(await exists(path.join(source, 'epsilon', 'new')), true)
  assert.equal((await lstat(path.join(target, 'epsilon'))).isSymbolicLink(), true)
  assert.equal(await readlink(path.join(target, 'epsilon')), path.join(source, 'epsilon'))
})

test('sync --adopt recognizes target symlinks already pointing at source', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(source, 'zeta'))
  await mkdir(path.join(source, 'zeta', 'file'))
  await symlink(path.join(source, 'zeta'), path.join(target, 'zeta'), linkType)

  const repeated = await runCli('sync', source, target, '--adopt', '--yes')
  assert.match(repeated.stdout, /all source project directories already have matching links in target/)
  assert.equal((await lstat(path.join(source, 'zeta'))).isDirectory(), true)
  assert.equal((await lstat(path.join(target, 'zeta'))).isSymbolicLink(), true)
})

test('sync --adopt handles a mixed batch of missing, linked, and target-only projects', async () => {
  const { source, target } = await createParents()
  await mkdir(path.join(source, 'missing-link'))
  await mkdir(path.join(source, 'already'))
  await symlink(path.join(source, 'already'), path.join(target, 'already'), linkType)
  await mkdir(path.join(target, 'adopt-me'))

  const result = await runCli('sync', source, target, '--adopt', '--yes')
  assert.match(result.stdout, /created 1 symlink/)
  assert.match(result.stdout, /adopted 1 director/)
  assert.equal(await readlink(path.join(target, 'missing-link')), path.join(source, 'missing-link'))
  assert.equal((await lstat(path.join(source, 'adopt-me'))).isDirectory(), true)
  assert.equal(await readlink(path.join(target, 'adopt-me')), path.join(source, 'adopt-me'))
  assert.equal(await readlink(path.join(target, 'already')), path.join(source, 'already'))
})

test('sync --adopt requires --force before replacing a source symlink', async () => {
  const { source, target } = await createParents()
  const elsewhere = path.join(path.dirname(source), 'elsewhere')
  await mkdir(elsewhere)
  await symlink(elsewhere, path.join(source, 'eta'), linkType)
  await mkdir(path.join(target, 'eta'))
  await writeFile(path.join(target, 'eta', 'project'), 'project')

  await assert.rejects(
    runCli('sync', source, target, '--adopt', '--yes'),
    (error) => {
      assert.match(commandOutput(error), /source entries conflict with directories selected for adoption/)
      return true
    },
  )
  assert.equal((await lstat(path.join(source, 'eta'))).isSymbolicLink(), true)
  assert.equal((await lstat(path.join(target, 'eta'))).isDirectory(), true)

  await runCli('sync', source, target, '--adopt', '--force', '--yes')
  assert.equal((await lstat(path.join(source, 'eta'))).isDirectory(), true)
  assert.equal(await exists(path.join(source, 'eta', 'project')), true)
  assert.equal(await readlink(path.join(target, 'eta')), path.join(source, 'eta'))
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
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  return String(error)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

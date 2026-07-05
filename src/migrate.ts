import type { CodexIntegrationResult, MigrateOptions, MigrateResult, MigrationPlan } from './types.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCodexMigration } from './codex.js'
import { info, note, success, verbose, warn } from './log.js'

const isWindows = os.platform() === 'win32'

/**
 * Resolve a path argument to an absolute path. `~` is expanded to the home dir.
 * Relative paths are resolved against `cwd`.
 */
export function resolvePath(input: string): string {
  let value = input
  if (value === '~') {
    return os.homedir()
  }
  if (value.startsWith('~/')) {
    value = path.join(os.homedir(), value.slice(2))
  }
  return path.resolve(value)
}

/**
 * Return true when `p` is a symbolic link (independent of what it points to).
 */
export function isSymlink(p: string): boolean {
  try {
    const stat = fs.lstatSync(p)
    return stat.isSymbolicLink()
  }
  catch {
    return false
  }
}

/**
 * Return true when `p` exists on disk (file, dir, or symlink).
 */
export function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  }
  catch {
    return false
  }
}

/**
 * Return true when `p` is a real directory (not a symlink) or a symlink
 * pointing at a directory.
 */
export function isDirectory(p: string): boolean {
  try {
    const stat = fs.statSync(p)
    return stat.isDirectory()
  }
  catch {
    return false
  }
}

export function buildMigrationPlan(source: string, target: string): MigrationPlan {
  const absSource = resolvePath(source)
  const absTarget = resolvePath(target)
  const targetParent = path.dirname(absTarget)

  return {
    source: absSource,
    target: absTarget,
    symlink: absSource,
    targetParent,
    targetExists: pathExists(absTarget),
    targetParentExists: pathExists(targetParent),
  }
}

/**
 * Move a directory from `source` to `target`. The source's parent must exist;
 * the target's parent is created if missing.
 */
export async function moveDirectory(source: string, target: string, opts: MigrateOptions): Promise<void> {
  if (opts.dryRun) {
    note(`dry-run: would move ${source} -> ${target}`)
    return
  }

  const targetParent = path.dirname(target)
  await fsp.mkdir(targetParent, { recursive: true })

  if (pathExists(target)) {
    if (!opts.force) {
      throw new Error(`target already exists: ${target} (use --force to replace)`)
    }
    verbose(`removing existing target: ${target}`)
    await fsp.rm(target, { recursive: true, force: true })
  }

  verbose(`moving ${source} -> ${target}`)
  try {
    await fsp.rename(source, target)
  }
  catch (err) {
    if (!isCrossDeviceRenameError(err)) {
      throw err
    }

    verbose(`rename crossed devices; copying ${source} -> ${target}`)
    await copyDirectoryThenRemoveSource(source, target)
  }
}

function isCrossDeviceRenameError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EXDEV'
}

async function copyDirectoryThenRemoveSource(source: string, target: string): Promise<void> {
  try {
    await fsp.cp(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    })
  }
  catch (err) {
    await fsp.rm(target, { recursive: true, force: true })
    throw err
  }

  try {
    await fsp.rm(source, { recursive: true, force: false })
  }
  catch (err) {
    await fsp.rm(target, { recursive: true, force: true })
    throw err
  }
}

/**
 * Create a symbolic link at `linkPath` pointing to `target`. `target` should be
 * an absolute path. On Windows, directory junctions are used when the host
 * platform can't create a native symlink.
 */
export async function createSymlink(linkPath: string, target: string, opts: MigrateOptions): Promise<void> {
  if (opts.dryRun) {
    note(`dry-run: would create symlink ${linkPath} -> ${target}`)
    return
  }

  const linkParent = path.dirname(linkPath)
  await fsp.mkdir(linkParent, { recursive: true })

  if (pathExists(linkPath) || isSymlink(linkPath)) {
    if (!opts.force) {
      throw new Error(`symlink location already exists: ${linkPath} (use --force to replace)`)
    }
    verbose(`removing existing symlink location: ${linkPath}`)
    await fsp.rm(linkPath, { recursive: true, force: true })
  }

  if (isWindows) {
    // Junctions don't require elevated privileges on Windows.
    try {
      await fsp.symlink(target, linkPath, 'junction')
      return
    }
    catch (err) {
      verbose(`junction creation failed, falling back to dir symlink: ${(err as Error).message}`)
    }
  }

  await fsp.symlink(target, linkPath, 'dir')
}

/**
 * Validate that `source` is a real, non-symlink directory and that `target` is
 * not a descendant of `source` (avoids moving a dir into itself).
 */
export function validateSource(source: string): void {
  if (!pathExists(source)) {
    throw new Error(`source directory does not exist: ${source}`)
  }
  if (isSymlink(source)) {
    throw new Error(`source is a symbolic link, refusing to migrate: ${source}`)
  }
  if (!isDirectory(source)) {
    throw new Error(`source is not a directory: ${source}`)
  }
}

export function validateTarget(source: string, target: string): void {
  const relative = path.relative(source, target)
  const isInsideSource = relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)

  if (isInsideSource) {
    // target is inside source
    throw new Error(`target ${target} is inside source ${source}; refusing to nest`)
  }
  if (path.resolve(source) === path.resolve(target)) {
    throw new Error('source and target resolve to the same path')
  }

  const targetParent = path.dirname(target)
  if (pathExists(targetParent) && !isDirectory(targetParent)) {
    throw new Error(`target parent is not a directory: ${targetParent}`)
  }
}

export function validateMigrationPlan(plan: MigrationPlan, opts: Pick<MigrateOptions, 'force'>): void {
  validateSource(plan.source)
  validateTarget(plan.source, plan.target)

  if (plan.targetExists && !opts.force) {
    throw new Error(`target already exists: ${plan.target} (use --force to replace)`)
  }
}

/**
 * Core migration: move `source` -> `target`, then leave a symlink at `source`
 * pointing to `target`. Optionally also migrate Codex history.
 */
export async function migrateProject(source: string, target: string, opts: MigrateOptions): Promise<MigrateResult> {
  const plan = buildMigrationPlan(source, target)
  const absSource = plan.source
  const absTarget = plan.target
  const warnings: string[] = []
  const errors: string[] = []

  verbose(`migrate ${absSource} -> ${absTarget} (force=${opts.force}, dryRun=${opts.dryRun})`)

  try {
    validateMigrationPlan(plan, opts)
  }
  catch (err) {
    errors.push((err as Error).message)
    return {
      ok: false,
      source: absSource,
      target: absTarget,
      symlink: absSource,
      moved: false,
      codex: null,
      warnings,
      errors,
    }
  }

  let moved = false
  try {
    await moveDirectory(absSource, absTarget, opts)
    moved = !opts.dryRun
  }
  catch (err) {
    errors.push(`failed to move directory: ${(err as Error).message}`)
    return {
      ok: false,
      source: absSource,
      target: absTarget,
      symlink: absSource,
      moved: false,
      codex: null,
      warnings,
      errors,
    }
  }

  try {
    await createSymlink(absSource, absTarget, opts)
    if (!opts.dryRun) {
      success(`migrated ${absSource} -> ${absTarget}`)
      info(`symlink ${absSource} -> ${absTarget}`)
    }
  }
  catch (err) {
    errors.push(`failed to create symlink: ${(err as Error).message}`)
    warn(`directory was moved to ${absTarget} but the symlink at ${absSource} could not be created`)
    return {
      ok: false,
      source: absSource,
      target: absTarget,
      symlink: absSource,
      moved,
      codex: null,
      warnings,
      errors,
    }
  }

  let codex: CodexIntegrationResult | null = null
  if (!opts.noCodex) {
    codex = await runCodexMigration(absSource, absTarget, opts)
    if (codex.skipped) {
      if (!codex.silent) {
        note(`codex migration skipped: ${codex.reason ?? 'unknown reason'}`)
      }
    }
    else if (!codex.ok) {
      warnings.push(`codex migration exited with code ${codex.exitCode}`)
    }
    else if (!opts.dryRun) {
      success('codex history migrated')
    }
  }

  return {
    ok: errors.length === 0 && (codex === null || codex.ok || codex.skipped),
    source: absSource,
    target: absTarget,
    symlink: absSource,
    moved,
    codex,
    warnings,
    errors,
  }
}

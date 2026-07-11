import type { SyncEntry, SyncOptions, SyncPlan, SyncResult } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import { info, success, verbose } from './log.js'
import { createSymlink, isDirectory, isSymlink, moveDirectory, pathExists, resolvePath } from './migrate.js'

/**
 * Build a plan to create source-side links for direct project directories in
 * the target parent. Existing correct links are retained; conflicting source
 * entries are reported and need --force before they can be replaced.
 *
 * In adopt mode, real (non-symlink) directories found in the target are flagged
 * for adoption: they are moved into the source parent and a symlink is left at
 * the original target path.
 */
export function buildSyncPlan(source: string, target: string, opts: Pick<SyncOptions, 'adopt' | 'force'> = { adopt: false, force: false }): SyncPlan {
  const plan: SyncPlan = {
    source: resolvePath(source),
    target: resolvePath(target),
    entries: [],
  }

  validateSyncDirectories(plan)
  plan.entries = fs.readdirSync(plan.target, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.')
      && (opts.adopt
        ? (entry.isSymbolicLink() || entry.isDirectory()) && !entry.isFile()
        : entry.isDirectory() && !entry.isSymbolicLink()))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const targetPath = path.join(plan.target, entry.name)
      // readdirSync withFileTypes: true reports symlink entries, but a symlink
      // whose target is a directory reports isDirectory() via stat, not lstat.
      // entry.isDirectory() here is lstat-based, so a symlink reports false.
      const targetIsSymlink = entry.isSymbolicLink()
      return describeSyncEntry(plan.source, targetPath, entry.name, targetIsSymlink, opts)
    })

  return plan
}

/** Validate the parent directories and reject ambiguous nested layouts. */
export function validateSyncPlan(plan: SyncPlan, opts: Pick<SyncOptions, 'force'>): void {
  validateSyncDirectories(plan)

  // 'adopt' entries that would replace an existing real source directory are
  // only safe with --force; surface them as conflicts otherwise.
  const conflicts = plan.entries.filter(entry => entry.state === 'conflict'
    || (entry.state === 'adopt' && entryHasRealSourceConflict(entry)))
  if (conflicts.length > 0 && !opts.force) {
    const paths = conflicts.map(entry => entry.source).join(', ')
    throw new Error(`source entries conflict with required symlinks: ${paths} (use --force to replace)`)
  }
}

function entryHasRealSourceConflict(entry: SyncEntry): boolean {
  return pathExists(entry.source) && !isSymlink(entry.source)
}

/** Return the source-side links that sync would create or replace. */
export function getSyncActions(plan: SyncPlan, opts: Pick<SyncOptions, 'force'>): SyncEntry[] {
  return plan.entries.filter(entry => entry.state === 'missing' || (opts.force && entry.state === 'conflict'))
}

/** Return target-side real directories that sync would adopt into the source parent. */
export function getAdoptActions(plan: SyncPlan): SyncEntry[] {
  return plan.entries.filter(entry => entry.state === 'adopt')
}

/** Create every missing source-side symlink and adopt real target directories in a validated sync plan. */
export async function syncProjectDirectories(plan: SyncPlan, opts: SyncOptions): Promise<SyncResult> {
  const created: string[] = []
  const alreadyLinked = plan.entries
    .filter(entry => entry.state === 'linked')
    .map(entry => entry.source)
  const adopted: string[] = []
  const errors: string[] = []

  try {
    validateSyncPlan(plan, opts)
  }
  catch (err) {
    errors.push((err as Error).message)
    return { ok: false, source: plan.source, target: plan.target, created, alreadyLinked, adopted, errors }
  }

  const linkActions = getSyncActions(plan, opts)
  const adoptActions = opts.adopt ? getAdoptActions(plan) : []
  verbose(`sync ${plan.source} <- ${plan.target} (${linkActions.length} symlinks, ${adoptActions.length} adopts, dryRun=${opts.dryRun})`)

  for (const entry of adoptActions) {
    try {
      await adoptProjectDirectory(entry, opts)
      adopted.push(entry.target)
    }
    catch (err) {
      errors.push(`failed to adopt ${entry.target}: ${(err as Error).message}`)
    }
  }

  for (const entry of linkActions) {
    try {
      await createSymlink(entry.source, entry.target, {
        force: opts.force,
        noCodex: true,
        yes: opts.yes,
        dryRun: opts.dryRun,
      })
      created.push(entry.source)
    }
    catch (err) {
      errors.push(`failed to create symlink ${entry.source}: ${(err as Error).message}`)
    }
  }

  return {
    ok: errors.length === 0,
    source: plan.source,
    target: plan.target,
    created,
    alreadyLinked,
    adopted,
    errors,
  }
}

/**
 * Adopt a real target directory: move it into the source parent and leave a
 * symlink at the original target path pointing to the new source location.
 * The source parent must not already contain a conflicting real entry unless
 * --force is set.
 */
async function adoptProjectDirectory(entry: SyncEntry, opts: SyncOptions): Promise<void> {
  if (opts.dryRun) {
    info(`dry-run: would adopt ${entry.target} -> ${entry.source} (symlink back: ${entry.target} -> ${entry.source})`)
    return
  }

  const sourceExists = pathExists(entry.source)
  const sourceIsLink = isSymlink(entry.source)

  if (sourceExists && !sourceIsLink && !opts.force) {
    throw new Error(`source location already exists as a real directory: ${entry.source} (use --force to replace)`)
  }

  await moveDirectory(entry.target, entry.source, {
    force: opts.force || sourceIsLink,
    noCodex: true,
    yes: opts.yes,
    dryRun: opts.dryRun,
  })

  await createSymlink(entry.target, entry.source, {
    force: true,
    noCodex: true,
    yes: opts.yes,
    dryRun: opts.dryRun,
  })

  success(`adopted ${entry.target} -> ${entry.source}`)
  info(`symlink ${entry.target} -> ${entry.source}`)
}

function validateSyncDirectories(plan: SyncPlan): void {
  if (!pathExists(plan.source)) {
    throw new Error(`source directory does not exist: ${plan.source}`)
  }
  if (isSymlink(plan.source) || !isDirectory(plan.source)) {
    throw new Error(`source must be a real directory: ${plan.source}`)
  }
  if (!pathExists(plan.target)) {
    throw new Error(`target directory does not exist: ${plan.target}`)
  }
  if (isSymlink(plan.target) || !isDirectory(plan.target)) {
    throw new Error(`target must be a real directory: ${plan.target}`)
  }

  const realSource = fs.realpathSync(plan.source)
  const realTarget = fs.realpathSync(plan.target)
  const sourceToTarget = path.relative(realSource, realTarget)
  const targetToSource = path.relative(realTarget, realSource)
  if (sourceToTarget === '' || targetToSource === '' || isDescendant(sourceToTarget) || isDescendant(targetToSource)) {
    throw new Error('source and target must be separate, non-nested directories')
  }
}

function isDescendant(relativePath: string): boolean {
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
}

function describeSyncEntry(
  sourceParent: string,
  target: string,
  name: string,
  targetIsSymlink: boolean,
  opts: Pick<SyncOptions, 'adopt' | 'force'>,
): SyncEntry {
  const source = path.join(sourceParent, name)
  const targetIsReal = !targetIsSymlink && pathExists(target) && isDirectory(target)
  const sourceExists = pathExists(source)
  const sourceIsLink = isSymlink(source)

  // Adopt mode: a real directory under target that should be moved into the
  // source parent, with a symlink left behind at the target path.
  if (opts.adopt && targetIsReal) {
    if (!sourceExists) {
      return { name, source, target, state: 'adopt', targetIsReal: true }
    }
    // Source already holds a real directory. Replacing it needs --force; we
    // return 'adopt' and let validateSyncPlan block the run without --force.
    if (!sourceIsLink) {
      return { name, source, target, state: 'adopt', targetIsReal: true }
    }
    // Source is a symlink; fall through to the linked/conflict checks.
  }

  // Already-adopted: target is a symlink pointing at the real source directory.
  // Both directions resolve to the same realpath, so no action is needed.
  if (targetIsSymlink && sourceExists && !sourceIsLink) {
    try {
      if (fs.realpathSync(target) === fs.realpathSync(source)) {
        return { name, source, target, state: 'linked', targetIsReal: false }
      }
    }
    catch {
      // Broken target symlink; fall through to conflict.
    }
  }

  if (!sourceExists) {
    // Target is a real directory (no symlink yet) and source is missing — this
    // is the plain "create a symlink" case in non-adopt mode.
    return { name, source, target, state: 'missing', targetIsReal }
  }
  if (!sourceIsLink) {
    return { name, source, target, state: 'conflict', reason: 'source entry exists and is not a symlink', targetIsReal }
  }

  try {
    if (fs.realpathSync(source) === fs.realpathSync(target)) {
      return { name, source, target, state: 'linked', targetIsReal }
    }
  }
  catch {
    // A broken link or inaccessible target must not be replaced without --force.
  }

  return { name, source, target, state: 'conflict', reason: 'source symlink points to a different location or is broken', targetIsReal }
}

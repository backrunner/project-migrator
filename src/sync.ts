import type { SyncEntry, SyncOptions, SyncPlan, SyncResult } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import { verbose } from './log.js'
import { createSymlink, isDirectory, isSymlink, pathExists, resolvePath } from './migrate.js'

/**
 * Build a plan to create source-side links for direct project directories in
 * the target parent. Existing correct links are retained; conflicting source
 * entries are reported and need --force before they can be replaced.
 */
export function buildSyncPlan(source: string, target: string): SyncPlan {
  const plan: SyncPlan = {
    source: resolvePath(source),
    target: resolvePath(target),
    entries: [],
  }

  validateSyncDirectories(plan)
  plan.entries = fs.readdirSync(plan.target, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => describeSyncEntry(plan.source, path.join(plan.target, entry.name), entry.name))

  return plan
}

/** Validate the parent directories and reject ambiguous nested layouts. */
export function validateSyncPlan(plan: SyncPlan, opts: Pick<SyncOptions, 'force'>): void {
  validateSyncDirectories(plan)

  const conflicts = plan.entries.filter(entry => entry.state === 'conflict')
  if (conflicts.length > 0 && !opts.force) {
    const paths = conflicts.map(entry => entry.source).join(', ')
    throw new Error(`source entries conflict with required symlinks: ${paths} (use --force to replace)`)
  }
}

/** Return the source-side links that sync would create or replace. */
export function getSyncActions(plan: SyncPlan, opts: Pick<SyncOptions, 'force'>): SyncEntry[] {
  return plan.entries.filter(entry => entry.state === 'missing' || (opts.force && entry.state === 'conflict'))
}

/** Create every missing source-side symlink in a validated sync plan. */
export async function syncProjectDirectories(plan: SyncPlan, opts: SyncOptions): Promise<SyncResult> {
  const created: string[] = []
  const alreadyLinked = plan.entries
    .filter(entry => entry.state === 'linked')
    .map(entry => entry.source)
  const errors: string[] = []

  try {
    validateSyncPlan(plan, opts)
  }
  catch (err) {
    errors.push((err as Error).message)
    return { ok: false, source: plan.source, target: plan.target, created, alreadyLinked, errors }
  }

  const actions = getSyncActions(plan, opts)
  verbose(`sync ${plan.source} <- ${plan.target} (${actions.length} symlinks, dryRun=${opts.dryRun})`)

  for (const entry of actions) {
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
    errors,
  }
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

function describeSyncEntry(sourceParent: string, target: string, name: string): SyncEntry {
  const source = path.join(sourceParent, name)
  if (!pathExists(source)) {
    return { name, source, target, state: 'missing' }
  }
  if (!isSymlink(source)) {
    return { name, source, target, state: 'conflict', reason: 'source entry exists and is not a symlink' }
  }

  try {
    if (fs.realpathSync(source) === fs.realpathSync(target)) {
      return { name, source, target, state: 'linked' }
    }
  }
  catch {
    // A broken link or inaccessible target must not be replaced without --force.
  }

  return { name, source, target, state: 'conflict', reason: 'source symlink points to a different location or is broken' }
}

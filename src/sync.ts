import type { SyncEntry, SyncOptions, SyncPlan, SyncResult } from './types.js'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { info, success, verbose } from './log.js'
import { createSymlink, isDirectory, isSymlink, moveDirectory, pathExists, resolvePath } from './migrate.js'

/**
 * Build a plan that mirrors direct, non-hidden project directories from the
 * source parent into the target parent as symlinks. Existing correct links are
 * retained; conflicting target entries require --force before replacement.
 *
 * In adopt mode, real directories found in the target are moved into the
 * source parent and replaced with links back to their new source locations.
 */
export function buildSyncPlan(
  source: string,
  target: string,
  opts: Pick<SyncOptions, 'adopt' | 'force'> = { adopt: false, force: false },
): SyncPlan {
  const plan: SyncPlan = {
    source: resolvePath(source),
    target: resolvePath(target),
    entries: [],
  }

  validateSyncDirectories(plan)

  const entries = fs.readdirSync(plan.source, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => describeSourceEntry(plan, entry.name, opts))

  if (opts.adopt) {
    const sourceNames = new Set(entries.map(entry => entry.name))
    const adoptEntries = fs.readdirSync(plan.target, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.')
        && entry.isDirectory()
        && !entry.isSymbolicLink()
        && !sourceNames.has(entry.name))
      .map(entry => describeAdoptEntry(plan, entry.name))
    entries.push(...adoptEntries)
  }

  plan.entries = entries.sort((left, right) => left.name.localeCompare(right.name))
  return plan
}

/** Validate the parent directories and reject conflicts that need --force. */
export function validateSyncPlan(plan: SyncPlan, opts: Pick<SyncOptions, 'adopt' | 'force'>): void {
  validateSyncDirectories(plan)

  const targetConflicts = plan.entries.filter(entry => entry.state === 'conflict')
  if (targetConflicts.length > 0 && !opts.force) {
    const paths = targetConflicts.map(entry => entry.target).join(', ')
    throw new Error(`target entries conflict with required symlinks: ${paths} (use --force to replace)`)
  }

  const sourceConflicts = opts.adopt
    ? plan.entries.filter(entry => entry.state === 'adopt' && pathExists(entry.source))
    : []
  if (sourceConflicts.length > 0 && !opts.force) {
    const paths = sourceConflicts.map(entry => entry.source).join(', ')
    throw new Error(`source entries conflict with directories selected for adoption: ${paths} (use --force to replace)`)
  }
}

/** Return target-side links that sync would create, repair, or replace. */
export function getSyncActions(plan: SyncPlan, opts: Pick<SyncOptions, 'force'>): SyncEntry[] {
  return plan.entries.filter(entry => entry.state === 'missing'
    || entry.state === 'repair'
    || (opts.force && entry.state === 'conflict'))
}

/** Return real target directories that sync would adopt into the source parent. */
export function getAdoptActions(plan: SyncPlan): SyncEntry[] {
  return plan.entries.filter(entry => entry.state === 'adopt')
}

/** Create missing target-side links and adopt selected real target directories. */
export async function syncProjectDirectories(plan: SyncPlan, opts: SyncOptions): Promise<SyncResult> {
  const created: string[] = []
  const repaired: string[] = []
  const alreadyLinked = plan.entries
    .filter(entry => entry.state === 'linked')
    .map(entry => entry.target)
  const adopted: string[] = []
  const errors: string[] = []

  try {
    validateSyncPlan(plan, opts)
  }
  catch (err) {
    errors.push((err as Error).message)
    return { ok: false, source: plan.source, target: plan.target, created, repaired, alreadyLinked, adopted, errors }
  }

  const linkActions = getSyncActions(plan, opts)
  const adoptActions = opts.adopt ? getAdoptActions(plan) : []
  verbose(`sync ${plan.source} -> ${plan.target} (${linkActions.length} symlinks, ${adoptActions.length} adopts, dryRun=${opts.dryRun})`)

  for (const entry of adoptActions) {
    try {
      await adoptProjectDirectory(entry, opts)
      adopted.push(entry.source)
    }
    catch (err) {
      errors.push(`failed to adopt ${entry.target}: ${(err as Error).message}`)
    }
  }

  for (const entry of linkActions) {
    try {
      if (entry.state === 'repair') {
        await repairCaseMismatchSymlink(entry, opts)
      }
      else {
        await createSymlink(entry.target, entry.source, {
          force: opts.force,
          noCodex: true,
          yes: opts.yes,
          dryRun: opts.dryRun,
        })
      }

      if (entry.state === 'repair') {
        repaired.push(entry.target)
      }
      else {
        created.push(entry.target)
      }
    }
    catch (err) {
      const action = entry.state === 'repair' ? 'repair' : 'create'
      errors.push(`failed to ${action} symlink ${entry.target}: ${(err as Error).message}`)
    }
  }

  return {
    ok: errors.length === 0,
    source: plan.source,
    target: plan.target,
    created,
    repaired,
    alreadyLinked,
    adopted,
    errors,
  }
}

async function repairCaseMismatchSymlink(entry: SyncEntry, opts: SyncOptions): Promise<void> {
  if (opts.dryRun) {
    info(`dry-run: would repair symlink ${entry.target} -> ${entry.source}`)
    return
  }

  const currentDestination = isSymlink(entry.target)
    ? resolveSymlinkDestination(entry.target)
    : undefined
  if (currentDestination === undefined || !isCaseOnlyPathMismatch(currentDestination, entry.source)) {
    throw new Error('target changed after planning; refusing automatic replacement')
  }

  await createSymlink(entry.target, entry.source, {
    force: true,
    noCodex: true,
    yes: opts.yes,
    dryRun: false,
  })
}

/** Move a real target directory into source, then leave a link at target. */
async function adoptProjectDirectory(entry: SyncEntry, opts: SyncOptions): Promise<void> {
  if (opts.dryRun) {
    info(`dry-run: would adopt ${entry.target} -> ${entry.source} (symlink back: ${entry.target} -> ${entry.source})`)
    return
  }

  if (pathExists(entry.source) && !opts.force) {
    throw new Error(`source location already exists: ${entry.source} (use --force to replace)`)
  }

  await moveDirectory(entry.target, entry.source, {
    force: opts.force,
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

function describeSourceEntry(
  plan: SyncPlan,
  name: string,
  opts: Pick<SyncOptions, 'adopt'>,
): SyncEntry {
  const source = path.join(plan.source, name)
  const target = path.join(plan.target, name)
  const targetExists = pathExists(target)
  const targetIsSymlink = isSymlink(target)
  const targetIsReal = targetExists && !targetIsSymlink && isDirectory(target)

  if (!targetExists) {
    return { name, source, target, state: 'missing', targetIsReal: false }
  }

  if (targetIsSymlink) {
    const symlinkDestination = resolveSymlinkDestination(target)
    if (symlinkDestination !== undefined && isCaseOnlyPathMismatch(symlinkDestination, source)) {
      return {
        name,
        source,
        target,
        state: isCaseSensitivePath(source) ? 'repair' : 'linked',
        reason: 'target symlink uses different path casing',
        targetIsReal: false,
      }
    }

    try {
      if (fs.realpathSync(target) === fs.realpathSync(source)) {
        return { name, source, target, state: 'linked', targetIsReal: false }
      }
    }
    catch {
      // Broken or inaccessible links are conflicts and require --force.
    }

    return {
      name,
      source,
      target,
      state: 'conflict',
      reason: 'target symlink points to a different location or is broken',
      targetIsReal: false,
    }
  }

  if (opts.adopt && targetIsReal) {
    return {
      name,
      source,
      target,
      state: 'adopt',
      reason: 'source entry already exists and would be replaced',
      targetIsReal: true,
    }
  }

  return {
    name,
    source,
    target,
    state: 'conflict',
    reason: targetIsReal ? 'target entry is a real directory' : 'target entry is not a symlink',
    targetIsReal,
  }
}

/** Detect case sensitivity without writing by probing an alternate-cased path. */
export function isCaseSensitivePath(existingPath: string): boolean {
  if (process.platform === 'win32') {
    return false
  }

  let current = path.resolve(existingPath)
  while (current !== path.dirname(current)) {
    const name = path.basename(current)
    const alternateName = swapFirstAsciiLetterCase(name)
    if (alternateName !== name) {
      try {
        const original = fs.statSync(current)
        const alternate = fs.statSync(path.join(path.dirname(current), alternateName))
        return original.dev !== alternate.dev || original.ino !== alternate.ino
      }
      catch {
        return true
      }
    }
    current = path.dirname(current)
  }

  return true
}

function resolveSymlinkDestination(linkPath: string): string | undefined {
  try {
    const destination = fs.readlinkSync(linkPath)
    return path.resolve(path.dirname(linkPath), destination)
  }
  catch {
    return undefined
  }
}

function isCaseOnlyPathMismatch(actual: string, expected: string): boolean {
  return actual !== expected && actual.toLowerCase() === expected.toLowerCase()
}

function swapFirstAsciiLetterCase(value: string): string {
  const index = value.search(/[a-z]/i)
  if (index === -1) {
    return value
  }

  const character = value[index]
  const swapped = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()
  return `${value.slice(0, index)}${swapped}${value.slice(index + 1)}`
}

function describeAdoptEntry(plan: SyncPlan, name: string): SyncEntry {
  const source = path.join(plan.source, name)
  const target = path.join(plan.target, name)
  return {
    name,
    source,
    target,
    state: 'adopt',
    reason: pathExists(source) ? 'source entry already exists and would be replaced' : undefined,
    targetIsReal: true,
  }
}

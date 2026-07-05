import type { MigrateResult, WatchOptions } from './types.js'
import path from 'node:path'
import chokidar from 'chokidar'
import { info, note, success, warn } from './log.js'
import { buildMigrationPlan, migrateProject, validateMigrationPlan } from './migrate.js'

export interface WatchState {
  /** Names already migrated during this watch session (basename -> target). */
  migrated: Map<string, string>
  /** Names intentionally ignored (e.g. already a symlink). */
  ignored: Set<string>
}

/**
 * Watch `watchDir` (non-recursive) for new directories. When a new directory
 * appears, move it under `targetParent` and leave a symlink at the original
 * path. Existing entries at watch start are migrated once, then new ones are
 * handled as they're created.
 */
export function startWatcher(
  watchDir: string,
  targetParent: string,
  opts: WatchOptions,
): () => Promise<void> {
  const absWatch = path.resolve(watchDir)
  const absTargetParent = path.resolve(targetParent)
  const state: WatchState = { migrated: new Map(), ignored: new Set() }

  info(`watching ${absWatch} (non-recursive) -> ${absTargetParent}`)
  if (opts.dryRun) {
    note('dry-run mode: no files will be moved')
  }

  let queue = Promise.resolve()

  const handlePath = async (entryPath: string): Promise<void> => {
    const name = path.basename(entryPath)
    if (!name || name.startsWith('.')) {
      return
    }
    if (state.migrated.has(name) || state.ignored.has(name)) {
      return
    }

    try {
      const stat = await import('node:fs/promises').then(async fsp => fsp.lstat(entryPath))
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        state.ignored.add(name)
        return
      }
    }
    catch {
      // disappeared between event and handler — ignore
      return
    }

    const target = path.join(absTargetParent, name)
    const plan = buildMigrationPlan(entryPath, target)
    info(`new directory detected: ${entryPath}`)

    try {
      validateMigrationPlan(plan, opts)
    }
    catch (err) {
      warn((err as Error).message)
      state.ignored.add(name)
      return
    }

    if (opts.confirmMigration) {
      let confirmed = false
      try {
        confirmed = await opts.confirmMigration(plan)
      }
      catch (err) {
        warn((err as Error).message)
        state.ignored.add(name)
        return
      }

      if (!confirmed) {
        note(`skipped ${name}`)
        state.ignored.add(name)
        return
      }
    }

    let result: MigrateResult
    try {
      result = await migrateProject(plan.source, plan.target, {
        force: opts.force,
        noCodex: opts.noCodex,
        yes: opts.yes,
        dryRun: opts.dryRun,
        codexProjectName: opts.codexProjectName ?? name,
      })
    }
    catch (err) {
      warn(`failed to migrate ${entryPath}: ${(err as Error).message}`)
      state.ignored.add(name)
      return
    }

    if (result.ok) {
      state.migrated.set(name, target)
      if (!opts.dryRun) {
        success(`auto-migrated ${name} -> ${target}`)
      }
    }
    else {
      for (const err of result.errors) {
        warn(err)
      }
      state.ignored.add(name)
    }
  }

  const watcher = chokidar.watch(absWatch, {
    ignored: (p) => {
      const rel = path.relative(absWatch, p)
      if (rel === '') {
        return false
      }
      // ignore anything nested (only direct children)
      return rel.includes(path.sep)
    },
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  })

  watcher.on('addDir', (dirPath) => {
    if (path.resolve(dirPath) === absWatch) {
      return
    }
    queue = queue
      .then(async () => {
        await handlePath(dirPath)
      })
      .catch((err: unknown) => {
        warn(`failed to handle ${dirPath}: ${(err as Error).message}`)
      })
  })

  watcher.on('error', (err) => {
    warn(`watcher error: ${(err as Error).message}`)
  })

  return async () => {
    await watcher.close()
  }
}

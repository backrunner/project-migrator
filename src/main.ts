import type { MigrateOptions, SyncOptions, WatchOptions } from './types.js'
import os from 'node:os'
import process from 'node:process'
import chalk from 'chalk'
import { Command } from 'commander'
import { version } from '../package.json'
import { configureLog, error, info, isVerbose, success, verbose } from './log.js'
import { buildMigrationPlan, isDirectory, migrateProject, pathExists, resolvePath, validateMigrationPlan } from './migrate.js'
import { confirmCreateDirectory, confirmMigrationPlan, confirmSyncPlan } from './prompt.js'
import { buildSyncPlan, getAdoptActions, getSyncActions, syncProjectDirectories, validateSyncPlan } from './sync.js'
import { startWatcher } from './watch.js'

const program = new Command()

program
  .name('project-migrate')
  .usage('[options] <src> <target>')
  .description('Migrate project directories to another location while keeping a symlink at the original path.')
  .version(version)
  .argument('[src]', 'source project directory')
  .argument('[target]', 'target project directory')
  .option('-q, --quiet', 'suppress non-error output')
  .option('-v, --verbose', 'print debug-level detail')
  .option('--force', 'replace an existing target or symlink')
  .option('--no-codex', 'skip codex-migrate history migration')
  .option('-y, --yes', 'confirm this migration and apply codex-migrate non-interactively')
  .option('--dry-run', 'print the plan; write nothing')
  .option('--codex-project-name <name>', 'override the project name passed to codex-migrate')
  .hook('preAction', (cmd) => {
    const opts = cmd.optsWithGlobals()
    configureLog({ quiet: Boolean(opts.quiet), verbose: Boolean(opts.verbose) })
  })
  .action(async (src: string | undefined, target: string | undefined, _options: Record<string, unknown>, command: Command) => {
    if (src === undefined || src === '' || target === undefined || target === '') {
      program.help({ error: true })
      return
    }

    const opts = toMigrateOptions(command.optsWithGlobals())
    const plan = buildMigrationPlan(src, target)
    verbose(`os=${os.platform()} node=${process.version}`)

    try {
      validateMigrationPlan(plan, opts)
      const confirmed = await confirmMigrationPlan(plan, opts)
      if (!confirmed) {
        info('migration cancelled')
        process.exitCode = 1
        return
      }
    }
    catch (err) {
      error((err as Error).message)
      process.exitCode = 1
      return
    }

    const result = await migrateProject(plan.source, plan.target, opts)
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        error(err)
      }
      process.exitCode = 1
      return
    }
    if (opts.dryRun) {
      info(`dry-run plan: ${result.source} -> ${result.target}, symlink at ${result.symlink}`)
    }
    success('migration complete')
  })

program
  .command('watch')
  .description('Watch a directory (non-recursive) and auto-migrate any new subdirectories to a target parent, leaving symlinks behind.')
  .argument('<watch-dir>', 'directory to watch (non-recursive)')
  .argument('<target-parent>', 'parent directory new projects are moved under')
  .option('--force', 'replace an existing target or symlink')
  .option('--no-codex', 'skip codex-migrate history migration')
  .option('-y, --yes', 'confirm migrations and apply codex-migrate non-interactively')
  .option('--dry-run', 'report what would happen; write nothing')
  .option('--codex-project-name <name>', 'override the project name passed to codex-migrate')
  .action(async (watchDir: string, targetParent: string, _options: Record<string, unknown>, command: Command) => {
    const opts = toWatchOptions(command.optsWithGlobals())
    const absWatch = resolvePath(watchDir)
    const absTarget = resolvePath(targetParent)

    verbose(`watch ${absWatch} -> ${absTarget}`)

    if (!pathExists(absWatch) || !isDirectory(absWatch)) {
      error(`watch directory does not exist or is not a directory: ${absWatch}`)
      process.exitCode = 1
      return
    }

    if (pathExists(absTarget)) {
      if (!isDirectory(absTarget)) {
        error(`target parent is not a directory: ${absTarget}`)
        process.exitCode = 1
        return
      }
    }
    else if (!opts.dryRun) {
      try {
        const confirmed = await confirmCreateDirectory(absTarget, opts)
        if (!confirmed) {
          info('watch cancelled')
          process.exitCode = 1
          return
        }

        await import('node:fs/promises').then(async fsp => fsp.mkdir(absTarget, { recursive: true }))
      }
      catch (err) {
        error(`failed to create target parent: ${(err as Error).message}`)
        process.exitCode = 1
        return
      }
    }

    if (!opts.yes && !opts.dryRun) {
      opts.confirmMigration = async (plan) => {
        return confirmMigrationPlan(plan, opts)
      }
    }

    const stop = startWatcher(absWatch, absTarget, opts)

    const shutdown = async (signal: string): Promise<void> => {
      info(`received ${signal}, shutting down`)
      await stop()
      process.exit(0)
    }

    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))

    info('press Ctrl+C to stop')
  })

program
  .command('sync')
  .description('Create missing source-side symlinks for direct project directories already present in a target directory.')
  .argument('<src>', 'source parent directory where symlinks are created')
  .argument('<target>', 'target parent directory containing migrated projects')
  .option('--force', 'replace conflicting source entries with symlinks')
  .option('-y, --yes', 'confirm this sync non-interactively')
  .option('--dry-run', 'print the links that would be created; write nothing')
  .option('--adopt', 'adopt real directories in target: move them into source and leave a symlink')
  .action(async (src: string, target: string, _options: Record<string, unknown>, command: Command) => {
    const opts = toSyncOptions(command.optsWithGlobals())

    try {
      const plan = buildSyncPlan(src, target, opts)
      validateSyncPlan(plan, opts)
      const actions = getSyncActions(plan, opts)
      const adoptActions = opts.adopt ? getAdoptActions(plan) : []
      if (actions.length === 0 && adoptActions.length === 0) {
        info('sync complete: all target project directories already have matching symlinks')
        return
      }

      const confirmed = await confirmSyncPlan(plan, opts)
      if (!confirmed) {
        info('sync cancelled')
        process.exitCode = 1
        return
      }

      const result = await syncProjectDirectories(plan, opts)
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          error(err)
        }
        process.exitCode = 1
        return
      }

      if (opts.dryRun) {
        info(`dry-run plan: would create ${result.created.length} symlink(s), adopt ${result.adopted.length} director(y/ies)`)
      }
      else {
        const parts = [`created ${result.created.length} symlink(s)`]
        if (result.adopted.length > 0) {
          parts.push(`adopted ${result.adopted.length} director(y/ies)`)
        }
        success(`sync complete: ${parts.join(', ')}`)
      }
    }
    catch (err) {
      error((err as Error).message)
      process.exitCode = 1
    }
  })

function toMigrateOptions(raw: Record<string, unknown>): MigrateOptions {
  return {
    force: Boolean(raw.force),
    noCodex: raw.codex === false,
    yes: Boolean(raw.yes),
    dryRun: Boolean(raw.dryRun),
    codexProjectName: typeof raw.codexProjectName === 'string' ? raw.codexProjectName : undefined,
  }
}

function toWatchOptions(raw: Record<string, unknown>): WatchOptions {
  return {
    force: Boolean(raw.force),
    noCodex: raw.codex === false,
    yes: Boolean(raw.yes),
    dryRun: Boolean(raw.dryRun),
    codexProjectName: typeof raw.codexProjectName === 'string' ? raw.codexProjectName : undefined,
  }
}

function toSyncOptions(raw: Record<string, unknown>): SyncOptions {
  return {
    force: Boolean(raw.force),
    yes: Boolean(raw.yes),
    dryRun: Boolean(raw.dryRun),
    adopt: Boolean(raw.adopt),
  }
}

void isVerbose

program.parseAsync(process.argv).catch((err: unknown) => {
  error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

void chalk

import type { MigrateOptions, MigrationPlan, SyncOptions, SyncPlan } from './types.js'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'

type PromptOptions = Pick<MigrateOptions, 'dryRun' | 'force' | 'noCodex' | 'yes'>

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }
  finally {
    rl.close()
  }
}

function requirePromptable(message: string): void {
  if (!canPrompt()) {
    throw new Error(`${message}; pass --yes to proceed non-interactively`)
  }
}

export async function confirmCreateDirectory(dir: string, opts: Pick<MigrateOptions, 'dryRun' | 'yes'>): Promise<boolean> {
  if (opts.yes || opts.dryRun) {
    return true
  }

  requirePromptable(`cannot confirm creation of ${dir}`)
  return askYesNo(`Target directory does not exist: ${dir}. Create it?`)
}

export async function confirmMigrationPlan(plan: MigrationPlan, opts: PromptOptions): Promise<boolean> {
  if (opts.yes || opts.dryRun) {
    return true
  }

  requirePromptable('cannot confirm migration')
  printMigrationPlan(plan, opts)

  if (!plan.targetExists) {
    return askYesNo('Target does not exist. Create it by moving the source there?')
  }

  return askYesNo('Proceed with this migration?')
}

export async function confirmSyncPlan(plan: SyncPlan, opts: SyncOptions): Promise<boolean> {
  if (opts.yes || opts.dryRun) {
    return true
  }

  requirePromptable('cannot confirm sync')
  printSyncPlan(plan, opts)

  const creates = plan.entries.filter(entry => entry.state === 'missing').length
  const replacements = opts.force
    ? plan.entries.filter(entry => entry.state === 'conflict').length
    : 0
  return askYesNo(`Create ${creates + replacements} symlink(s)?`)
}

function printMigrationPlan(plan: MigrationPlan, opts: PromptOptions): void {
  const targetStatus = plan.targetExists
    ? opts.force ? 'exists; will be replaced because --force was passed' : 'exists'
    : 'does not exist; will be created from the source directory'
  const parentStatus = plan.targetParentExists ? 'exists' : 'does not exist; will be created'
  const codexStatus = opts.noCodex
    ? 'skipped by --no-codex'
    : opts.yes ? 'runs non-interactively when codex-migrate is available' : 'skipped unless --yes is passed'

  process.stdout.write([
    'Migration plan:',
    `  Source:        ${plan.source}`,
    `  Target:        ${plan.target} (${targetStatus})`,
    `  Target parent: ${plan.targetParent} (${parentStatus})`,
    `  Symlink:       ${plan.symlink} -> ${plan.target}`,
    `  Codex:         ${codexStatus}`,
    '',
  ].join('\n'))
}

function printSyncPlan(plan: SyncPlan, opts: SyncOptions): void {
  const missing = plan.entries.filter(entry => entry.state === 'missing')
  const linked = plan.entries.filter(entry => entry.state === 'linked')
  const conflicts = plan.entries.filter(entry => entry.state === 'conflict')
  const actions = opts.force ? [...missing, ...conflicts] : missing

  process.stdout.write([
    'Sync plan:',
    `  Source:          ${plan.source}`,
    `  Target:          ${plan.target}`,
    `  Existing links:  ${linked.length}`,
    `  Links to create: ${actions.length}`,
    ...actions.map(entry => `    ${entry.source} -> ${entry.target}`),
    ...conflicts.map(entry => `  Conflict: ${entry.source} (${entry.reason ?? 'unknown conflict'})`),
    '',
  ].join('\n'))
}

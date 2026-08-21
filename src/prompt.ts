import type { MigrateOptions, MigrationPlan, SyncEntry, SyncOptions, SyncPlan } from './types.js'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'

type PromptOptions = Pick<MigrateOptions, 'dryRun' | 'force' | 'noCodex' | 'yes'>

const labelWidth = 18

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const prompt = `${chalk.cyan.bold('?')} ${chalk.bold(question)} ${chalk.dim('[y/N]')} `
    const answer = (await rl.question(prompt)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }
  finally {
    rl.close()
    process.stdout.write('\n')
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
  writePanel('Create directory', [row('Target', dir, chalk.green)])
  return askYesNo('Create this directory?')
}

export async function confirmMigrationPlan(plan: MigrationPlan, opts: PromptOptions): Promise<boolean> {
  if (opts.dryRun) {
    printMigrationPlan(plan, opts)
    return true
  }
  if (opts.yes) {
    return true
  }

  requirePromptable('cannot confirm migration')
  printMigrationPlan(plan, opts)

  if (!plan.targetExists) {
    return askYesNo('Create the target by moving the source there?')
  }

  return askYesNo('Proceed with this migration?')
}

export async function confirmAdoptDirectories(entries: SyncEntry[]): Promise<boolean> {
  requirePromptable('cannot confirm target directory adoption')

  writePanel('Real directories found in target', [
    row('Directories', String(entries.length), chalk.magenta),
    '',
    ...entries.flatMap(entry => actionLines('adopt', entry)),
  ])

  return askYesNo(`Adopt ${entries.length} director${entries.length === 1 ? 'y' : 'ies'} into the source?`)
}

export async function confirmSyncPlan(plan: SyncPlan, opts: SyncOptions): Promise<boolean> {
  if (opts.dryRun) {
    printSyncPlan(plan, opts)
    return true
  }
  if (opts.yes) {
    return true
  }

  requirePromptable('cannot confirm sync')
  printSyncPlan(plan, opts)

  const creates = plan.entries.filter(entry => entry.state === 'missing').length
  const repairs = plan.entries.filter(entry => entry.state === 'repair').length
  const replacements = opts.force
    ? plan.entries.filter(entry => entry.state === 'conflict').length
    : 0
  const adopts = opts.adopt
    ? plan.entries.filter(entry => entry.state === 'adopt').length
    : 0
  const total = creates + repairs + replacements + adopts
  return askYesNo(`Apply ${total} action${total === 1 ? '' : 's'}?`)
}

function printMigrationPlan(plan: MigrationPlan, opts: PromptOptions): void {
  const targetStatus = plan.targetExists
    ? opts.force ? 'exists; replace with --force' : 'exists'
    : 'new location'
  const parentStatus = plan.targetParentExists ? 'exists' : 'will be created'
  const codexStatus = opts.noCodex
    ? 'skipped by --no-codex'
    : opts.yes ? 'non-interactive when available' : 'skipped unless --yes is passed'

  writePanel('Migration plan', [
    row('Source', plan.source, chalk.cyan),
    row('Target', `${plan.target} ${chalk.dim(`(${targetStatus})`)}`, chalk.green),
    row('Target parent', `${plan.targetParent} ${chalk.dim(`(${parentStatus})`)}`, chalk.green),
    row('Symlink', `${chalk.green(plan.symlink)} ${arrow()} ${chalk.cyan(plan.target)}`),
    row('Codex', codexStatus),
  ])
}

export function printSyncPlan(plan: SyncPlan, opts: SyncOptions): void {
  const missing = plan.entries.filter(entry => entry.state === 'missing')
  const linked = plan.entries.filter(entry => entry.state === 'linked')
  const repairs = plan.entries.filter(entry => entry.state === 'repair')
  const conflicts = plan.entries.filter(entry => entry.state === 'conflict')
  const replacements = opts.force ? conflicts : []
  const adopts = opts.adopt ? plan.entries.filter(entry => entry.state === 'adopt') : []
  const detailLines = [
    ...missing.flatMap(entry => actionLines('create', entry)),
    ...repairs.flatMap(entry => actionLines('repair', entry)),
    ...replacements.flatMap(entry => actionLines('replace', entry)),
    ...adopts.flatMap(entry => actionLines('adopt', entry)),
  ]

  writePanel('Sync plan', [
    row('Project source', plan.source, chalk.cyan),
    row('Link directory', plan.target, chalk.green),
    '',
    row('Existing links', String(linked.length), chalk.green),
    row('Create', String(missing.length), chalk.green),
    row('Repair', String(repairs.length), chalk.blue),
    row('Replace', String(replacements.length), chalk.yellow),
    row('Adopt', String(adopts.length), chalk.magenta),
    ...(detailLines.length > 0 ? ['', ...detailLines] : []),
    ...(!opts.force && conflicts.length > 0
      ? ['', ...conflicts.flatMap(entry => actionLines('conflict', entry))]
      : []),
  ])
}

function actionLines(kind: 'adopt' | 'conflict' | 'create' | 'repair' | 'replace', entry: SyncEntry): string[] {
  if (kind === 'adopt') {
    return [
      `${chalk.magenta.bold('ADOPT')} ${chalk.bold(entry.name)}`,
      `  ${chalk.magenta(entry.target)} ${arrow()} ${chalk.cyan(entry.source)}`,
      `  ${chalk.dim('leave link')} ${chalk.green(entry.target)} ${arrow()} ${chalk.cyan(entry.source)}`,
    ]
  }

  const styles = {
    conflict: { marker: 'CONFLICT', color: chalk.red },
    create: { marker: 'CREATE', color: chalk.green },
    repair: { marker: 'REPAIR', color: chalk.blue },
    replace: { marker: 'REPLACE', color: chalk.yellow },
  } as const
  const style = styles[kind]
  const reason = kind === 'conflict' && entry.reason !== undefined && entry.reason !== ''
    ? ` ${chalk.dim(`(${entry.reason})`)}`
    : ''
  return [
    `${style.color.bold(style.marker)} ${chalk.bold(entry.name)}${reason}`,
    `  ${style.color(entry.target)} ${arrow()} ${chalk.cyan(entry.source)}`,
  ]
}

function row(label: string, value: string, color: (text: string) => string = chalk.white): string {
  return `${chalk.gray(label.padEnd(labelWidth))}${color(value)}`
}

function arrow(): string {
  return chalk.gray('->')
}

function writePanel(title: string, lines: string[]): void {
  process.stdout.write(`\n${chalk.cyan.bold(title)}\n\n${lines.join('\n')}\n\n`)
}

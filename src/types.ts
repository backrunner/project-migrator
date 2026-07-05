export interface MigrateOptions {
  /** Replace an existing target directory/symlink if present. */
  force: boolean
  /** Skip the Codex history migration step. */
  noCodex: boolean
  /** Pass --yes to codex-migrate (non-interactive apply). */
  yes: boolean
  /** Dry run: print the plan, write nothing. */
  dryRun: boolean
  /** Custom name for the codex-migrate project command (basename by default). */
  codexProjectName?: string
}

export interface MigrationPlan {
  source: string
  target: string
  symlink: string
  targetParent: string
  targetExists: boolean
  targetParentExists: boolean
}

export type ConfirmMigration = (plan: MigrationPlan) => Promise<boolean>

export interface WatchOptions {
  /** Replace existing targets when auto-migrating. */
  force: boolean
  /** Skip the Codex history migration step for auto-migrations. */
  noCodex: boolean
  /** Pass --yes to codex-migrate (non-interactive apply). */
  yes: boolean
  /** Dry run: report what would happen, write nothing. */
  dryRun: boolean
  /** Custom name for the codex-migrate project command (basename by default). */
  codexProjectName?: string
  /** Confirm a pending migration before the watcher moves anything. */
  confirmMigration?: ConfirmMigration
}

export interface MigrateResult {
  ok: boolean
  source: string
  target: string
  symlink: string
  moved: boolean
  codex: CodexIntegrationResult | null
  warnings: string[]
  errors: string[]
}

export interface CodexIntegrationResult {
  ok: boolean
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  skipped: boolean
  reason?: string
  silent?: boolean
}

export interface WatchEvent {
  kind: 'add'
  path: string
  name: string
}

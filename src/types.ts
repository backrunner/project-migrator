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

export type SyncEntryState = 'missing' | 'linked' | 'conflict' | 'adopt'

export interface SyncEntry {
  name: string
  source: string
  target: string
  state: SyncEntryState
  reason?: string
  /** True when the target entry is a real directory (not a symlink). */
  targetIsReal?: boolean
}

export interface SyncPlan {
  source: string
  target: string
  entries: SyncEntry[]
}

export interface SyncOptions {
  /** Replace conflicting source entries with the expected symlink. */
  force: boolean
  /** Skip the confirmation prompt. */
  yes: boolean
  /** Print the links that would be created without writing to disk. */
  dryRun: boolean
  /**
   * Adopt real (non-symlink) directories found in the target: move them into the
   * source parent and leave a symlink pointing back from the target.
   */
  adopt: boolean
}

export interface SyncResult {
  ok: boolean
  source: string
  target: string
  created: string[]
  alreadyLinked: string[]
  /** Target-side real directories adopted (moved into the source parent). */
  adopted: string[]
  errors: string[]
}

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

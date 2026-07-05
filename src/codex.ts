import type { ChildProcess } from 'node:child_process'
import type { CodexIntegrationResult, MigrateOptions } from './types.js'
import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { verbose } from './log.js'

const CODEX_BIN = 'codex-migrate'

interface CodexMigrateAvailability {
  available: boolean
  supportsYes: boolean
  reason?: string
}

/**
 * Detect whether the `codex-migrate project` command is usable.
 */
export function checkCodexMigrateAvailability(): CodexMigrateAvailability {
  const child = spawnSync(CODEX_BIN, ['project', '--help'], { encoding: 'utf-8' })
  if (child.error) {
    return {
      available: false,
      supportsYes: false,
      reason: `${CODEX_BIN} not found on PATH`,
    }
  }

  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  if (child.status !== 0 && output.trim().length === 0) {
    return {
      available: false,
      supportsYes: false,
      reason: `${CODEX_BIN} project help is unavailable`,
    }
  }

  return {
    available: true,
    supportsYes: output.includes('--yes'),
  }
}

/**
 * Run `codex-migrate project <name> <targetDir> --from-dir <sourceDir> [--yes]`
 * so Codex conversation history follows the directory move.
 *
 * The command is non-interactive when `opts.yes` is true (requires a
 * codex-migrate version that supports --yes). Otherwise we skip with a warning,
 * because spawning an interactive prompt from a watcher would hang.
 */
export async function runCodexMigration(
  source: string,
  target: string,
  opts: MigrateOptions,
): Promise<CodexIntegrationResult> {
  const projectName = opts.codexProjectName ?? path.basename(source)
  const args = ['project', projectName, target, '--from-dir', source]
  if (opts.yes) {
    args.push('--yes')
  }
  if (opts.dryRun) {
    // codex-migrate is already a dry-run by default; no extra flag needed, but
    // we don't want to confirm so we still pass --yes to avoid the prompt.
    if (!opts.yes) {
      args.push('--yes')
    }
  }

  const availability = checkCodexMigrateAvailability()
  if (!availability.available) {
    return {
      ok: false,
      command: `${CODEX_BIN} ${args.join(' ')}`,
      exitCode: null,
      stdout: '',
      stderr: '',
      skipped: true,
      reason: availability.reason,
      silent: true,
    }
  }

  if ((opts.yes || opts.dryRun) && !availability.supportsYes) {
    return {
      ok: false,
      command: `${CODEX_BIN} ${args.join(' ')}`,
      exitCode: null,
      stdout: '',
      stderr: '',
      skipped: true,
      reason: `${CODEX_BIN} does not support --yes`,
      silent: true,
    }
  }

  if (!opts.yes && !opts.dryRun) {
    return {
      ok: false,
      command: `${CODEX_BIN} ${args.join(' ')}`,
      exitCode: null,
      stdout: '',
      stderr: '',
      skipped: true,
      reason: 'interactive codex-migrate would hang; pass --yes to apply automatically',
    }
  }

  const command = `${CODEX_BIN} ${args.join(' ')}`
  verbose(`running: ${command}`)

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(CODEX_BIN, args)
    }
    catch (err) {
      resolve({
        ok: false,
        command,
        exitCode: null,
        stdout: '',
        stderr: (err as Error).message,
        skipped: true,
        reason: (err as Error).message,
        silent: true,
      })
      return
    }
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Uint8Array) => {
      const text = Buffer.from(chunk).toString('utf-8')
      stdout += text
      if (opts.dryRun === false) {
        process.stdout.write(text)
      }
    })
    child.stderr?.on('data', (chunk: Uint8Array) => {
      const text = Buffer.from(chunk).toString('utf-8')
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', (err: Error) => {
      resolve({
        ok: false,
        command,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        skipped: true,
        reason: err.message,
        silent: true,
      })
    })
    child.on('close', (code: number | null) => {
      resolve({
        ok: code === 0,
        command,
        exitCode: code,
        stdout,
        stderr,
        skipped: false,
      })
    })
  })
}

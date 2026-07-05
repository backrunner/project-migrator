import process from 'node:process'
import chalk from 'chalk'

export interface LogOptions {
  quiet: boolean
  verbose: boolean
}

let options: LogOptions = { quiet: false, verbose: false }

export function configureLog(next: Partial<LogOptions>): void {
  options = { ...options, ...next }
}

export function isVerbose(): boolean {
  return options.verbose
}

export function info(message: string): void {
  if (options.quiet) {
    return
  }
  process.stdout.write(`${chalk.cyan('i')} ${message}\n`)
}

export function success(message: string): void {
  if (options.quiet) {
    return
  }
  process.stdout.write(`${chalk.green('✓')} ${message}\n`)
}

export function warn(message: string): void {
  process.stderr.write(`${chalk.yellow('!')} ${message}\n`)
}

export function error(message: string): void {
  process.stderr.write(`${chalk.red('✗')} ${message}\n`)
}

export function verbose(message: string): void {
  if (!options.verbose || options.quiet) {
    return
  }
  process.stdout.write(`${chalk.gray('·')} ${chalk.gray(message)}\n`)
}

export function note(message: string): void {
  if (options.quiet) {
    return
  }
  process.stdout.write(`${chalk.gray('›')} ${chalk.gray(message)}\n`)
}

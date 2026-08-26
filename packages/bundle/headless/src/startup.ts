/**
 * The one-shot app's command-line provider: it parses the task positional, the
 * named-session flags, and `--help`, then publishes
 * {@link HEADLESS_STARTUP_SERVICE}. The runner is an ordinary consumer whose
 * lazy config waits for that service.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { OutputFormat } from './index.ts'
import { assertValidSessionName } from '@deepseek-ai/dsh-named-sessions'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for. */
  task: string
  /** The `--session-name` value; absent for anonymous one-shot runs. */
  sessionName?: string
  /** The `--format` value; absent lets the runner schema default to `text`. */
  format?: OutputFormat
}

/**
 * This app's command: the task positional, its flags, descriptions, and help.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .option('--session-name <name>', 'create once and then resume this durable named session')
    .option('--format <format>', 'output format: text (default) or json (NDJSON text parts)')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"     answer one task and exit
`)
}

/**
 * Parse and provide the one-shot task as an ordinary Cordis service. The
 * command's action publishes the parsed values; a missing or whitespace-only
 * task, a malformed `--session-name`, or an unknown `--format` is a usage
 * error, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    const values: HeadlessStartupValues = { task }
    const opts = program.opts<{ sessionName?: string; format?: string }>()
    const sessionName = opts.sessionName
    if (sessionName !== undefined) {
      try {
        assertValidSessionName(sessionName)
      } catch {
        // The validator's message is config-plane wording; the command line
        // refuses the same value as usage text instead.
        program.error(`error: invalid --session-name "${sessionName}": use 1-64 characters of A-Za-z0-9._- starting with A-Za-z0-9`)
      }
      values.sessionName = sessionName
    }
    const format = opts.format
    if (format !== undefined) {
      if (format === 'text' || format === 'json') {
        values.format = format
      } else {
        program.error(`error: invalid --format "${format}": expected text or json`)
      }
    }
    ctx.provide(HEADLESS_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}

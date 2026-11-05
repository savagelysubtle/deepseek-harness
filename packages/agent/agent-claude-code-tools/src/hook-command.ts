/**
 * Builds the PreToolUse hook command line and the hook settings entry. Every interpolated value is
 * checked against a strict grammar and then shell-quoted; nothing is concatenated raw.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/hook-command
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSeatName, isSha256 } from './grammar.ts'

/** Seconds the CLI waits for the hook before treating it as failed. */
export const HOOK_TIMEOUT_SECONDS = 60

/** The tool names the seat-guard hook fires for: every native file tool and every dsh MCP tool. */
export const GUARD_MATCHER = 'Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|mcp__dsh__.*'

/** Characters a path in the command line may use; nothing a shell or `env` could interpret. */
const COMMAND_PATH = /^\/[A-Za-z0-9_@+=:,./-]*$/

/** Values the command line is built from. */
export interface HookCommandInput {
  /** Absolute path of the attested node binary. */
  readonly nodePath: string
  /** Absolute path of the attested guard script: the built `lib/seat-guard.js` (default, see {@link guardScriptPath}). */
  readonly guardPath?: string
  /** Allow a `.ts` guard (in-workspace tests only: Node refuses to strip types under `node_modules`). */
  readonly allowSourceGuard?: boolean
  /** Absolute path of the policy file. */
  readonly policyPath: string
  /** SHA-256 of the policy file content. */
  readonly sha256: string
  /** The seat's bare name. */
  readonly seat: string
}

/** One settings hook group (`matcher` plus command handlers). */
export interface HookGroup {
  /** Tool-name matcher. */
  readonly matcher?: string
  /** Command handlers. */
  readonly hooks: readonly { readonly type: 'command'; readonly command: string; readonly timeout?: number }[]
}

/**
 * Where the guard script lives in this package: the bundled plain-JavaScript `lib/seat-guard.js` that
 * ships in the published files, or (when explicitly requested, for tests inside the workspace) the
 * TypeScript source `src/bin.ts`.
 * @param kind - `built` (default) or `source`.
 * @returns the absolute path.
 */
export function guardScriptPath(kind: 'built' | 'source' = 'built'): string {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  return kind === 'built' ? join(root, 'lib', 'seat-guard.js') : join(root, 'src', 'bin.ts')
}

/**
 * Single-quote a value for a POSIX shell.
 * @param value - raw text.
 * @returns a quoted token.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`
}

function assertCommandPath(label: string, value: string): string {
  if (!COMMAND_PATH.test(value) || resolve(value) !== value) {
    throw new Error(`agent-claude-code-tools: ${label} ${JSON.stringify(value)} is not an absolute, canonical path of safe characters`)
  }
  return value
}

function assertGuardPath(path: string, allowSource: boolean): string {
  if (!allowSource && path.endsWith('.ts')) {
    throw new Error(`agent-claude-code-tools: guard ${JSON.stringify(path)} is TypeScript source, which cannot run from an installed package; use the built lib/seat-guard.js`)
  }
  return assertCommandPath('guard path', path)
}

/**
 * Build the hook command line:
 * `env -u NODE_OPTIONS <node> <guard> --policy <path> --sha256 <hex> --seat <name>`.
 * @param input - the values to interpolate.
 * @returns the command string.
 * @throws when any value fails its grammar, or the guard is a `.ts` file without `allowSourceGuard`.
 */
export function buildHookCommand(input: HookCommandInput): string {
  if (!isSeatName(input.seat)) throw new Error(`agent-claude-code-tools: seat ${JSON.stringify(input.seat)} is not a valid seat name`)
  if (!isSha256(input.sha256)) throw new Error('agent-claude-code-tools: policy sha256 is not a lower-case hex digest')
  return [
    'env', '-u', 'NODE_OPTIONS',
    shellQuote(assertCommandPath('node path', input.nodePath)),
    shellQuote(assertGuardPath(input.guardPath ?? guardScriptPath(), input.allowSourceGuard === true)),
    '--policy', shellQuote(assertCommandPath('policy path', input.policyPath)),
    '--sha256', input.sha256,
    '--seat', input.seat,
  ].join(' ')
}

/**
 * The PreToolUse group that runs the seat guard.
 * @param command - from {@link buildHookCommand}.
 * @returns the group with the matcher and the 60 second timeout.
 */
export function guardHookGroup(command: string): HookGroup {
  return { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] }
}

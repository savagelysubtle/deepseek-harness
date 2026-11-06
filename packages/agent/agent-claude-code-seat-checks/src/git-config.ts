/**
 * Reading a clone's `.git/config` through git itself, fail closed. Git parses the file (`--list -z --no-includes`);
 * this module spawns it with a scrubbed environment, an absolute binary, cwd `/`, a timeout and an output cap, and
 * grants only a run that returned no error, no signal, status 0, empty stderr and a fully parsed NUL-terminated
 * output. Every other outcome throws a typed {@link CloneCheckError}.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/git-config
 */

import { spawnSync } from 'node:child_process'
import { CloneCheckError } from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { ConfigRecord } from './allowlist.ts'
import { GIT_MAX_OUTPUT, GIT_TIMEOUT_MS, LOG_PREFIX, SCRUBBED_GIT_ENV } from './limits.ts'

/** What one git run reported, normalised from `spawnSync`. */
export interface GitRunResult {
  /** The spawn error, if the run failed to start, timed out or overflowed its buffer. */
  readonly error: (Error & { readonly code?: string }) | undefined
  /** The signal that ended the run, or `null`. */
  readonly signal: NodeJS.Signals | null
  /** The exit status, or `null` when a signal ended the run. */
  readonly status: number | null
  /** Captured stdout. */
  readonly stdout: string
  /** Captured stderr. */
  readonly stderr: string
}

/** Runs git with the given arguments; tests inject a fake. */
export type RunGit = (gitPath: string, args: readonly string[]) => GitRunResult

/** The remedy shown when git itself cannot be used. */
const GIT_REMEDY = `Remedy: install git at /usr/bin/git or set gitPath in the agent-claude-code-seat-checks row; see the host log lines starting ${LOG_PREFIX}`

/**
 * Build a refusal.
 * @param seat - the seat's bare name.
 * @param code - the machine-readable code.
 * @param what - what is wrong, naming the key or path involved.
 * @param remedy - the remedy sentence.
 * @returns the error to throw.
 */
export function refusal(seat: string, code: string, what: string, remedy: string): CloneCheckError {
  return new CloneCheckError(seat, code, `${what}. ${remedy}`)
}

/**
 * Run the real git: scrubbed environment, cwd `/`, no shell, timeout, output cap, SIGKILL on timeout.
 * @param gitPath - absolute path of git.
 * @param args - git arguments.
 * @returns the normalised result.
 */
export const realRunGit: RunGit = (gitPath, args) => {
  const result = spawnSync(gitPath, [...args], {
    cwd: '/',
    env: { ...SCRUBBED_GIT_ENV },
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  })
  return { error: result.error, signal: result.signal, status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '' }
}

/** The code a spawn error maps to. */
function spawnErrorCode(error: Error & { readonly code?: string }): string {
  switch (error.code) {
    case 'ENOENT': return 'git-missing'
    case 'EACCES':
    case 'EPERM': return 'eacces'
    case 'ETIMEDOUT': return 'timeout'
    case 'ENOBUFS': return 'enobufs'
    default: return 'git-error'
  }
}

/**
 * Split `git config --list -z` output into records. Each record is NUL-terminated; the key ends at the first
 * newline (a key written without `=` has none), and a value may itself hold newlines.
 * @param seat - the seat's bare name, for the refusal.
 * @param stdout - git's output.
 * @returns the records.
 * @throws {CloneCheckError} with code `parse` when the output is empty, not NUL-terminated, not valid text or holds an empty key.
 */
export function parseConfigRecords(seat: string, stdout: string): ConfigRecord[] {
  if (stdout === '' || !stdout.endsWith('\0')) {
    throw refusal(seat, 'parse', 'git config printed output that is empty or not NUL-terminated', GIT_REMEDY)
  }
  if (stdout.includes('�')) throw refusal(seat, 'parse', 'git config printed bytes that are not valid UTF-8', GIT_REMEDY)
  const records: ConfigRecord[] = []
  for (const record of stdout.slice(0, -1).split('\0')) {
    const newline = record.indexOf('\n')
    const key = newline === -1 ? record : record.slice(0, newline)
    if (key === '') throw refusal(seat, 'parse', 'git config printed a record with an empty key', GIT_REMEDY)
    records.push({ key, value: newline === -1 ? undefined : record.slice(newline + 1) })
  }
  return records
}

/**
 * Read a config file through git, fail closed.
 * @param seat - the seat's bare name, for refusals.
 * @param gitPath - absolute path of git.
 * @param configPath - the file to list (already checked to be a small regular file).
 * @param run - how git is run.
 * @returns the parsed records.
 * @throws {CloneCheckError} on any outcome that is not a clean, fully parsed run.
 */
export function readGitConfig(seat: string, gitPath: string, configPath: string, run: RunGit): ConfigRecord[] {
  const result = run(gitPath, ['config', '--file', configPath, '--list', '-z', '--no-includes'])
  if (result.error !== undefined) {
    throw refusal(seat, spawnErrorCode(result.error), `git could not read ${configPath} (${result.error.code ?? result.error.message})`, GIT_REMEDY)
  }
  if (result.signal !== null) throw refusal(seat, 'git-signal', `git was ended by ${result.signal} while reading ${configPath}`, GIT_REMEDY)
  if (result.status !== 0) throw refusal(seat, 'git-exit', `git exited with status ${String(result.status)} reading ${configPath}`, GIT_REMEDY)
  if (result.stderr !== '') throw refusal(seat, 'git-stderr', `git printed errors reading ${configPath}`, GIT_REMEDY)
  return parseConfigRecords(seat, result.stdout)
}

/**
 * The `rules-hooks` clone check. A coder clone must carry NO host-executable git hook state: the
 * whole `.git` is
 * read-only inside the sandbox, and host git runs with hooks disabled, so nothing is fenced here;
 * the check asserts
 * absence. It is provisioning hygiene and drift detection, defence in depth behind the guard and
 * the sandbox, NOT a
 * security boundary. It never installs or enforces `reference-transaction` (that fence is owned by
 * `~/.agents`).
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/clone-state
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CloneCheckError } from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { CloneCheckContext } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { checkConfigRecords } from './allowlist.ts'
import { fingerprintClone, realCloneFs } from './fingerprint.ts'
import type { CloneFs } from './fingerprint.ts'
import { printableName, readGitConfig, realRunGit, refusal } from './git-config.ts'
import type { RunGit } from './git-config.ts'
import { FORBIDDEN_GIT_ENTRIES, GIT_CANDIDATES, HOOK_SAMPLE_SUFFIX, LOG_PREFIX, MAX_CONFIG_BYTES,
  SCRUB_REMEDY } from './limits.ts'

/** What an inspection needs. */
export interface CloneInspectDeps {
  /** Absolute path of git. */
  readonly gitPath: string
  /** How git is run. */
  readonly run: RunGit
  /** Filesystem calls. */
  readonly fs: CloneFs
  /**
   * Exact remote urls or `/`-suffixed prefixes a remote url must match; empty refuses every remote
   * url.
   */
  readonly remoteUrlAllow: readonly string[]
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function fsRefusal(seat: string, path: string, error: unknown): CloneCheckError {
  const code = errnoCode(error)
  if (code === 'ENOENT') return refusal(seat, 'enoent', `${path} does not exist`, SCRUB_REMEDY)
  if (code === 'EACCES' || code === 'EPERM') return refusal(seat, 'eacces',
    `${path} cannot be read (${code})`, SCRUB_REMEDY)
  return refusal(seat, 'fs-error', `${path} cannot be inspected (${code ?? 'unknown error'})`,
    SCRUB_REMEDY)
}

function lstatOrAbsent(seat: string, path: string, fs: CloneFs,
  shown = path): ReturnType<CloneFs['lstat']> | undefined {
  try {
    return fs.lstat(path)
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw fsRefusal(seat, shown, error)
  }
}

function checkHooks(seat: string, hooks: string, fs: CloneFs): void {
  const stat = lstatOrAbsent(seat, hooks, fs)
  if (stat === undefined) return
  if (!stat.isDirectory()) throw refusal(seat, 'hook-entry', `${hooks} is not a real directory`,
    SCRUB_REMEDY)
  let names: string[]
  try {
    names = fs.readdir(hooks)
  } catch (error: unknown) {
    throw fsRefusal(seat, hooks, error)
  }
  for (const name of names) {
    const path = join(hooks, name)
    const shown = `${hooks}/${printableName(name)}`
    const entry = lstatOrAbsent(seat, path, fs, shown)
    if (entry === undefined || !entry.isFile() || !name.endsWith(HOOK_SAMPLE_SUFFIX)) {
      throw refusal(seat, 'hook-entry',
        `${shown} is a host-executable hook candidate (only regular *.sample files are allowed)`,
        SCRUB_REMEDY)
    }
  }
}

/**
 * Inspect a clone, uncached. Throws on the first problem.
 * @param seat - the seat's bare name, for refusals.
 * @param cwd - the clone's canonical working directory.
 * @param deps - git path, how git is run, filesystem calls.
 * @throws {CloneCheckError} when the clone carries hook state, a redirect or a config key off the
 *   allowlist,
 * or when any step cannot be completed.
 */
export function inspectCloneState(seat: string, cwd: string, deps: CloneInspectDeps): void {
  const git = join(cwd, '.git')
  const root = lstatOrAbsent(seat, git, deps.fs)
  if (root === undefined) throw refusal(seat, 'enoent', `${git} does not exist (not a clone)`,
    SCRUB_REMEDY)
  if (!root.isDirectory()) throw refusal(seat, 'git-not-directory',
    `${git} is not a real directory`, SCRUB_REMEDY)
  for (const entry of FORBIDDEN_GIT_ENTRIES) {
    const path = join(git, entry)
    if (lstatOrAbsent(seat, path, deps.fs) !== undefined) {
      throw refusal(seat, 'forbidden-entry', `${path} must not exist in a coder clone`,
        SCRUB_REMEDY)
    }
  }
  checkHooks(seat, join(git, 'hooks'), deps.fs)
  const configPath = join(git, 'config')
  let config: ReturnType<CloneFs['lstat']>
  try {
    config = deps.fs.lstat(configPath)
  } catch (error: unknown) {
    throw fsRefusal(seat, configPath, error)
  }
  if (!config.isFile() || config.nlink !== 1n) {
    throw refusal(seat, 'config-not-regular',
      `${configPath} must be a regular file with one link (not a symlink or hardlink)`,
      SCRUB_REMEDY)
  }
  if (config.size > BigInt(MAX_CONFIG_BYTES)) {
    throw refusal(seat, 'config-too-large',
      `${configPath} is larger than ${MAX_CONFIG_BYTES} bytes`, SCRUB_REMEDY)
  }
  // Accepted gap: the config could be swapped between the lstat above and git opening it; see
  // readGitConfig.
  const violation = checkConfigRecords(readGitConfig(seat, deps.gitPath, configPath, deps.run),
    deps.remoteUrlAllow)
  if (violation !== undefined) {
    throw refusal(seat, violation.code,
      `${configPath}: key ${printableName(violation.key)}: ${violation.reason}`, SCRUB_REMEDY)
  }
}

/** The per-query clone check plus its off switch. */
export interface CloneChecker {
  /** The function registered into the clone-check registry. */
  readonly check: (ctx: CloneCheckContext) => void
  /** After this the check refuses every query (the registry cannot unregister). */
  readonly dispose: () => void
}

/**
 * Build the per-query check. It remembers, per seat, the cwd and fingerprint of the last clean
 * inspection and
 * re-runs the git parse only at the first query, on a cwd change or when the fingerprint changed. A
 * refusal is never remembered.
 * @param deps - git path, how git is run, filesystem calls.
 * @returns the check and its dispose function.
 */
export function createCloneChecker(deps: CloneInspectDeps): CloneChecker {
  const clean = new Map<string, { readonly cwd: string; readonly fingerprint: string }>()
  let disposed = false
  return {
    check: ({ seat, cwd }) => {
      if (disposed) {
        throw refusal(seat, 'disposed', 'the clone hook check was unloaded',
          `Remedy: restart the host; see the host log lines starting ${LOG_PREFIX}`)
      }
      const fingerprint = fingerprintClone(cwd, deps.fs)
      const last = clean.get(seat)
      if (last !== undefined && last.cwd === cwd && last.fingerprint === fingerprint) return
      clean.delete(seat)
      inspectCloneState(seat, cwd, deps)
      clean.set(seat, { cwd, fingerprint })
    },
    dispose: () => { disposed = true },
  }
}

/** Options of {@link assertCloneHookState}. */
export interface AssertCloneHookOptions {
  /** Absolute path of git; default the first of /usr/bin/git, /usr/local/bin/git that exists. */
  readonly gitPath?: string
  /** Seat name used in the refusal; default `host-git`. */
  readonly seat?: string
  /** How git is run (tests). */
  readonly run?: RunGit
  /** Filesystem calls (tests). */
  readonly fs?: CloneFs
  /**
   * Remote urls the clone may carry (exact, or prefixes ending in `/`); default empty, which
   * refuses every remote url.
   */
  readonly remoteUrlAllow?: readonly string[]
  /** Whether a path exists, for the git lookup (tests). */
  readonly exists?: (path: string) => boolean
}

/**
 * The guard for host-side git: call it before EVERY host-side git command on a coder clone (same
 * checks as the
 * per-query check, uncached). Host commands must also use `git -c core.fsmonitor=false -c
 * core.hooksPath=/dev/null`
 * with `GIT_CONFIG_NOSYSTEM=1`, and never `git add -A` (a seat can plant a nested
 * `sub/.git/config`).
 * @param cwd - the clone's canonical working directory.
 * @param options - overrides.
 * @throws {CloneCheckError} when the clone is not clean or git cannot be used.
 */
export function assertCloneHookState(cwd: string, options: AssertCloneHookOptions = {}): void {
  const seat = options.seat ?? 'host-git'
  const exists = options.exists ?? existsSync
  const gitPath = options.gitPath ?? GIT_CANDIDATES.find(candidate => exists(candidate))
  if (gitPath === undefined) {
    throw refusal(seat, 'git-missing', `git was not found (looked in ${GIT_CANDIDATES.join(', ')})`,
      `Remedy: install git or pass gitPath; see the host log lines starting ${LOG_PREFIX}`)
  }
  inspectCloneState(seat, cwd, {
    gitPath,
    run: options.run ?? realRunGit,
    fs: options.fs ?? realCloneFs,
    remoteUrlAllow: options.remoteUrlAllow ?? [],
  })
}

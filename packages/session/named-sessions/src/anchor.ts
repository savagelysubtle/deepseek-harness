/**
 * Project-anchor resolution shared by every consumer that keys durable state
 * on a working directory: the git common directory when the directory belongs
 * to a git repository, the resolved directory itself otherwise. Memory
 * namespaces and named-session ids both hash this value, so every worktree of
 * one repository maps to the same project identity while distinct repositories
 * stay distinct.
 * @module @deepseek-ai/dsh-named-sessions/anchor
 */

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Wall-clock bound on one `git rev-parse --git-common-dir` probe, in
 * milliseconds. The probe runs synchronously on session-id derivation and
 * memory-scope resolution paths, so a wedged git must never stall them: past
 * the bound the child is killed and the caller falls back to the directory
 * itself. Fixed rather than configured because the anchor is a consistency
 * primitive, not a tunable; raising it delays every uncached derivation.
 */
export const PROJECT_ANCHOR_GIT_TIMEOUT_MS = 2_000

/**
 * Anchors resolved during this process, keyed by the resolved working
 * directory. Bounded in practice by the number of distinct working
 * directories one process sees; the value is stable per directory, so a
 * stale entry could only differ from a live re-probe by an intervening
 * `.git` replacement, which no supported flow performs.
 */
const anchorCache = new Map<string, string>()

/**
 * Probe the git common directory for one working directory.
 * @param absolute - resolved working directory to probe from.
 * @returns the real path of the common directory, or undefined when the
 *   directory is not inside a git repository, git is unavailable, or the
 *   probe fails for any reason (non-zero exit, timeout, spawn error).
 */
function resolveGitCommonDir(absolute: string): string | undefined {
  try {
    // execFile over exec: the git invocation passes fixed argv, never a
    // shell, so working-directory characters cannot be reinterpreted. The
    // synchronous form keeps every consumer of the anchor synchronous.
    const output = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: absolute,
      encoding: 'utf8',
      timeout: PROJECT_ANCHOR_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    /* v8 ignore next 1 -- git never exits 0 with an empty common-dir print; the guard keeps a stray empty string out of path resolution. */
    if (output === '') return undefined
    // git prints the common directory relative to the cwd at repo root
    // (`.git`) and absolute elsewhere; resolve handles both forms, and the
    // real path makes a symlinked checkout agree with its target.
    return realpathSync(resolve(absolute, output))
  } catch {
    // Any failure (not a repository, git missing, timeout, unreadable cwd)
    // means "no git anchor available"; the caller falls back to the
    // directory itself, which is today's behavior outside a repository.
    return undefined
  }
}

/**
 * Real path of one path, or undefined when it cannot be resolved (absent
 * directory, permission, platform without realpath support).
 * @param path - the path to resolve.
 * @returns the real path, or undefined on any failure.
 */
function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * Resolve the project anchor for one working directory: the real path of the
 * git common directory when the directory belongs to a git repository, else
 * the real path of the directory itself, else its resolved form. Never
 * throws — every resolution failure degrades to the next fallback, so
 * derivation callers cannot fail because the anchor probe did.
 * @param cwd - working directory naming the project; a relative path
 *   resolves against the process working directory.
 * @returns the anchor path to hash wherever a cwd is hashed today.
 */
export function projectAnchor(cwd: string): string {
  const absolute = resolve(cwd)
  const cached = anchorCache.get(absolute)
  if (cached !== undefined) return cached
  const anchor = resolveGitCommonDir(absolute) ?? realPathOrUndefined(absolute) ?? absolute
  anchorCache.set(absolute, anchor)
  return anchor
}

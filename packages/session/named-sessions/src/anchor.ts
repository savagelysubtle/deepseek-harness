/**
 * Project-anchor resolution shared by every consumer that keys durable state
 * on a working directory: the git common directory when the directory
 * belongs to a git repository, the resolved directory itself otherwise.
 * Memory namespaces and named-session ids both hash this value, so every
 * worktree of one repository maps to the same project identity while
 * distinct repositories stay distinct.
 *
 * A second, independent boundary signal overrides that default: a marker
 * file named exactly `.dsh-anchor` (see {@link ANCHOR_MARKER_FILENAME}).
 * Its content is never read or parsed — presence alone means "this
 * directory is its own anchor root", regardless of what git thinks. This is
 * how a directory with no repository of its own can keep an identity
 * separate from an enclosing repository, and how a directory that IS a
 * repository can be addressed by itself rather than by its `.git` path. See
 * {@link resolveAnchor} for the precedence rule between the two signals.
 * @module @deepseek-ai/dsh-named-sessions/anchor
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

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
 * Name of the marker file whose mere presence in a directory declares it its
 * own anchor root. The content is never read — a caller creates it empty —
 * so this constant names the only part of the file that is ever a signal.
 * The caller decides which directories get one; this module has no notion
 * of what a "seat" or an org registry is.
 */
export const ANCHOR_MARKER_FILENAME = '.dsh-anchor'

/**
 * Anchors resolved during this process, keyed by the resolved working
 * directory. Bounded in practice by the number of distinct working
 * directories one process sees; the value is stable per directory, so a
 * stale entry could only differ from a live re-probe by an intervening
 * `.git` replacement or marker-file change, which no supported flow performs.
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
 * Nearest ancestor-or-self of `absolute` that contains an
 * {@link ANCHOR_MARKER_FILENAME} marker. Pure `existsSync` walk upward via
 * `dirname()`, terminating at the filesystem root — no git subprocess, so a
 * caller that never places a marker anywhere pays only cheap stat calls, one
 * per ancestor directory.
 * @param absolute - resolved directory to start the walk from.
 * @returns the marker-bearing directory, or undefined when no ancestor up to
 *   and including the filesystem root contains the marker.
 */
function findMarkerDir(absolute: string): string | undefined {
  let dir = absolute
  for (;;) {
    if (existsSync(join(dir, ANCHOR_MARKER_FILENAME))) return dir
    const parent = dirname(dir)
    // dirname() of the filesystem root returns the root itself; that
    // fixed point is how the walk terminates without a platform-specific
    // "is this the root" check.
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Count of non-empty path segments. Used only to order two paths that are
 * both known to be ancestors-or-self of the same resolved `absolute` (see
 * {@link resolveAnchor}) — under that precondition one is always an
 * ancestor of the other, so segment count is a valid depth order between
 * them. This is not a general path-depth comparator.
 * @param path - an absolute path.
 * @returns the number of non-empty segments.
 */
function segmentCount(path: string): number {
  return path.split(sep).filter(segment => segment !== '').length
}

/**
 * Resolve the project anchor for one already-resolved working directory,
 * combining the git-common-dir signal with the independent marker signal.
 *
 * No marker above `absolute`: byte-identical to the pre-marker behavior —
 * the git common dir, else the directory itself.
 *
 * A marker above `absolute` with no enclosing repository: the marker
 * directory wins outright, since there is nothing to compare it against.
 *
 * A marker above `absolute` AND an enclosing repository: the marker wins
 * only when it is not shallower than the repository's MAIN CHECKOUT ROOT —
 * `dirname(gitCommonDir)`, never `git rev-parse --show-toplevel`. The
 * common dir is the same physical directory from every worktree of one
 * repository, so its parent is worktree-invariant; `--show-toplevel` is
 * not — it returns the CURRENT worktree's own root. Comparing against
 * `--show-toplevel` would let a marker at the main checkout root win when
 * evaluated from the main checkout (tied depth) but lose when evaluated
 * from inside a linked worktree (a deeper path than the worktree's own
 * root), silently splitting a directory's own scratch worktrees off from
 * its own anchor — exactly the regression this comparison exists to avoid.
 * @param absolute - resolved working directory to anchor.
 * @returns the anchor path, following the same never-throws contract as
 *   {@link projectAnchor}.
 */
function resolveAnchor(absolute: string): string {
  const markerDir = findMarkerDir(absolute)
  // Always probed, marker or not: the comparison below needs it whenever a
  // marker is also found, and probing unconditionally keeps this the one
  // and only `resolveGitCommonDir` call per resolution.
  const gitCommonDir = resolveGitCommonDir(absolute)

  if (markerDir === undefined) {
    return gitCommonDir ?? realPathOrUndefined(absolute) ?? absolute
  }

  const markerReal = realPathOrUndefined(markerDir) ?? markerDir
  if (gitCommonDir === undefined) return markerReal

  const gitMainRoot = realPathOrUndefined(dirname(gitCommonDir)) ?? dirname(gitCommonDir)
  // Both markerReal and gitMainRoot are ancestors-or-self of `absolute`, so
  // one is always an ancestor of the other and segment count orders them
  // correctly. A tie means the marker sits exactly at the repository root,
  // and the marker wins.
  return segmentCount(markerReal) >= segmentCount(gitMainRoot) ? markerReal : gitCommonDir
}

/**
 * Resolve the project anchor for one working directory: the real path of a
 * `.dsh-anchor` marker directory or the git common directory — see
 * {@link resolveAnchor} for the precedence rule — falling back to the real
 * path of the directory itself, then its resolved form. Never throws —
 * every resolution failure degrades to the next fallback, so derivation
 * callers cannot fail because the anchor probe did.
 * @param cwd - working directory naming the project; a relative path
 *   resolves against the process working directory.
 * @returns the anchor path to hash wherever a cwd is hashed today.
 */
export function projectAnchor(cwd: string): string {
  const absolute = resolve(cwd)
  const cached = anchorCache.get(absolute)
  if (cached !== undefined) return cached
  const anchor = resolveAnchor(absolute)
  anchorCache.set(absolute, anchor)
  return anchor
}

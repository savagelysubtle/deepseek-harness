/**
 * Project-scope derivation and path jail for the memory seam: every operation
 * resolves its workspace through one slug per project anchor, and every
 * stored path is jailed to that scope before any filesystem call. The slug
 * derives from {@link projectAnchor}, which performs the one git probe this
 * module relies on; the jail stays pure.
 * @module @deepseek-ai/dsh-memory/scope
 */

import { createHash } from 'node:crypto'
import { projectAnchor } from '@deepseek-ai/dsh-named-sessions'

/** Longest accepted relative entry path, in characters. */
export const MAX_ENTRY_PATH_LENGTH = 200

/** Largest storable entry, in UTF-8 bytes; enforced on the complete value. */
export const MAX_ENTRY_BYTES = 262_144

/** Maximum number of entries `list()` returns (whole-result bound). */
export const MAX_LIST_ENTRIES = 1_000

/** Default maximum number of matches one `search()` returns. */
export const DEFAULT_SEARCH_LIMIT = 50

/** Hard ceiling on `search()` results regardless of the requested limit. */
export const MAX_SEARCH_LIMIT = 200

/** Characters a scope directory keeps from the project name; mirrors common munging. */
const UNSAFE_BASENAME = /[^a-zA-Z0-9._-]+/g

/**
 * The readable project name inside one scope slug, taken from the anchor: a
 * standard repository anchors on `<repo>/.git`, so the repository directory
 * names the scope; any other anchor names itself — a bare repository keeps
 * its `name.git` basename, and a non-git directory keeps its own basename,
 * which is the pre-anchor behavior.
 * @param anchor - the resolved project anchor (see {@link projectAnchor}).
 * @returns the anchor's project-directory basename; `project` when the anchor
 *   has no readable directory name.
 */
function anchorProjectName(anchor: string): string {
  const segments = anchor.split(/[\\/]/).filter(Boolean)
  /* v8 ignore next 1 -- the anchor is always an absolute path (resolve or realpath output), so the fallback covers no real anchor. */
  const last = segments.at(-1) ?? 'project'
  return last === '.git' ? segments.at(-2) ?? 'project' : last
}

/**
 * The stable per-project scope name under the memory root:
 * `<project-name>-<6 base36 chars of sha256(project anchor)>`. The anchor is
 * the git common directory when `cwd` belongs to a repository — so every
 * worktree of one repository maps to the same scope and notes follow the
 * repository, not the checkout — and the real path of `cwd` itself outside a
 * repository. The hash keeps two same-named projects distinct directories,
 * like the reference deployment's project slugs.
 * @param cwd - absolute working directory naming the project.
 * @returns the scope directory name.
 */
export function projectSlug(cwd: string): string {
  if (cwd.trim() === '') throw new Error('memory: project cwd must be a non-empty path')
  const anchor = projectAnchor(cwd)
  const safeBasename = anchorProjectName(anchor).replace(UNSAFE_BASENAME, '-').slice(0, 64)
  const digest = createHash('sha256').update(anchor, 'utf8').digest('base64url')
  // base64url uses `-`/`_` beyond alphanumerics; keep only word characters so
  // the slug stays one POSIX-safe segment across every alphabet.
  const suffix = digest.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase()
  return `${safeBasename}-${suffix}`
}

/**
 * Jail one model- or caller-supplied relative path to the scope root.
 * Rejects absolute paths, parent traversal in any segment, backslash or NUL
 * bytes, and over-long names — fail loud with the offending input, because a
 * silently rewritten path would write somewhere the caller did not ask about.
 * @param path - the requested scope-relative path.
 * @returns the normalized path (`a//b/` collapses to `a/b`).
 */
export function jailedScopePath(path: string): string {
  if (path.includes('\0')) throw new Error(`memory: path contains a NUL byte: ${JSON.stringify(path)}`)
  if (path.includes('\\')) throw new Error(`memory: path must use forward slashes: ${JSON.stringify(path)}`)
  if (path.startsWith('/')) throw new Error(`memory: path must be relative to the project scope, got absolute: ${JSON.stringify(path)}`)
  if (path.trim() === '') throw new Error('memory: path must be a non-empty scope-relative path')
  if (path.length > MAX_ENTRY_PATH_LENGTH) {
    throw new Error(`memory: path exceeds ${MAX_ENTRY_PATH_LENGTH} characters`)
  }
  const segments = path.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0) {
    throw new Error('memory: path resolves to no entry (empty path)')
  }
  if (segments.some(segment => segment === '..')) {
    throw new Error(`memory: path escapes the project scope: ${JSON.stringify(path)}`)
  }
  return segments.join('/')
}

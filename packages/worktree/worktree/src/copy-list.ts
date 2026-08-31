/**
 * Copy-list bootstrap: after `git worktree add`, copy the repo-root files a
 * work session needs (v1: `.env`) into the fresh worktree. The list lives in
 * `.worktree-include` at the repository root and uses gitignore syntax; v1
 * honors literal relative paths only and refuses the syntax it cannot honor —
 * a silently skipped entry is a silent fence, leaving work broken later.
 *
 * @module @deepseek-ai/dsh-worktree/copy-list
 */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { WorktreeError } from './errors.ts'

/** Repo-root file listing the paths every new worktree receives. */
export const WORKTREE_INCLUDE_FILENAME = '.worktree-include'

/**
 * Parse `.worktree-include` content into repo-root-relative file paths.
 * Blank lines and `#` comments are skipped. v1 honors literal relative paths
 * only: glob metacharacters (`*`, `?`, `[`), negation (`!`), a trailing
 * directory slash, an absolute path, or a `..` segment fails loud with the
 * offending line number, instead of copying less than the list promises.
 * @param content - raw `.worktree-include` text.
 * @returns repo-root-relative file paths, in list order, deduplicated.
 */
export function parseCopyList(content: string): readonly string[] {
  const entries: string[] = []
  const seen = new Set<string>()
  const lines = content.split(/\r?\n/)
  for (const [offset, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (/[*?[\]]/.test(line)) {
      throw new WorktreeError(
        `${WORKTREE_INCLUDE_FILENAME} line ${offset + 1}: glob patterns are not supported yet (${JSON.stringify(line)}); list the literal path`,
        'COPY_LIST_UNSUPPORTED',
      )
    }
    if (line.startsWith('!')) {
      throw new WorktreeError(
        `${WORKTREE_INCLUDE_FILENAME} line ${offset + 1}: negation is not supported (${JSON.stringify(line)})`,
        'COPY_LIST_UNSUPPORTED',
      )
    }
    if (line.endsWith('/')) {
      throw new WorktreeError(
        `${WORKTREE_INCLUDE_FILENAME} line ${offset + 1}: directory entries are not supported yet (${JSON.stringify(line)}); list files`,
        'COPY_LIST_UNSUPPORTED',
      )
    }
    const withoutAnchor = line.startsWith('/') ? line.slice(1) : line
    if (isAbsolute(withoutAnchor) || withoutAnchor.length === 0) {
      throw new WorktreeError(
        `${WORKTREE_INCLUDE_FILENAME} line ${offset + 1}: entry must be a repo-root-relative file path (${JSON.stringify(line)})`,
        'COPY_LIST_UNSUPPORTED',
      )
    }
    const segments = withoutAnchor.split('/')
    if (segments.includes('..')) {
      throw new WorktreeError(
        `${WORKTREE_INCLUDE_FILENAME} line ${offset + 1}: entry must stay inside the repository (${JSON.stringify(line)})`,
        'COPY_LIST_UNSUPPORTED',
      )
    }
    const normalized = posix.join(...segments)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      entries.push(normalized)
    }
  }
  return entries
}

/**
 * Read the repository's copy list. A missing `.worktree-include` copies
 * nothing — that is the documented default, observable in the repository
 * itself, not a skipped entry.
 * @param repoRoot - absolute path of the main checkout.
 * @returns parsed entries; empty when the list file does not exist.
 */
export function readCopyList(repoRoot: string): readonly string[] {
  const listPath = join(repoRoot, WORKTREE_INCLUDE_FILENAME)
  let content: string
  try {
    content = readFileSync(listPath, 'utf8')
  } catch (error: unknown) {
    // Only ENOENT means "no list"; every other read failure is a real
    // misconfiguration the caller must see rather than an empty copy set.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parseCopyList(content)
}

/**
 * Copy every listed repo-root file into the same relative path under the
 * worktree, creating parent directories. A listed file that does not exist at
 * the repo root fails loud: the list is the promise that these files reach
 * every worktree.
 * @param repoRoot - absolute path of the main checkout.
 * @param worktreePath - absolute path of the freshly created worktree.
 * @param entries - repo-root-relative file paths from {@link readCopyList}.
 * @returns the copied relative paths, in copy order.
 * @throws WorktreeError with code `COPY_SOURCE_MISSING` when a listed file is absent.
 */
export function copyListEntries(repoRoot: string, worktreePath: string, entries: readonly string[]): readonly string[] {
  const copied: string[] = []
  for (const entry of entries) {
    const source = join(repoRoot, ...entry.split('/'))
    const destination = join(worktreePath, ...entry.split('/'))
    try {
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
    } catch (error: unknown) {
      // A listed-but-missing source is a broken copy-list promise; every
      // other copy failure surfaces unchanged with its own reason.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorktreeError(
          `${WORKTREE_INCLUDE_FILENAME} lists ${JSON.stringify(entry)} but the file does not exist at the repository root`,
          'COPY_SOURCE_MISSING',
        )
      }
      throw error
    }
    copied.push(entry)
  }
  return copied
}

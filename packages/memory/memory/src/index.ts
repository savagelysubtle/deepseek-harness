/**
 * Service Definition for the project-scoped memory seam (`ctx.memory`):
 * durable plain-markdown notes per project, co-editable by humans and
 * agents. Storage is a capability of the harness home (`memory/` by default),
 * one directory per project anchor; content reaches a model only when that
 * seat explicitly reads or searches it — memory is a tool call, not an
 * injection.
 * @module @deepseek-ai/dsh-memory
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryEntry, MemoryMatch, MemoryWriteResult } from './types.ts'

export type { MemoryEntry, MemoryMatch, MemoryWriteResult } from './types.ts'
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_ENTRY_BYTES,
  MAX_ENTRY_PATH_LENGTH,
  MAX_LIST_ENTRIES,
  MAX_SEARCH_LIMIT,
  jailedScopePath,
  projectSlug,
} from './scope.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/**
 * Abstract memory service. Providers implement the four operations over one
 * storage root; every operation resolves the project scope from the caller's
 * absolute `cwd` through the project anchor, so two repositories never share
 * notes, every worktree of one repository shares one scope, and the scope
 * persists across every session, restart, and seat.
 */
export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  /**
   * Read one entry's full text.
   * @param cwd - absolute working directory naming the project scope.
   * @param path - scope-relative POSIX path; jailed before any I/O.
   * @returns the file content verbatim, frontmatter included.
   */
  abstract read(cwd: string, path: string): Promise<string>

  /**
   * Create or replace one entry atomically enough for human co-editors:
   * temp-file plus rename inside the target directory, so a reader never sees
   * a torn write.
   * @param cwd - absolute working directory naming the project scope.
   * @param path - scope-relative POSIX path; missing directories are created.
   * @param content - complete replacement text (UTF-8).
   * @returns the normalized path and stored byte size.
   */
  abstract write(cwd: string, path: string, content: string): Promise<MemoryWriteResult>

  /**
   * List every entry in the project scope, recursive, sorted by path.
   * @param cwd - absolute working directory naming the project scope.
   * @returns all entries with their byte sizes.
   */
  abstract list(cwd: string): Promise<MemoryEntry[]>

  /**
   * Case-insensitive substring search across the scoped entries' lines.
   * Empty files and oversized skips are silent; results are bounded by
   * {@linkcode MAX_SEARCH_LIMIT} regardless of the requested limit.
   * @param cwd - absolute working directory naming the project scope.
   * @param query - substring to find; empty queries reject.
   * @param limit - maximum matches to return (default {@link DEFAULT_SEARCH_LIMIT}).
   * @returns ordered by path, then line number.
   */
  abstract search(cwd: string, query: string, limit?: number): Promise<MemoryMatch[]>
}

/**
 * Client-safe type surface of the memory seam. Types only — no runtime code.
 * @module @deepseek-ai/dsh-memory/types
 */

/** One stored memory entry as `list()` reports it. */
export interface MemoryEntry {
  /** Scope-relative POSIX path with forward slashes (`todo/auth.md`). */
  readonly path: string
  /** UTF-8 byte size of the stored file. */
  readonly bytes: number
}

/** One search hit inside the scoped tree. */
export interface MemoryMatch {
  /** Scope-relative path of the matching entry. */
  readonly path: string
  /** 1-based line number of the first match on that line. */
  readonly line: number
  /** The matched line, trimmed and clipped to the excerpt budget. */
  readonly excerpt: string
}

/** Result of one committed write. */
export interface MemoryWriteResult {
  /** Scope-relative path written (normalized form of the requested path). */
  readonly path: string
  /** Stored UTF-8 byte size. */
  readonly bytes: number
  /**
   * Present only when this write replaced an existing entry at the same
   * path: that entry's size and last-modified time, before its content was
   * moved into a bounded retained-version history rather than destroyed.
   * Absent when the path was previously unused.
   */
  readonly replaced?: {
    /** UTF-8 byte size of the content that was replaced. */
    readonly bytes: number
    /** ISO-8601 timestamp of the replaced content's last modification. */
    readonly modifiedAt: string
  }
}

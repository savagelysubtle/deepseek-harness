/**
 * Tools settings page store: the live `mcp/status` roster, kept current by
 * an explicit `load()` (mount + Refresh) and by folding `mcp/status-changed`
 * push updates in place. The Host stays the single fact source for the
 * roster; per-row action state (busy/error for Authorize, Reconnect,
 * Enable/Disable) is component-local, not stored here — see
 * `ToolsSection.tsx`.
 */

import type { McpServerStatus } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Page snapshot. */
export interface ToolsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level action failures stay local to the row. */
  error: string | null
  /** Every registered MCP server's current status, in Host registration order. */
  rows: readonly McpServerStatus[]
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The wire face this store's `load()` reads through (unwraps `RemoteResult` and throws on failure). */
export interface McpStatusReader {
  status: () => Promise<McpServerStatus[]>
}

/** The Tools settings page controller (one per settings surface). */
export class McpToolsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ToolsSettingsState> = createSnapshotStore<ToolsSettingsState>({
    status: 'idle', error: null, rows: [],
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param remote - the wire face `load()` reads the full roster through.
   */
  constructor(private readonly remote: McpStatusReader) {}

  /**
   * Refresh the whole roster. A failure keeps the last good rows and
   * surfaces the error; a stale response (superseded by a newer `load()`)
   * is dropped.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let rows: McpServerStatus[]
    try {
      rows = await this.remote.status()
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = messageOf(error)
      })
      return
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.rows = rows
    })
  }

  /**
   * Fold one `mcp/status-changed` push into the roster: replace the matching
   * row, append it when the server was not previously listed (e.g. the
   * Loader just activated it), or drop it when the push carries `removed`
   * (the mount left the profile entirely — a stronger signal than
   * `disabled`, which still lists the server). Never clears the whole-load
   * error or busy status by itself — a push can arrive mid-`load()` and the
   * next `load()` resolution still wins.
   * @param next - the server's new point-in-time status, or a removal marker.
   */
  applyStatus(next: McpServerStatus): void {
    this.store.update((s) => {
      const index = s.rows.findIndex(row => row.serverName === next.serverName)
      if (next.removed === true) {
        if (index !== -1) s.rows = s.rows.filter(row => row.serverName !== next.serverName)
        return
      }
      if (index === -1) {
        s.rows = [...s.rows, next]
        return
      }
      const rows = [...s.rows]
      rows[index] = next
      s.rows = rows
    })
  }
}

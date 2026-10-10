/**
 * Project-wide MCP attention store: the small slice of `mcp/status` the
 * in-chat Tools banner needs — which servers are stuck in
 * `needs-authorization` or have `gave-up` reconnecting — loaded once and kept
 * current by `mcp/status-changed`. Deliberately NOT session-scoped: a
 * server's auth state is a Host-wide fact (one connection supervisor per
 * configured server), not a per-conversation one, so one store instance
 * serves every session the resident shell ever renders.
 *
 * The plan's "intersect with the active session's tool roster" refinement is
 * NOT implemented here: the browser has no per-session tool-roster projection
 * to intersect against (see the apply.ts wiring note), so the banner names
 * every affected server regardless of which session is open. Flagged for the
 * architect/manager in the implementing report.
 *
 * @module @deepseek-ai/dsh-client-ui-conversation/mcp-status-store
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { McpServerState, McpServerStatus } from '@deepseek-ai/dsh-mcp-client/status'

/** The two states the Tools banner names; every other state stays quiet. */
const ATTENTION_STATES: ReadonlySet<McpServerState> = new Set(['needs-authorization', 'gave-up'])

/** One attention-worthy server, stripped to what the banner renders. */
export interface McpAttentionStatus {
  readonly serverName: string
  readonly state: 'needs-authorization' | 'gave-up'
}

function isAttentionState(state: McpServerState): state is McpAttentionStatus['state'] {
  return ATTENTION_STATES.has(state)
}

function toAttention(statuses: Iterable<McpServerStatus>): readonly McpAttentionStatus[] {
  const attention: McpAttentionStatus[] = []
  for (const status of statuses) {
    if (isAttentionState(status.state)) attention.push({ serverName: status.serverName, state: status.state })
  }
  // Stable order (serverName) so the banner's rendered list and its dismiss
  // signature never reorder across an unrelated status change.
  return attention.sort((a, b) => a.serverName.localeCompare(b.serverName))
}

/** The one `mcp/status` method this store calls; narrowed so tests fake it without the generated Typert client. */
export interface McpStatusRemote {
  status(): Promise<{ ok: true; value: McpServerStatus[] } | { ok: false; error: { message: string } }>
}

/**
 * Loads `mcp/status` once (`load`) and folds every forwarded
 * `mcp/status-changed` event into the same live set (`apply`) — merge by
 * `serverName`; a status carrying `removed: true` (the mount left the
 * profile) drops that server from the set instead of merging it in.
 */
export class McpAttentionStore {
  /** The live, sorted set of attention-worthy servers; subscribe for the Tools banner's render input. */
  readonly store: ObservableSnapshot<readonly McpAttentionStatus[]> & {
    set(next: readonly McpAttentionStatus[]): void
  } = createSnapshotStore<readonly McpAttentionStatus[]>([])

  private readonly all = new Map<string, McpServerStatus>()

  /**
   * @param getRemote - resolves the `mcp/status` Remote face on every call
   *   (`() => ctx.get('remote.mcp')` in production, not the `ctx.remote.mcp`
   *   property chain — see apply.ts's wiring note), NOT a captured snapshot:
   *   this package does not declare `'remote.mcp'` in its own `inject` array
   *   (blocking the whole conversation plugin on a peripheral banner's
   *   Remote namespace would be the wrong trade), so the namespace may still
   *   be `undefined` at construction time and only become defined later once
   *   the host coder's aggregator mount lands. Re-resolving on every `load()`
   *   call picks that up without a restart.
   */
  constructor(private readonly getRemote: () => McpStatusRemote | undefined) {}

  /**
   * Load every server's current status once; a failed or not-yet-mounted
   * load leaves the store at its last-known set rather than throwing into an
   * unhandled rejection.
   */
  async load(): Promise<void> {
    const remote = this.getRemote()
    if (remote === undefined) return
    try {
      const result = await remote.status()
      if (!result.ok) return
      this.all.clear()
      for (const status of result.value) {
        if (status.removed === true) continue
        this.all.set(status.serverName, status)
      }
      this.publish()
    } catch {
      // Last-known set stands; `mcp/status-changed` or a later load() call
      // (once the mount lands) is the recovery path.
    }
  }

  /**
   * Fold one forwarded `mcp/status-changed` event into the live set. A
   * status carrying `removed: true` (the mount left the profile) drops that
   * server from the set rather than merging it in — the banner stops naming
   * it and its dismiss signature changes accordingly.
   *
   * @param status - the server's latest status, as forwarded by the host's `mcp/status-changed` event.
   */
  apply(status: McpServerStatus): void {
    if (status.removed === true) {
      this.all.delete(status.serverName)
    } else {
      this.all.set(status.serverName, status)
    }
    this.publish()
  }

  private publish(): void {
    this.store.set(toAttention(this.all.values()))
  }
}

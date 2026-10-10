/**
 * Shared wire contract for the mcp status Remote namespace: the RPC/event
 * names, the `mcp/status-changed` Cordis `Events` augmentation, and
 * `authorize-start`'s result shape. `McpServerState`/`McpServerStatus`
 * themselves stay defined in `@deepseek-ai/dsh-mcp-client/status` — that
 * package's `ConnectionHandle.status()` returns them directly, and this
 * package only re-exports the TYPES (not a second declaration) so a client
 * importing from either package's `./status` subpath sees the same type.
 * Kept intentionally small and stable — client packages build against these
 * names and shapes directly, so a change here is a cross-package contract
 * change, not a local refactor.
 *
 * @module @deepseek-ai/dsh-mcp-status/status
 */

import type { McpServerStatus } from '@deepseek-ai/dsh-mcp-client/status'

export type { McpServerState, McpServerStatus } from '@deepseek-ai/dsh-mcp-client/status'

/** Typert namespace every Remote method and event below is published under. */
export const MCP_STATUS_NAMESPACE = 'mcp'

/** `@Remote` export name for {@link MCP_STATUS_ENDPOINT}: list every registered server's current status. */
export const MCP_STATUS_METHOD = 'status'
/** `@Remote` export name for {@link MCP_AUTHORIZE_START_ENDPOINT}: begin (or resume) OAuth consent for one server. */
export const MCP_AUTHORIZE_START_METHOD = 'authorize-start'
/** `@Remote` export name for {@link MCP_RECONNECT_ENDPOINT}: manually retry a given-up (or disabled) server now. */
export const MCP_RECONNECT_METHOD = 'reconnect'
/** `@Remote` export name for {@link MCP_SET_ENABLED_ENDPOINT}: persist a plugin mount's enabled flag. */
export const MCP_SET_ENABLED_METHOD = 'set-enabled'

/** Wire endpoint (`<namespace>/<method>`): list every registered server's current status. */
export const MCP_STATUS_ENDPOINT = `${MCP_STATUS_NAMESPACE}/${MCP_STATUS_METHOD}`
/** Wire endpoint: begin (or resume) the OAuth consent flow for one server. */
export const MCP_AUTHORIZE_START_ENDPOINT = `${MCP_STATUS_NAMESPACE}/${MCP_AUTHORIZE_START_METHOD}`
/** Wire endpoint: manually retry a given-up (or disabled) server now. */
export const MCP_RECONNECT_ENDPOINT = `${MCP_STATUS_NAMESPACE}/${MCP_RECONNECT_METHOD}`
/** Wire endpoint: persist a plugin mount's enabled flag via the `cordis.patch.yml` seam. */
export const MCP_SET_ENABLED_ENDPOINT = `${MCP_STATUS_NAMESPACE}/${MCP_SET_ENABLED_METHOD}`
/** Host → client event name: one server's status changed. Forwarded verbatim by the application's Host-event allowlist. */
export const MCP_STATUS_CHANGED_EVENT = 'mcp/status-changed'

/**
 * Wire endpoint names the loopback-only client is privileged to call —
 * mirrors `packages/client/connection/src/index.ts`'s own `PRIVILEGED_METHODS`
 * set, whose string literals are unaffected by which package implements the
 * RPC; kept here too so a reviewer of this package sees the full privileged
 * surface it publishes without having to cross-reference the connection
 * layer. `mcp/status` is deliberately absent — reading status is not
 * privileged, only the three actions below are.
 */
export const MCP_PRIVILEGED_ENDPOINTS: ReadonlySet<string> = new Set([
  MCP_AUTHORIZE_START_ENDPOINT,
  MCP_RECONNECT_ENDPOINT,
  MCP_SET_ENABLED_ENDPOINT,
])

/** Result of {@link MCP_AUTHORIZE_START_ENDPOINT}: the consent URL to open. */
export interface McpAuthorizeStartResult {
  /** The authorization URL the client should open in a new tab/window. */
  consentUrl: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One server's status changed. Forwarded to clients verbatim only once
     * `packages/api/remotes/src/remote-events.ts`'s allowlist names it.
     * @param status - the server's new point-in-time status.
     * @mode emit
     */
    'mcp/status-changed'(status: McpServerStatus): void
  }
}

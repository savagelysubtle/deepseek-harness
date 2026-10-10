/**
 * Shared wire contract for one MCP server connection's live status: the state
 * enum, the point-in-time status shape, and the RPC/event names the Host's
 * status registry ({@link ../status-registry.ts}) and every client consumer
 * (Settings panel, in-chat notice) agree on. Kept intentionally small and
 * stable — client packages build against these names and shapes directly, so
 * a change here is a cross-package contract change, not a local refactor.
 *
 * `disabled` names the connection supervisor's own `reconnect.enabled: false`
 * policy, NOT whether the plugin mount itself is loaded (the Loader's
 * `entry.disabled`, toggled by `mcp/set-enabled`) — the two "disabled"
 * concepts are deliberately independent; see the status-registry module doc
 * for the full reasoning. A mount the Loader never activated has no live
 * `ConnectionHandle`, but it still appears in `mcp/status` with state
 * `disabled` and `attempts: 0` as long as it is still named (disabled) in
 * the profile's `cordis.patch.yml` — otherwise the Tools panel could disable
 * a server and never have a way to re-enable it. Only a mount no longer
 * named in that file at all (removed from configuration entirely) is
 * missing from `mcp/status`'s listing; see `removed` below for how a client
 * is told to drop that row.
 *
 * @module @deepseek-ai/dsh-mcp-client/status
 */

/** Lifecycle state of one MCP server connection, as observed by the Host. */
export type McpServerState =
  | 'connected'
  | 'connecting'
  | 'needs-authorization'
  | 'gave-up'
  | 'disabled'

/** Point-in-time status for one configured MCP server. */
export interface McpServerStatus {
  /** The server's configured namespace (`Config.serverName`). */
  serverName: string
  /** Current lifecycle state. */
  state: McpServerState
  /** Consecutive failed attempts within the current outage; 0 while `connected` or `disabled`. */
  attempts: number
  /** The server's configured reconnect attempt budget (`ReconnectConfig.maxAttempts`). */
  maxAttempts: number
  /** Last connection error, with absolute paths redacted; absent while healthy or awaiting consent. */
  lastError?: string
  /**
   * Set only on the final `mcp/status-changed` emitted when this server's
   * plugin mount deregisters AND is no longer named in the profile's
   * `cordis.patch.yml` at all — as opposed to merely disabled, which keeps
   * reporting `state: 'disabled'` so a re-enable action stays available. A
   * client should drop this server's row entirely rather than render it.
   * Always absent from `mcp/status`'s own listing, including its
   * synthesized rows for a currently-disabled-but-still-configured mount.
   */
  removed?: boolean
}

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

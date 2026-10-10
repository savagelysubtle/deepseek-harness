/**
 * Shared wire shape for one MCP server connection's live status: the state
 * enum and the point-in-time status shape every client consumer (Settings
 * panel, in-chat notice) and `@deepseek-ai/dsh-mcp-status`'s status registry
 * agree on. Kept intentionally small and stable — client packages build
 * against these names and shapes directly, so a change here is a
 * cross-package contract change, not a local refactor.
 *
 * The RPC/event names, the `mcp/status-changed` Cordis `Events` augmentation,
 * and the Remote-only status service itself live in
 * `@deepseek-ai/dsh-mcp-status` (SWD-164 round 5, defect 2) — this package
 * keeps only the two wire TYPES, since `ConnectionHandle.status()` in
 * `./connection.ts` (which stays here) returns `McpServerStatus` directly.
 *
 * `disabled` names the connection supervisor's own `reconnect.enabled: false`
 * policy, NOT whether the plugin mount itself is loaded (the Loader's
 * `entry.disabled`, toggled by `mcp/set-enabled`) — the two "disabled"
 * concepts are deliberately independent; see `@deepseek-ai/dsh-mcp-status`'s
 * status-registry module doc for the full reasoning. A mount the Loader
 * never activated has no live `ConnectionHandle`, but it still appears in
 * `mcp/status` with state `disabled` and `attempts: 0` as long as it is
 * still named (disabled) in the profile's `cordis.patch.yml` — otherwise the
 * Tools panel could disable a server and never have a way to re-enable it.
 * Only a mount no longer named in that file at all (removed from
 * configuration entirely) is missing from `mcp/status`'s listing; see
 * `removed` below for how a client is told to drop that row.
 *
 * @module @deepseek-ai/dsh-mcp-client/status
 */

/**
 * Lifecycle state of one MCP server connection, as observed by the Host.
 * @typert object
 */
export type McpServerState =
  | 'connected'
  | 'connecting'
  | 'needs-authorization'
  | 'gave-up'
  | 'disabled'

/**
 * Point-in-time status for one configured MCP server.
 *
 * Tagged `@typert object` (no Remote service lives in this package anymore —
 * that moved to `@deepseek-ai/dsh-mcp-status`, SWD-164 round 5, defect 2) so
 * the typert workspace generator still treats this package as a cross-package
 * type root: without an explicit surface marker, `mcp-client` has nothing a
 * `registrationHasSurface` scan recognizes, drops out of the generator's
 * discovered-package set entirely, and a consumer like `mcp-status` — which
 * imports this very interface into a `declare module Events` signature —
 * fails workspace analysis with "package reference McpServerStatus is not
 * exported by @deepseek-ai/dsh-mcp-client at ./status" (the generator can no
 * longer force this package's *source* into the bounded compiler program, so
 * it only ever resolves the pre-built `.d.ts`, which the cross-package
 * reference check never matches). This tag, plus this package keeping its
 * own `./typert` export (see `package.json`; `./remote` stays absent since
 * there is still no `@Remote` method here), is the sanctioned fix — the same
 * pattern `packages/core/session/src/index.ts`'s plain `@typert object`
 * classes use.
 */
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

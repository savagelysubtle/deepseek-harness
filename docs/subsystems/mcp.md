# MCP Client

English | [中文](mcp.zh.md)

The MCP client bridge of [dsh-mcp-client](../../packages/mcp/mcp-client): connects to configured MCP servers (stdio or streamable-http transports), supervises each connection's reconnect/backoff lifecycle, drives the OAuth consent flow for servers that need authorization, and registers each server's tools on `ctx.tools`. This page documents the live-status wire contract a Settings panel (or any other client) consumes — `McpServerState`, `McpServerStatus`, and the `mcp/status-changed` event — from [`packages/mcp/mcp-client/src/status.ts`](../../packages/mcp/mcp-client/src/status.ts). Per-connection reconnect policy, transport configuration, and the tool-registration bridge itself are internal to the package and are not part of this wire contract; see the package [README](../../packages/mcp/mcp-client/README.md).

## Status

```ts type-equiv
/** Lifecycle state of one MCP server connection, as observed by the Host. */
type McpServerState =
  | 'connected'
  | 'connecting'
  | 'needs-authorization'
  | 'gave-up'
  | 'disabled'
```

`disabled` names the connection supervisor's own `reconnect.enabled: false` policy, NOT whether the plugin mount itself is loaded (the Loader's `entry.disabled`, toggled by `mcp/set-enabled`) — the two "disabled" concepts are deliberately independent. A mount the Loader never activated has no live connection handle, but `mcp/status` still lists it with state `disabled` and `attempts: 0`, synthesized straight from the profile's `cordis.patch.yml`, as long as that file still names it (disabled) — otherwise a Tools panel could disable a server and have no way to show a re-enable action for it. Only a mount no longer named in that file at all (removed from configuration entirely, not merely disabled) is missing from `mcp/status`'s listing; see `removed` below for how a client is told to drop that row instead.

```ts type-equiv
/** Point-in-time status for one configured MCP server. */
interface McpServerStatus {
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
```

The pending OAuth consent URL is deliberately NOT part of this status: it carries the OAuth `state` anti-CSRF token, so exposing it on a poll any trusted client can read would let whoever opens the leaked URL complete the pending flow. `authorize-start` is the only path that ever hands a consent URL to a caller — it returns a fresh one directly in its (privileged) RPC response. A status read while `state` is `needs-authorization` tells a Settings panel to show the Authorize affordance; clicking it calls `authorize-start` to get the URL to open. `reconnect` forces an immediate retry, valid only from `gave-up` or `disabled` and rate-limited per server; `set-enabled` edits the live `cordis.patch.yml` mount roster rather than touching a connection directly.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="mcp-events"></a>

### `mcp/*` events

<a id="mcpstatus-changed--emit"></a>

#### `mcp/status-changed` — emit

One server's status changed. Forwarded to clients verbatim only once `packages/api/remotes/src/remote-events.ts`'s allowlist names it.

```ts cordis-catalog
/**
 * One server's status changed. Forwarded to clients verbatim only once
 * `packages/api/remotes/src/remote-events.ts`'s allowlist names it.
 * @param status - the server's new point-in-time status.
 * @mode emit
 */
'mcp/status-changed'(status: McpServerStatus): void
```

Source: [`packages/mcp/mcp-client/src/status.ts:94`](../../packages/mcp/mcp-client/src/status.ts)
<!-- END GENERATED cordis-surface -->

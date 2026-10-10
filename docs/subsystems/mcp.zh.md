# MCP 客户端

[English](mcp.md) | 中文

[dsh-mcp-client](../../packages/mcp/mcp-client) 的 MCP 客户端桥接层：连接到已配置的 MCP 服务器(stdio 或 streamable-http 传输),监管每个连接的重连/退避生命周期,为需要授权的服务器驱动 OAuth 同意流程,并将每个服务器的工具注册到 `ctx.tools` 上。本页记录 Settings 面板(或任何其他客户端)所消费的实时状态线上契约 —— `McpServerState`、`McpServerStatus` 以及 `mcp/status-changed` 事件 —— 均来自 [`packages/mcp/mcp-client/src/status.ts`](../../packages/mcp/mcp-client/src/status.ts)。单个连接的重连策略、传输配置以及工具注册桥接本身都是该包的内部实现,不属于这份线上契约;详见包 [README](../../packages/mcp/mcp-client/README.md)。

## 状态

```ts type-equiv
/** Lifecycle state of one MCP server connection, as observed by the Host. */
type McpServerState =
  | 'connected'
  | 'connecting'
  | 'needs-authorization'
  | 'gave-up'
  | 'disabled'
```

`disabled` 指的是连接监督器自身的 `reconnect.enabled: false` 策略,**不是**插件挂载点本身是否已加载(Loader 的 `entry.disabled`,由 `mcp/set-enabled` 切换)—— 这两个"disabled"概念是刻意独立的。Loader 从未激活的挂载点没有存活的连接句柄,但只要配置档案的 `cordis.patch.yml` 仍然(以 disabled 的形式)列出该挂载,`mcp/status` 仍会把它列为 `state: 'disabled'`、`attempts: 0` 的合成行 —— 否则 Tools 面板一旦停用某个服务器,就再也没有入口把它重新启用。只有当该文件里完全不再列出这个挂载(即从配置中整体移除,而非仅仅停用)时,它才会从 `mcp/status` 的列表中消失；这时客户端如何得知要丢弃该行,见下方 `removed` 字段。

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

待处理的 OAuth 同意 URL 刻意不属于该状态对象：它携带 OAuth 的 `state` 防 CSRF 令牌,若把它暴露在任何可信客户端都能读取的轮询结果中,就会让拿到该 URL 的任何人完成这次待处理的授权流程。`authorize-start` 是唯一会把同意 URL 交给调用方的路径 —— 它在自己的(特权)RPC 响应中直接返回一个新鲜的 URL。当 `state` 为 `needs-authorization` 时读取到的状态,是在告诉 Settings 面板显示“授权”操作入口;点击它时再调用 `authorize-start` 获取要打开的 URL。`reconnect` 强制立即重试,仅在 `gave-up` 或 `disabled` 状态下有效,并按服务器限流;`set-enabled` 编辑的是存活的 `cordis.patch.yml` 挂载清单,而不是直接操作连接。

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

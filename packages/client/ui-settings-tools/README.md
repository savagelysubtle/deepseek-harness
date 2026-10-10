# @deepseek-ai/dsh-client-ui-settings-tools

English | [中文](README.zh.md)

**Tools** tab for Web Settings, a sibling of the Models, Agent Presets, and Plugins sections. The browser plugin registers one localized `settings.section` contribution with id `tools`; the section owns its own navigation entry. It lists one row per MCP server known to the Host's status registry ([`@deepseek-ai/dsh-mcp-status`](../../mcp/mcp-status/README.md), reached only through [`api-remotes`](../../api/remotes/README.md)'s `mcp` Remote namespace), with a plain-word connection-state badge, any last-error text, and the actions a server can need.

Each row's actions are state-driven: **Authorize** appears for a server that needs authorization or has given up, and opens a blank tab synchronously in the click handler before awaiting `mcp/authorize-start`, navigating that tab to the returned consent URL only once the call resolves — a tab opened after an `await` loses the user-gesture token most browsers require to avoid a popup block. **Reconnect** appears only for a server that has given up and retries the connection once. The **Enable/Disable** toggle calls `mcp/set-enabled`; disabling asks for an explicit acknowledgement first through the shared `RiskConfirmation` primitive, while enabling is immediate. Every rejected action replaces the row's own inline text with the failure instead of failing silently, and a rejected Authorize call closes the tab it opened. The roster loads on mount and on an explicit Refresh, and stays live afterward over the `mcp/status-changed` event without a reload.

## Model Experience

None, as this package only visualizes and operates a Host-owned MCP connection registry in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No bulk actions** — each action (Authorize, Reconnect, Enable, Disable) targets exactly one server; there is no multi-select or roster-wide retry.
- **Enable/Disable reads the Loader mount, not a dedicated flag** — a server is rendered `disabled` purely from `McpServerStatus.state`, since `mcp/status` never emits a separate Loader-disabled signal of its own.

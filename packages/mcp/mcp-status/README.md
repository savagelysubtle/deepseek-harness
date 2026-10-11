# @deepseek-ai/dsh-mcp-status

English | [中文](README.zh.md)

Permanently-mounted Remote status registry for every active [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.md) connection. `McpStatusRegistryService` registers the `mcpStatus` service and publishes four Remote methods under the `mcp` namespace — `mcp/status` (list), `mcp/authorize-start`, `mcp/reconnect`, and `mcp/set-enabled` — plus the `mcp/status-changed` push event. See [`docs/subsystems/mcp.md`](../../../docs/subsystems/mcp.md) for the full wire contract.

## Why this is its own package

This service used to be mounted lazily, once per `ctx.root`, the first time any `@deepseek-ai/dsh-mcp-client` instance activated. That was correct at the Cordis fiber level — the mount outlived any one instance's own disposal — but wrong one layer up: `@deepseek-ai/dsh-typert-loader` registers and withdraws a package's strict Typert manifest keyed to a *Loader entry*, and the service had none of its own. Disabling the last live mcp-client server withdrew its registration too, and the Gateway's strict/SRC-fallback latch is one-way — once a strict registration for an endpoint has ever existed, SRC fallback is permanently forbidden for that endpoint, even though this (still-alive) service could have answered it.

The fix is this package: it carries its own permanent Loader entry (mounted in [`packages/bundle/web-app/cordis.patch.yml`](../../bundle/web-app/cordis.patch.yml) beside the other host services), so the Typert registration is keyed to an entry that never unmounts — entirely decoupled from any individual mcp-client server's lifecycle. `@deepseek-ai/dsh-mcp-client` itself keeps only a root-scoped handle store that every instance registers into unconditionally; a host with this package absent from its `cordis.patch.yml` (headless, embedded) behaves identically, minus the Remote surface itself.

## Behavior

- `mcp/status` lists every registered server's current status, plus a synthesized `disabled` row (no live handle) for every other mcp-client mount the profile's `cordis.patch.yml` marks disabled — a Tools panel can always show a re-enable action for a server it just disabled.
- `mcp/authorize-start` begins (or resumes) one server's OAuth consent flow: probes reachability, binds the shared loopback listener, and returns the consent URL. The listener is single-flight across every server, not per-server.
- `mcp/reconnect` manually retries a given-up or disabled server now.
- `mcp/set-enabled` persists a plugin mount's enabled flag via an atomic `cordis.patch.yml` read-modify-write, matched by `config.serverName` — never the mount's opaque `id`. Before writing anything, it refuses outright if the current file carries any YAML tag its own `yaml` dependency cannot round-trip — the boot loader's `!!js` dialect (a token-header expression like `Authorization: !!js` in a profile) chief among them — logging the real file path to the host log and throwing an error naming the tag's line/column, the tag itself, and the remedy ("edit the file by hand and restart the host (SWD-169)"), with the path itself redacted on the wire, rather than silently dropping the tag (and every comment) on write-back.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Model Experience

None, as this Host-only status registry registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **The consent loopback listener is single-flight** — only one `authorize-start` flow may be pending at a time across every registered server.
- **No provenance or history beyond the current patch file and live handles** — `set-enabled` never inserts a new mount, and `list()` reports only what the handle store and the current `cordis.patch.yml` say right now.
- **The tag refusal above is a guard, not a fix** — `set-enabled` still cannot write back a file carrying an unpreservable tag at all; a tag-preserving writer is tracked as a separate follow-up (SWD-169).

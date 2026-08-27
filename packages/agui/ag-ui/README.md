# @deepseek-ai/dsh-ag-ui

English | [中文](README.zh.md)

Outbound [AG-UI](https://docs.ag-ui.com) adapter: subscribes to durable session events and live agent failures, translates them through a strict allowlist, and serves the result as Server-Sent Events so external dashboards can watch agent runs. Read-only — the mount registers no tools, no prompts, and nothing model-visible.

The endpoint runs on this plugin's **own `node:http` listener**, never on the web-GUI server: that server is browsers-only, loopback, and unauthenticated by contract, while this surface exposes session content and carries its own bearer auth. Mounting is optional; deployments expose it behind a gateway that terminates TLS.

## Endpoint

`POST /ag-ui/:threadId` → `200 text/event-stream`

- `threadId` is the session id (the AG-UI thread). Unknown id → `404`; malformed → `400`.
- Body is an optional JSON object `{ "runId": string }` (1..256 chars) supplying the connection's run-id base; absent bodies generate one.
- Frames are `event: <TYPE>\ndata: <json>\n\n`. A fresh attach streams `MESSAGES_SNAPSHOT` (projected from the committed log), then a synthesized `RUN_STARTED` when a turn is already open, then live frames.
- Per-turn run ids are `<base>-<turn>` so sequential turns stay distinguishable on one connection.
- Keepalive `: ping` comments every `keepAliveMs`.

## Event mapping

| dsh event | AG-UI frames |
|---|---|
| `turn/start` | `RUN_STARTED {threadId, runId}` |
| `assistant/chunk` text-delta | `TEXT_MESSAGE_START` (first) + `TEXT_MESSAGE_CONTENT {delta}` |
| `assistant/chunk` tool-call-delta | `TOOL_CALL_START {toolCallId, name}` (first) + `TOOL_CALL_ARGS {delta}` |
| `assistant/message` | closes open `TEXT_MESSAGE_END` / `TOOL_CALL_END` brackets |
| `tool/call` (unstreamed call) | `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` triad |
| `tool/result` | `TOOL_CALL_RESULT {toolCallId, content}` |
| `turn/end` completed | `RUN_FINISHED` |
| `turn/end` error, or `agent/error` while open | `RUN_ERROR {message}` |
| `approval/asked` | `CUSTOM {name: "dsh.approval.requested"}` (display-only) |
| anything else | dropped, counted in one debug line per connection |

**Allowlist contract:** every mapped type is an explicit `switch` case. Unmapped event types and chunk subtypes increment `BracketState.droppedUnmapped` and produce no frames — plugin-merged vocabulary must be added explicitly before it crosses this package's trust boundary.

## Config

| Field | Type | Default | Semantics |
|---|---|---|---|
| `host` | string | `"127.0.0.1"` | Listener bind address. |
| `port` | number | required | TCP port; `0` selects ephemeral. |
| `bearerToken` | string | required | Minimum 8 characters; validated at load (misconfiguration fails loud). Compared via SHA-256 digests under `timingSafeEqual`. |
| `keepAliveMs` | number | `15000` | Keepalive comment interval. |
| `maxBufferedEvents` | number | `256` | Per-connection queue bound; overflow ends that stream with a terminal `RUN_ERROR` frame and graceful close, leaving sibling connections unaffected. |

Auth failure answers `401` with `WWW-Authenticate: Bearer` before routing, so unknown paths leak nothing to unauthenticated probes.

## Extension points

None outbound. Consumers of the frame stream implement any AG-UI client; the protocol requires tolerating unknown event types, which this server never sends beyond the union above.

## Model Experience

None, as the server only projects the session log onto outbound AG-UI sockets and registers nothing model-facing.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- No TLS: terminate at a gateway in front of this listener.
- Observe-only: approvals forward as display-only `CUSTOM`; steering, injection, and run triggering stay on other surfaces (ACP, CLI). Interrupt round-tripping is deferred until the dashboard needs it.
- Mid-run attaches see committed history plus synthesized bracketing; in-flight chunk deltas of the open step arrive only for steps starting after attach.
- The keyless snapshot scenario for assembled SSE transcripts is not yet wired into `test:snapshot`; unit + composition coverage lives in `tests/`.

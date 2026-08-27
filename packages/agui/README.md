# agui/ — AG-UI outbound projection family

English | [中文](README.zh.md)

The read-only projection of session activity onto the [AG-UI protocol](https://docs.ag-ui.com), so external dashboards render agent runs without touching the harness core.

| Package | Role | ctx key |
|---|---|---|
| [`ag-ui/`](ag-ui/README.md) | Bearer-authenticated SSE listener translating `session/event` into AG-UI frames. | (owns its own `node:http` listener) |

The adapter is an allowlist translator: unmapped session events are dropped, never forwarded, so plugin-merged vocabulary cannot leak to the external wire. The session log stays the source of truth; this family only projects it.

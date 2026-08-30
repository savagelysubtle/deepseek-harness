# mailbox/ — durable agent messaging family

English | [中文](README.zh.md)

Durable, cross-process messaging between agents through swappable stores. The seam's delivery contract is at-least-once with `done` meaning inbox admission; replies travel as new messages, never as settlement payloads.

| Package | Role | ctx key |
|---|---|---|
| [`mailbox/`](mailbox/README.md) | Service Definition: provider contract, bare seat-name address grammar, registry + default-resolved conveniences, `mailbox` message-source kind | `ctx.mailbox` |
| [`local/`](local/README.md) | SQLite store: single-file durability, IMMEDIATE-transaction single-winner claims, token-guarded settlement with stale-lease reclaim, schema-version gating | provider `local` on `ctx.mailbox` |
| [`bridge/`](bridge/README.md) | Consumer: poll-drain into addressed named-session agents — steer-first delivery, cold-resume under residency locks, `unknown-address` failure | runs the drain; no ctx key |
Planned roles: `mailbox-rest` (a PostgREST-compatible provider) waits for a deployment that needs one; the model-facing send, drain, and await tools ship in [`tool-mailbox/`](tool-mailbox/README.md).

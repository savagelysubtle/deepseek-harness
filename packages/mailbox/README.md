# mailbox/ — durable agent messaging family

English | [中文](README.zh.md)

Durable, cross-process messaging between agents through swappable stores. The seam's delivery contract is at-least-once with `done` meaning inbox admission; replies travel as new messages, never as settlement payloads.

| Package | Role | ctx key |
|---|---|---|
| [`mailbox/`](mailbox/README.md) | Service Definition: provider contract, `<namespace>:<name>` address grammar, registry + default-resolved conveniences, `mailbox` message-source kind | `ctx.mailbox` |

Planned roles per the [mailbox plan](../../interagentstuff/plans/mailbox-plan.md): `mailbox-local` (SQLite provider), `mailbox-rest` (PostgREST-compatible provider), `mailbox-bridge` (drain → resolve → cold-resume consumer), `tool-mailbox-send` (model-facing send tool).

# agent/ — alternate agent drivers

English | [中文](README.zh.md)

Packages that register an alternate driver under the keyed agent-factory seam of [`core/agent`](../core/agent/README.md). The default loop stays in [`core/agent-loop`](../core/agent-loop/README.md); a seat opts into a driver in its registry row.

| Package | Role | ctx key |
|---|---|---|
| [`agent-claude-code-driver/`](agent-claude-code-driver/README.md) | Runs a seat on the unmodified `claude` program through the official Agent SDK | registers the `claude-code` driver on `ctx.agents` |

The durable event vocabulary of the Claude Code driver lives in [`core/agent-claude-code`](../core/agent-claude-code/README.md).

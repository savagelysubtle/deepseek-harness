# agent/ — alternate agent drivers

English | [中文](README.zh.md)

Packages that register an alternate driver under the keyed agent-factory seam of [`core/agent`](../core/agent/README.md). The default loop stays in [`core/agent-loop`](../core/agent-loop/README.md); a seat opts into a driver in its registry row.

| Package | Role | ctx key |
|---|---|---|
| [`agent-claude-code-driver/`](agent-claude-code-driver/README.md) | Runs a seat on the unmodified `claude` program through the official Agent SDK | registers the `claude-code` driver on `ctx.agents` |
| [`agent-claude-code-registry/`](agent-claude-code-registry/README.md) | Verifies the mailbox bridge's seat binding and applies a registry row's sender lists for Claude Code seats | provides `ctx.claudeCodeSeatSource` and `ctx.claudeCodeMailHooks` |
| [`agent-claude-code-bash/`](agent-claude-code-bash/README.md) | Registers the sandboxed `bash` tool (bubblewrap under a transient systemd scope, no network) and the `sandbox` readiness entry for Claude Code coder seats | none (registers into `claudeCodePolicyRegistries`) |
| [`agent-claude-code-tools/`](agent-claude-code-tools/README.md) | Generates the permission rules, the `PreToolUse` seat-guard hook and the policy file a Claude Code seat runs under, plus the readiness registry | none yet (the `ctx.claudeCodePolicy` provider lands later in the same slice) |
| [`agent-claude-code-seat-checks/`](agent-claude-code-seat-checks/README.md) | Registers the guard boot-canary and the clone `rules-hooks` check as readiness entries (`canary`, `rules-hooks`), which lifts the coder refusal once the sandbox entry is also registered | none (registers into `claudeCodePolicyRegistries`) |

The durable event vocabulary of the Claude Code driver lives in [`core/agent-claude-code`](../core/agent-claude-code/README.md).

# agent/ — 替代 agent 驱动

[English](README.md) | 中文

在 [`core/agent`](../core/agent/README.md) 的带键 agent 工厂接缝下注册替代驱动的包。默认循环仍在 [`core/agent-loop`](../core/agent-loop/README.md);席位通过注册表条目选择驱动。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`agent-claude-code-driver/`](agent-claude-code-driver/README.md) | 通过官方 Agent SDK 让席位运行在未经修改的 `claude` 程序上 | 在 `ctx.agents` 上注册 `claude-code` 驱动 |

Claude Code 驱动的持久事件词汇位于 [`core/agent-claude-code`](../core/agent-claude-code/README.md)。

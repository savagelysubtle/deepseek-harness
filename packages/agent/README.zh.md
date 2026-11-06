# agent/ — 替代 agent 驱动

[English](README.md) | 中文

在 [`core/agent`](../core/agent/README.md) 的带键 agent 工厂接缝下注册替代驱动的包。默认循环仍在 [`core/agent-loop`](../core/agent-loop/README.md);席位通过注册表条目选择驱动。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`agent-claude-code-driver/`](agent-claude-code-driver/README.md) | 通过官方 Agent SDK 让席位运行在未经修改的 `claude` 程序上 | 在 `ctx.agents` 上注册 `claude-code` 驱动 |
| [`agent-claude-code-registry/`](agent-claude-code-registry/README.md) | 为 Claude Code 席位验证邮箱桥的席位绑定,并应用注册表条目的发送者列表 | 提供 `ctx.claudeCodeSeatSource` 与 `ctx.claudeCodeMailHooks` |
| [`agent-claude-code-bash/`](agent-claude-code-bash/README.md) | 为 Claude Code coder 席位注册沙箱 `bash` 工具(临时 systemd scope 下的 bubblewrap,无网络)和 `sandbox` 就绪项 | 无(注册进 `claudeCodePolicyRegistries`) |
| [`agent-claude-code-tools/`](agent-claude-code-tools/README.md) | 生成 Claude Code 席位所依据的权限规则、`PreToolUse` seat-guard 钩子和策略文件,以及就绪状态注册表 | 暂无(`ctx.claudeCodePolicy` 的 provider 在同一切片稍后提供) |
| [`agent-claude-code-seat-checks/`](agent-claude-code-seat-checks/README.md) | 把守卫启动金丝雀和克隆 `rules-hooks` 检查注册为就绪项(`canary`、`rules-hooks`);与 `sandbox` 就绪项一起齐备后,coder 席位不再被拒绝 | 无(注册进 `claudeCodePolicyRegistries`) |

Claude Code 驱动的持久事件词汇位于 [`core/agent-claude-code`](../core/agent-claude-code/README.md)。

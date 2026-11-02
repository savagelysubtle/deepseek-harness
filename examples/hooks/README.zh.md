# 门禁钩子

[English](README.md) | 中文

一个可选 overlay，让在 dsh 内运行的模型受到与 Claude Code 会话相同的规则门禁约束。它挂载 [Claude 钩子桥](../../packages/hooks/hooks-claude-code/README.md)，并使用 `~/.agents/hooks/` 中的三个控制平面脚本：

| 事件 | 脚本 | 作用 |
|---|---|---|
| `PreToolUse`（文件编辑） | `plan-gate.sh` | 当工单分支（`OP-<id>`、`SWD-###`、`#<id>`）对应的工单没有附带方案时，拒绝文件编辑。没有工单引用的分支会带警告放行。 |
| `PreToolUse`（文件编辑） | `screenshot-gate.sh` | 在附上截图证明之前，拒绝编辑 UI 路径（由 `GATE_UI_GLOBS` 匹配）。 |
| `Stop` | `done-evidence.sh` | 当完成声明中没有门禁结果时，拒绝结束本轮并强制再执行一步。 |

`PreToolUse` 匹配器为 `^(Edit|Write|MultiEdit|NotebookEdit|edit|write|str_replace_editor)$`：既包含 Claude Code 的工具名，也包含 harness 工具 `edit`、`write` 和 `str_replace_editor`。完成证据通过 `Stop` 钩子传递，因为 harness 的 `SubagentStop` 无法拒绝。

文件：

- `gate-hooks.cordis.yml`：overlay（插入一行 `@deepseek-ai/dsh-hooks-claude-code`）。
- `gate-hooks.settings.json`：桥读取的钩子配置。命令使用 `"$HOME/.agents/hooks/..."`；钩子命令经 shell 执行，因此 `$HOME` 会展开。脚本位于其他位置时请修改路径。

## 应用

只应用到 dshTest 一次性 profile，绝不要用于在线席位或稳定宿主：

```sh
dsh web --patch examples/hooks/gate-hooks.cordis.yml
```

`configPath` 是进程级的，相对于启动目录解析，因此请在仓库根目录运行，或将 `DSH_GATE_HOOKS_SETTINGS` 设为设置文件的绝对路径。文件缺失或无法读取时只会记录警告且不注册任何钩子，因此请在会话日志中查找 `hook/invoked` 和 `hook/result` 事件，确认门禁已触发。

## 桥发送的内容

每个 `PreToolUse` 负载都包含 `tool_name`（harness 工具名，例如 `edit`）、`tool_input`、`tool_use_id`、`cwd`（会话工作区；脚本据此读取 git 分支上的工单）、`session_id` 和 `transcript_path`。`edit` 与 `write` 的目标字段名为 `file_path`；`str_replace_editor` 使用 `path`，因此桥会在 `tool_input` 中追加 `file_path` 别名（原有 `path` 保留）。`Stop` 包含 `last_assistant_message` 和 `stop_hook_active`。只有退出码 2 会拒绝；其他非零退出码都会放行。

## 限制

- 仅为提醒强度。这些门禁只检查产物是否存在，不是安全围栏：拥有 shell 的模型仍可绕过它们写文件。真正的隔离见工单 #166。
- 配置在加载时读取一次，并作用于进程内的所有会话；不支持按会话配置钩子。
- Codex 方言桥（`dsh-hooks-codex`）对工具调用只发送 shell `command`，因此 `screenshot-gate.sh` 在那里拿不到文件路径，无法匹配 UI glob。请像本 overlay 一样使用 Claude 方言桥。
- 每次拒绝都会作为工具错误或下一步引导文本展示给模型。`Stop` 钩子最多连续强制继续 8 次，之后允许智能体停止。

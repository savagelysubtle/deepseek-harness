# @deepseek-ai/dsh-tool-compact

[English](README.md) | 中文

一个可由模型调用的 `compact` 工具，它把真正的压缩推迟到 agent 的下一个空闲边界，运行在 [`ctx.compaction`](../compaction/README.md) 之上。调度是进程本地的接纳状态；持久工作通过 [`Agent.runMaintenance`](../../core/agent/README.md) 在引擎既有的空闲认领与 `compaction/start` 锁内执行，因此本插件既不添加第二个队列，也不添加额外的互斥量。[排队手动压缩 Agent Note](../../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.md)拥有这些接纳决策；本工具是对 [command-compact](../command-compact/README.md) 中仅限人类命令策略的一次刻意的面向模型反转。

## 工具约定

| 调用 | 结果 |
|---|---|
| 不带参数的 `compact` | `Compaction scheduled; it runs when this turn ends.` —— 调度已就绪（armed），调用立即返回。 |
| 调度挂起期间的第二次调用 | `Compaction was already scheduled; it runs when this turn ends.` —— 就绪期间按 agent 幂等。 |
| 来自非 agent 调用方的调用 | 错误结果：`compact requires an owning agent session`。 |

当所属 agent 的状态变为 `idle` 时，运行器同步消费已就绪的调度并直接调用 `compactNow(agent, signal)`。引擎自己完成那一次空闲阶段认领；赢得边界的唤醒发送以 `ManualCompactionError('busy')` 浮现，运行器重新就绪原始调度，让它在下一个空闲边界重试，保留提示词的 FIFO 优先权。在边界前中止的调度信号会把调度作为已取消丢弃。其他所有失败——包括预期的 `changed`、`summary`、`commit` 与 `persistence` 代码——都落定而不重新抛出：引擎的标记对已经持久化在日志中，运行器在进程日志里记录一条警告。

待定集与落定记录是按 agent 弱键控的每进程模块状态。插件处置会移除状态监听器并丢弃仍然就绪的调度，因此重新挂载的 fiber 绝不会针对永远不会运行的调度去重。

## 组合

挂载工具注册表、一个压缩后端与本插件：

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: tool-compact
  name: '@deepseek-ai/dsh-tool-compact'
```

生产方注入 `tools` 和 `compaction`。

## 模型体验

### 空闲期延迟的 `compact` 控制

#### 模型看到什么

一次无参数的 `compact` 调用加入提示词组装，并返回立即确认 `Compaction scheduled; it runs when this turn ends.`；稍后——延迟运行成功之后——后端的 user 角色检查点替换派生模型历史中选定范围的内容。结果文本说明了延迟，使模型不会期望压缩发生在当前回合内。

#### Token 影响

调度只会在当前对话中增加一条简短的工具结果。成功的延迟运行会用一份带框架的摘要替换选定范围，从而减少后续请求；摘要生成本身是空闲边界处的一次辅助请求。

#### KV Cache 影响

调度不使任何内容失效。已被接受的 surface 替换从第一个被遮蔽的历史 token 起使复用失效。

## 已知限制与暂缓事项

- **内存中的调度** —— 就绪的调度只存在于当前进程中；崩溃会将其丢弃，模型在观察到尽管结果被接受却没有检查点出现之后会自然地再次调用。
- **空闲边界延迟** —— 压缩仅在 agent 下一次进入空闲时开始；持续忙碌的 agent 会在每次 `busy` 失败后重新就绪，而不是内联运行。
- **单一后端目标** —— 延迟总是指向组合中的那个 `ctx.compaction` 引擎；与程序化的 `compactRegion()` 路径不同，不存在范围或策略参数。

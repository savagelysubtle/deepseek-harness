# @deepseek-ai/dsh-agent-claude-code-driver

[English](README.md) | 中文

**Claude Code 席位驱动**:注册表条目写着 `driver: claude-code` 的席位保留自己的名称、邮箱、条目和 dsh 日志,只有"思考"改由官方 Agent SDK 在操作者自己的登录下运行未经修改的 `claude` 程序。dsh 自己从不发送模型请求,也从不接触登录令牌。

本包在 [`dsh-agent`](../../core/agent/README.md) 的带键 agent 工厂接缝的 `claude-code` 键下注册一个工厂(`ctx.agents.setFactory(factory, 'claude-code')`)。不传 `driver` 的调用方仍然走默认循环([`agent-loop`](../../core/agent-loop/README.md)),行为不变。持久记录词汇位于 [`agent-claude-code`](../../core/agent-claude-code/README.md);本包复用它的记录器。

## 席位条目

```yaml
seats:
  mail-triage:
    driver: claude-code
    claude_code:
      model: haiku            # alias or full id; a fable id is rejected unless the row sets fable_ok: true
      effort: low             # optional: low | medium | high | xhigh | max
      role: mail-only         # coder | lead | mail-only
      max_turns: 20           # SDK maxTurns for one query
      claude_path: /home/me/.local/share/claude/versions/2.1.317/claude   # absolute, required
      max_calls_per_window: 30   # optional; enforced by a later slice
    fable_ok: false
```

- `claude_path` 必须是绝对路径并原样使用:从不通过 PATH 查找(`which claude` 可能是包装脚本)。
- 校验器先对模型 id 做 Unicode NFKC 折叠、去掉不可见格式字符并转小写,再查找 `fable`,因此全角或零宽字符写法无法绕过。
- 插件 `Config` 为 `{ stateDir, seats, disposeGraceMs?, defaultPauseMs? }`。在注册表切片落地之前,会话对应的席位按 `meta.agentPreset` 查找,否则按会话 id。

## 回合模型与转向

每个回合是一次流式输入的 `query()`。它的 `prompt` 是一个打开的 `AsyncIterable<SDKUserMessage>`(`PromptStream`),在查询运行期间保持打开。

- **首次查询**把新生成的 UUID 作为 `sessionId` 传入;**后续查询**传 `resume` 并设 `persistSession: true`。驱动在**发送第一个提示之前**把 `claude-code/session-bound` 追加到 dsh 日志,因此在绑定与提示之间崩溃也不会丢失绑定。若已绑定会话在完成过回合后其 Claude 转录缺失或不可读,则拒绝:追加 `claude-code/resume-failed`,回合以"需要重新播种"的补救提示失败。驱动绝不会静默开启新的 Claude 会话,邮件保持排队。
- **`agent.steer(msg)`** 领取该消息并推入打开的流。Claude 在**下一个模型调用边界**消费它,所以延迟等于正在执行的工具调用的剩余时间(S0 实测:在 20 秒 `sleep` 期间 8 秒推入的消息于 24.5 秒生效)。`agent.followup(msg)` 则排入之后单独的回合。
- 当每条推入的消息都已被某个 `result` 回应且收件箱为空时,关闭该流。若某个 result 没有指明任何已推入消息的 uuid,则视为它回应了全部。
- **后备方案:**`interruptAndResume(msg)` 调用 `query.interrupt()`,再用恢复的查询送达消息。中断之后结果迭代器会抛错,因此对 interrupt 与 close 都做了 try/catch。
- **阶段机:**本进程内每个席位恰好一个活动查询。对已有活动查询的席位再次 `create`/`resume`,或另一个 agent 在该席位上发起回合,都会以带编码的错误(`CLAUDE_CODE_SEAT_BUSY`)拒绝。

## 工具、选项与取消

- 每次查询都设置 `settingSources: []`、`strictMcpConfig: true`、`permissionMode: 'dontAsk'`、`maxTurns`、`model`、固定的 `pathToClaudeCodeExecutable` 与已清洗的 `env`。`lead` 与 `mail-only` 席位为 `tools: []`;`coder` 席位为 `Read, Grep, Glob, Edit, Write`。原生 `Bash` 与 `AskUserQuestion` 始终在 `disallowedTools` 中。
- `QueryOptionsExtension` 是内联 `settings`(钩子与拒绝规则,后续切片)的类型化扩展点。它在围栏之前应用,因此无法放宽围栏。
- **取消**会中止控制器、调用 `query.close()`(try/catch),然后让子进程的进程组退出:先由子进程所有者执行 SIGTERM 再 SIGKILL 的阶梯,若无法证明进程树已消失则直接对进程组发 `SIGKILL`。回合以 `aborted` 结束,除非设置 `keepInbox`,否则清空收件箱。
- **进程所有权:**子进程通过共享的子进程所有者在独立进程组中启动。每个席位子进程的 pid 与进程启动时间记录在 `<stateDir>/claude-code-seat-pids.json`;插件启动时 `ProcessLedger.reapStale()` 会杀死启动时间仍然匹配的已记录子进程,并忽略已被回收复用的 pid。

## 环境

子进程环境是已清除凭据的父环境,再去掉 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 与 `CLAUDE_CODE_OAUTH_TOKEN`。只要宿主环境中设置了其中任何一个,插件拒绝启动,每个回合也拒绝运行。

## 订阅窗口暂停

SDK 没有专门的"限流"result 子类型。驱动把以下情形视为窗口被拒绝:`rate_limit_info.status` 为 `rejected` 的 `rate_limit_event`(`overage` 类型或 `credits_required` 记为 `usage-exhausted`,否则为 `rate-limit`)、带 `error: 'rate_limit'` 或 `'billing_error'` 的助手消息,以及 `api_error_status: 429` 的 result。席位追加 `claude-code/paused {reason, until?}`,停止查询,以 `CLAUDE_CODE_PAUSED` 码使回合失败,并在重置时间之前(未报告时为 `defaultPauseMs`,15 分钟)拒绝后续回合,邮件保持排队。这只是单席位信号;全队暂停属后续切片。

## 写入的持久记录

`claude-code/session-bound`、`claude-code/resume-failed`、`claude-code/steer`、`claude-code/paused`,以及每回合一条 `claude-code/turn-completed`(仅从 `result` 的命名字段映射)。回合索引就是 dsh 回合号,因此跨重启持续递增,满足记录不变量。

## Known Limitations and Deferred Work

- **尚无事件映射器** — 助手文本、工具调用、压缩边界与未映射消息暂未写入 dsh 日志(方案第 9 节);目前只写上面列出的记录。
- **尚未集成租约与收件箱** — 驱动运行在 agent 收件箱之上;暂停或恢复失败时让邮箱租约失败、崩溃恢复幂等键、以及桥接层的驱动切换拒绝都属后续切片。
- **席位查找是临时的** — 在注册表切片提供真正的解析器之前,按 `meta.agentPreset` 或会话 id 查找席位。
- **规则、git 围栏与沙箱 shell 尚未接入** — 只有选项扩展点;coder 席位没有 shell。
- **转录检查依赖 SDK** — `getSessionInfo` 无返回会被视为转录缺失,因此没有可提取摘要的转录同样会被拒绝。
- **单席位窗口上限与全队限额** — `max_calls_per_window` 已校验但尚未强制执行。

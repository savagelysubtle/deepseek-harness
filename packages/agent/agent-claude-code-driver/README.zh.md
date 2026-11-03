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
      model: haiku            # opus | sonnet | haiku or a claude-<family>-<version> id; fable only with fable_ok: true
      effort: low             # optional: low | medium | high | xhigh | max
      role: mail-only         # coder | lead | mail-only
      max_turns: 20           # SDK maxTurns for one query
      claude_path: /home/me/.local/share/claude/versions/2.1.317/claude   # absolute, required
      claude_path_sha256: <64 hex>   # optional: re-pin after an intended upgrade
      max_calls_per_window: 30   # optional; enforced by a later slice
    fable_ok: false
```

- `claude_path` 必须是绝对路径并原样使用:从不通过 PATH 查找(`which claude` 可能是包装脚本)。
- 校验器先对模型 id 做 Unicode NFKC 折叠、去掉不可见格式字符并转小写,然后只接受白名单:`opus`、`sonnet`、`haiku`,或 `claude-opus|sonnet|haiku-<数字与连字符>`。fable id 仅在 `fable_ok: true` 时通过;其他任何写法(例如 Bedrock 或 Vertex 风格的 id)一律拒绝。
- `role: coder` 条目在插件启动时被拒绝:它们需要后续切片的权限策略扩展,在其落地之前 coder 席位会在没有拒绝规则的情况下运行。
- **二进制认证。**插件启动时,`claude_path` 必须解析为运行用户所有的常规文件,不得被组或其他用户写入,不得带脚本扩展名(`.js .mjs .cjs .sh .py`,在符号链接解析前后各检查一次),其路径上的任何目录也不得被组或其他用户写入(`/tmp` 这类带粘滞位的目录除外)。其 SHA-256 在首次见到时按席位固定在 `<stateDir>/claude-code-binary-pins.json` 中。之后哈希变化会拒绝启动并给出新哈希;若升级是有意的,在条目上把 `claude_path_sha256` 设为该哈希即可接受。每个回合之前会重新检查文件的大小、mtime 与 inode,因此启动之后被替换会使回合被拒绝。
- 插件 `Config` 为 `{ stateDir, dshHome?, seats, disposeGraceMs?, defaultPauseMs? }`。`stateDir` 必须位于 harness 主目录内(`dshHome`,否则 `$DSH_HOME`,否则 `~/.dsh`):`claude-code` 这样的普通名称是它的子目录,绝对路径必须本来就在其中,主目录本身或其外部的路径一律拒绝。该目录以 `0700` 创建,若是符号链接、属于他人或对组及其他用户开放则拒绝。在注册表切片落地之前,会话对应的席位按 `meta.agentPreset` 查找,否则按会话 id。

## 回合模型与转向

每个回合是一次流式输入的 `query()`。它的 `prompt` 是一个打开的 `AsyncIterable<SDKUserMessage>`(`PromptStream`),在查询运行期间保持打开。

- **首次查询**把新生成的 UUID 作为 `sessionId` 传入;**后续查询**传 `resume` 并设 `persistSession: true`。驱动在**发送第一个提示之前**把 `claude-code/session-bound` 追加到 dsh 日志并刷新会话存储,因此在绑定与提示之间崩溃也不会丢失绑定;刷新失败会拒绝该提示(`CLAUDE_CODE_BINDING`)并在下一个回合重试。日志中不是 UUID 的会话 id 会被当作日志损坏而拒绝。写入日志的错误文本会被脱敏并限制长度。若已绑定会话在完成过回合后其 Claude 转录缺失或不可读,则拒绝:追加 `claude-code/resume-failed`,回合以"需要重新播种"的补救提示失败。驱动绝不会静默开启新的 Claude 会话,邮件保持排队。
- **`agent.steer(msg)`** 领取该消息并推入打开的流。Claude 在**下一个模型调用边界**消费它,所以延迟等于正在执行的工具调用的剩余时间(S0 实测:在 20 秒 `sleep` 期间 8 秒推入的消息于 24.5 秒生效)。`agent.followup(msg)` 则排入之后单独的回合。
- 当每条推入的消息都已被某个 `result` 回应且收件箱为空时,关闭该流。若某个 result 没有指明任何已推入消息的 uuid,则视为它回应了全部。
- **后备方案:**`interruptAndResume(msg)` 调用 `query.interrupt()`,再用恢复的查询送达消息。中断之后结果迭代器会抛错,因此对 interrupt 与 close 都做了 try/catch。
- **阶段机:**本进程内每个席位恰好一个活动查询。对已有活动查询的席位再次 `create`/`resume`,或另一个 agent 在该席位上发起回合,都会以带编码的错误(`CLAUDE_CODE_SEAT_BUSY`)拒绝。

## 工具、选项与取消

- 每次查询都设置 `settingSources: []`、`strictMcpConfig: true`、`permissionMode: 'dontAsk'`、`maxTurns`、`model`、固定的 `pathToClaudeCodeExecutable` 与已清洗的 `env`。`lead` 与 `mail-only` 席位为 `tools: []`;`coder` 席位为 `Read, Grep, Glob, Edit, Write`。原生 `Bash` 与 `AskUserQuestion` 始终在 `disallowedTools` 中。
- `QueryOptionsExtension` 是内联 `settings`(钩子与拒绝规则,后续切片)的类型化扩展点。其输出经过白名单过滤:只保留 `hooks` 与 `permissions.deny` / `permissions.ask` 字符串列表,其余一切(允许规则、目录、默认模式、设置文件路径)都会被丢弃并给出警告。它在围栏之前应用,因此无法放宽围栏,最后还会再次检查成品选项不含被禁止的环境变量名且模型在允许范围内。
- **取消**会中止控制器、调用 `query.close()`(try/catch),然后让子进程的进程组退出:先由子进程所有者执行 SIGTERM 再 SIGKILL 的阶梯,若无法证明进程树已消失则直接对进程组发 `SIGKILL`。回合以 `aborted` 结束,除非设置 `keepInbox`,否则清空收件箱。
- **进程所有权:**子进程通过共享的子进程所有者在独立进程组中启动。每个席位的子进程(一个席位可保留多条)记录在 `<stateDir>/claude-code-seat-pids.json`,包含子进程的 pid 与启动时间、宿主的 pid 与启动时间以及内核 boot id。文件以原子方式写入(独占临时文件,模式 `0600`),若是符号链接、属于他人、对组或其他用户开放或已损坏则拒绝,错误信息会给出路径与补救办法。插件启动时,仅当 boot id 一致、启动时间仍然匹配且其所属宿主已不存在时,`ProcessLedger.reapStale()` 才会杀死已记录的子进程。来自更早一次启动的条目会被丢弃;所属宿主仍然存活的条目保持不动并给出警告;首进程已死但进程组仍有成员的情形只报告、不杀死;一次杀进程失败不会中断整个过程。

## 环境

子进程环境是已清除凭据的父环境,再去掉 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 与 `CLAUDE_CODE_OAUTH_TOKEN`。宿主环境带有 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_MODEL`、`ANTHROPIC_DEFAULT_<FAMILY>_MODEL`(任意家族)、`ANTHROPIC_SMALL_FAST_MODEL`、`ANTHROPIC_CUSTOM_HEADERS`、`CLAUDE_CONFIG_DIR` 或 `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / `_MANTLE` / `_GATEWAY` 时同样被拒绝(启动时与每个回合),名称不区分大小写。只要宿主环境中设置了其中任何一个,插件拒绝启动,每个回合也拒绝运行。

## 订阅窗口暂停

SDK 没有专门的"限流"result 子类型。驱动把以下情形视为窗口被拒绝:`rate_limit_info.status` 为 `rejected` 的 `rate_limit_event`(`overage` 类型或 `credits_required` 记为 `usage-exhausted`,否则为 `rate-limit`)、带 `error: 'rate_limit'` 或 `'billing_error'` 的助手消息,以及 `api_error_status: 429` 的 result。当请求正按超额额度(`isUsingOverage: true`)处理,或非 overage 窗口被拒绝但超额仍被允许(`overageStatus` 为 `allowed` / `allowed_warning`)时,被拒绝的窗口不算暂停;被拒绝的 `overage` 窗口,或没有超额余量的拒绝,才算暂停。席位追加 `claude-code/paused {reason, until?}`,停止查询,以 `CLAUDE_CODE_PAUSED` 码使回合失败,并在重置时间之前(未报告时为 `defaultPauseMs`,15 分钟)拒绝后续回合,邮件保持排队。窗口上限为 24 小时,仍然有效的暂停会在重启后重新构建席位时从日志中恢复。这只是单席位信号;全队暂停属后续切片。

## 写入的持久记录

`claude-code/session-bound`、`claude-code/resume-failed`、`claude-code/steer`、`claude-code/paused`,以及每回合一条 `claude-code/turn-completed`(仅从 `result` 的命名字段映射)。回合索引就是 dsh 回合号,因此跨重启持续递增,满足记录不变量。

## Known Limitations and Deferred Work

- **尚无事件映射器** — 助手文本、工具调用、压缩边界与未映射消息暂未写入 dsh 日志(方案第 9 节);目前只写上面列出的记录。
- **尚未集成租约与收件箱** — 驱动运行在 agent 收件箱之上;暂停或恢复失败时让邮箱租约失败、崩溃恢复幂等键、以及桥接层的驱动切换拒绝都属后续切片。
- **席位查找是临时的** — 在注册表切片提供真正的解析器之前,按 `meta.agentPreset` 或会话 id 查找席位。
- **规则、git 围栏与沙箱 shell 尚未接入** — 只有选项扩展点;coder 席位没有 shell。
- **转录检查依赖 SDK** — `getSessionInfo` 无返回会被视为转录缺失,因此没有可提取摘要的转录同样会被拒绝。
- **斜杠命令邮件未经测试** — 以 `/` 开头的邮件正文尚未对照 SDK 验证,等待实际演练。
- **在没有完成任何回合时转录缺失,会沿用同一 id 继续** — 这是设计使然:从未完成过回合的会话可以用其已记录的 id 重新开始,因为没有丢失任何内容。
- **工作目录由调用方提供** — 它必须已经是自己的 realpath;从席位条目获取它属于注册表切片(S3)。
- **单席位窗口上限与全队限额** — `max_calls_per_window` 已校验但尚未强制执行。

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
      max_turns: 20           # optional, default 25: SDK maxTurns for one query
      max_budget_usd: 2       # optional, default 5: notional spend cap for one query (SDK maxBudgetUsd)
      claude_path: /home/me/.local/share/claude/versions/2.1.317/claude   # absolute, required
      claude_path_sha256: <64 hex>   # optional: re-pin after an intended upgrade
      max_calls_per_window: 30   # optional, default 120: queries the seat may start per call window
      call_window_ms: 18000000   # optional, default 5 hours, at least 60000: length of that window
    fable_ok: false
```

- `claude_path` 必须是绝对路径并原样使用:从不通过 PATH 查找(`which claude` 可能是包装脚本)。
- 校验器先对模型 id 做 Unicode NFKC 折叠、去掉不可见格式字符并转小写,然后只接受白名单:`opus`、`sonnet`、`haiku`,或 `claude-opus|sonnet|haiku-<数字与连字符>`。fable id 仅在 `fable_ok: true` 时通过;其他任何写法(例如 Bedrock 或 Vertex 风格的 id)一律拒绝。
- **角色按需、对照策略服务接受。** `mail-only` 始终可运行。`lead` 与 `coder` 条目可以挂载,但只有当 `ctx.get('claudeCodePolicy')` 已注册、契约版本为 1 且其 `readiness().roles` 列出该角色时,席位才会被解析(回合才会启动);否则创建或回合会被拒绝并给出可见原因(`policy service absent`,或 `not ready for it (missing: ...)`)。该服务在使用时读取、绝不在挂载时读取,因此可以晚于驱动注册。在沙箱、金丝雀与规则钩子三个贡献者注册之前(S6、S7),`coder` 保持被拒绝。
- **二进制认证。**插件启动时,`claude_path` 必须解析为运行用户所有的常规文件,不得被组或其他用户写入,不得带脚本扩展名(`.js .mjs .cjs .sh .py`,在符号链接解析前后各检查一次),其路径上的任何目录也不得被组或其他用户写入(`/tmp` 这类带粘滞位的目录除外);其上方的每一级目录,无论沿解析后的文件,还是沿配置路径按原样书写的每一级目录前缀(因此带符号链接的中间目录以及存放符号链接的目录都在其内),都必须属于操作者或 root。其 SHA-256 在首次见到时按席位固定在 `<stateDir>/claude-code-binary-pins.json` 中。之后哈希变化会拒绝启动并给出新哈希;若升级是有意的,在条目上把 `claude_path_sha256` 设为该哈希即可接受。交给 SDK 的是已认证的真实路径,而不是配置的路径。每个回合之前会重新解析配置的路径,并重新检查文件的大小、mtime、ctime 与 inode,因此启动之后被替换,或符号链接被改指向(Claude Code 自动更新程序正是这样改指 `~/.local/bin/claude` 的),都会使回合被拒绝,直到重启宿主。
- 插件 `Config` 为 `{ stateDir, dshHome?, seats, claudePathPrefixes?, hostSeats?, disposeGraceMs?, defaultPauseMs? }`(后两项新增,见下一节)。`stateDir` 必须位于 harness 主目录内(`dshHome`,否则 `$DSH_HOME`,否则 `~/.dsh`):`claude-code` 这样的普通名称是它的子目录,绝对路径必须本来就在其中,主目录本身或其外部的路径一律拒绝。该目录以 `0700` 创建,若是符号链接、属于他人或对组及其他用户开放则拒绝。会话对应的席位先在静态 `seats` 中按 `meta.agentPreset` 查找,否则按会话 id;在那里找不到的席位通过注册表来源查找。

## 经注册表路由的席位与主机条目

席位也可以通过组织注册表到达本驱动:它的注册表条目写着 `driver: claude-code`,邮箱桥在每次 create 和 resume 时把冻结的条目放在 `agentOptions.seatBinding` 中交给驱动。注册表条目是不受信任的请求,只携带路由与准入信息(`driver`、`admit_from`、`admit_sender_classes`,以及通用的 `cwd`、`sessionId`、`tools`)。所有花钱或扩大信任的设置都放在本插件自己配置里 `hostSeats` 下的**主机条目**中;这份配置属于 profile,任何席位都无法写入。

```yaml
claudePathPrefixes:
  - /home/me/.local/share/claude/versions    # the real path of every claude_path must sit under one of these
hostSeats:
  mail-triage:
    model: haiku                 # same allowlist and fable fence as a static row
    role: mail-only              # lead and coder need the claudeCodePolicy service to serve the role (checked at use time)
    # lead/coder only, host-private (a registry row carrying any of these is refused):
    # tools: [mailbox_send]        # exact dsh tool names
    # send_to: [ops-lead]          # seats this seat may mail
    # allow_blocking: false
    # rules_dir: /abs/path         # coder only
    claude_path: /home/me/.local/share/claude/versions/2.1.317/claude
    cwd: /home/me/work/mail-triage      # the pinned working directory; the registry row's cwd must equal it
    admit_from_ceiling: [ops-lead]      # the widest sender list the registry row may ask for
    # also: effort, max_turns, max_budget_usd, max_calls_per_window, call_window_ms, claude_path_sha256, fable_ok, session_id
```

- **查找顺序。** 先查静态 `seats` 配置;只有静态配置没有的席位才去查注册表来源(`ctx.claudeCodeSeatSource`,由 [`agent-claude-code-registry`](../agent-claude-code-registry/README.md) 提供)。没有绑定的请求会被来源拒绝,因此除邮箱桥之外没有任何调用方能打开经注册表路由的席位。来源的可选方法 `hasRow` 让驱动在挂载后不久对"没有任何注册表条目指向"的主机条目发出警告。
- **没有主机条目的注册表条目会被响亮地拒绝**,拒绝信息会打印需要添加的 `hostSeats` 条目。创始人在 profile 中补上它,并填入真实的 `claude_path`。
- **合并强制执行什么。** `mergeHostSeat` 用主机条目构造席位,并对它运行全部静态检查(模型白名单、fable 栅栏、限额)。它校验策略字段(`tools`、`send_to`、`allow_blocking`、`rules_dir`;mail-only 不带任何字段,`rules_dir` 仅限 coder),并拒绝携带其中任何一项的注册表条目(条目不是信任根);角色能否被服务留待之后对照策略服务判断。它要求 `claude_path` 的 realpath 位于某个 `claudePathPrefixes` 条目之下,要求条目的 `admit_from` 是 `admit_from_ceiling` 的子集,要求条目的 `cwd` 等于主机 `cwd` 固定值(工厂还会用该固定值核对收到的工作目录),并要求条目的驱动为 `claude-code`。主机条目与静态席位一样在挂载时校验、认证并固定,因此坏条目让挂载失败,而不是等到第一封邮件。同时出现在 `seats` 与 `hostSeats` 的席位会被拒绝。
- **静态席位的不变量对经注册表路由的席位同样成立:** `settingSources: []`、`strictMcpConfig: true`、`tools: []`、二进制认证及其每回合复查、熔断开关和调用窗口。
- **会话固定。** 经注册表路由的席位首次创建时使用的 dsh 会话 id 会固定在 `<stateDir>/claude-code-seat-sessions.json` 中(私有,与二进制固定相同)。相同 id 通过。不同的 id 以 `seat-session-changed: ... ask the founder to reseed` 拒绝,因此注册表写入者无法通过修改 `sessionId` 给席位换上全新的日志。与主机条目的 `session_id` 相等的不同 id 是创始人授权的重新播种:固定值随之移动,驱动记录一条警告。
- **调用窗口在重新播种和重启后保留。** 每个席位的调用时间随发生保存在 `<stateDir>/claude-code-call-windows.json` 中(私有),重启后的闸门计入已保存的时间,而不只是当前会话的日志。因此重新播种无法重置窗口,重启主机也不能。写入失败会被记录,内存中的计数继续。损坏或非私有的调用窗口状态文件会阻止挂载,纯静态部署也一样(有意为之,以便大声失败)。
- **准入携带发送者。** 准入请求新增可选的 `from`,读取自邮件的 `source.from`;注册表胶水包的 `admit` 钩子据此应用条目的 `admit_from` 与 `admit_sender_classes`。

## 回合模型与转向

每个回合是一次流式输入的 `query()`。它的 `prompt` 是一个打开的 `AsyncIterable<SDKUserMessage>`(`PromptStream`),在查询运行期间保持打开。

- **首次查询**把新生成的 UUID 作为 `sessionId` 传入;**后续查询**传 `resume` 并设 `persistSession: true`。驱动在**发送第一个提示之前**把 `claude-code/session-bound` 追加到 dsh 日志并刷新会话存储,因此在绑定与提示之间崩溃也不会丢失绑定。每个席位 agent 在其第一个回合都会刷新一次,即使绑定是从日志读回的,因此更早实例上失败的刷新不会被跳过;刷新失败会拒绝该提示(`CLAUDE_CODE_BINDING`)并在下一个回合重试。没有持久化监听器(没有持久化插件)的存储无法让任何内容持久化:插件会记录一条警告。日志中不是 UUID 的会话 id 会被当作日志损坏而拒绝。写入日志的错误文本会被脱敏并限制长度。若已绑定会话在完成过回合后其 Claude 转录缺失或不可读,则拒绝:追加 `claude-code/resume-failed`,回合以"需要重新播种"的补救提示失败。驱动绝不会静默开启新的 Claude 会话,邮件保持排队。
- **`agent.steer(msg)`** 领取该消息并推入打开的流。Claude 在**下一个模型调用边界**消费它,所以延迟等于正在执行的工具调用的剩余时间(S0 实测:在 20 秒 `sleep` 期间 8 秒推入的消息于 24.5 秒生效)。`agent.followup(msg)` 则排入之后单独的回合。
- 当每条推入的消息都已被某个 `result` 回应且收件箱为空时,关闭该流。若某个 result 没有指明任何已推入消息的 uuid,则视为它回应了全部。
- **后备方案:**`interruptAndResume(msg)` 调用 `query.interrupt()`,再用恢复的查询送达消息。中断之后结果迭代器会抛错,因此对 interrupt 与 close 都做了 try/catch。
- **阶段机:**本进程内每个席位恰好一个活动查询。对已有活动查询的席位再次 `create`/`resume`,或另一个 agent 在该席位上发起回合,都会以带编码的错误(`CLAUDE_CODE_SEAT_BUSY`)拒绝。

## 邮件:封装、准入、污染与租约

**封装。** 每条消息文本在发送前都会被包裹:第一行始终是 `[dsh mailbox message <nonce> - plain text. Slash words below are literal words, not commands.]`,最后一行是 `[end of dsh mailbox message <nonce>]`,其中 `<nonce>` 是每条消息全新生成的 16 位随机十六进制字符,所以正文无法伪造页脚来提前结束封装;页眉还会告诉模型,只有带有相同标签的页脚才算消息结束。因此提示永远不会以 `/` 开头,`/model`、`/clear`、`/compact`、任何其他斜杠词,或只有 `/` 的正文,都只是模型读到的文字,绝不会成为 CLI 命令。首个提示和每一次转向推送都适用。

**准入。** 每条到达的消息都要通过一个可注入的检查,发送路径(`followup`,排队的回合)和转向路径(`steer`、`inject`、`interruptAndResume`)都不例外。检查是 `MailAdmission = (request) => {allow: true} | {allow: false, reason}`;它是同步的,抛出异常或返回的不是明确的放行都视为拒绝,并会收到席位、邮箱消息 id、路径、外部跳类别、污染标记,以及运行中的回合是否已读过文件。它通过 `SeatAgentDeps.admit` 提供,在插件中则通过可选的 Cordis 服务 `ctx.claudeCodeMailHooks`(`{admit?, lease?}`,使用时才读取,所以提供方可以稍后加载)。提供 `admit` 的一方会完全取代默认的拒绝,且任何插件都可以提供该服务,所以只应由主机信任的插件提供。默认的 `defaultAdmission` 拒绝任何元数据标记了外部类别跳的邮件:`source.senderClass` 不是 `seat`(邮箱桥会给每个不在名册里的发送者标 `unverified`,所以在注册表切片提供按席位的准入发送者类别之前,创始人经邮箱发来的邮件同样是未验证的),或 `source.chain` 中任何类别不是 `seat` 的条目(门户、网页表单、Stripe、Twilio、其他任何来源,或无法读取的类别)。邮箱邮件必须证明它来自某个席位:没有发送者类别的邮箱邮件被视为未知的外部跳(失败即关闭)。没有邮箱来源的手工输入会被放行。只有邮箱的转发邮件可被认领:拒绝通知(`form: notice`)带的是它所报告的那条消息的 id,因此从不被认领;记录时 id 会发生变化的转发邮件(含控制字符、凭据形态,或超过 500 个字符)会被拒绝,而不是不留记录地运行。在邮件经过门户、表单、Stripe 或 Twilio 时由桥接层给 `chain` 与 `tainted` 打标,属于注册表切片(S3);在它落地之前,驱动只能依据收到的元数据行事。拒绝通知(`form: notice`)在 S3 放行该形式之前会被这个默认规则拒绝,所以在此之前席位看不到自己被拒绝的发送。拒绝是响亮的:一条 `reason: admission` 的 `claude-code/refused` 记录、一条警告、以及带原因的租约失败;消息不会入队。在邮箱桥的租约通过 `ctx.claudeCodeMailHooks.lease` 接入(切片 S8)之前,被拒绝或被丢弃的消息除了这条记录和警告之外,对发送者是不可见的。

**污染。** 邮件的来源标明 `tainted: true`,或带有外部跳时即为被污染;该标记随邮件传递。被污染的邮件绝不进入席位被恢复的 Claude 会话。它从不作为转向排队,也不会被推入运行中的回合;它作为自己的回合在**一次性**会话中运行:全新的会话 id、`persistSession: false`、`tools: []`、不使用策略扩展(没有钩子,没有设置)、不写 `session-bound` 记录,其 `turn-completed` 标有 `throwaway: true`。成品选项会在查询启动前按允许清单断言:空工具列表、`persistSession: false`、`settingSources: []`、`strictMcpConfig: true`、`permissionMode: 'dontAsk'`、被允许的模型,并且只含驱动自己设置的键,因此任何其他键(所有可能增加工具、钩子、权限回调、额外参数、技能、沙箱或恢复会话的 SDK 选项,以及以后 SDK 新增的任何选项)都会使该回合以 `CLAUDE_CODE_TAINTED_TOOLS` 被拒绝,租约失败。该回合的消息之前会写入一条 `claude-code/throwaway-turn {turnIndex}` 记录,使重新播种的摘要可以略去该回合的 `user/message` 与 `assistant/message` 文本。如果这条记录写不进去,该回合会在认领任何东西之前被拒绝,被污染邮件的租约失败。任何摘要或切换构建器(切片 S3)都必须排除每一个带有 `claude-code/throwaway-turn` 标记的回合,并为此编写自己的测试。一次性回合不接受转向,回合队列头部是被污染邮件时,会等待排队中的转向先运行。读取文件或抓取内容(`Read`、`Grep`、`Glob`、`WebFetch`、`WebSearch`)会使运行中的回合被污染:它被追踪(`agent.turnTainted`),并以 `turnTainted` 报告给准入检查;对这些工具的强制限制等待权限切片。

**租约与幂等。** 真正的租约归邮箱桥所有;驱动通过 `SeatAgentDeps.lease`(`MailLeaseSink {settle(id), fail(id, reason)}`,或 `ctx.claudeCodeMailHooks.lease`)来完成或让它失败。一条邮箱消息的确切顺序:

1. **准入。** 拒绝会写入 `claude-code/refused`、让租约失败,并在此结束。
2. **认领检查。** 回合认领消息时,在日志中查找其邮箱 id。已完成:再次完成租约并跳过该消息。此前已认领但没有结果(崩溃,或第一份仍在运行):绝不再运行第二次;本进程中仍在运行的副本会被丢弃并留下记录,崩溃遗留的则以 `claude-code/refused` 让租约响亮地失败。已失败或已暂停的同样拒绝。
3. **认领记录、刷盘、提示。** 追加 `claude-code/mail-claimed {messageId, tainted}` 并对会话**刷盘**,之后才发送提示(转向邮件在自己的刷盘之后才推送)。认领记录写不进去或刷盘失败时,什么都不发送,租约失败。
4. **结果。** 回合结束时追加 `claude-code/mail-outcome {messageId, outcome, reason}`,租约随之完成(`settled`:回合完成)或带原因失败(`failed`:出错、取消、中断或熔断开关;`paused`:订阅窗口拒绝了工作)。

在第 3 步与第 4 步之间崩溃,会留下没有结果的认领记录,因此重投递会响亮地失败,而不是把同一封邮件运行两次。结果为 `failed` 或 `paused` 同样是最终的:同一 id 的重投递会被永久拒绝而不会运行,发送者若想再试一次,必须发送新消息。第 3 步之前的失败(被拒绝的预检,如熔断开关、调用窗口或暂停)不留任何记录,邮件保持排队,重试会正常运行它。无法恢复的席位(`CLAUDE_CODE_RESUME_FAILED`)会让所有排队中的邮箱消息的租约失败并把它们移出队列,因为它需要重新播种;手工输入保持不动。取消 agent 会让排队中和运行中的邮箱邮件的租约失败。抛出异常的租约调用只是警告,不会让回合失败,`whenIdle()` 会等待仍在运行的租约调用。只有经邮箱到达的邮件才有认领与结果记录;手工输入不受影响。

## 流消息的映射

每条 SDK 流消息都只从命名字段映射;任何 SDK 对象都不会被展开或保存,工具结果正文、工具参数与思考文本都不会进入日志。

| SDK 消息 | dsh 记录 |
|---|---|
| `system` / `init` | `claude-code/session-bound`,仅当 Claude 报告的有效会话 id 与日志中的不同(一次性回合从不写) |
| `assistant` 文本 | `assistant/message`,先截断到 16000 个字符(附 `[truncated N characters]` 标记),再对凭据形态脱敏(Anthropic、类 OpenAI、GitHub、GitLab、npm、Slack、Stripe、Twilio、AWS、Google、JWT、bearer、key=value、PEM 私钥块),不区分大小写 |
| `assistant` 的 `tool_use` 加 `user` 的 `tool_result` | `claude-code/tool-call {name, ok, ms, argDigest}`;摘要为以每进程密钥加密的 `hmac:<16 位十六进制>`(输入不可用时为 `len:<n>`),绝不是普通哈希 |
| `assistant` 的 `thinking` | `claude-code/thinking {length}` |
| `system` / `compact_boundary` | `claude-code/compact {trigger, preTokens, postTokens?}` |
| `result` | `claude-code/turn-completed`(由 agent 写入;被污染的回合带 `throwaway: true`) |
| `rate_limit_event`、助手的错误通知 | 由下面的暂停逻辑处理;不映射 |
| 其他任何消息 | `claude-code/unmapped {type}`,每个回合每种类型一次 |

上下文腐化信号可查询:每次压缩都是一个可检索的事件(`preTokens`、`postTokens`、`trigger`),回合数与压缩次数可由 `turn-completed` 与 `compact` 记录得出。

## 限额与熔断开关

- **席位限额**在条目上:`max_turns`(默认 25)与 `max_budget_usd`(默认 5,订阅下为名义值)作为 `maxTurns` 与 `maxBudgetUsd` 传给每次查询,达到任一上限的 result 会以带码错误结束回合(`CLAUDE_CODE_ERROR_MAX_TURNS`、`CLAUDE_CODE_ERROR_MAX_BUDGET_USD`)。`max_calls_per_window`(默认 120)限制席位在滑动的 `call_window_ms`(默认五小时)内启动的查询数;计数由本进程中该席位的所有 agent 共享,调用时间保存在 `<stateDir>/claude-code-call-windows.json` 中,因此重启和创始人重新播种(新的会话日志)都不会重置窗口;没有已保存时间的席位则从其日志重建(每个走到第一步的回合都计一次,时间取其日志时间)。`call_window_ms` 至少为 60000。超出上限的回合在认领任何东西之前就被拒绝:`claude-code/refused {reason: call-window}`、错误 `CLAUDE_CODE_CALL_WINDOW`,邮件保持排队。
- **熔断开关。** 驱动状态目录(位于 harness home 之内)中名为 `claude-code-kill-switch` 的标志文件,即 `<stateDir>/claude-code-kill-switch`。每个回合开始前、查询启动前再看一次、运行中流的每条消息,以及实时回合期间每 500 毫秒都会检查,因此在某个长工具调用运行期间设置的开关同样会中止查询。文件存在期间回合被拒绝,写入 `claude-code/refused {reason: kill-switch}`,错误为 `CLAUDE_CODE_KILL_SWITCH`,邮件保持排队;如果它在回合中途出现,运行中的查询会被中止,回合以同样的错误结束,该回合邮件的租约失败(开关被发现时已被认领的邮件是失败处理,而不是重新排队)。无法检查的文件,或抛出异常的注入检查,都视为存在(失败即关闭)。检查只是普通的文件测试;主机横幅与逐工具调用检查属于后续切片。

## 工具、选项与取消

- 每次查询都设置 `settingSources: []`、`strictMcpConfig: true`、`permissionMode: 'dontAsk'`、`maxTurns`、`model`、固定的 `pathToClaudeCodeExecutable` 与已清洗的 `env`。`lead` 与 `mail-only` 席位为 `tools: []`;`coder` 席位为 `Read, Grep, Glob, Edit, Write`。原生 `Bash` 与 `AskUserQuestion` 始终在 `disallowedTools` 中。
- 策略扩展(`ctx.claudeCodePolicy.extend`,包装为 `QueryOptionsExtension`)返回 `{settings?, mcpServers?, allow?}`,并收到一个 `PolicyQueryContext`(seat、role、config、cwd、binding、`isTurnTainted()`、`markTurnTainted(reason)`、`deliveredTraceIds()`)。`mcpServers` 必须恰好是键为 `dsh`、名为 `dsh` 的一个进程内 `sdk` 服务器(不允许 stdio、http 或 sse)。`allow` 条目必须通过严格语法,否则整个扩展被拒绝:`mcp__dsh__<name>`(`^[a-z][a-z0-9_]{0,63}$`,且必须同时提供 dsh 服务器)、`Read(//<cwd>/**)`,以及仅限 coder 的 `Edit(//<cwd>/**)`,其中 `//` 表示绝对路径、`<cwd>` 是席位自己的工作目录;若 cwd 含空格、控制字符或 `* ? [ ] ! # { } \` 中任一字符,或以 `/` 结尾,则不接受任何路径条目。没有 `canUseTool`:在 `dontAsk` 加生成的允许规则下它永远不会被调用,因此各层是拒绝/允许规则、仅拒绝的 PreToolUse 钩子,以及下面的 init 断言。`settings` 仍按白名单过滤:只保留 `hooks` 与 `permissions.deny` / `permissions.ask` 字符串列表,其余一切(`settings` 内的允许规则、目录、默认模式、设置文件路径)都会被丢弃并给出警告。钩子校验很严格:只接受已知事件名,每个处理器必须是 `{type: "command", command: <string>}`(可带数值 `timeout`)。`prompt`、`agent` 与 `http` 处理器会发起模型调用或把工具输入发往机器之外,因此任何其他类型或多余的键都会使整个设置对象被拒绝、查询不会启动,因为只应用一部分的策略比没有策略更糟。它在围栏之前应用,因此无法放宽围栏,最后还会再次检查成品选项不含被禁止的环境变量名且模型在允许范围内。
- **Init 断言。** 每条 `system/init` 消息所报告的 `tools` 必须与预期集合(角色的原生工具加上允许的 `mcp__dsh__<name>` 条目)按集合严格相等;否则查询被中止,写入一条 `claude-code/refused` 记录(原因 `admission`,详情 `tool set mismatch ...`,即现有最接近的记录),回合以 `CLAUDE_CODE_TOOL_SET` 结束,邮件租约失败。因此暴露的工具多于其 `allow` 列表的策略服务器会响亮地失败。一次性(被污染邮件)查询必须是空列表。
- **自动记忆**通过向每个非一次性查询的内联设置加入 `autoMemoryEnabled: false` 来关闭(SDK 的 `Settings.autoMemoryEnabled` 开关,无论 `settingSources` 如何都会加载)。尚未经过实机验证;实机探测必须确认 CLI 遵守它。一次性查询完全不带设置,也没有工具可触及记忆目录,因此那里不设该开关(残余风险:CLI 仍可能把记忆索引注入其提示)。
- **取消**会中止控制器、调用 `query.close()`(try/catch),然后让子进程的进程组退出:先由子进程所有者执行 SIGTERM 再 SIGKILL 的阶梯,若无法证明进程树已消失则直接对进程组发 `SIGKILL`。回合以 `aborted` 结束,除非设置 `keepInbox`,否则清空收件箱。
- **进程所有权:**子进程通过共享的子进程所有者在独立进程组中启动。每个席位的子进程(一个席位可保留多条)记录在 `<stateDir>/claude-code-seat-pids.json`,包含子进程的 pid 与启动时间、宿主的 pid 与启动时间以及内核 boot id。文件以原子方式写入(独占临时文件,模式 `0600`),若是符号链接、属于他人、对组或其他用户开放或已损坏则拒绝,错误信息会给出路径与补救办法。插件启动时,仅当 boot id 一致、启动时间仍然匹配且其所属宿主已不存在时,`ProcessLedger.reapStale()` 才会杀死已记录的子进程。来自更早一次启动的条目会被丢弃;所属宿主仍然存活的条目保持不动并给出警告;首进程已死但进程组仍有成员的情形只报告、不杀死;一次杀进程失败不会中断整个过程。所属宿主仍然存活的条目、杀进程失败的条目以及仍有存活进程组的条目会保留在文件中,供下一次启动再次检查。

## 环境

子进程环境是已清除凭据的父环境,再去掉 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 与 `CLAUDE_CODE_OAUTH_TOKEN`。名称按家族拒绝(不区分大小写,启动时与每个回合):所有以 `ANTHROPIC_` 开头的名称,所有以 `CLAUDE_CODE_USE_`(包括 `_ANTHROPIC_AWS` 与 `_ANTHROPIC_GOOGLE_CLOUD`)或 `CLAUDE_CODE_SKIP_` 开头的名称,任何包含 `BASE_URL`、`OAUTH`、`AUTH`、`CERT`、`PROXY` 或 `EXTRA_BODY` 的 `CLAUDE_CODE_*` 名称,任何包含 `KEY`、`TOKEN`、`PASSWORD` 或 `SECRET` 的 `ANTHROPIC*` / `CLAUDE*` 名称,以及 `CLAUDE_CONFIG_DIR`。有三个名称虽属某个家族但被明确放行,因为它们只切换本地工具或停止写本地历史:`CLAUDE_CODE_USE_NATIVE_FILE_SEARCH`、`CLAUDE_CODE_USE_POWERSHELL_TOOL`、`CLAUDE_CODE_SKIP_PROMPT_HISTORY`。若宿主本身是从 Claude Code 会话中启动的,它带有 `CLAUDE_CODE_MESSAGING_TOKEN`,会被拒绝:请从普通 shell 启动 dsh 宿主。只要宿主环境中设置了其中任何一个,插件拒绝启动,每个回合也拒绝运行。

## 订阅窗口暂停

SDK 没有专门的"限流"result 子类型。驱动把以下情形视为窗口被拒绝:`rate_limit_info.status` 为 `rejected` 的 `rate_limit_event`(`overage` 类型或 `credits_required` 记为 `usage-exhausted`,否则为 `rate-limit`)、带 `error: 'rate_limit'` 或 `'billing_error'` 的助手消息,以及 `api_error_status: 429` 的 result。当请求正按超额额度(`isUsingOverage: true`)处理,或非 overage 窗口被拒绝但超额仍被允许(`overageStatus` 为 `allowed` / `allowed_warning`)时,被拒绝的窗口不算暂停;被拒绝的 `overage` 窗口无论 `isUsingOverage` 为何值都算暂停,没有超额余量的拒绝同样如此。席位追加 `claude-code/paused {reason, until?}`,停止查询,以 `CLAUDE_CODE_PAUSED` 码使回合失败,并在重置时间之前(未报告时为 `defaultPauseMs`,15 分钟)拒绝后续回合,邮件保持排队。窗口上限为 24 小时,仍然有效的暂停会在重启后重新构建席位时从日志中恢复。这只是单席位信号;全队暂停属后续切片。

## 写入的持久记录

`claude-code/session-bound`、`claude-code/resume-failed`、`claude-code/steer`、`claude-code/paused`,以及每回合一条 `claude-code/turn-completed`(仅从 `result` 的命名字段映射),另有映射器记录 `claude-code/tool-call`、`claude-code/thinking`、`claude-code/compact`、`claude-code/unmapped`,邮件记录 `claude-code/mail-claimed` 与 `claude-code/mail-outcome`,以及 `claude-code/refused`、`claude-code/throwaway-turn` 和 `assistant/message`。回合索引就是 dsh 回合号,因此跨重启持续递增,满足记录不变量。

## Known Limitations and Deferred Work

- **租约与准入的提供方只是接缝** — 驱动调用注入的租约接收器与准入检查;接入邮箱桥的真实租约以及注册表的准入发送者类别(例如让创始人经邮箱发来的邮件被放行)属于后续切片。在此之前,默认准入会拒绝所有来自非名册席位发送者的邮件。
- **污染按会话粘滞,只标注、不强制** — 污染性工具(`Read`、`Grep`、`Glob`、`WebFetch`、`WebSearch`)或策略的 `markTurnTainted(reason)` 会写入一次 `claude-code/session-tainted`;恢复时从日志还原,会话余下部分 `isTurnTainted()` 一直为真。只有全新会话(主机重新播种会产生新日志)才能清除。`compact_boundary` 不会清除它:SDK 无法确认摘要已丢弃被污染的文本,驱动绝不假设这一点。策略的邮件工具读取该标志来给发送加标签;标注不会拒绝发送。
- **在 S6 与 S7 报告就绪之前,`coder` 保持被拒绝。** 只有沙箱、金丝雀与规则钩子三个贡献者全部注册后,策略服务才会列出 `coder`;目前一个都不存在。
- **守卫钩子在崩溃、超时或缺少 node 时失败放行**(只有退出码 2 才会拦截);S7 启动金丝雀是结构性的兜底,在它出现之前,`lead` 席位(没有文件工具)是唯一被接受的带工具角色。
- **没有 `canUseTool`** — 权限回调被有意从该接缝中去除。
- **熔断开关按回合和按流消息检查** — 尚未逐工具调用检查,也没有主机横幅。
- **经注册表路由的席位需要两方各改一处** — 注册表条目(雇用脚本或组织看板)与主机条目(创始人,在 profile 中);只有条目没有主机条目会被拒绝,而"主机条目是否有注册表条目"的检查在挂载后不久只运行一次,因为注册表在挂载之后才加载。
- **git 围栏与沙箱 shell 尚未接入** — 策略接缝已存在,但 coder 席位没有 shell,且尚未对真实 CLI 运行实机探测(规则匹配、钩子匹配器以及 `tools: []` 时的 init 工具列表无法离线测试)。
- **转录检查依赖 SDK** — `getSessionInfo` 无返回会被视为转录缺失,因此没有可提取摘要的转录同样会被拒绝。
- **操作者环境的透传** — `HTTPS_PROXY`、`HTTP_PROXY`、`NODE_EXTRA_CA_CERTS`、`NODE_OPTIONS` 与 `CLAUDE_ENV_FILE` 不会被清除:它们属于操作者自己的环境。代理加自定义 CA 可以读取登录流量,`NODE_OPTIONS` 或 `CLAUDE_ENV_FILE` 可以在子进程中运行代码;请保持宿主上这些变量干净。
- **斜杠命令封装只对驱动做过测试,未对真实 CLI 验证** — 封装后的提示永远不会以 `/` 开头;真实 CLI 如何处理提示中间的斜杠词,以及 `@path`、`!` 与 `#` 前缀展开,等待实际演练确认。
- **在没有完成任何回合时转录缺失,会沿用同一 id 继续** — 这是设计使然:从未完成过回合的会话可以用其已记录的 id 重新开始,因为没有丢失任何内容。
- **工作目录由调用方提供** — 它必须已经是自己的 realpath;对经注册表路由的席位,它还必须等于主机条目中的 `cwd` 固定值。
- **全队限额** — 单席位调用窗口已在此强制执行;全局并发查询上限、每小时回合上限、按发送者限流与乒乓熔断属后续切片。

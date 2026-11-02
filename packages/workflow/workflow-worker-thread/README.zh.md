# @deepseek-ai/dsh-workflow-worker-thread

[English](README.md) | 中文

本包为 `WorkflowEngine` 提供实现，每次运行使用一个 Node worker thread。worker 执行编排脚本；子 agent（智能体）留在宿主上，脚本通过带类型的宿主／worker 协议经由 `ctx.subagents` 访问它们。

包根目录默认导出引擎插件及其 `Config`；worker 协议、运行时和会话模块均为实现私有。操作入口 `./worker` 仍是引擎的 spawn 目标。

这种拆分只有一个主要目的：同步脚本循环不能阻塞 harness 事件循环，忽略取消的脚本可以连同其 worker 一起终止。它不是安全沙箱。

## 信任与隔离边界

工作流脚本由模型编写，信任前提与模型已有的 bash 访问相同。worker 内的 `node:vm` 是塑造 API 的机制，不是安全边界：逃逸的脚本可以用宿主进程权限重新取得 Node 能力。

worker 仍提供实用的隔离：

- 脚本 CPU 工作和同步自旋不会占用宿主事件循环；
- `worker.terminate()` 为 dispose（资源释放）提供真实的最终停止手段；
- 除未构建 loader 所需的衔接配置外，worker 以空环境启动，因此环境凭据不会通过 `process.env` 跨越边界；
- 宿主/worker 消息使用结构化克隆数据，并在脚本边界执行普通 JSON 校验。

真正的不可信脚本沙箱需要在同一工作流 seam 背后采用不同引擎。

## 脚本约定

工作流的 `meta` 是宿主提供的数据，而不是待求值的脚本文本。引擎会校验必需的 `name` 和 `description`、拒绝未知字段，并在返回运行前检查脚本正文能否解析。

在 worker 内，脚本会收到 `args` 以及以下钩子：

- `agent(prompt, { label, phase, schema, model })` 启动一个宿主侧 subagent。提供 schema 时返回结构化值，否则返回最终文本。普通子 agent 失败会产生 `null`；
- `parallel(thunks)` 在已配置的并发限制下运行 thunk；
- `pipeline(items, ...stages)` 在没有跨阶段屏障的情况下传递 `(previous, item, index)`；
- `phase(title)` 和 `log(message)` 发出观察器叙述；
- `bash(command, { nodeId, workdir, timeoutMs, env, inputs, retry })` 在 host 侧运行命令，返回 `{ exitCode, signal, timedOut, aborted, stdout, stderr, truncated, stdoutBytes, stderrBytes, durationMs }`。只有持有方以 `bashEnabled: true` 启动运行时才存在。`env` 可携带 `WF_*` 节点输出变量；`retry: { maxAttempts, delayMs }` 由引擎应用，只会重跑超时触发的命令；
- `approve({ nodeId, message, timeoutMs })` 返回结果字符串：`allowed-once`、`rejected`、`cancelled` 或 `unavailable`。等待上限为一小时，到期视为拒绝；
- `cancel(reason)` 取消运行并抛出引擎的 `CANCELLED` 错误；
- `nodeStart(nodeId, kind, { gate })`、`nodeEnd(nodeId, { status, exitCode, durationMs, truncated, output, error })`（接受 `output`，但绝不写入事件） 与 `gate(nodeId, gateKind, outcome)` 报告节点进度；节点 id 须匹配 `^[a-z0-9_-]{1,64}$`；
- `agent()` 还接受 `nodeId`、`tier`（未给 `model` 时通过 `tierModels` 解析）、`timeoutMs` 与 `idleTimeoutMs`（均由子 agent 监督器执行）、`retry: { maxAttempts, delayMs }`（引擎只会重跑启动失败，或以 `timeout`／`stalled` 结束的子 agent；每次尝试都是独立配对的 agent 调用），开启 bash 后还接受 `doneWhen: { command, workdir, timeoutMs, maxContinuations }`；`evidence(nodeId)` 返回某节点最后一份已耗尽的 done-when 证据，没有则返回 `null`。

未知选项、格式错误的参数、不支持的 schema、超出上限、提供方启动失败和基础设施结果失败都属于致命工作流错误。有意不注入 timer、文件系统 API 或 Node 全局变量，但上述信任注意事项仍然适用。

## 运行顺序

`start()` 会校验 meta、解析脚本正文、解析一个已注册且规范化的提供方路由，并解析每次运行的子 agent 总数上限，然后才创建 worker 或发布 `workflow/start`。请求的 `maxTotalAgents` 必须是正安全整数，且不能超过引擎配置的部署上限。源代码模式通过 data URL bootstrap 安装 TypeScript 转换；构建模式把同级 `lib/worker.cjs` 作为文件系统路径传入，因为 pkg 的虚拟文件系统（VFS）钩子要求 CommonJS。两者都能在普通 Node 下运行。ready/go 握手可以避免启动信号取消与 worker 启动发生竞态，导致脚本最初的同步片段被执行。

对于每次 `agent()` 调用：

1. worker 发送 `child-start`，其中包含普通数据提示词和选项。
2. 宿主通过异步 `SubagentRuntime.start` 调用启动请求中指定的提供方，否则调用已配置的提供方；调用会传入工作流父级和该次运行共用的唯一中止信号。提供方选择应用于该次运行的每个子 agent，对脚本不可见。
3. 如果启动被拒绝，宿主会发送 `child-start-error`；提供方启动已经完全停稳，不会发出子 agent 生命周期事件。
4. 如果启动兑现时工作流仍接纳工作，宿主会记录该运行、观察 `result`，然后发送 `child-started`。即使结果已经结算，也只会随后转发，以保持先启动、后结果的顺序。
5. worker 发出成对的 `workflow/agent-start` 和 `workflow/agent-end` 叙述，并在收集后请求 dispose 子 agent。

提供方启动与已发布子 agent 分开跟踪。如果启动仍在等待，而取消、worker 死亡或正常工作流结算关闭了接纳，共享信号会中止该启动。即便提供方随后兑现，宿主也会 dispose 它，且绝不向 worker 通知。

## Host 钩子与监督器接入点

`bash()`、`approve()` 与节点观察器都是协议 RPC（`bash-start`／`bash-result`／`bash-error`、`approve-start`／`approve-result`、`node-start`、`node-end`、`gate`）；worker 自身不运行任何命令（由 host 的执行器运行）。host 在执行器运行之前会重新校验每个 `bash-start`（拒绝清单、`WF_` 映射、大小限制、workdir 的 realpath 限定在 `WorkflowStartRequest.cwd` 之内），并把每条命令和每个未决审批当作待完成的 host 工作跟踪，因此 dispose 会等待进程组终止。与子 agent 共用的中止信号也会终止每条运行中命令的整棵进程树，并把所有未决审批置为 `cancelled`。

遗留节点清扫（`endStrandedNodes`）与 `endStrandedAgents` 一起在每条终止路径上运行，因此 `workflow/node-end` 与 `workflow/gate` 会在 `workflow/end` 之前配对。

`WorkflowStartRequest.gateManifest`（`{ nodeId, gateKind }[]`，门的唯一权威；同一节点可有多个门，按类型跟踪，worker 的 `nodeStart` 不能新增或更改） 预先声明已编译工作流的关卡，因此在每条终止路径上，从未启动的节点上的关卡都会被报告为 `not-reached`。

留给监督器的接入点都位于 `WorkflowStartRequest` 上，由 `host.ts` 中的 `WorkerRun` 实现：

- `supervisor.register(child)` 在 `startChild` 内、`subagents.start` 之前运行；此时会话 id 未知，请以 `callId` 为键；
- `supervisor.bind(child, childId)` 对每个已发布的子 agent 运行一次，每次续跑迭代再运行一次；`childId` 等于该子 agent 的 `subagent/start` `info.id`，这就是停滞看门狗的关联点；
- `supervisor.evaluate(child, outcome, tools)` 在设置了 `doneWhen` 时于每个子 agent 结果之后运行。返回失败证据则继续，返回 `undefined` 则接受。`tools.runBash` 与脚本的 `bash()` 一样经过校验、限定范围并与中止信号关联。循环由引擎负责：它限定上限（默认 3，最高 8），写入 `iteration` 与 `maxContinuations`，把尾部截到 8192 个字符，组装下一个提示词（`composeContinuationPrompt`，证据标为不可信数据）并启动全新子 agent。耗尽时返回 `stopReason: 'done-when-exhausted'` 并带有 `continuation.evidence`；
- `supervisor.release(child, childId)` 在每个子 agent 结算、dispose 或被拒绝时恰好触发一次；
- `onBashOutput` 接收运行的每个命令输出数据块，供运行存储转存；
- `approver` 是由存储支撑的审批代理的接入点；`WorkerRun.pendingApprovals()` 与 `decideApproval()` 服务于在 approver 之外作答的 UI。

`register`/`bind`/`release` 抛出的异常会被记录并忽略。`evaluate` 抛出或被拒绝（包括 done-when 检查被 bash 预算或并发上限拒绝）会被视为失败的检查，尾部为 `done_when check could not run: <原因>`，因此走正常的续跑与上限路径，耗尽时节点带着该证据失败；绝不会被当作“无意见”而接受。设置了 `doneWhen` 却没有可评估的监督器（仅在调用方安装了不含 `evaluate` 的监督器时）时会被明确拒绝（`child-start-error`），绝不会被悄悄接受。本包不会在 agent 的 turn 停止事件上注册任何监听器；有一项测试会扫描源码以保证这一点。

`createWorkflowChildSupervisor(options)` 是默认监督器（`WorkflowStartRequest.supervisor` 会将其替换）。它把 `timeoutMs` 作为绝对截止时间（`handle.stop('timeout')`），把 `idleTimeoutMs` 作为停滞看门狗（`handle.stop('stalled')`）：看门狗是普通的 `setTimeout`，每当子 agent 的会话日志有新追加就重新计时（宿主会转发已绑定子 agent id 的 `session/event`），并在工具调用进行期间暂停（`tool/call` 开始、`tool/result` 结束，按 `callId` 配对）。它不复用绑定迭代器的 `idleWatchdog`。`evaluate` 通过 `tools.runBash` 运行 `doneWhen` 命令，并把非零退出、超时或被中止的检查作为失败证据返回（尾部为 stdout 加 stderr）；上限由引擎循环负责。未先 `register` 就 `bind` 会抛出明确的错误（宿主会记录它，该子 agent 随后不受监督）；`release` 幂等，并清除两个定时器与订阅。没有 `observe` 数据源时只有截止时间生效。 脚本未给出 `timeoutMs` 的子 agent 会获得默认一小时的绝对截止时间（上限 24 小时），因此没有任何东西会无限期运行。子 agent 的结果到手后，`evaluate` 会在 done-when 检查运行前停止两个定时器。done-when 检查与脚本的 `bash()` 共用同一组上限（并发 8、每次运行 1000）。远程运行的追加事件不会到达本进程，因此只启用截止时间（停滞看门狗关闭）。

## 值边界

离开脚本的值会经过 `materializeFromRealm`；该函数接受普通的无损 JSON 数据，并拒绝特殊原型、函数、symbol、循环、稀疏数组、非有限数和嵌套 `undefined`。遍历在 worker 内执行，并把对象键定义为数据属性，使 `__proto__` 无法改变原型。

子 agent 结果从宿主跨越到 worker 之前，会先投影并制作快照。这是真正近似进程的序列化边界；它有意不同于可信的同进程工作流和 subagent 事件 payload，后者以不可变方式借用值。

## 取消与 dispose

`WorkflowRun.cancel()` 会记录第一个原因、通知 worker 取消、中止每个待处理及已发布子 agent 共享的唯一信号，并启动 `disposeGraceMs` 定时器。worker 钩子会在下次 await 时抛出 `CANCELLED`。如果运行到期限仍未结算，宿主会将其以已取消状态兑现、为悬空的子 agent 生命周期事件配对，并终止 worker。

subagent seam 只有一个取消通道：请求信号。不存在单独的子 agent 取消 RPC。已发布子 agent 使用 `run.dispose()` 清理；待处理的提供方启动在其 promise 拒绝或兑现前仍由提供方负责。

正常结算也会中止待处理启动，并在结果对外结算前开始 dispose 所有已发布但无需等待的子 agent。宿主的完全停稳条件同时包括待处理启动和已发布子 agent 的 dispose，因此清理不会遗漏异步启动事务。

`dispose()` 是幂等的。它会取消运行、立即启动宿主驱动的 dispose、在同一宽限时间内等待结果和子 agent 完全停稳、无条件终止 worker，并执行最后一次幸存项扫描。每个子 agent 的 dispose 都会记忆化，使 worker RPC、宿主取消、死亡清理和公开 dispose 都汇入同一操作。

## 结果与事件保证

在宿主的结果确认点，终态结果遵循先到者胜。已接受的外部取消会覆盖后到的非取消 worker 结果；先完成确认的结果或 worker 死亡不能被可重入清理回调改写。

worker 错误、消息失败或提前退出会在清理前关闭消息接纳，然后以 `error` 兑现；如果取消已经接管该运行，则不覆盖取消。后到的排队消息无法在该逻辑边界后创建子 agent 或发出叙述。

宿主会维护已转发子 agent 启动的台账。优雅退出的 worker 会提供对应的结束事件；死亡或强制终止会把缺失的结束事件合成为已取消。因此，每个已转发的 `workflow/agent-start` 都会且只会配对一次，不过已经到达的工作流结果之后的清理可能稍后才完成。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `provider` | `spawn` | `agent()` 使用的宿主侧 subagent 提供方。 |
| `maxConcurrentAgents` | `0` | 并发 `agent()` 上限；`0` 会根据可用 CPU 并行度解析。 |
| `maxTotalAgents` | `1000` | 一次运行中的 `agent()` 调用总数。 |
| `maxItemsPerCall` | `4096` | 一次 `parallel()` 或 `pipeline()` 调用接受的条目数。 |
| `syncTimeoutMs` | `5000` | 脚本最初同步片段的 VM 超时时间。 |
| `disposeGraceMs` | `5000` | 强制结算/终止之前的期限，也是公开 dispose 的期限。 |

bash 的限制是固定常量而非配置：每个流捕获 64 KB 输出，默认超时 120 秒、上限 600 秒，每个环境变量 128 KB、总计 256 KB。

负责该引擎的消费方可以为一次运行设置 `WorkflowStartRequest.subagentProvider` 和 `WorkflowStartRequest.maxTotalAgents`。它们属于引擎级策略，不是脚本钩子或面向模型的选项；普通 `workflow` 工具不会设置两者。每次运行的子 agent 总数上限可以降低、但绝不能提高已配置的 `maxTotalAgents` 上限。

## 模型体验

### 子 agent 请求

#### 模型看到的内容

脚本每次调用 `agent()`，都会把提示词原样发送给 subagent 提供方，并附带可选模型或结构化输出 schema。每个子 agent 看到该提供方自己的上下文；phase 和 log 叙述只留在观察器事件中。

#### Token 影响

可能需要为许多独立子 agent 上下文支付 token 成本，数量受 `maxConcurrentAgents`、`maxTotalAgents` 和 `maxItemsPerCall` 限制；这些上下文绝不会直接加入父级历史。

#### KV Cache 影响

与父级请求缓存和同级子 agent 缓存相互独立。每个子 agent 只能在其自身提供方、模型、提示词和 schema 下复用逐字节相同的前缀；其后续历史仅追加增长。

### 父级工具结果（间接）

#### 模型看到的内容

通过 [`dsh-tool-workflow`](../tool-workflow/README.md)，成功结果只会在该消费方的包装层中公开实体化的最终 JSON 值和子 agent 数量。本引擎提供稳定错误，包括 `workflow script does not parse: <error>`、`invalid meta: <violations>`、`agent() requires a non-empty prompt string`、`agent() could not start a child: <error>`、`child agent run failed: <error>`，以及其精确的 `parallel()`、`pipeline()`、`phase()`、选项、schema 和 JSON 边界校验消息。中间子 agent 输出可供脚本使用，但不提供给父模型。

#### Token 影响

本引擎不会直接向父级添加 token。最终结果大小由工具消费方限制，并保留到压缩（compaction）为止。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **`bashEnabled` 不是安全边界**：它只决定钩子是否存在；逃逸 `node:vm` 的脚本无论是否启用 bash 都能访问 Node。
- **默认执行器以 host 权限运行**，并继承 `SSH_AUTH_SOCK`。
- **续跑子 agent 计入 agent 上限**。
- **脚本 `cancel()` 的清扫状态为 `interrupted`** 而非 `cancelled`。
- **host 体量上限**：每次运行最多 8 个并发、1000 次 `bash()` 调用，16 个待决、1000 次审批，1000 个节点，10000 个节点/门事件，200000 条 worker 消息；洪泛会使运行以错误结束。`supervisor.bind` 收到的句柄的 `stop('timeout'|'stalled')` 会使子 agent 结算，从而触发引擎 `retry`。
- **worker/vm 不是安全边界**：模型编写的代码可以逃逸 `node:vm` 并取得 worker 的进程权限；不可信代码部署需要独立进程或容器引擎。
- **每次运行都要支付一个 worker thread 的成本**：没有池、预热运行时或跨运行脚本缓存。
- **不注入默认可用的定时器、文件系统或网络，但逃逸代码仍可访问 Node**：这些缺失的全局变量属于可移植性 API 设计，而非隔离措施。
- **自建会话的 bash 子进程会幸存**：进程组会整体被终止，但调用 `setsid` 或双重 fork 脱离进程组的后代不受跟踪，宿主崩溃也可能留下孤儿进程（运行存储的中断运行清扫应写明"可能成为孤儿"，而不是"已终止"）。
- **没有 approver 的 `approve()` 回答 `unavailable`**：引擎自己从不弹出提问；持有方必须注入审批代理。
- **续跑的子 agent 只对监督器可见**：脚本侧的 `workflow/agent-*` 事件只列出一次 `agent()` 调用的第一个子 agent。
- **终止只能报告宿主观察到的启动**：`agentsStarted` 不包括因并发限制仍在 worker 侧排队、且在强制终止后无法得知的调用。
- **跨 realm 错误在脚本内无法通过 `instanceof Error`**：工作流作者必须根据 `name` 和 `code` 等稳定字段分支。

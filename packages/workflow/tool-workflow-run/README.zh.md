# @deepseek-ai/dsh-tool-workflow-run

[English](README.md) | 中文

面向模型的 **`workflow_run` 工具**与 **`ctx.workflowRuns` 宿主运行器**：执行 YAML 工作流定义（`<workflowsDir>/<name>.yaml`，由 [`@deepseek-ai/dsh-workflow-yaml`](../workflow-yaml/README.md) 解析），基于 [`ctx.workflowEngine`](../workflow/README.md)，并通过 [`@deepseek-ai/dsh-workflow-run-store`](../workflow-run-store/README.md) 记录每次运行。它与 [`@deepseek-ai/dsh-tool-workflow`](../tool-workflow/README.md) 并存，后者继续按原样运行模型编写的 JavaScript 脚本。

## 功能

- **工具。** `name`、`path`、`resume`、`cancel` 必须且只能给出一个，另有可选的 `inputs` 与 `dryRun`。`dryRun` 返回执行顺序、门禁清单和所有 shell 命令，且不启动任何东西（不调用 shell，不启动引擎）。编译与校验错误以带 `行:列` 位置的诊断返回，绝不返回堆栈。运行为前台执行；未完成的运行以错误结果返回，内容为状态行、节点表和门禁报告。结果 `data` 为 `{ report, nodes, hash }`。
- **运行器（`ctx.workflowRuns`）。** 每个进程中每个工作区一个存储句柄（目录来自 `workflowStoreDir(dshHome, workspace)`）。每个工作区同一时间只能有一个活动运行：第二次启动会被拒绝，并给出持有者的运行 id、工作流名称、开始时间和处理办法。每次启动都会在存储中固定源文本与哈希，因此运行中途编辑文件不会改变该次运行；当磁盘文件哈希与固定哈希不同时，`getRunView` 报告 `fileChanged`。
- **Shell。** 工作流的 `bash` 节点通过 `ctx.shell` 运行（不使用引擎自带的本地执行器），挂载了限制型 shell（bash-sandbox）时受会话沙箱策略约束；bash-local 忽略该策略，而已挂载的限制型 shell 若没有策略则拒绝运行，输出尾部保留 64 KB，完整 stdout 溢写到存储。
- **信任。** 首次运行未见过或被编辑过的哈希时会被拒绝，直到人工确认；确认文本展示工作区、每个 bash 命令（原样，控制字符和双向字符会被转义）、环境变量的键（绝不显示值）、每个 agent 的档位与模型、每个提示文件及其 sha256，以及完整的 64 位哈希，并说明工作流以与 agent 的 bash 工具相同的权限运行。信任键是 YAML 哈希加上提示文件摘要，并绑定到工作区；任何提示文件的修改都会重新询问。过长而无法安全展示的确认行会被拒绝而不是被截断。策略 `ask` 在哈希变化时重新询问；策略 `never` 拒绝任何未确认的哈希。已确认的哈希保存在存储目录下的 `trust.json`。
- **审批。** 先询问存储；仅当调用方 agent 有打开的回合时，才同时通过 `ctx.approval` 询问（由界面启动、父 agent 空闲的运行不会进入聊天）。先到的回答生效，另一路被取消。等待在 `approvalWaitMs` 到期后结束：审批标记为过期，节点被拒绝。无人值守会话、信任策略 `never`，或无人可回答的会话（没有打开的回合且没有连接的界面）会立即拒绝；原因与处理办法同时出现在工具结果、存储的审批记录和会话的门禁报告行中。
- **门禁报告。** 在每条终止路径（完成、失败、取消、worker 死亡、释放）上，运行器根据清单加存储记录为每个已声明的门禁生成一行（`fired-pass`、`fired-block`、`skipped`、`not-reached`、`never-evaluated`），并在存储中结束该运行。
- **恢复。** 只读取存储。仅当某节点成功、输出可恢复（完整输出或其溢写文件）且其所有依赖也被跳过时才跳过它。当某个会修改工作区的成功节点（bash、loop，或标记了 `mutatesCheckout` 的 prompt）输出不可恢复时，恢复会拒绝并指明该节点；若这样的节点已成功、但它依赖的节点没有可恢复输出（它将不得不再次运行），同样拒绝。恢复后的运行到达审批节点时，会重新创建待处理审批。
- **界面控制。** `attachUi()` 是显式的有人在场信号（返回释放函数；订阅并不算），`cancel(runId, reason, scope)` 接受 `CancelScope`（工作区，给定时还包括会话），对范围之外的运行与未知运行作出完全相同的应答；`dryRun(workspace, options)` 接受 `DryRunOptions`（`name`、`path`、`inputs`、`caller`），对不受信任的内容返回一次性 `trustChallenge`（五分钟，绑定调用方、工作区与信任键；每个调用方最多同时持有四个），`start` 必须将其与 `trustHash` 一同提交。已受信任的内容会忽略两者。
- **会话记录。** 通过 [`@deepseek-ai/dsh-tool-workflow`](../tool-workflow/README.md) 导出的记录器写入：`tool-workflow/run-start`、`agent-start`、`agent-end`、`node-start`、`node-end`（带 `truncated`）、`approval`（待定及每次决定，原因去除控制字符并限 500 字符）、`gate-report`、`run-end`，均为仅日志事件，以存储运行 id 为键。这些事件在回合之间合法，因此空闲的父 agent 无需打开的回合即可记录。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `toolName` | `workflow_run` | 面向模型的工具名称。 |
| `workflowsDir` | `.workflows` | 存放 `<name>.yaml` 的工作区相对目录；必须位于工作区内。 |
| `approvalWaitMs` | `3600000` | 审批最长等待时间（1 到 86400000 毫秒），到期后审批过期且节点被拒绝。 |
| `headless` | `false` | 无人可回答时为 true：审批节点立即被拒绝，并给出原因与处理办法。 |
| `trustPolicy` | `ask` | `ask` 对未见过的哈希确认一次；`never` 拒绝任何未确认的哈希。 |
| `tierModels` | `haiku` / `sonnet` / `opus` | `cheap`、`standard`、`premium` 三档对应的模型；命中禁用的模型家族会使插件在启动时失败。 |
| `retention` | `200` | 每个工作区保留的已结束运行数，超出后最旧的被清理。 |
| `dshHome` | `$DSH_HOME`，否则 `~/.dsh` | 存放运行存储的 harness 主目录。 |
| `maxResultChars` | `50000` | 渲染后的工具结果文本上限。 |

## 模型体验

### workflow_run 工具

#### 模型看到什么

工具 schema 加下方的描述。完成的运行返回状态行、节点表和门禁报告；失败或取消的运行以错误形式返回同样的文本。拒绝（写入者忙、哈希未信任、恢复被拒绝、输入无效）都会说明原因与处理办法。

##### 工具描述与使用指引

```markdown
Run a workflow defined as a YAML file in the workspace workflows directory (default `.workflows/<name>.yaml`). A workflow is a graph of nodes (`prompt`, `bash`, `loop`, `approval`, `cancel`) with dependencies, optional `when` conditions, retries, and hard gates (verifier, bash, approval, done_when, until_bash). Use it only when the user asks to run a named workflow, or when a workflow file already exists for the task.

Exactly one of these selects what to do:
- `name`: the workflow file name without `.yaml` (lowercase words joined by hyphens). `path` is an alternative: a workspace-relative path to a `<name>.yaml` file inside the workflows directory.
- `resume`: a run id. Starts a new run from that run's pinned source and skips nodes that already succeeded with recoverable output. It refuses, with a reason, if a successful node that changes the workspace has no recoverable output, or depends on a node that has none.
- `cancel`: a run id owned by this process. Cancels it.

Other arguments: `inputs` (object, values for the workflow's declared inputs; unknown or missing required names are rejected before anything runs) and `dryRun` (true returns the graph, the gate manifest and every shell command the workflow would run, and starts nothing).

A run is foreground: the call returns when the whole workflow finished. The result is a status line, a node table and a gate report (one row per declared gate: fired-pass, fired-block, skipped, not-reached or never-evaluated). Only one run per workspace may be active; a second start is refused and names the holder. The first run of an unseen or edited workflow asks the user to confirm the shell commands. Approval nodes wait for a human answer (up to the configured cap) and are rejected at once when the session is headless or approvals are disabled, with a reason in the report. The run is pinned to the file content at start, so editing the file during a run changes nothing about that run. Compile or validation errors come back as located `line:column` diagnostics: fix the YAML and call again.
```

#### Token 影响

在工具可见的每个请求上有固定的 schema 与描述开销（描述约 2 KB）。结果以 `maxResultChars` 为上限，并保留在上下文中直到压缩。

#### KV Cache 影响

只要工具名称、定义与可见性不变，前缀保持稳定。结果只追加，不会使较早的缓存条目失效。

## 已知限制与暂缓事项

- **仅前台运行** —— 调用会阻塞到工作流结束，没有后台启动与轮询 API。
- **每个工作区同一时间只有一个活动运行** —— 由存储写入锁保证；第二次启动被拒绝而不是排队。
- **`ctx.shell` 不支持流式输出** —— 输出接收端在命令结束时收到一个整块，因此长命令不显示中间输出。
- **agent 节点输出在运行结束时才记录** —— 引擎不逐节点转发，因此提前死亡的运行会使 agent 输出不可恢复：会修改工作区的节点会阻止恢复，不修改的节点会被重新运行。
- **信任信息保存在 `trust.json`** 中（位于存储目录），因为存储没有信任记录类型。
- **`mutates_checkout` 由作者声明**（针对 prompt 节点）；恢复的幂等性只是便利，不是安全边界。
- **Fable 模型检查是成本防护，不是安全边界** —— worker-thread 宿主会拒绝最终模型 id 或目录名称属于 Fable 系列的节点；它不防御把该系列藏在无关名称之后的提供方。
- **无人值守（headless）捆绑包** 会为本工具设置 `headless: true`，因此审批节点在那里立即被拒绝。
- **存储中的门禁行没有原因字段** —— 原因见审批记录、会话的门禁报告行以及工具结果。
- **远程 RPC 与 Workflows 界面接线** 属于其他切片；本包只暴露它们调用的服务 API。
- **空闲父 agent** —— 已验证：真实的 worker 线程引擎与 spawn 提供方可以运行父 agent 没有打开回合的工作流，记录器向该空闲会话追加事件也不会触发会话不变量。只有聊天审批镜像需要打开的回合，没有时会跳过。

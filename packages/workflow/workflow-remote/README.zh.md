# @deepseek-ai/dsh-workflow-remote

[English](README.md) | 中文

Workflows UI（OP-240）所使用的常驻挂载 Typert Remote 命名空间 `workflow`。`WorkflowRemoteService` 注册 `workflowRemote` 服务，并在 `workflow` 命名空间下发布其方法；线路契约位于 `src/wire.ts`（以 `./wire` 导出，并从包根重新导出），Typert 生成器从本包生成 `./typert` 与 `./remote` 产物。

本包拥有独立的 Loader 条目（挂载于 [`packages/bundle/web-app/cordis.patch.yml`](../../bundle/web-app/cordis.patch.yml)），原因与 [`@deepseek-ai/dsh-mcp-status`](../../mcp/mcp-status/README.md) 相同：当包的最后一个 Loader 条目卸载时，其 RPC 契约会被撤回，且 Gateway 不会回退，因此该命名空间不能依附于可能卸载的包。读取方法无需特权（`list`、`read`、`validate`、`dryRun`、`runs`、`runDetail`、`pendingApprovals`）；写入方法与原始节点输出为特权方法（`save`、`run`、`resume`、`cancel`、`nodeOutput`、`approve`、`reject`、`attachUi`、`detachUi`），列于 [`@deepseek-ai/dsh-connection`](../../client/connection/README.md) 的 `PRIVILEGED_METHODS`，因此只有 TCP 对端地址为回环（且 Host 头也为回环）的调用方才能访问；从不参考 `X-Forwarded-For`。每个方法都根据调用方会话解析其工作区，校验所有参数，并返回 `{ ok: true, ... }` 或不含堆栈与主机路径的纯文本失败。`save` 检查工作区 `workflows/` 目录内的包含关系，拒绝符号链接，原子写入，并比较乐观内容令牌。`run` 与 `resume` 需要 `dryRun` 为调用方签发的信任挑战（一次性，五分钟有效）；`run` 会重新读取当前文件，并拒绝内容已变化的计划，而 `resume` 运行的是随运行保存的固定副本，而不是现有文件。`attachUi` 与 `detachUi` 持有可续期租约，告知运行器有人在场。`cancel` 只能停止调用方会话自己启动的运行。推送事件仅携带标识与状态，且不含主机路径：`workflow/run-changed`（`WorkflowRunChange`）、`workflow/approval-pending`（`WorkflowApprovalPending`：运行、批准与节点标识，绝不含问题文本，问题文本由 `pendingApprovals` 返回）和 `workflow/approval-decided`（`WorkflowApprovalDecided`）。每个事件还带有不透明的 `workspaceKey`，与 `list`、`runs`、`attachUi` 返回的值相同，客户端据此忽略其他工作区的事件。发布后目录刷新失败的保存仍然成功，并附带 `warning`。

## 调用形态

浏览器代码从 `@deepseek-ai/dsh-workflow-remote/client` 导入契约（类型、常量、`WORKFLOW_LOOPBACK_ONLY_MESSAGE`、`explainWorkflowRefusal`、`explainWorkflowRejection`、租约时间）；它只重新导出没有值导入的 `src/wire.ts`（仅一条被擦除的纯类型导入用于锚定 cordis 事件扩充），因此无法触达任何 Host 模块。Remote 层会再包装一次方法结果，所以一次调用有以下几种结果：

- **成功** 为 `RemoteResult<{ ok: true, ... }>`，例如 `{ ok: true, value: { ok: true, leaseId: 'ab12...', ttlMs: 45000, workspaceKey: '0f3a...' } }`。
- **Host 报告的失败** 为 `{ ok: true, value: { ok: false, error: 'NOT_FOUND', message: '...' } }`；机器可读字段是 `error`（一个 `WorkflowErrorCode`），从来不是 `code`。`validate` 把无效草稿报告为不带 `error` 的 `{ ok: false, diagnostics }`，所以用 `error` 区分调用失败与校验结论。
- **载体失败**（特权方法上的 403、网络故障）为 `{ ok: false, error: { message: '... HTTP 403 ...' } }` 或一次拒绝，它不是 `WorkflowFailure`。把它们传给 `explainWorkflowRejection('workflow/save', cause)`：对特权端点上的 403 返回 `WORKFLOW_LOOPBACK_ONLY_MESSAGE`，否则返回 `undefined`。
- **`validate` 不接受会话参数：** 其请求为 `{ text, name? }`，其余每个方法都根据调用方会话解析工作区。

## 模型体验

无，因为这个仅限 Host 的 Remote 服务不注册任何提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **回环不是身份验证** —— 特权方法对局域网调用方返回不带正文的 403；`explainWorkflowRefusal` 在客户端提供面向创始人的解释。
- **回环之后没有调用方身份验证（既有缺口）** —— 此处以及 `settings.*`、`credentials.*` 等特权集合仅由回环对端与 Host 检查把关。在主机上拥有 shell 的模型可以自行调用这些端点，从而确认自己的信任挑战或批准自己的批准；目前 bash 工具的批准应答同样没有防护。堵住它需要模型无法获得的调用方令牌，本次不自行发明。
- **事件未在主机端按工作区限定** —— 主机事件流没有按订阅者过滤工作区的机制，所有已连接客户端都会收到各工作区的运行与批准标识；`workspaceKey` 让客户端过滤，但并不隐藏它们。
- **取消按会话限定** —— 运行只能由启动它的会话取消；同一工作区的其他会话视其为未运行。
- **租约会失效** —— UI 租约在 45 秒未续期后过期，此后批准回退到模型路径。
- **Web 应用包** —— 工作流引擎在其中被禁用，因此运行会报告不可用。

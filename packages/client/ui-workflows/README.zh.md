# @deepseek-ai/dsh-client-ui-workflows

[English](README.md) | 中文

面向 YAML 工作流的浏览器**工作流**界面（OP-240）。浏览器插件在会话头部的 `conversation.session.header.actions` 列表中（位于 Org Board 之后）注册一个本地化按钮，id 为 `workflows`、顺序为 45；并注册一个同 id 的 `shell.overlay` 条目。按下按钮会为该会话打开浮层；所有调用都以该会话的身份发往 Host 的 `workflow` Remote 命名空间（由 [`@deepseek-ai/dsh-workflow-remote`](../../workflow/workflow-remote/README.md) 提供，经 [`api-remotes`](../../api/remotes/README.md) 访问），因此工作区始终是该会话自己的工作区。插件专门等待 `remote.workflow`。

## 浮层功能

- **工作流标签页。** 列出工作区的工作流文件，带有效/无效标记、节点数与诊断数以及最近一次运行。打开文件时会连同保存令牌一起读取并校验（防抖、按需，且每次加载后都会校验）。*新建工作流*会填入模板，并以 `expectedToken: null` 保存。
- **编辑器。** 自带的 `WorkflowEditor`（文本框、行号栏、可点击的诊断）。保存时发送文件加载时的令牌。输掉竞争（`CONFLICT`）会触发编辑器的冲突状态并显示 Host 的消息与处理办法；**重新加载**会重读文件并丢弃未保存的修改，横幅上会如实说明。保存成功但目录刷新失败时，Host 的 `warning` 会以可见的*已保存，但有警告*提示显示，并按已保存处理。读取失败的文件显示失败原因，而不是空编辑器。
- **试运行与信任。** 试运行和运行都会打开*已保存*文件的计划（有未保存修改时会先要求保存）：执行顺序、按 Host 布局绘制的依赖图、门禁清单、逐字显示的每条 Shell 命令（含工作目录和所设环境变量的名称）、智能体节点、提示文件与警告。声明的输入有一个小表单；修改输入会使计划过期，直到刷新。已受信任的计划可直接运行。未受信任的计划会显示 Host 给出的确切 `confirmText`，在勾选确认框之前*信任并运行*保持禁用；随后的运行会携带 `trustHash`（计划的 `trustKey`）和 `trustChallenge`。挑战令牌只能使用一次：未受信任的启动被拒后，计划被标记为已用，并要求刷新。启动运行后会在运行标签页中打开它。
- **运行标签页。** 待处理的审批（*批准*、*拒绝*及可选原因）、按游标分页的运行列表，以及单个运行的详情：节点的状态、尝试次数、退出码与耗时，门禁报告、审批、输入、*文件在运行后已更改*提示，按 64 KiB 分片读取的节点输出，运行中可*取消运行*，已结束的可*恢复运行*。被拒绝的批准、拒绝、取消或恢复会一直显示 Host 的消息与处理办法，直到被关闭。
- **实时审批租约。** 打开浮层会调用 `attachUi`；每 15 秒续约一次（Host 的有效期为 45 秒），浮层关闭或卸载时用 `detachUi` 释放。头部显示*实时审批已连接*；否则显示*已中断*或*不可用*，并给出原因与处理办法。续约失败会立即显示*已中断*，下一个周期重新获取租约；续约一直没有回应时，在有效期耗尽时宣告中断。403 是终态（*不可用*，不再重试）。
- **事件。** `workflow/run-changed`、`workflow/approval-pending` 与 `workflow/approval-decided` 会发给每个已连接的浏览器，因此每个处理函数都会把事件的 `workspaceKey` 与 `list`、`runs`、`attachUi` 返回的键比较，忽略其他一切，包括没有键的事件。匹配的事件会刷新运行列表、工作流列表、待处理审批和已打开的运行；突发事件合并为一次进行中的刷新加一次排队的刷新。
- **仅限本机的调用。** `save`、`run`、`resume`、`cancel`、`approve`、`reject`、`attachUi`、`detachUi` 和 `nodeOutput` 对不在 Host 机器上的浏览器只会返回一个简单的 `403`。每次调用都在 `src/client/api.ts` 中折叠为一个永不抛出的结果；这些端点上的 403 会用 `explainWorkflowRefusal`（Host 的*仅限本机*说明）加一行处理办法来解释，绝不会只显示状态码。

## 引导测试用选择器

以下全部是 `data-*` 属性，没有类名。

| 区域 | 选择器 |
| --- | --- |
| 入口 | `[data-workflows-button]`（头部）、带 `data-workflows-tab="workflows\|runs"` 的 `[data-workflows-overlay]`、`[data-workflows-tab-button="workflows\|runs"]`、`[data-pending-approvals-count]` |
| 租约 | `[data-lease-indicator][data-lease-state="attaching\|attached\|lapsed\|refused\|detached"]`、`[data-lease-label]`、`[data-lease-reason]` |
| 失败 | `[data-failure][data-failure-scope="list\|editor\|dryrun\|run\|action\|detail\|output\|runs\|approvals\|lease"][data-failure-code]`，子元素 `[data-failure-message]`、`[data-failure-remedy]`、`[data-failure-dismiss]` |
| 列表 | `[data-workflow-list]`、`[data-workflow-row][data-workflow-name][data-workflow-valid][data-selected]`、`[data-list-refresh]`、`[data-new-workflow-name]`、`[data-new-workflow]`、`[data-new-workflow-problem="invalid\|exists"]` |
| 编辑器 | `[data-workflow-editor]`、`[data-editor-textarea]`、`[data-validate]`、`[data-save]`、`[data-dryrun]`、`[data-run]`、`[data-conflict]`、`[data-reload]`、`[data-diagnostic]`、`[data-save-ok]`、`[data-save-warning]`（`[data-save-warning-text]`）、`[data-save-first]`、`[data-editor-new]` |
| 试运行 | `[data-dryrun-view][data-dryrun-status]`、`[data-dryrun-refresh]`、`[data-dryrun-close]`、`[data-input-field][data-input-name]`、`[data-dryrun-stale]`、`[data-plan-list]` / `[data-plan-node][data-node-id]`、`[data-plan-graph]` / `[data-graph-node][data-node-id][data-node-kind][data-node-gate]` / `[data-graph-edge][data-from][data-to]`、`[data-gate-manifest]` / `[data-gate-entry][data-gate-node][data-gate-kind]`、`[data-trust-command][data-node-id]`（含 `[data-command]`）、`[data-trust-agent]`、`[data-plan-warning]` |
| 信任与运行 | `[data-trust-state="trusted\|untrusted"]`、`[data-confirm-text]`、`[data-trust-ack]`、`[data-run-start][data-trust-run="true\|false"]`、`[data-trust-spent]`、`[data-run-started][data-run-id]` |
| 运行 | `[data-run-list]`、`[data-run-row][data-run-id][data-run-status]`、`[data-runs-refresh]`、`[data-runs-more]`、`[data-pending-approvals]`、`[data-approval-row][data-run-id][data-approval-id][data-approval-state]`、`[data-approve]`、`[data-reject]`、`[data-reject-reason]` |
| 运行详情 | `[data-run-detail][data-run-id][data-run-status]`、`[data-detail-close]`、`[data-run-cancel]`、`[data-run-resume]`、`[data-file-changed]`、`[data-run-error]`、`[data-workflow-nodes]` / `[data-workflow-node][data-node-id][data-node-kind][data-node-status]`、`[data-node-output-button]`、`[data-node-output]`、`[data-gate-table]` / `[data-gate-row][data-gate-node][data-gate-kind][data-gate-outcome]` |

## 组合方式

本包把语言词典（`workflows`，含 `en` 与 `zh`）、头部按钮和浮层注册为 Cordis 副作用；卸载插件会同时移除这三者。浮层的控制器只在浮层打开期间存在，因此租约、定时器和事件订阅都随之结束。已发布的 Web 包只列出该插件一次，位于 `ui-org-board` 之后。

## 模型体验

无，因为本包是 Host 拥有的工作流状态之上的浏览器界面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- 运行详情嵌入了 `ui-workflow-run` 的节点列表和门禁报告（经其 `runDetailToNodeData` 由 `runDetail` 映射），因此节点状态显示为 `done` 而不是线上的 `success`，且门禁报告的原因列为空（线上的门禁视图没有该字段）。门禁报告默认折叠，除非有门禁阻止。
- 冲突的保存会把未保存的修改留在屏幕上，但只提供*重新加载*，而它会丢弃这些修改。
- 图是静态的分层绘制（无缩放和平移）；很宽的工作流需要滚动。
- 事件会发给每个已连接的浏览器并在此处过滤；Host 无法按订阅者限定范围。
- 与现有的特权方法一样，特权 `workflow` 调用依赖本机回环连接门禁；没有逐次调用的调用方令牌（见 `workflow-remote` 的限制）。

# @deepseek-ai/dsh-client-ui-workflow-run

[English](README.md) | 中文

这个浏览器插件把持久化的顶层工作流运行重建为独立 Chat 节点。它消费由 [`dsh-tool-workflow`](../../workflow/tool-workflow/README.md) 拥有的 `tool-workflow/*` Session 事件，注册一个 `ConversationNodeDefinition`，并通过 keyed `conversation.chat.node` slot 渲染，不改变现有工作流工具卡。

## 持久状态与回放

`tool-workflow/run-start` 以 `runId` 创建唯一 Context；成员开始、成员结束和运行结束事件按日志顺序更新该 Context。只有 update 的历史尾页会保持 pending，直到更早页面补入唯一 start；此后 prepend、完整回放和实时 append 得到相同状态。若所属 Turn 或 Step 已关闭但终点事件缺失，界面把相应运行或成员显示为已中断，而不改写工具结果。

阶段组只来自真正开始过的成员。完全相同的阶段字符串归入同一组，字段缺省与空字符串保持不同身份；成员结算只改变状态，不删除或重排成员。

## 展示与导航

运行和每个阶段都从当前生命周期事实派生 disclosure 控制。运行自身处于运行中、失败、已取消或已中断，或者任一阶段包含这些状态的成员时，运行保持展开；受影响的阶段也保持展开。强制展开的标题行只是静态展开行，不承诺按钮、键盘操作或 `aria-expanded`。阶段在全部成员完成时折叠一次；运行在自身和全部阶段都完成时折叠一次。每个干净层级随后恢复普通 disclosure 控件，其本地选择在干净状态的 rerender 中保持；新活动会重新取得控制，remount 则从当前数据派生初始状态。运行使用 32 像素 `--dsw-alias-bg-module-platform` 背景行，常驻向右／向下 chevron，并以内联状态点加状态文字表达结局，不使用胶囊。阶段使用 32 像素 disclosure 行，在可伸缩主区显示标题与成员数，在固定尾部精确显示聚合状态且不重复状态点。成员使用 16 像素状态点槽、可省略名称区和固定 64 像素状态列。

只有所有实时事实同时成立时，成员才可打开子 Session：成员仍在运行、子 id 位于普通 Session 列表、列表行为 `origin: 'subagent'`、`parentId` 等于当前 Session，且列表行仍标记运行。带下划线的成员文字是唯一可见导航提示；键盘聚焦时，名称区显示 2 像素 business-primary 焦点环，右侧状态仍只显示“运行中”。组件只调用注入的普通 `sessions.open(id)`；远程、仅地址化、父级不符或终态的行都不可交互。

## YAML 工作流节点与门禁报告

对 YAML 工作流运行，节点还会折叠 `tool-workflow/node-start`、`tool-workflow/node-end`、`tool-workflow/approval` 与 `tool-workflow/gate-report`。node-start 使该行变为 `running` 并记录开始时间；node-end 将其结算为 `done`、`failed`、`skipped`、`cancelled` 或 `interrupted`，同一节点后到的 node-end 会替换先前的记录（agent 节点的截断要到运行结束才知道）。运行结束时仍在运行的节点显示为 `interrupted`。每行（`data-workflow-node`、`data-node-id`、`data-node-status`）显示状态文字、退出码、耗时，以及来自事件 `truncated` 字段的输出截断标记。有审批记录的节点带 `data-approval-state`（`pending`、`allowed`、`rejected`、`expired`、`unavailable` 或 `cancelled`）及文字徽标，取自最新的 `tool-workflow/approval` 事件；决定是终局的，晚到的 `pending` 不会回退。审批原因（否则取门禁报告原因）原样显示，因此无头或无人应答的拒绝会连同补救办法一起呈现。没有 `run-start` 的运行所对应的事件会被忽略。门禁报告渲染在运行 disclosure 之后，是带标题的表格（`data-gate-table`），每个门禁一行：节点、类型、`fired-pass`、`fired-block`、`skipped`、`not-reached` 或 `never-evaluated` 的文字结果徽标，以及原因。默认折叠，若有门禁阻止则默认展开；切换按钮（`data-gate-toggle`、`aria-expanded`）仅在组件状态中按运行 id 记忆。普通 `workflow` 工具运行的渲染保持不变。

## 选择器

供测试与 pilot 使用的稳定 `data-*` 钩子：

| 选择器 | 含义 |
| --- | --- |
| `[data-workflow-node]` | 一个节点行；带 `data-node-id`、`data-node-kind`、`data-node-status`，有审批时还带 `data-approval-state` |
| `[data-node-attempt]` | “第 N / M 次尝试”标签，仅在节点运行了多次尝试时出现 |
| `[data-node-earlier-toggle]` / `[data-node-earlier-attempt]` | 重试节点的早先尝试展开按钮，以及展开后的每次早先尝试；早先尝试从不单独成行 |
| `[data-node-failure-code]` / `[data-node-failure-message]` / `[data-node-failure-remedy]` | 监督器的终止原因（`NODE_STALLED` 或 `NODE_TIMEOUT`）、其消息与补救办法，均为纯文本 |
| `[data-node-reason]` / `[data-node-truncated]` | 原样的审批或失败原因，以及输出截断标记 |
| `[data-gate-report]` / `[data-gate-toggle]` / `[data-gate-table]` / `[data-gate-row]` | 门禁报告、其切换按钮、表格与行；行带 `data-gate-outcome` |

## 可嵌入的运行视图

客户端入口（`@deepseek-ai/dsh-client-ui-workflow-run/client`）还导出 Workflows 浮层嵌入的组件，避免重复渲染相同事实：`NodeList`（`nodes`、`t`）、`NodeRow`（`node`、`t`）、`ApprovalBadge`（`state`、`t`）以及受控的 `GateReport`（`rows`、`open`、`onToggle`、`t`），其中 `t` 是 `workflowRun` 命名空间的翻译函数。`runDetailToNodeData(detail)` 是纯映射函数，把 `runDetail` 结果体（`nodes`、`gates`、`approvals`）转换为 `{ nodes, gateReport }`：节点状态 `success` 显示为 `done`，未知状态为 `interrupted`，未知审批状态为 `unavailable`；节点取其最新审批，原因取审批原因，否则取节点错误，并限制在 500 个字符内。由会话事件生成的 Chat 投影保持不变。

这些组件同时以客户端服务 `ctx.workflowRunView`（注入键 `workflowRunView`，契约类型 `WorkflowRunViewContract`）提供，成员为 `NodeList`、`NodeRow`、`ApprovalBadge`、`GateReport` 与 `runDetailToNodeData`。其他 UI 插件把 `workflowRunView` 写入自己的 `inject` 数组，并且只从 `/client` 入口导入类型，因为客户端 bundle 纯净性检查禁止对其他插件入口做值导入。该服务随本插件的 fiber 存亡。

## 装配

本包把 Definition、locale 字典和 `workflow-run` renderer 都注册为 Cordis effect；移除客户端 entry 会撤销三者。shipped Web bundle 在 `ui-conversation` 与 `ui-tool` 之后装配该插件。

## 模型体验

无，因为本包只为人类展示持久 Session 事实，不增加 prompt、工具 schema、请求内容或模型可见结果。

#### KV Cache effect

无。

## 已知限制与暂缓事项

- 只有经 `dsh-tool-workflow` 发起的顶层调用会生成这些记录；嵌套 Code Mode 调用和直接 `WorkflowEngine` 消费方不会生成。
- 导航刻意只面向实时运行。终态成员继续保留供复盘，但本节点永不为其提供冷 Session 入口。
- 节点只显示运行、阶段、成员身份、节点、审批与门禁报告事实；脚本、输出、错误、日志、用量、静态拓扑和控制操作都不属于本界面。

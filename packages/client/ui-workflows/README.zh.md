# @deepseek-ai/dsh-client-ui-workflows

[English](README.md) | 中文

面向 YAML 工作流的浏览器**工作流**界面（OP-240）。浏览器插件在会话头部的 `conversation.session.header.actions` 列表中（位于 Org Board 之后）注册一个本地化按钮，id 为 `workflows`、顺序为 45；并注册一个同 id 的 `shell.overlay` 条目，在按钮将其打开时显示工作流面板。两处注册共用同一个开关状态存储，并专门等待由 [`@deepseek-ai/dsh-workflow-remote`](../../workflow/workflow-remote/README.md) 提供的 `workflow` Remote 命名空间，经 [`api-remotes`](../../api/remotes/README.md) 访问。

当前版本只是包脚手架：浮层展示占位面板。工作流列表、图（`@xyflow/react`，与 [`ui-org-board`](../ui-org-board/README.md) 使用相同版本范围）、YAML 编辑器以及运行视图将在 OP-240 的后续切片中落地。

## 模型体验

无，因为本包是 Host 拥有的工作流状态之上的浏览器界面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **仅为脚手架** —— 浮层只是占位面板；目前不能列出、编辑或运行任何内容，也不会调用 `workflow` Remote 命名空间。

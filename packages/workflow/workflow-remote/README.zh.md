# @deepseek-ai/dsh-workflow-remote

[English](README.md) | 中文

Workflows UI（OP-240）所使用的常驻挂载 Typert Remote 命名空间 `workflow`。`WorkflowRemoteService` 注册 `workflowRemote` 服务，并在 `workflow` 命名空间下发布其方法；线路契约位于 `src/wire.ts`（以 `./wire` 导出，并从包根重新导出），Typert 生成器从本包生成 `./typert` 与 `./remote` 产物。

本包拥有独立的 Loader 条目（挂载于 [`packages/bundle/web-app/cordis.patch.yml`](../../bundle/web-app/cordis.patch.yml)），原因与 [`@deepseek-ai/dsh-mcp-status`](../../mcp/mcp-status/README.md) 相同：当包的最后一个 Loader 条目卸载时，其 RPC 契约会被撤回，且 Gateway 不会回退，因此该命名空间不能依附于可能卸载的包。目前唯一的方法是 `workflow/list`，返回空列表；它的存在是为了让生成器有可输出的方法。

## 模型体验

无，因为这个仅限 Host 的 Remote 服务不注册任何提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **仅为脚手架** —— `list` 返回空列表；发现、读取、校验、试运行、保存、运行、批准、取消、恢复、推送事件以及特权端点集合均尚未实现。

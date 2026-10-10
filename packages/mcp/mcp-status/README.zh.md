# @deepseek-ai/dsh-mcp-status

[English](README.md) | 中文

为每个存活的 [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.md) 连接提供永久挂载的 Remote 状态注册服务。`McpStatusRegistryService` 注册 `mcpStatus` 服务，并在 `mcp` 命名空间下发布四个 Remote 方法——`mcp/status`（列表）、`mcp/authorize-start`、`mcp/reconnect`、`mcp/set-enabled`——以及 `mcp/status-changed` 推送事件。完整的线上契约见 [`docs/subsystems/mcp.md`](../../../docs/subsystems/mcp.md)。

## 为什么独立成包

该服务过去是惰性挂载的：每个 `ctx.root` 仅挂载一次，在任意一个 `@deepseek-ai/dsh-mcp-client` 实例首次激活时触发。这在 Cordis fiber 层面是正确的——挂载的生命周期超出了任何一个实例自身的销毁——但在更高一层是错的：`@deepseek-ai/dsh-typert-loader` 按 *Loader 条目* 注册和撤回一个包的严格 Typert 清单，而该服务并没有属于自己的条目。停用最后一个存活的 mcp-client 服务器时，它的注册也随之被撤回，而 Gateway 的严格/SRC 回退闩锁是单向的——一旦某个端点曾经存在过严格注册，该端点就永久禁止 SRC 回退,即便这个(仍然存活的)服务本可以回答它。

修复方式就是这个包本身:它携带自己永久的 Loader 条目(与其他 host 服务一起挂载在 [`packages/bundle/web-app/cordis.patch.yml`](../../bundle/web-app/cordis.patch.yml) 中),因此 Typert 注册绑定在一个永不卸载的条目上——与任何单个 mcp-client 服务器的生命周期完全解耦。`@deepseek-ai/dsh-mcp-client` 自身只保留一个根作用域的 handle 存储,每个实例都会无条件地向其注册;即使某个 host 的 `cordis.patch.yml` 中没有这个包(headless、嵌入式场景),行为也完全一致,只是缺少 Remote 表面而已。

## 行为

- `mcp/status` 列出每个已注册服务器的当前状态,并为 profile 的 `cordis.patch.yml` 标记为 disabled 的其他 mcp-client 挂载合成一行 `disabled` 状态(没有存活的 handle)——Tools 面板始终可以为刚被停用的服务器显示重新启用的操作。
- `mcp/authorize-start` 开始(或恢复)某个服务器的 OAuth 授权流程:探测可达性、绑定共享的本地回调监听器,并返回授权 URL。该监听器在所有服务器之间是单飞的,不是按服务器各自独立的。
- `mcp/reconnect` 立即手动重试一个已放弃或已停用的服务器。
- `mcp/set-enabled` 通过原子的 `cordis.patch.yml` 读-改-写操作持久化某个插件挂载的启用标志,按 `config.serverName` 匹配——绝不使用挂载本身不透明的 `id`。

该服务仅供 Remote 使用,刻意不声明同进程 Cordis `Context` merge。Client 包通过显式的 [`api-remotes`](../../api/remotes/README.md) 组合消费它,而不导入 Host 实现。

## 模型体验

无,因为这个仅限 Host 的状态注册服务不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无;本包从不组装模型输入。

## 已知限制与暂缓事项

- **授权回调监听器是单飞的** —— 在所有已注册服务器中,同一时间只能有一个 `authorize-start` 流程处于待定状态。
- **除当前 patch 文件和存活 handle 外没有来源或历史记录** —— `set-enabled` 永不插入新挂载,`list()` 仅报告 handle 存储与当前 `cordis.patch.yml` 此刻所说的内容。

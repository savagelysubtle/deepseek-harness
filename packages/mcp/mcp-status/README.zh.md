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
- `mcp/set-enabled` 通过原子的 `cordis.patch.yml` 读-改-写操作持久化某个插件挂载的启用标志,按 `config.serverName` 匹配——绝不使用挂载本身不透明的 `id`。它将文件解析为保留 CST 的 YAML `Document`(通过 `@deepseek-ai/dsh-mcp-client` 的 `parsePatchFile`,该函数注册了一个自定义的 `tag:yaml.org,2002:js` 标量标签,使启动加载器的 `!!js` 令牌头方言——例如 `Authorization: !!js '`Bearer ${process.env.TOKEN}`'` 这类模板表达式——能够原样往返,而不会发出警告或被丢弃),仅通过 `doc.setIn` 就地编辑目标条目的 `disabled` 标志,并用 `doc.toString({ indent, indentSeq, singleQuote: true })` 重新序列化——`indent` 与 `indentSeq` 是从文件自身现有的格式推断出来的(对原始文本做一次简单的行扫描;`yaml` 的 `Document` 并未提供任何 API 来回答"这个文件用的是什么缩进"这个问题),而不是固定的约定,因此一个采用 `yaml` 自身默认的 `indentSeq: true` 风格、或使用 4 空格缩进写成的 profile,也能像真实 `web-stable` profile 自己那种 2 空格、`indentSeq: false` 的 `insert:` 列表一样无损地往返。其他所有标签、所有注释,以及文件其余部分的格式在写入过程中都保持原样不变,包括文件自身的换行符约定:一个 CRLF 文件会被原样写回为全篇 CRLF,一个结尾没有换行符的文件写回后结尾依然没有换行符——因为 `yaml` 自身的序列化器总是只输出裸的 `\n`,并且无论源文件原来是什么样子都总会在末尾恰好补上一个换行符,所以 `set-enabled` 会在真正比对或写入之前,把它的输出转换回原始文件自身的约定(如果某个文件在不同位置混用了两种换行约定,仍可能会被拒绝写入,原因与其他任何无法证明安全的差异一样)。如果匹配到的条目本身是一个 YAML 别名(alias)或锚点引用,而不是一个普通的映射——这一点在匹配阶段是看不出来的,因为匹配是基于完全解析后的文档进行的——那么这次原地编辑根本无法进行,写入会被拒绝,并返回:`mcp set-enabled: cordis patch file "<path>" entry for "<serverName>" is not a plain mapping the host can edit in place (YAML alias or anchor reference) — edit the file by hand and restart the host (SWD-170)`。在提交一次确实可以进行的编辑之前,该方法会对结果证明两件互相独立的事:第一是它的"形状"(SHAPE)——将重写后的文本与原始文本进行差异比对,写入唯一允许引入的差异,是目标条目内一行新增、删除或变更的 `disabled:` 行,任何其他差异都会直接拒绝写入(不会写入任何内容),将真实文件路径通过 `ctx.logger.warn` 记录到 host 日志,并返回一个指明首个意外差异所在行号及修复方式的错误——该错误在线上(wire)传输时会将路径本身做脱敏处理:`mcp set-enabled: cordis patch file "<path>" could not be rewritten without altering other content (first unexpected difference at line N) — edit the file by hand and restart the host (SWD-170)`;第二是它的"位置"(LOCATION)——通过重新解析写入后的文本,并再次按 `config.serverName` 重新匹配,确认 `disabled` 标志在那个确切挂载自己的条目上读出的正是期望的值,而不仅仅是文件中某处有一行以正确的形状发生了变化。

该服务仅供 Remote 使用,刻意不声明同进程 Cordis `Context` merge。Client 包通过显式的 [`api-remotes`](../../api/remotes/README.md) 组合消费它,而不导入 Host 实现。

## 模型体验

无,因为这个仅限 Host 的状态注册服务不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无;本包从不组装模型输入。

## 已知限制与暂缓事项

- **授权回调监听器是单飞的** —— 在所有已注册服务器中,同一时间只能有一个 `authorize-start` 流程处于待定状态。
- **除当前 patch 文件和存活 handle 外没有来源或历史记录** —— `set-enabled` 永不插入新挂载,`list()` 仅报告 handle 存储与当前 `cordis.patch.yml` 此刻所说的内容。
- **`indent`/`indentSeq` 的推断是一种尽力而为的启发式方法,无损重写校验才是它真正的安全网** —— 它只使用文件中任意位置找到的每种证据的第一个例子(为 `indent` 取第一个带有嵌套映射的键,为 `indentSeq` 取第一个带有嵌套块序列的键),因此如果某个文件在不同位置混用了两种不同的缩进约定,针对编辑落点的那部分仍可能推断错误;但无论哪种情况,写入都绝不会被悄悄破坏——推断错误只会像任何其他意外差异一样触发单行差异校验并拒绝写入(SWD-170 第一轮用这个无损写入器与校验机制取代了此前 SWD-169 中"任意不安全标签即拒绝"的防护;第二轮则把最初硬编码的 `indentSeq: false` 替换成了这种按文件推断的方式)。

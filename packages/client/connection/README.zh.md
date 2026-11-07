# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 当前页面的 loopback 状态 + 可观察且按 generation 生效的 `hostDescription` + 单消费方流循环启动器）；导出表层携带协议约定类型、`AbstractApiClient` 抽象，以及循环的 sink／配置类型。每次就绪握手成功后，都会在 `onConnected` 之前发布完整的 `host.describe` 值；generation 失效或显式 stop 会清空它，因此原生能力消费者不会保留已经断线的判断。浏览器载体以 HTTP POST 发送 unary／respond，并为 `events.mux` 与 `events.host` 各开一条只下行的 WebSocket；进程内载体满足同一双流抽象。Host half 持有唯一 `/api` route 及其 Fetch bridge；已注册的 Typert interceptor 会先认领自己的 Remote endpoint，未认领请求再回退 API Proxy。Loopback hostname 判定逻辑留在包内部：`/api` Host fence 与 WebSocket upgrade 会直接使用它，其他客户端插件则消费派生的 `ctx.connection.isLoopback` 状态。node 半侧的 `/api` 路由让特权方法集（`host.pickDirectory`、`host.openPath`，以及整个配置面——`settings.describe`/`openDocument`/`update`/`replace`/`mutate` 与 `credentials.describe`/`set`/`unset`；读取与原生操作也在内，因为 describe 会返回已暴露的配置、打开操作会作用于 Host 桌面，而探测任意引用会报出某条凭据来自何处——以及 agent（智能体） preset 的创作面 `agentPreset.read`/`copy`/`openDocument`/`remove`，因为组装指明了一个会话所运行的插件，读取它是侦察，而 copy/remove/openDocument 管理名单并驱动宿主桌面（创作只有复制一种写入，因此这些方法都不接收组装文本或路径）；`agentPreset.list` 与 `agentPreset.select` 不在其中——名单只携带 id 与信任级别，而选择一个 preset 并不比 `session.create` 自带的 `agentPreset` 多给任何能力，何况默认 preset 本就带着 bash）以及 workflow 写入面（`workflow/save`/`run`/`resume`/`cancel`/`nodeOutput`/`approve`/`reject`/`attachUi`/`detachUi`，因为它们会在检出目录内写文件、启动 bash 节点以宿主用户身份执行的运行、回答审批，并声明有人在场，而 `nodeOutput` 返回未截断的原始节点输出；其他 workflow 读取方法不在其中，因为它们只返回调用方本就能从会话记录读到的文件文本与运行记录；被拒的非回环浏览器只会得到裸 403，所以 Workflows UI 用 `@deepseek-ai/dsh-workflow-remote/wire` 的 `WORKFLOW_LOOPBACK_ONLY_MESSAGE` 解释）以空信任表过信任 fence，并要求原始套接字对端地址为回环（LAN 对端伪造 `Host: localhost` 会被拒绝，且从不读取 `X-Forwarded-For`），从而钉在回环——已声明的 `trustedHosts` 授权可达其余全部方法，而这些方法在真正的认证层出现之前仍只限回环本机。平台载体与 ConnectionController 循环属于包内部；apply 负责选择并驱动它们。下行边界见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、部署推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，如附带 `Origin`，则它必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何事件流前拒绝握手。非回环组合必须显式信任其服务权威：Web 运行时从全接口服务器配置推导 LAN IP 字面量，cordis.yml 中的 `trustedHosts` 与 CLI（命令行界面）的 `--trusted-host` flag 则声明具名权威。`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持。这道栅栏是可达性策略，而不是认证；下文的每次启动调用方令牌守卫特权方法。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)。

## `peerIsLoopback` 创始人标记事实

与上面的 Host 权威信任栅栏不同，`/api` 路由的 `apply()` 与 `HostConnectionService.register()` 自己的路由各自会计算原始 TCP 对端是否回环——`src/loopback-hostname.ts` 中的 `isLoopbackAddress(req.socket.remoteAddress)`，它识别 IPv6 回环字面量 `::1`、`127/8` 段内的任意 IPv4 地址，以及双栈绑定时报出的 IPv4 映射 IPv6 回环地址（`::ffff:127.x.y.z`）——并在进程内经 `bridge()` 与 `toFetchHandler()` 把这个布尔值串联进 `RpcRequest.peerIsLoopback`。它绝不是请求头：客户端无法设置或伪造它。该字段是可选的，除了宿主侧入向的 unary 分发（`handleUnary`）之外处处缺失，与显式的 `false` 同义；`register()` 的路由出于对称性串联同一事实，即便当前没有任何 interceptor 读取它。[`@deepseek-ai/dsh-host-apiproxy`](../../host/apiproxy/README.md) 的 `session.prompt` 与 `session.sendAll` 是目前仅有的消费方——只有这个事实为 `true` 时，它们才会在持久用户消息上铸造 `MessageSourceMap.user.founder: true`。

## 每次启动的调用方令牌

回环可达性无法识别操作者的浏览器：任何本地页面或进程都能通过。因此主机在每次启动时生成随机调用方令牌（`src/caller-token.ts` 中的 `createCallerAuth`），只保存在内存中，并要求特权方法在 `x-dsh-token` 请求头中携带它。使用请求头是因为浏览器会把 cookie 发送到每个回环端口，seat 自己的开发服务器可以重放它。闸门包裹共享的 `/api` 处理器，因此也覆盖由拦截器认领的端点。`PRIVILEGED_METHODS` 中的方法需要回环对端、回环 `Host` 和有效令牌；令牌缺失或错误会得到带平实消息的 401，以及一条限速的服务器 warning，其中从不包含令牌。`host.listDirectory` 与 `session.export` 保留普通的 `trustedHosts` 栅栏，并额外要求令牌。其他所有方法以及两条 WebSocket 下行都不需要令牌。

主机通过一次性启动码（有效期 10 分钟，最多 16 个待兑换）把令牌交给页面。启动器向交互终端打印 `http://127.0.0.1:<port>/#dsh-boot=<code>`；stdout 不是 TTY 时，把链接写入权限为 0600 的文件并只打印路径（[组合包](../../bundle/web-app/README.md)）。启动码从不进入 `DSH_WEB_URL` 或任何环境变量。页面用 `history.replaceState` 移除片段，向 `POST /api/auth.exchange`（仅限回环对端和 `Host`）提交 `{code}`，收到 `{ok: true, token}` 后把令牌保存在内存和 `sessionStorage` 中，并在每个 API 请求中以 `x-dsh-token` 发送。`HostConnectionService.mintLaunchCode()` 方法生成启动码；页面侧位于 `src/client/caller-auth.ts`。

被拒绝的兑换或任何 401 都会显示固定的红色条（`role="alert"`，`src/client/auth-banner.ts`），写明原因和「Reopen dsh from the launcher link」；不会静默重试。fixture 模式（`?fixture`）没有主机，也没有令牌。载体把令牌检查结果传给 [`@deepseek-ai/dsh-host-apiproxy`](../../host/apiproxy/README.md)，后者仅对持有令牌的调用方生成创始人标记并接受审批应答。决策记录：[每次启动调用方令牌 Agent Note](../../../.agents/notes/implemented/architecture/2026-11-06-op-270-per-boot-caller-token.md)。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE（Server-Sent Events）回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 160 MiB，按默认 100 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
- **现有自动化需要兑换才能使用特权方法**：解析 `dsh web:` 行的脚本仍可访问非特权方法，但特权方法需要来自终端行或 0600 文件的启动码、一次 `/api/auth.exchange` 调用以及 `x-dsh-token` 请求头。失败的兑换不会被限速，只有 warning 日志被限速。
- **令牌不会在主机重启后保留**：已打开的标签页会显示红色条，直到操作者打开新的启动链接。

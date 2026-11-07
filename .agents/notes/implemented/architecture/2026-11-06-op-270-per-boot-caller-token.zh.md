# Agent Note: 每次启动生成的调用方令牌守卫特权 `/api` 方法

Status: implemented

[English](2026-11-06-op-270-per-boot-caller-token.md) | 中文

## 问题

`/api` 回环栅栏（[浏览器信任边界](2026-07-28-api-browser-trust-boundary.md)）决定谁能到达该路由：回环 socket 对端和回环 `Host`。同一台机器上的任何其他本地页面或进程都能通过这两项检查，因此可以调用特权方法：应答审批、停止会话、写入组织注册表、创建工作区或列出主机目录。用户消息上的创始人标记（`peerIsLoopback`）有同样的弱点：回环只能证明调用方运行在本机。OP-270 的 sentinel 设计评审（vault 笔记 `Plans/2026-11-06-OP-270-sentinel-design-review.md`）要求引入只有操作者自己的浏览器标签页持有的密钥。

## 决策

主机在每次启动时生成随机调用方令牌，并要求特权 `/api` 方法在 `x-dsh-token` 请求头中携带它。

- **令牌。** `createCallerAuth()`（`packages/client/connection/src/caller-token.ts`）在每次主机启动时抽取 32 字节随机数并编码为 base64url。令牌只存在于该闭包中：从不写入环境变量、文件或 `DSH_WEB_URL`。重启会使此前的所有令牌失效。`verify()` 用 `timingSafeEqual` 比较 sha256 摘要。
- **启动码。** `HostConnectionService.mintLaunchCode()` 返回一次性随机码，有效期为 `LAUNCH_CODE_TTL_MS`（10 分钟）。待兑换的码只以 sha256 摘要保存，同时最多 `MAX_PENDING_LAUNCH_CODES`（16）个；超出上限时生成新码会淘汰最旧的码。无论启动码是否已过期，兑换都会消耗它。
- **把启动码交给操作者。** `@deepseek-ai/dsh-web-app` 的 `web-runtime` 插件构造 `http://127.0.0.1:<port>/#dsh-boot=<code>`。URL 片段不会发送给服务器。stdout 为交互终端时，链接打印在一行中；否则写入 `$XDG_RUNTIME_DIR/dsh-web-access-<port>.url`，权限为 0600，并且只打印路径；该变量未设置时不写入任何文件（共享临时目录对该机密不安全），并打印一行说明。启动码从不进入 `DSH_WEB_URL`、Web 表层提示词段落或任何环境变量，因为这些内容会到达 agent。
- **兑换。** 页面加载时（`src/client/caller-auth.ts`）先用 `history.replaceState` 移除片段，再进行任何网络操作，然后向 `POST /api/auth.exchange`（`application/json`）提交 `{code}`。主机返回 `{ok: true, token}` 并带 `cache-control: no-store`；该端点只接受回环 socket 对端和回环 `Host`（否则 403）。错误、重放或过期的启动码得到 401 和一条平实的消息。
- **令牌存储与传输。** 页面把令牌保存在内存和 `sessionStorage` 中（作用域为页面 origin，因此刷新后仍保留）；从不使用 `localStorage` 或 URL。每个 API 请求都在 `x-dsh-token` 中携带它。WebSocket 下行（`events.mux`、`events.host`）不属于特权，也不带令牌；所有特权调用都是一元 POST。
- **闸门。** 闸门包裹共享的 `/api` fetch 处理器，因此也覆盖由 Typert 拦截器（例如 `workflow/*`）认领的端点。`PRIVILEGED_METHODS` 中的方法仍要求回环 socket 对端和回环 `Host`（否则 403），现在还要求有效令牌（否则返回带 `CALLER_TOKEN_REQUIRED_MESSAGE` 的 401）。`host.listDirectory`、`session.export`、`commands/execute` 以及 `dynamicCordisRunner/{runHostHalf,resolveRequestRun,settleUserRun,undefineFromPanel,stopFromPanel}` 构成第二组 `TOKEN_REQUIRED_METHODS`：它们保留普通的 `trustedHosts` 栅栏，并额外要求令牌。审计发现，同一用户对 `commands/execute` 发起的 `curl` 可以运行 `/permission danger-full-access`，从而关闭审批闸门。插件 Remote 除非列入否则保持开放，所以新增的授予能力的 Remote 必须加入该集合；插件 Remote 的默认拒绝是已命名的后续工作，尚未实现。特权集合新增 `org.write`、`org.writeServed`、`worktree.create`、`worktree.remove`、`worktree.lock`、`host.createDirectory`、`session.sendAll`、`session.stopAll` 和 `session.stopTree`。`session.create`、`session.prompt`、`subagent.prompt`、`session.history`、`session.rename`、`mailbox.publish` 和 `mcp/status` 保持开放，因为非浏览器调用方需要它们，或者它们授予的权限不超过 `session.create`。
- **API Proxy 中的消费方。** 载体把验证结果作为 `RpcRequest.callerAuthenticated` 和 `RespondCaller` 传入代理。`session.prompt` 与 `session.sendAll` 仅在对端为回环且令牌有效时才生成创始人标记。`respond` 在缺少令牌时以 `caller-not-authenticated` 拒绝审批应答和 plan-review 应答，对端非回环时以 `caller-not-loopback` 拒绝；待处理条目保持待处理。`allowNonLoopbackApprovalAnswers`（默认 `false`）是允许携带令牌的 LAN 调用方应答的唯一开关。
- **重新链接。** 令牌在一次启动内不会过期，只有启动码会过期。启动器把每次启动的重新链接密钥写入 `$XDG_RUNTIME_DIR/dsh-web-relink-<port>.key`（0600，主机停止时删除）。`dsh open [--port N]` 读取它，在 `x-dsh-relink` 中提交给仅限回环的 `POST /api/auth.relink`，后者返回新的启动码，并打印 `http://127.0.0.1:<port>/#dsh-boot=<code>`。
- **拒绝对操作者可见。** 任何 401 或被拒绝的兑换都会把令牌状态置为 `rejected`，`mountAuthBanner`（`src/client/auth-banner.ts`）随即显示固定的红色条（`role="alert"`），写明原因和「Reopen dsh from the launcher link」。没有静默重试。fixture 模式（`?fixture`）没有主机，也没有令牌。兑换请求 10 秒后超时，避免停滞的主机阻塞之后的所有请求。`ctx.connection.fetch`（`ConnectionHandle.fetch`）为 Connection RPC 之外的 Host 端点携带令牌；会话导出使用它并保存 blob URL，因为普通下载链接无法发送该请求头。主机把每次拒绝记为一条 warning，只写方法名，从不写令牌或启动码；warning 每 10 秒最多一条，并附带被抑制的条数。

横幅使用普通 DOM，因为 `AppFrame` 是纯函数式的、无法访问 Cordis，所以令牌持有者无法使用现有的 `ConnectionBanner` atom 和布局席位。

## 曾考虑的替代方案

**把令牌放进 cookie。** 浏览器会把 cookie 发送到该主机的每个端口，因此 seat 自己在另一个回环端口上的开发服务器会收到令牌并能重放它。请求头只会由本页面的代码附加。

**把令牌放进 URL 查询串。** 否决：查询串会到达服务器、访问日志和 `Referer` 头。片段只留在浏览器中。

**把令牌或启动码放进 `DSH_WEB_URL` 或其他环境变量。** 否决：受管 bash 环境和提示词段落会到达 agent，agent 就能冒充操作者行事。

**`localStorage`。** 否决：它在浏览器重启后仍然保留，生命周期超过生成令牌的那次启动。`sessionStorage` 受标签页限制，且刷新后仍保留。

**用 `ConnectionBanner` atom 和 `ui-layout` 渲染提示。** 未选用：`AppFrame` 是纯函数式的，无法访问 Cordis。React 横幅可作为后续变更。

## 后果

- 不持有令牌的同用户进程或页面不能再应答审批、停止会话或调用其他特权方法，也无法获得创始人标记。
- 解析 `dsh web: http://...` 行的现有自动化对非特权方法仍可用。要使用特权方法，它必须从终端行或 0600 文件读取访问链接，把启动码提交到 `/api/auth.exchange`，并发送 `x-dsh-token`。Playwright 流程、`dsh-stable` 重启辅助脚本和 `dsh-session-testing` skill 位于本仓库之外，此处未改动。
- 每次主机重启都会丢失令牌，已打开的标签页会显示红色条，直到操作者打开新的启动链接。
- 不带令牌的 LAN 客户端会失去斜杠命令和插件面板；目前接受这一点。
- 重新链接密钥文件无法防御同一用户的恶意进程：任何能以该用户身份读取它的人（包括 seat 的 shell）都能生成链接。它把访问链接文件原有的暴露期从 10 分钟延长到主机的整个生命周期。
- 在默认设置下，LAN 手机即使带有令牌也不能应答审批；是否启用 `allowNonLoopbackApprovalAnswers` 是尚待创始人决定的问题。
- 闸门按方法名拒绝，而不是按端点清单。新的特权方法必须加入 `PRIVILEGED_METHODS` 或 `TOKEN_REQUIRED_METHODS` 才会被覆盖。
- 失败的兑换不会被限速。启动码为 256 位且一次性有效，猜测不可行；只有 warning 日志被限速。
- 验证依据：`caller-gate.host.spec.ts`、`caller-token.host.spec.ts`、`route-classification.host.spec.ts`、`caller-auth.client.spec.ts`（connection），`api-proxy-caller-auth.spec.ts`、`api-proxy-founder-stamp.spec.ts`（apiproxy）以及 `web-app.spec.ts`。

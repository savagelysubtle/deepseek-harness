# Agent Note：Streamable HTTP MCP 服务器的 OAuth 认证

Status: implemented

[English](2026-08-26-mcp-oauth-streamable-http.md) | 中文

## 问题

`dsh-mcp-client` 桥接 Streamable HTTP MCP 服务器时只支持静态请求标头（[插件 Note](../../implemented/feature/2026-07-07-mcp-client-plugin.md)——本 Note 是对它的扩展，不取代其中任何内容）。Steve 的 agent 需要的两个远程服务器——supabase 和 stripe MCP——仅支持 OAuth：它们不签发静态凭证，而参考部署（opencode）中为它们保存的也只有 PKCE 流程状态（`mcp-auth.json`）。只有标头能力的客户端完全无法使用这些服务器。

照搬 opencode 的存储方式有两重错误。它的 `mcp-auth.json` 是一个位于任何优先级体系之外的临时明文 JSON 状态文件，其 token 与无关的流程状态混在一起，也没有按操作读取。harness 已拥有一个凭证 seam，其信条是"配置承载引用；消费者按操作解析"——OAuth 状态要么放进这里，要么不做。

## 决策

Streamable HTTP 配置带有显式的 `auth: { mode: 'oauth', scope?, clientId?, redirectPort? }` 块，SDK 的 `OAuthClientProvider` 基于 `ctx.credentials` 实现：

- **显式而非自动启动。** 401 绝不会自行开启同意流程。同意是对单个身份授权的人工批准；它写在组合配置里，评审者看得到。未经认证的 401 继续让连接带着诊断失败。
- **每个服务器一个凭证引用。** 全部状态以单一引用 `DSH_MCP_OAUTH_<SERVERNAME>`（大写、非标识符字符替换为下划线）持久保存：token、动态客户端注册、待用的 PKCE verifier、发现缓存，按版本化的 `{version:1,...}` 信封写入 `$DSH_HOME/.credentials.yaml`，权限 `0600`。损坏的信封明确报错，而不是伪装成"未授权"——静默循环同意流程毫无效果，比报错更糟。
- **按操作解析就是刷新与交接机制。** 每次提供方读取都在调用时经过存储，因此 (a) 任一进程写入的状态立即对其他进程可见；(b) SDK 驱动的刷新轮换经由同一路径提交。运行中的 Host 在下一次连接尝试时即可取到 CLI 写入的 token，无需重启。
- **同意在浏览器可用的地方进行。** `dsh-mcp-client-auth`（包 bin）打印授权 URL，在 `127.0.0.1:<auth.redirectPort>`（默认 14506）上捕获回环重定向，交换 code 并写入存储。Host 从不监听；缺少同意时记录一次 URL 日志并附运行 CLI 的指引，同时在正常重连预算内继续重试。Host 与 CLI 使用同一个固定重定向 URL，动态注册与先完成同意的进程保持一致。
- **刷新由 SDK 负责。** SDK 持有 `refresh_token` 时即执行刷新并通过 `saveTokens` 重新保存轮换后的 token；本包只负责持久化。

## 曾考虑的替代方案

- **自动检测 401 → 启动同意。** 否决：会把任何认证配置错误变成无人值守 Host 上突如其来的交互流程。
- **明文 JSON 状态文件（opencode 对齐）。** 否决：绕过本地提供方已强制执行的凭证优先级、遮蔽规则和 `0600` 写入纪律。
- **认证作为独立服务插件**（按早前设计 brief）。暂缓：当前没有第二个消费者，且提供方所需配置未超出服务器行已携带的内容。结构化的 `OAuthCredentialStore` 接口保留了这扇门。

## 后果

- supabase/stripe 风格的远程服务器可在任意机器上经一次 CLI 运行后无头使用。
- 新增 peer 依赖：`@deepseek-ai/dsh-credentials`（seam）与 `@deepseek-ai/dsh-credentials-local`（CLI 侧存储构造）。
- 已知限制记录于 README：每服务器的单端口协调、CLI 将 `state` 校验交由 SDK（单用户本地威胁模型）、刻意不设 `apikey` 模式。

## 验证

- 针对进程内同意门禁 fixture 的无密钥测试套件（`tests/oauth.spec.ts`）：完整 CLI 同意往返、经真实 SDK 传输的 Host 取用 + 刷新轮换、缺失同意时的遏制与指引日志、缺少凭证服务时快速失败、损坏信封拒绝、按范围失效。
- REAL 组合覆盖沿用现有插件加载测试；快照表面无变化，因为没有模型可见文本变更。

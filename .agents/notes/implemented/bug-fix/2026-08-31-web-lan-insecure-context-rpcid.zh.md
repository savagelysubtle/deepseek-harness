# Agent Note: Web 载体生成 rpcId 不再要求安全上下文

Status: implemented

[English](2026-08-31-web-lan-insecure-context-rpcid.md) | 中文

## Problem

在任何非回环浏览器(局域网 IP,如 `http://10.0.0.3:3080`,即沙发模式 iPhone)上,DSH Web GUI 能渲染外壳,但工作区与会话永远为空;同一构建在 `http://127.0.0.1:3080` 上完全正常。researcher 席位的包级诊断(2026-08-31,`companyOrchestrator/researcher/research/dsh-mobile-access/`)证实:每次 WebSocket 升级都成功,服务端推送了真实的订阅数据;是客户端自己关闭了两个套接字(代码 1001,"WebSocket is closed before the connection is established");`host.describe` 从未发出任何 fetch;`ConnectionController.loop` 的静默 `catch {}` 把可见症状压缩成永无止境的 "connection lost, retry #N" 退避循环。故障取决于 origin 字符串而非传输层——这排除了围栏、TLS、持久化状态和服务端网关(api-proxy 事件流里根本不存在 origin 分支;服务端只是镜像了客户端自己的关闭)。

真正起作用的 origin 界线是安全上下文边界。`crypto.randomUUID()` 只存在于安全上下文(HTTPS 或 localhost);纯 HTTP 的局域网 origin 两者皆非。`AbstractApiClient.mintRpcId()`——包括就绪握手 `host.describe` 在内的所有一元 RPC 的基础载体——直接调用了它,于是在局域网 origin 上第一个 RPC 就在 fetch 之前抛出 `TypeError: crypto.randomUUID is not a function`,该拒绝被重连循环的兜底 catch 吞掉,连接代在就绪前中止,两个下行套接字在握手中途被关闭。

## Decision

`mintRpcId()` 改用 `crypto.getRandomValues()`(浏览器在非安全 origin 上同样暴露)生成 RFC 4122 版本 4 的 UUID,实现为 apiproxy fetch 载体内新的内部 `randomUuid()` 辅助函数。它与 `@deepseek-ai/dsh-client-connection` 在其通用 RPC 通道中已有的辅助函数相同(`rpc.ts` 本来是安全的;不安全的是 apiProxy 基础载体)——这是有意的复制而非导入,因为依赖方向是从 client-connection 指向 apiproxy,不能反向。线上格式不变:rpcId 仍是 UUID v4 字符串,服务端原样回显,任何 schema 或持久化面都不移动。`fetch-carrier.spec.ts` 中的新测试以非安全上下文的 crypto 形态(`getRandomValues` 存在、`randomUUID` 缺失)断言经由真实 `mintRpcId` 生成的 v4 格式。

## Alternatives considered

**仅在 `WebApiClient`(client-connection)中覆写 `mintRpcId`。** 否决:只修一个消费方,基础载体对其他所有 `AbstractApiClient` 消费方在非安全 origin 上仍是坏的。缺陷在基类,修复也在基类。

**改为要求 HTTPS(如 Tailscale)。** 作为修复方案否决:researcher 的证据证明故障取决于 origin 而非传输,仅 HTTPS 并不能恢复会话;HTTPS 仍是 PWA 安装与浏览器内麦克风这条路线图上的独立解锁项。沙发模式部署方式就是局域网 IP 上的纯 HTTP,这是明确决策。

**基于计数器或时间戳的 rpcId。** 否决:同一浏览器上下文会有多个标签页各自造号;CSPRNG UUID 成本与任何"足够唯一"的方案相同,同时保持 id 不透明且免碰撞。

## Consequences

局域网/移动端部署真正可用:会话在非回环 origin 上正常填充、历史正常渲染,仅剩的非 2xx 响应是特权方法按设计的回环钉死(`settings.describe`、`credentials.describe` → 403)。修复清查中发现两处同类调用点,刻意保留并记录为后续项:`packages/client/ui-conversation/src/client/service.ts` 用 `crypto.randomUUID()` 生成草稿附件 id(局域网 origin 上一添加草稿附件就会触达——同样的 TypeError 形态);`packages/llm/llm/src/message.ts` 的 `createMessage` 以同样方式生成 `MessageId`(浏览器包目前不可达——没有客户端调用方;它实际运行的 Node 环境是安全的)。复发条件:任何新的浏览器端 `crypto.randomUUID()` 使用都会重新破坏非安全 origin;快速审计方法是在服务端的 client bundle 中指纹查找 `getRandomValues(new Uint8Array(16))`。掩盖真实错误的诊断债未在本变更中处理:`ConnectionController.loop` 与 `pumpStream` 的静默 `catch {}` 已记录为简化/可观测性候选项。

# Agent Note：worktree 消费端整合——单一适配缝、ref=slug、拒绝折叠

Status: implemented

[English](2026-08-31-worktree-consumer-integration.md) | [中文](2026-08-31-worktree-consumer-integration.zh.md)

## Problem

宿主网关（`dsh-host-apiproxy`）在真实能力包还在并行构建时，就先按消费端自声明的 seam 契约交付了 worktree 面：消费端的声明即记录契约，并约定由一个整合提交把它们替换为真实包，而不是重写 wire 面。整合要调和两套词汇——wire 的 `WorktreeHandle`/`WorktreeRow`/spawn 输入与服务端的 `WorktreeSpawnRequest`/`WorktreeSpawnResult`/`WorktreeRow`——既不能让任何一侧漂移，也不能把服务的完整拒绝词汇泄漏到 wire 上，同时还要保住可选组合规则（未挂载 seam 的部署照常服务其他所有域）。

## Decision

`src/worktree-seam.ts` 是适配层，也是两套词汇唯一相遇的地方：

- **消费端声明的契约保留，声明本身退场。** 网关 handler 仍然消费面向消费端的 `WorktreeSeam`（spawn/list/lock/remove）与其类型化 `WorktreeSeamError`，但该模块不再声明 Context 键或本地类型。`worktreeSeamOf(ctx)` 读取真实包自己注册的服务（`ctx.get('worktrees')`，来自 `@deepseek-ai/dsh-worktree` 自己的声明合并），并用 `adaptWorktreeService` 包一层。服务始终通过 `ctx.get` 读取、从不做声明注入，因此服务缺席时照旧以 `worktree-unavailable` 应答。
- **ref=slug。** 消费端从不构造引用：服务铸进 `WorktreeHandle.slug` 的 slug 就是 `worktree.lock`/`worktree.remove` 携带的地址。wire 品牌（`WorktreeRef`）经一次有注释的转型逐字重品牌到服务的 slug id 上——两个品牌按约定命名同一个字符串，约定就写在适配模块里。
- **词汇映射收在一个边界。** Spawn：输入的 `sessionName` 是服务的 `intent`；句柄的 `sessionName` 是服务铸出的 `session`（`<seat>.<slug>`），而不是调用者的输入——命名归 seam 所有，调用方只提供归属与意图。行投影：`session` → `sessionName`，`lockReason` → `locked`/`lockReason`。由于服务让每个 worktree 出生即锁定（创建理由 `<seat> <session>`，见 [seam 笔记](2026-08-31-worktree-capability-seam.md)），新铸的工作树在 seat 侧生命周期解锁之前会拒绝 wire 的 `worktree.lock`；wire 面目前刻意不设 unlock 动词。
- **拒绝折叠进三码消费词汇。** 服务的 `WorktreeError` 码按 `LOCKED`/`ALREADY_LOCKED` → `worktree-locked`、`NO_ROW` → `worktree-unknown` 映射，其余所有码——连同任何非 `WorktreeError` 的抛出——折叠为 `worktree-forbidden`；服务的消息始终逐字抵达调用方，因为消息就是调用方看到的理由。映射在 forbidden 一侧刻意开放：消费端只区分 wire 要区分的东西，因此上游日后新增的码无需消费端改动即可折叠，消费端不被绑死在上游完整清单上。

| 服务拒绝 | wire `seamCode` |
| --- | --- |
| `LOCKED`、`ALREADY_LOCKED` | `worktree-locked` |
| `NO_ROW` | `worktree-unknown` |
| 其余所有码，以及任何非 `WorktreeError` 抛出 | `worktree-forbidden` |

## Testing

- `tests/api-proxy-worktree.spec.ts` 让每个动词都穿过一个按真实接口形态构造的 `WorktreeService` 替身——出生即锁的行、携带服务消息原文的 `NO_ROW`/`ALREADY_LOCKED`/`LOCKED` 拒绝——因此 spawn 输入→intent 映射、铸出会话的句柄、行投影以及每个折叠后的拒绝都在 RPC 面上得到演练，而不是对着手搓的 seam。
- 客户端侧为新域补齐了契约时效：两个 `FakeApiClient` 测试替身实现 `IApiClient['worktree']`，connection fixture 的内存契约实现以出生即锁的注册表服务四个动词。

## Alternatives considered

- **让 handler 直接面对 `WorktreeService`**——拒绝：五个调用点各自重做输入/结果映射与拒绝折叠，wire 测试也只能去 mock 服务而不是消费端契约。单一适配缝让 handler 保持稳定，并让映射本身成为被测单元。
- **把每个 `WorktreeError` 码 1:1 映射到 wire 码**——拒绝：这会把消费端绑死在上游完整词汇上，服务每加一个码消费端就得跟着改。wire 的调用方只区分这三个码；其余都是「按当前要求不被允许」，理由逐字携带。
- **把服务重新注册到消费端旧的 `worktree` 键下**——拒绝：一个服务两个 Context 键会招来对无人挂载键的读取；包自己的注册（`worktrees`）是权威，消费端直接读它。

## Consequences

- wire 错误的 `seamCode` details 字段如今在 `worktree-refused` 上必然存在：适配层给每一次抛出都定了型，而此前只有类型化的 seam 错误才回显码。
- 句柄的 `sessionName` 语义随真实服务改变：它是 seam 铸出的 `<seat>.<slug>` 会话，不再是调用者的 spawn 输入。回显输入名的调用方必须改读句柄。
- wire 面无法把出生即锁的工作树变为可锁定或可移除——解锁由 seat 侧通过服务自己完成。等 wire 调用方需要该动词时再加入（README 已知限制）。
- 伪造 `IApiClient` 的客户端包必须携带 `worktree` 域；新 `RpcMethodMap` 域的契约时效在同一次变更中就覆盖到客户端测试替身。

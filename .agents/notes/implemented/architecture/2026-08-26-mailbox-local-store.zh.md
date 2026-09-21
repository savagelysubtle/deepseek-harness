# Agent Note：邮箱本地存储——SQLite 租约语义

Status: implemented

[English](2026-08-26-mailbox-local-store.md) | 中文

## 问题

邮箱接缝定义了 publish/claim/settle 但没有交付任何存储，`ctx.mailbox` 的每个地址在上游提供方落地之前都无法路由。队列排他性是该设计的承重决策：两个排水器（每进程一个，或重启后两个）绝不能并发投递同一消息，而崩溃认领者的消息必须自动回归。opencode 先例把认领状态留在进程内存中，一次崩溃就让行永久不可见。

## 决策

`@deepseek-ai/dsh-mailbox-local` 基于 `node:sqlite` 的 `DatabaseSync` 实现提供方契约，全部排他性都活在 SQL 里：

- 认领是一个 `BEGIN IMMEDIATE` 事务：候选选取（pending 或 `claimed_at <= now - staleClaimMs`，按 `created_at` FIFO 排序）后跟守卫式 UPDATE，其 `changes === 1` 结果承认赢家。该检查是对事务的双重保险——即使未来修改放松了事务模式，也能保持赢家关系成立。
- 租约 ref 内嵌全新随机认领令牌（`<message id>:<claim token>`）。落定同时匹配令牌与 `state = 'claimed'`，因此过期回收后的旧租约、重复落定与其他存储的 ref 一律拒绝而非误写。ref 是字符串而非内存句柄：它们跨进程重启仍然有效，且恰在其行令牌轮换时失效。
- `settle(pending)` 把行退回全新 `pending` 态（清空租约列），这就是桥在会话驻留判定“活持有者在别处”时无需等待任何过期窗口的推迟方式。
- schema 归属依赖在打开事务内校验的 `mailbox_meta.schema_version` 戳记：空文件以 v1 初始化；非邮箱文件与任何外来版本都会让挂载响亮失败。单调递增，无迁移路径——预发布立场允许自由重构格式。
- 插件一次性解析配置（`path?` → `<dsh home>/mailbox/mailbox.db`），同步打开使不兼容数据库自身失败挂载，并经 `ctx.effect` 注册提供方 `local`；卸载先注销再关闭句柄（storage-sqlite 顺序）。

## 曾考虑的替代方案

否决项：队列行内的 pid 工件（具名会话锁已拥有驻存活命性；在此复制会让本可由过期时间戳回收消解的租约楔死）；用 `PRAGMA user_version` 做 schema 戳（裸整数无法像命名 meta 表那样区分“版本错误的邮箱库”与“其他工具的文件”）；可配置 journal mode（尚无部署需要回退日志模式；WAL 保持固定直到有此需求）。

## 验证

包测试套件覆盖版本戳接受／拒绝、payload 往返与可选字段省略、地址隔离、limit 界限（含 SQLite 负 LIMIT 读作无界的陷阱）、注入时钟下精确边界的过期回收、pending 推迟、终态失败、各落定拒绝路径、默认路径解析，以及真实 `Context` 上的注册表挂载与处置证明。组合覆盖随桥切片经 Loader 引导本提供方，遵循测试策略。

## 后果

每个命名 agent 地址在单机内变为可持久路由，桥切片可以对着可用存储编写而非 mock。存储保持零内存投递状态，因此 kill -9 不丢失任何已发布内容。跨进程争用表现为响亮的 `SQLITE_BUSY`，直到桥加入节奏控制——可以接受，因为静默重试会掩盖排水循环本来就必须拥有的丢失唤醒缺陷。

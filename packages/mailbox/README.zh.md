[English](README.md) | 中文

# mailbox/ — 持久化 agent 消息传递族

通过可插拔存储实现跨进程的持久化 agent 消息传递。接缝的投递契约为至少一次送达，`done` 表示收件箱准入；答复以新消息流转，绝不作为落定载荷。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`mailbox/`](mailbox/README.md) | Service Definition：提供方契约、`<namespace>:<name>` 地址文法、注册表与默认解析便捷操作、`mailbox` 消息来源种类 | `ctx.mailbox` |
| [`local/`](local/README.md) | SQLite 存储：单文件持久化、IMMEDIATE 事务单赢家认领、令牌守卫落定与过期租约回收、schema 版本门禁 | provider `local` on `ctx.mailbox` |
| [`bridge/`](bridge/README.md) | 消费方：轮询排水到具名会话 agent——steer 优先投递、驻留锁下的冷恢复、`unknown-address` 失败 | 驱动排水；无 ctx 键 |
| [`seat-runner/`](seat-runner/README.md) | 唤醒到达执行器：轮询 `claimableAddresses`、解析组织注册表，并在宿主旁边 shell 调用标准 headless 入口点 | 在宿主旁运行；无 ctx 键 |

[mailbox 计划](../../interagentstuff/plans/mailbox-plan.md)中的规划角色：`mailbox-rest`（兼容 PostgREST 的提供方）、`tool-mailbox-send`（面向模型的发送工具）。

[English](README.md) | 中文

# mailbox/ — 持久化 agent 消息传递族

通过可插拔存储实现跨进程的持久化 agent 消息传递。接缝的投递契约为至少一次送达，`done` 表示收件箱准入；答复以新消息流转，绝不作为落定载荷。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`mailbox/`](mailbox/README.md) | Service Definition：提供方契约、`<namespace>:<name>` 地址文法、注册表与默认解析便捷操作、`mailbox` 消息来源种类 | `ctx.mailbox` |

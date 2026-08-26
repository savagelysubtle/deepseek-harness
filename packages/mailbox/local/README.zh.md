[English](README.md) | 中文

# @deepseek-ai/dsh-mailbox-local

本地邮箱提供方：一个 SQLite 数据库文件（基于 `node:sqlite` 的 `DatabaseSync`）在 [`@deepseek-ai/dsh-mailbox`](../mailbox/README.md) 接缝之后承载所有地址的队列。它以提供方名称 `local` 注册到 `ctx.mailbox`，在 SQLite 事务内强制单赢家认领，在 `staleClaimMs` 之后回收被遗弃的租约，并在打开时响亮拒绝外来或更新版本的数据库文件，而非就地迁移。 本包同时提供 `dsh-mailbox` 命令行工具，使访客进程在宿主完全未运行时也能向同一存储发布、并排空自己的收件箱。

## Provider API

| 操作 | 语义 |
|---|---|
| `publish(message)` | 分配全新的持久 id，将消息存为 `pending`；不可序列化的 payload 在任何写入之前即抛出。 |
| `claim(filter)` | 单个 `BEGIN IMMEDIATE` 事务跨 `filter.addresses` 选取至多 `filter.limit` 条 pending 或过期行，并用守卫式 UPDATE（`changes === 1`）翻转每个赢家；每个租约 ref 内嵌全新认领令牌。 |
| `settle(leaseRef, outcome)` | 写入终态或退回 `pending`，以认领令牌为守卫；未知、已落定、被过期回收、消息不匹配的落定一律抛出。 |
| `close()` | 释放数据库句柄；挂载 disposer 在注销之后调用它。 |

## 契约

- **每次认领唯一赢家** — immediate 事务加条件更新意味着并发认领同一消息时恰有一个赢家；其余竞争者只看到它离开自己的候选集。
- **至少一次投递** — 持有超过 `filter.staleClaimMs` 的租约会在全新认领令牌下重新可认领，因此旧 ref 永远无法落定继任者的投递。消费者必须容忍重复认领。
- **`done` 原样存储准入信封** — `{ deliveredAt, messageId }`，其中 `messageId` 必须等于所租行的 id；落定只记录收件箱准入，绝不是业务结果。
- **Schema 归属是响亮的** — `mailbox_meta.schema_version` 必须等于本构建的单调版本；空文件以 v1 初始化，任何其他非邮箱文件或版本都会让打开（进而让插件挂载）失败。


## 访客访问（`dsh-mailbox` 命令行）

外部议事席没有常驻进程：被调用时发布、到达时排空收件箱。存储就是宕机期的接口——宿主停机期间写入的消息保持 `pending`，在下一次成功引导的挂载排水时自动投递。

```
dsh-mailbox send  --to <ns>:<name> --from <ns>:<name> [--type T] [--subject S]
                  [--payload-file F | --payload-stdin] [--trace-id X] [--db PATH] [--json]

dsh-mailbox inbox --address <ns>:<name> [--limit N] [--peek] [--db PATH] [--json]
```

| 关注点 | 语义 |
|---|---|
| 首写者权限 | 缺失的数据库目录以 `0700` 创建、文件以 `0600` 预留，走与插件挂载完全相同的打开序列（`openLocalMailbox`）；绝不回退到环境 umask。 |
| 文法门禁 | `--to`／`--from`／`--address` 在任何写入之前按接缝文法校验；不可路由的地址响亮失败，而不是隐形排队。 |
| 收件箱排水 | `claim` + 以 `done` 落定（恰是接缝的收件箱准入语义）。来自外部的坏 payload 行不会浮出：它们被落定为 `failed/malformed-payload`，同批兄弟消息照常投递。 |
| `--peek` | 将每条回执退回 `pending`：只读不消费。认领与落定之间的崩溃经 60 秒过期界限回收（与桥的默认值一致）。 |
| `--db` | 缺省时经 `resolveMailboxPath` 解析到 harness 家目录；支持 `:memory:` 哨兵值。 |
| 访客回合 | 投递内容是接收席位的数据，绝非指令；`type` 仅限咨询类（`field-report`、`question`）。外来来源邮件能否被接受由桥的 `admitFromNamespaces` 在排水时裁决。 |

## 配置

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `path` | string? | `<dsh home>/mailbox/mailbox.db` | 数据库文件位置。缺失的目录与文件以属主-only 权限创建；已有文件的权限保持不变。取值 `:memory:` 打开进程内数据库（测试）。 |

## Model Experience

### 投递的邮箱消息

#### What the model sees

本存储不贡献任何实时 prompt、schema 或请求变更。消息内容只有当消费者投递它时才会到达模型——典型是邮箱桥把认领的消息渲染为带有其自身来源归属的用户回合。payload 正文在本存储中只是不透明的 JSON 字节；含义完全由发送方与接收方拥有。

#### Token effect

零直接 token 效应：存储不向任何模型请求添加内容。

#### KV Cache effect

独立：队列的读写从不触碰请求前缀。任何缓存行为归属于渲染已投递消息的表面。

## Known Limitations and Deferred Work

- **无 busy 处理与重试** — 多进程争用下的认领会立即抛出 SQLite `SQLITE_BUSY` 而不是阻塞；排水循环的节奏与重试属于消费者（计划中的邮箱桥）。
- **Journal mode 固定为 WAL** — WAL 共享内存文件不适用的网络挂载文件系统在此没有回退日志模式；若部署证明需要，session 与 storage 后端已暴露 `journalMode` 配置可作先例。
- **组合覆盖推迟到桥切片** — 通过 Loader 引导本提供方的真实组合测试随邮箱桥（计划 PR-E）落地，遵循产品可见插件的测试策略。

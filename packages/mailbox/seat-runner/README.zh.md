# @deepseek-ai/dsh-seat-runner

[English](README.md) | 中文

唤醒到达执行器：一个小型常驻守护进程，轮询邮箱存储中可认领的工作，并通过标准 headless 入口点启动座位运行——在 web 宿主旁边、使用与任何人工运行相同的按名称锁（[docs/architecture.md](../../../docs/architecture.md) § "会话日志"中的一次写入规则）。守护进程不包含任何座位逻辑——发现、注册表解析和一次 shell 调用是它全部的工作，因此第二个拥有不同座位与边的项目只需要一个新的注册表文件，绝不需要新代码。

## 模型

- **发现** — 每个轮询间隔，守护进程从配置的邮箱存储（默认 `<dsh home>/mailbox/mailbox.db`）读取 `claimableAddresses`：持有至少一条 `pending` 消息的地址，或认领已过期的消息。这与排水路径自身的选择完全一致，因此守护进程看到的正是运行会接纳的内容。
- **解析** — 每个地址 `<namespace>:<name>` 通过组织注册表（`@deepseek-ai/dsh-mailbox` 的 `loadOrgRegistry`）解析：名称必须是花名册中的座位，且座位的命名空间必须与地址匹配。无法路由的地址每次守护进程运行只警告一次并被跳过；它保持 pending 状态，等待修复花名册的人。
- **唤醒** — 每个座位最多一个子进程：`dsh --profile headless --session-name <name> --mailbox-namespace <namespace> "<wake task>"`，在注册表解析出的座位工作区中执行。运行内部的积压接纳是 headless 运行器的既有行为；已被其他运行认领的邮件不会在这里被再次发现。
- **失败处理** — 唤醒非零退出（已被证明的锁竞争情形：某人或其他运行持有座位的锁）会让邮件保持 pending，并将该座位放入指数退避：`backoffBaseMs * 2^min(attempts-1, maxBackoffExponent)`，任何干净退出都会重置。指数上限让卡住的座位缓慢重试而非永不重试。
- **生命周期** — 间隔循环容纳自身故障（失败的 tick 记录日志并继续）；`SIGINT`/`SIGTERM` 停止循环并关闭存储，进行中的唤醒子进程作为普通 headless 进程独立完成。

## 配置

`dsh-seat-runner [--registry <path>] [--store <path>] [--poll-interval-ms <n>] [--stale-claim-ms <n>] [--entrypoint <cmd>] [--backoff-base-ms <n>]`

| 标志 | 默认值 | 含义 |
|---|---|---|
| `--registry` | `<dsh home>/org/registry.yml` | 组织注册表文件（花名册、边、call-up）。 |
| `--store` | `<dsh home>/mailbox/mailbox.db` | 要轮询的邮箱 SQLite 数据库。 |
| `--poll-interval-ms` | `5000` | 发现 tick 间隔。 |
| `--stale-claim-ms` | `120000` | 发现的过期界限；与 headless 积压排水一致。 |
| `--entrypoint` | `dsh` | 唤醒运行 shell 调用的命令，经 PATH 解析。 |
| `--backoff-base-ms` | `2000` | 唤醒指数退避的基数（指数上限为 6）。 |

每个值都在启动时校验；无效标志响亮失败，而不是启动一个配置错误的守护进程。唤醒任务文本不是一个标志：它是本包拥有的固定模型可见文本（见下），只能在源代码中修改，因为它的措辞是与运行中投递路径共享的契约，而不是按部署调节的旋钮。

## 扩展点

- 邮箱存储可以是任何暴露 `claimableAddresses` 的 `MailboxProvider` 实现；seam 拥有提供者替换权。
- 组织注册表是数据（interagent 拓扑在文件里，不在代码里）；添加座位、边或第二家公司只是编辑文件。

## 模型体验

### 请求上下文与条件

#### 模型看到什么

当邮件到达某个座位且没有运行持其锁时，守护进程启动一个 headless 运行，其任务文本是下方固定字面量，在积压排水之后作为该运行的普通任务投递。

##### 逐字唤醒任务文本

```markdown
You have new mail. Use the mailbox tool to drain your inbox, handle each message, then stop.
```

#### Token 效果

每次唤醒运行一次，约 25 个 token，不替换任何内容——全新或恢复的运行将其作为任务轮次读取。

#### KV Cache 效果

在被唤醒运行的第一个轮次内只追加；该字面量字节稳定，因此恢复的运行保持其缓存前缀直到追加的任务文本。

## 已知限制与延期工作

- **单存储发现** — 守护进程轮询一个邮箱数据库；从多个存储服务座位的部署需要每个存储一个守护进程，没有跨存储协调。
- **工作区存在性是唤醒时失败** — 注册表 `cwd` 路径不在启动时检查；缺失的工作区使唤醒运行失败（日志中响亮记录）而不是守护进程启动失败，因此一个损坏的座位不会阻塞其他座位的邮件。
- **无按座位的环境隔离** — 唤醒子进程继承守护进程的环境；部门间的 OS 级隔离按消息系统重构计划延期。

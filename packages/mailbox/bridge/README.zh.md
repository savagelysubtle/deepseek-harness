[English](README.md) | 中文

# @deepseek-ai/dsh-mailbox-bridge

邮箱消费方：一个轮询桥，把认领的消息变成投递到具名会话 agent 的普通用户回合（具名会话见 [named-sessions](../../session/named-sessions/README.md)）。路由是纯派生——地址的名称段就是会话名——因此进程内存活的目标 agent 立即被 steer；休眠目标在按名单驻留锁下冷恢复；被其他进程持有的目标退回队列，不等待任何过期窗口。

## 投递循环

| 步骤 | 语义 |
|---|---|
| `claim` | 每个周期跨配置的 `addresses` 经注册表默认提供方认领至多 `maxClaimPerCycle` 条 pending 或过期消息。 |
| **存活目标** | 派生的会话 id 在 `ctx.agents` 上命中：优先向运行中的回合注入 steering（发布侧唤醒必须及时落位）；回合边界拒绝时回退为普通排队回合。在准入即落定 `done`。 |
| **休眠目标** | 取具名会话锁（`lockStaleMs` 约束活持有者接管；缺省保持 pid 存活性为唯一接管路径），探测持久化：日志缺失以 `unknown-address` 落定 `failed`；日志存在则恢复 agent，作为 FIFO 回合投递，在准入即落定 `done`，等待静默、flush、注销后再释放锁。 |
| **驻留他处** | 锁获取输给存活的持有者：落定 `pending`，由后续周期重试。 |

每个投递回合携带合并的 [`mailbox` 消息来源](../mailbox/src/source.ts)（`{ kind: 'mailbox', form: 'relay', address, from, messageId, traceId? }`），使转录把中继邮件归因到发送方地址而非匿名用户回合。单条租约失败会以原因落定 `failed`，不会让毒消息卡住整个花名册。

## 配置

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `addresses` | string[]? | 缺省 | 服务的完整 `<namespace>:<name>` 端点；空花名册或格式错误在挂载即失败。 |
| `pollIntervalMs` | number? | `5000` | 排水周期之间的停顿。 |
| `maxClaimPerCycle` | number? | `10` | 每周期认领租约上限。 |
| `staleClaimMs` | number? | `60000` | 被遗弃的认领可回收的年龄阈值。 |
| `lockStaleMs` | number? | 缺省 | 冷恢复对楔死锁的接管界限；缺省保持出厂 pid 存活语义。 |
| `admitFromNamespaces` | string[]? | `[]` | 在本花名册自身命名空间之外额外准入的发送方命名空间。空即 FAIL-CLOSED：访客/外部来源邮件在排水时落定 `failed/sender-not-admitted`（存储无法在写入侧约束外部写入者）。chairs-only 由组合自然成立——只有主席桥选择加入 `['guest']`。 |

轮询计时器从不钉住宿主事件循环（`unref`）：只为服务邮件而存在的部署须通过其他句柄维持自身存活。挂载后的结构性失败会清除计时器并抛出，而不是永远静默空转。

## Model Experience

### 投递的邮箱消息

#### What the model sees

每条排水的消息到达为一个 user 回合：文本拼接发送方的 `subject` 与 `payload`（对象做 JSON 序列化），来源为 `{ kind: 'mailbox', form: 'relay' }`，附目的地 `address`、发送方 `from`、存储 `messageId` 与可选 `traceId`。答复绝不能经 settlement 传回——答案作为新发布的消息经发送工具流转。

#### Token effect

条件性且真实：每条被接纳的投递消息都会把它渲染的回合追加到目标对话的请求历史中一次；settlement 元数据本身不进入任何模型。

#### KV Cache effect

按目标会话追加式增长。每条准入邮件在既有前缀之后扩展转录，既有前缀缓存仍可复用；崩溃窗口内的过期重投可能追加重复回合——不替换任何内容，只是增加消费者必须容忍其重复的 token。

## 线路准入

非 dsh 调用方经宿主 API 的 `mailbox.publish`（[apiproxy](../../host/apiproxy/README.md)）走同一条排水路径，其内部封装了导出的 [`publishAndWake`](./src/index.ts)：对照每个已挂载桥的地址做响亮的花名册校验、经默认提供方的一次存储写入、一次立即路由，以及取自本次唤醒落定观察的 `delivered`／`queued` 处置。终态路由失败会携带记录原因响亮拒绝，而不是虚假的快速确认。

## Known Limitations and Deferred Work

- **无待送目录发现** — 花名册由配置声明；扫描存储中的未知地址需要 Service Definition 尚未提供的提供方枚举表面（`discoverPending` 在此之前不做规划）。
- **单存储解析** — 投递只走注册表的默认提供方；按地址路由提供方等待真实消费需求。
- **steering 拒绝是尽力而为** — 边界拒绝在同一周期内静默降级为排队；没有独立于准入的“稍后重试”信号。

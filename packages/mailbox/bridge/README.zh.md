[English](README.md) | 中文

# @deepseek-ai/dsh-mailbox-bridge

邮箱消费方：一个轮询桥，把认领的消息变成投递到具名会话 agent 的普通用户回合（具名会话见 [named-sessions](../../session/named-sessions/README.md)）。路由是纯派生——地址的名称段就是会话名——因此进程内存活的目标 agent 立即被 steer；休眠目标在按名单驻留锁下冷恢复；被其他进程持有的目标退回队列，不等待任何过期窗口。

## 投递循环

| 步骤 | 语义 |
|---|---|
| `claim` | 每个周期跨配置的 `addresses` 经注册表默认提供方认领至多 `maxClaimPerCycle` 条 pending 或过期消息。 |
| **存活目标** | 派生的会话 id 在 `ctx.agents` 上命中：投递立即以 STEER 注入活跃回合——不推断忙碌程度、不看消息类型（创始人模型：一切邮件皆打断；发送方标记 `blocking`，由接收方裁决优先级）。回合边界拒绝时回退为普通排队回合。在准入即落定 `done`。 |
| **休眠目标** | 取具名会话锁（`lockStaleMs` 约束活持有者接管；缺省保持 pid 存活性为唯一接管路径），探测持久化：日志缺失以 `unknown-address` 落定 `failed`；日志存在则恢复 agent，作为 FIFO 回合投递，在准入即落定 `done`，等待静默、flush、注销后再释放锁。 |
| **驻留他处** | 锁获取输给存活的持有者：落定 `pending`，由后续周期重试。 |

每个准入拒绝（`org-registry-unavailable`、`test: true` 边界违规、组织拓扑拒绝、`sender-not-admitted`、循环守卫命中）都从同一次 `refuse` 调用报告三处：接收方行落定 `failed`；`mailbox/refused` 上下文事件把发送方地址、接收方地址与记录的原因带给宿主消费者；同时一条耐久的拒绝通知写入发送方自己的会话。宿主 apiproxy 把该事件渲染为实时系统通知（`host/agent-error` 帧），寻址到发送方的会话——这是给恰好正在旁观者的提示条。通知是一个 `user/message` 上下文节点，来源为 mailbox 的 `notice` 形式，直接追加进发送方的会话日志，因此拒绝在重载后仍在、就在发送方阅读的对话里，并且不唤醒任何东西地到达发送方模型：没有 `steer`、没有 `followup`、没有回合，回合中的发送方在它本来就要发起的下一次请求里读到它。拒绝是宿主对发送方自身行为的报告，因此刻意不以邮件形式流转：退回发送方的 bounce 本身也受触发拒绝的那条规则约束，会被再次拒绝，发送方只会看到沉默。通知完全不触碰邮件存储，因此任何准入规则——包括刚触发的那条——都永远无法裁决它；拒绝通知自身不可能被拒绝。`guest:` 发送方没有会话，经任一出口谁也收不到（CLI 自身的发送路径以非零退出码报告其失败）；无法解析地址的发送方推不出任何会话；从未运行过的发送方不会为一条通知而凭空供给会话——那是幽灵会话一类。

准入之后的每个终态失败（唤醒或供给崩溃）都会把接收方行落定 `failed`，并向原始发送方回发一条尽力而为的 `bounce` 通知——类型为 `bounce`，载荷携带原 `traceId` 与记录的原因——使丢弃对发送者绝不再静默。这些是接收方一侧的失败；退信既非循环、也不受准入裁决。未被排空的退信只是一行未读消息，绝不会挂起。

每个投递回合携带合并的 [`mailbox` 消息来源](../mailbox/src/source.ts)（`{ kind: 'mailbox', form: 'relay', address, from, messageId, senderClass, subject?, blocking?, traceId? }`），使转录把中继邮件归因到发送方地址而非匿名用户回合，客户端的邮件卡片直接从耐久来源渲染发送方类别、主题与阻塞标记。拒绝通知携带同源的 `form: 'notice'` 变体（`{ kind: 'mailbox', form: 'notice', refusedTo, messageId, reason, summary }`），并且绝不携带 `from`：可读的 `from` 正是邮箱来源在客户端呈现为来信的钥匙，而拒绝是宿主的报告，不是书信。消息未携带的字段整体省略，因此更早的日志行仍按写入时的样子读取。单条租约失败会以原因落定 `failed`，不会让毒消息卡住整个花名册。

## 配置

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `addresses` | string[]? | 缺省 | 服务的裸座位名端点；空花名册或格式错误在挂载即失败。 |
| `pollIntervalMs` | number? | `5000` | 排水周期之间的停顿。 |
| `maxClaimPerCycle` | number? | `10` | 每周期认领租约上限。 |
| `staleClaimMs` | number? | `60000` | 被遗弃的认领可回收的年龄阈值。 |
| `lockStaleMs` | number? | 缺省 | 冷恢复对楔死锁的接管界限；缺省保持出厂 pid 存活语义。 |
| `admitFrom` | string[]? | `[]` | 在服务花名册之外额外准入的发送方地址。空即 FAIL-CLOSED：外部来源邮件在排水时落定 `failed/sender-not-admitted`（存储无法在写入侧约束外部写入者）。 |
| `admitGuests` | boolean? | `true` | 是否准入 `guest:` 前缀的外部操作者 CLI 通道。guest 发送方按设计绕过 `test: true` 边界与组织拓扑——这两条规则裁决座位对座位，而 guest 永远不是花名册座位——这正是通道存在的应急（break-glass）属性：外部操作者总能触达一个可用座位。它不给发送方带来任何权威（信封渲染 `unverified`，接收方被告知如此）；循环守卫仍完整适用。`false` 关闭通道，而且是唯一的开关。 |
| `seatAliases` | {address, sessionId}[]? | 缺省 | 面向非派生目标会话（web 宿主席位会话）的显式活席花名册：别名行将 steer/冷恢复路由到那个确切会话 id；未列入的名称仍走派生。缺省保持纯派生默认。 |

轮询计时器从不钉住宿主事件循环（`unref`）：只为服务邮件而存在的部署须通过其他句柄维持自身存活。挂载后的结构性失败会清除计时器并抛出，而不是永远静默空转。

## Roster-drift alarm (SWD-118)

挂载时，仅一次，在第一次排水之前——无论此刻是否有邮件在等待——本桥会把 `addresses` 声明给共享的 `ctx.mailbox` 注册表（[`declareRoster`](../mailbox/README.md#roster-drift-alarm)），并对照组织注册表做检查。两种情况会响亮告警，绝不抛出、绝不拒绝挂载、绝不阻塞邮件：本桥的名册与 `tool-mailbox` 的名册不一致，以及本桥服务了组织注册表并不认识的名称。注册表若根本不存在，属于合法的“无注册表”世界，直接跳过；注册表存在却无法加载，则告警说明检查未能完成，而不是悄悄当作“一切正常”。完整契约（包括刻意不告警的情形）见 [mailbox 包的 roster-drift alarm](../mailbox/README.md#roster-drift-alarm)。

## 线路准入

非 dsh 调用方经宿主 API 的 `mailbox.publish`（[apiproxy](../../host/apiproxy/README.md)）走同一条排水路径，其内部封装了导出的 [`publishAndWake`](./src/index.ts)：对照每个已挂载桥的地址做响亮的花名册校验、经默认提供方的一次存储写入、一次立即路由，以及取自本次唤醒落定观察的 `delivered`／`queued` 处置。终态路由失败会携带记录原因响亮拒绝，而不是虚假的快速确认。

## Model Experience

### 投递的邮箱消息

#### What the model sees

每条排水的消息到达为一个 user 回合：文本拼接发送方的 `subject` 与 `payload`（对象做 JSON 序列化），来源为 `{ kind: 'mailbox', form: 'relay' }`，附目的地 `address`、发送方 `from`、存储 `messageId`、派生的 `senderClass`，以及可选的 `subject`、`blocking` 与 `traceId`。答复绝不能经 settlement 传回——答案作为新发布的消息经发送工具流转。

#### Token effect

条件性且真实：每条被接纳的投递消息都会把它渲染的回合追加到目标对话的请求历史中一次；settlement 元数据本身不进入任何模型。

#### KV Cache effect

按目标会话追加式增长。每条准入邮件在既有前缀之后扩展转录，既有前缀缓存仍可复用；崩溃窗口内的过期重投可能追加重复回合——不替换任何内容，只是增加消费者必须容忍其重复的 token。

### 拒绝通知

#### What the model sees

当桥拒绝该会话自己的一次发送时，会话日志多出一个 `notice` 形式的上下文回合，指明尝试的接收方、存储 id、终态原因，以及发送方需要的两个事实：接收方什么也没看到；原样重发什么也改变不了。

#### Token effect

每次拒绝仅在发送方对话中追加一个短小的固定形态回合。它是追加而非 steer，因此绝不会开启回合、打断进行中的回合，或单独消耗一次模型调用。

#### KV Cache 影响

在发送方会话中每条被拒发送只追加一次；拒绝在存储行上是终态，因此同一次发送绝不会追加第二条通知。

## Known Limitations and Deferred Work

- **花名册保持配置声明** — 桥投递到其配置所命名的地址；待送地址的发现已存在于提供方 seam（`claimableAddresses`，目前没有随附的消费者），但桥不会据存储自行扩展花名册。
- **单存储解析** — 投递只走注册表的默认提供方；按地址路由提供方等待真实消费需求。
- **steering 拒绝是尽力而为** — 边界拒绝在同一周期内静默降级为排队；没有独立于准入的“稍后重试”信号。

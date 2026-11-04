[English](README.md) | 中文

# @deepseek-ai/dsh-mailbox

邮箱能力接缝：以 publish/claim/settle 语义实现持久化、跨进程的 agent 消息传递。本包承担 **Service Definition** 角色——提供方契约、地址文法、`ctx.mailbox` 注册表与 `mailbox` 消息来源种类。具体存储位于各自的包（`mailbox-local`、`mailbox-rest`）；消费者（如邮箱桥）只依赖本定义，绝不依赖某个提供方。

## Service API (`ctx.mailbox`)

| 成员 | 语义 |
|---|---|
| `registerProvider(provider)` | 以其自身名称收录一个存储；重名响亮失败；返回注销 disposer（fiber 卸载自动触发）。 |
| `getProvider(name)` | 精确名称查找；未存活时返回 `undefined`。 |
| `list()` | 按注册顺序列出存活提供方。 |
| `publish(message, signal?)` | 经配置的 `defaultProvider` 的便捷操作；在准入操作中校验目标地址文法。 |
| `claim(filter, signal?)` | 校验每个过滤地址后经默认提供方认领。 |
| `settle(leaseRef, outcome, signal?)` | 经默认提供方落定一个租约。 |
| `lookupByTraceId(traceId, signal?)` | 经默认提供方纯读取携带某 traceId 的全部已存消息（每条 `{ id, from, to, sentAt }`）——消费者据此识别答复方向；绝不认领或落定。 |
| `declareRoster(mountId, addresses)` | SWD-118 名册漂移告警，条件 (A)：声明一个挂载点已服务的名册，若与另一挂载点已声明的名册不一致则告警——绝不抛出——并指明双方各自缺失的具体座位名称。参见 [Roster-drift alarm](#roster-drift-alarm)。 |

## 契约

- **地址文法** — 座位裸名，复用具名会话名称模式（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`）；一个名字只命名一个座位，桥侧因此直接派生目标会话 id，无需第二套编码。`parseMailboxAddress`/`formatMailboxAddress` 天然往返一致。
- **至少一次投递** — 崩溃认领者的租约在 `staleClaimMs` 后被回收；消费者必须容忍重复认领。
- **发送时间由提供方铸造** — 每条投递的消息都携带 `sentAt`（epoch ms），在提供方准入时打点，绝不因认领、回收或落定而重打，排队邮件因此保留原始日期；`lease.claimedAt` 仍是投递认领时刻。
- **`done` = 收件箱准入** — 落定记录的是消息已到达目标队列，而非已获答复；答复作为新发布的消息流转。outcome 的 `result` 列只是投递信封，绝不是业务结果。
- **默认解析响亮失败** — 未配置或默认提供方未注册时，便捷调用即刻抛出并指明缺口；具名提供方调用不受影响。

## 配置

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `defaultProvider` | string? | 缺省 | 无参便捷操作使用的提供方名称。空白名称在挂载时即被 schema 校验拒绝；未知名称在首次被解析的调用处响亮失败。 |

## Roster-drift alarm

座位身份由人工维护于三处：组织注册表（`~/.dsh/org/registry.yml`）以及 `mailbox-bridge` 与 `tool-mailbox` 各自的 `addresses` 已服务名册。在本工单之前，从未有任何检查确保三者一致；过去二者出现分歧时，发往缺失座位的邮件会被静默吞掉——没有报错，也没有退信。经创始人裁定，恰好两种情况会在挂载时触发告警——两者都只是响亮警告，绝不抛出、绝不拒绝挂载、绝不阻塞邮件：

- **(A) 两个已服务名册互相不一致** —— 即上面的 `MailboxRegistry.declareRoster`，由每个挂载点各调用一次。
- **(B) 某名册所服务的名称组织注册表并不认识** —— 由每个挂载点各自判断（它本就同时持有自己的名册与其配置指向的注册表）；参见 `roster` 模块的 [`unknownServedSeats`](./src/roster.ts) 与 [`loadRegistrySeatNames`](./src/roster.ts)。

**刻意不告警的情形：** 注册表列出但没有任何名册服务的座位。这一缺口是正常的，且在生产部署中是刻意为之——`test: true` 座位以及任何刻意不服务的座位本就不应收到邮件。若对此告警，从第一天起就会是噪音。

注册表若根本不存在，属于合法的“无注册表”世界（宕机主机的 CLI 引导场景）：没有任何名称可判定为座位，因此条件 (B) 直接跳过而不告警。注册表存在却无法加载则是另一种情况，告警机制本身绝不能因此变成静默失败——该情况会明确告警说明条件 (B) 未能完成检查，而不是悄悄当作“一切正常”。

## 座位驱动与邮件准入（OP #292）

注册表中的座位行可以选择驱动，并声明谁可以向它发邮件。三个可选字段，只承载路由数据：

| 字段 | 含义 |
|---|---|
| `driver` | `default`（进程内智能体循环；字段缺失时同义）或 `claude-code`。 |
| `admit_from` | `claude-code` 座位接受其邮件的座位名。缺失或为空表示不接受任何人。 |
| `admit_sender_classes` | 接受的发送方类别：`seat`（任意注册表座位）或 `unverified`。缺失表示一类都不接受。`seat` 的意思是「注册表中的座位」，并不表示「可信」。 |

行上刻意没有 `claude_code` 块。模型、effort、角色、上限（`max_*`、`call_window_ms`）、`claude_path`、其 sha256 与 `fable_ok` 都在宿主私有配置中，因为 `org.write` 未经认证，行属于不可信输入。

**隔离，而不是让整份名册崩溃。** 若某行带有上述宿主配置键、在 `claude-code` 座位上出现未知键、`admit_*` 格式错误或类别未知、`admit_from` 指向非座位、默认座位上出现 `admit_*`，或 `sessionId` 与另一座位相同（且其中一方选择 `claude-code`），该行会被标记为 `invalid: "<原因>"` 并丢弃其驱动字段；其他座位保持有效。桥必须拒绝发往或来自 `invalid` 座位的邮件。`parseOrgRegistry(text, { strictSeats: true })` 则直接抛错，`writeOrgRegistry` 始终使用它，因此界面与雇佣脚本会明确失败，而不是写入读取时会被隔离的行。

纯函数位于 [`seat-driver.ts`](./src/seat-driver.ts)：`seatDriverKey`、`recordedSeatDriver`（把已存储的会话日志分类为 `default`、`claude-code`、`mixed` 或不作断言，使日志不会被错误的驱动恢复）、`admitsMail`（发送方与类别均默认拒绝；原因会指明失败的部分）以及 `seatRowHash`（对安全字段投影取 sha256：`driver`、`sessionId`、`cwd`、`admit_from`、`admit_sender_classes`、`test`、`tools`；键顺序与列表顺序不影响结果）。`SeatBinding` 是桥交给驱动的已冻结行及其哈希；其 `AgentOptions` 扩展为 `SeatBindingOptions`（本包不依赖 `@deepseek-ai/dsh-agent`，由使用方合并）。

## 扩展点

提供方实现 [`MailboxProvider`](./src/provider.ts) 并经 `ctx.mailbox` 注册。地址解析策略（chair-to-chair 别名）叠加在 [`provider.ts`](./src/provider.ts) 记录的文法扩展点之上——目前刻意不内置任何策略。

## Model Experience

None, as this package registers no tools, prompts, or context sections; its only model-visible contribution arrives when a consumer delivers messages as user turns attributed to the merged `mailbox` message source.

#### KV Cache 效应

独立：投递的消息经其消费者进入历史，任何前缀效应归属于投递表面，与本接缝无关。

## Known Limitations and Deferred Work

- **无订阅/监听表面** — 认领者轮询；当第二种桥形态需要推送语义时，变更通知事件可加入本接缝。
- **无跨提供方寻址** — 地址不携带提供方限定；默认提供方的间接层假设每个部署命名空间只有一个逻辑存储。

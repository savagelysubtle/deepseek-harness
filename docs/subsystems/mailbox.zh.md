# 邮箱（mailbox）

[English](mailbox.md) | 中文

邮箱 seam —— 把持久化 agent（智能体）间消息作为用户回合投递、具备 publish/claim/settle 语义的能力 seam，是一项[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)，拆分为：Service Definition（[dsh-mailbox](../../packages/mailbox/mailbox)，`ctx.mailbox`）、Service Provider（[dsh-mailbox-local](../../packages/mailbox/local)）和 Consumer（[dsh-mailbox-bridge](../../packages/mailbox/bridge)）。seam 既不拥有持久性也不拥有独占性；两者都归某个提供方所有。本页记录 [`packages/mailbox/mailbox/src/types.ts`](../../packages/mailbox/mailbox/src/types.ts) 中的确切契约；各包的配置与模型效果由该 seam 的[包族 README](../../packages/mailbox/README.md) 负责。

## 地址

端点的线路身份是其裸座位名——单一段，复用具名会话名称文法（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`）——因此路由可由地址直接派生目标会话 id，无需第二套编码（[named-sessions](../../packages/session/named-sessions/README.md)）。一个名字在整个部署中只命名一个座位。

[`parseMailboxAddress`](../../packages/mailbox/mailbox/src/address.ts) 针对段文法校验一条原始地址并为其加品牌（[品牌化 id](core.md#branded-ids)）；`formatMailboxAddress` 由已校验的部分组合地址，这对函数天然往返一致，未经校验的裸字符串无法越过提供方边界。

```ts type-equiv
/**
 * Opaque wire identity of one mailbox endpoint: the seat's bare name, using
 * the named-session name grammar. Grammar and validation live in
 * {@link ./address.ts}; this brand keeps raw strings from crossing a
 * provider boundary unvalidated.
 */
type MailboxAddress = Branded<'mailbox-address'>
```

```ts type-equiv
/**
 * Provider-minted durable identity of one stored message. Unique within the
 * issuing provider; no cross-provider meaning.
 */
type MailboxMessageId = Branded<'mailbox-message-id'>
```

```ts type-equiv
/**
 * Provider-opaque handle returned by {@link MailboxProvider.claim} and
 * consumed by {@link MailboxProvider.settle}. The issuing provider instance
 * is the only legitimate settler; refs are meaningless across providers.
 */
type MailboxLeaseRef = Branded<'mailbox-lease-ref'>
```

## 存储的消息

一条已发布的消息是发送方拥有的数据，传输层绝不解释它；语义结构完全归生产方与消费者所有。

```ts type-equiv
/** Lifecycle of one stored message inside a provider's store. */
type MailboxState = 'pending' | 'claimed' | 'done' | 'failed'
```

```ts type-equiv
/** One durable message accepted for delivery to a mailbox address. */
interface MailboxMessage {
  /** Provider-assigned durable id; absent on publish input. */
  readonly id?: MailboxMessageId
  /** Destination address: the recipient seat's bare name. */
  readonly to: MailboxAddress
  /** Sender address; free-form provenance, never validated against live endpoints. */
  readonly from: string
  /**
   * Epoch milliseconds at which the provider admitted this message — the send
   * time its reader dates mail by, not the later delivery-claim moment
   * (`MailboxLease.claimedAt`). Provider-minted at publish, like the id: a
   * message that sat queued keeps its original admission time.
   */
  readonly sentAt: number
  /** Optional machine-readable intent (`notice`, `task`, …) consumers may switch on. */
  readonly type?: string
  /** Optional human-readable subject line. */
  readonly subject?: string
  /** Optional JSON-serializable body owned by the sender; never interpreted by the seam. */
  readonly payload?: unknown
  /** Optional correlation id threaded through producer→delivery chains. */
  readonly traceId?: string
  /**
   * Whether the SENDER is blocked waiting on an answer to this message
   * (default false). Transport ignores it — all mail steers into a live turn
   * under the founder model — and the receiver JUDGES it: a blocking message
   * means a coworker or boss is stuck until this seat replies (handle now,
   * resume current work after), while non-blocking mail queues mentally for
   * the next natural gap. Delivered turns render the mark as its behavioural
   * contract line: the blocking contract when true, the FYI contract otherwise.
   */
  readonly blocking?: boolean
}
```

## 认领与落定

一次认领会显式限定自己的批量选择范围：

```ts type-equiv
/** Bounds and selection for one claim batch. */
interface MailboxClaimFilter {
  /** Addresses to claim against; providers must scope every lease to one of these. */
  readonly addresses: readonly MailboxAddress[]
  /** Maximum leases returned in this batch; providers may return fewer, never more. */
  readonly limit: number
  /** Age (milliseconds) past which an abandoned `claimed` message reverts to claimable. */
  readonly staleClaimMs: number
}
```

`claim` 原子地把匹配消息从 `pending`（或过期的 `claimed`）移到 `claimed`；并发认领同一条消息时恰有一个赢家，而返回少于 `limit` 条租约属正常。投递是**至少一次**：崩溃而未落定的认领者留下的租约会在 `staleClaimMs` 之后可回收，回收会铸造全新的认领令牌使被遗弃的 ref 失效——消费者必须容忍重复认领。

```ts type-equiv
/**
 * A message handed to exactly one claimer, paired with the ref its settlement
 * must arrive under. Delivery is at-least-once: a crashed claimer's lease is
 * reclaimed after `staleClaimMs`, so consumers tolerate duplicate claims.
 */
interface MailboxLease {
  /** The stored message being delivered. */
  readonly message: MailboxMessage
  /** Provider-opaque settlement handle for exactly this claim. */
  readonly leaseRef: MailboxLeaseRef
  /** Epoch milliseconds at which this claim was made; staleness accounting input. */
  readonly claimedAt: number
}
```

落定记录的是单次投递尝试的终态记录，绝不是被投递工作的业务结果：

```ts type-equiv
/**
 * Terminal record of one claim's settlement. `result` is the DELIVERY ENVELOPE
 * only — it records what became of the transport attempt, never the business
 * result of the delivered work; replies travel as new published messages.
 */
type MailboxOutcome =
  | { readonly state: 'done'; readonly result: { readonly deliveredAt: number; readonly messageId: MailboxMessageId } }
  | { readonly state: 'failed'; readonly result: { readonly reason: string } }
  | { readonly state: 'pending'; readonly result: undefined }
```

`done` 表示收件箱准入——消息已到达目标的队列——并加盖 `{ deliveredAt, messageId }`；答复只作为新发布的消息流转，绝不经过落定。`pending` 把消息退回其存储等待后续认领周期，`failed` 记录原因。只有签发该 ref 的提供方实例才能落定它。

## 提供方契约

提供方在“一个部署命名空间对应一个逻辑存储”上实现这五种操作；地址不携带提供方限定符，因此今天不存在跨提供方寻址。

| 操作 | 契约 |
|---|---|
| `publish(message, signal?)` | 把一条消息持久化存储并分配新 id；signal 拥有从发起到存储接受之间的准入。 |
| `claim(filter, signal?)` | 原子地把可认领的赢家移到 `claimed` 并返回其租约；返回少于 `limit` 属正常。 |
| `settle(leaseRef, outcome, signal?)` | 记录一条租约的终态，或以 `pending` 顺延；只有现行 ref 才能落定。 |
| `claimableAddresses(filter, signal?)` | 枚举持有至少一条可认领消息的地址，镜像 `claim` 的选择；唤醒驱动器通过它发现工作，而不是自持座位花名册。 |
| `lookupByTraceId(traceId, signal?)` | 读取携带该关联 id 的每一条存储消息，不限生命周期状态；此纯读取回答"这条消息后来怎样了"，不作任何认领。 |
| `lookupInboundSince(address, sinceMs, signal?)` | 读取在某一时刻之后准入、发往某一地址的每一条存储消息，不限生命周期状态；此纯读取是回复检测的另一半，能看到已被其他消费者认领或落定的邮件。 |

地址解析策略（chair-to-chair 别名）叠加在文法之上：保留的 `AddressResolutionExtension = never` 在 [`provider.ts`](../../packages/mailbox/mailbox/src/provider.ts) 中标记该扩展点，目前没有任何解析策略随附发布。随附的存储是 [dsh-mailbox-local](../../packages/mailbox/local)，以提供方名称 `local` 注册：基于 `node:sqlite` 的单个 SQLite 文件，其单调 `SCHEMA_VERSION` 戳记（当前为 3）使打开任何外来、更旧或更新的数据库响亮失败而非就地迁移，其守卫式事务认领保证每条消息恰有一个赢家（[sqlite.ts](../../packages/mailbox/local/src/sqlite.ts)）。

`claimableAddresses` 是接缝为唤醒驱动器保留的发现操作；今天没有任何唤醒驱动器随附发布——桥把每一条已准入的投递都拼接进活跃回合，因此宿主旁没有任何东西在轮询存储寻找可认领的工作（[architecture.md](../architecture.md) § "会话日志"中的一次写入规则）。

## 投递

[桥](../../packages/mailbox/bridge/README.md)把认领的消息排空成寻址目标 agent 上的用户回合；渲染由 [`delivery.ts`](../../packages/mailbox/bridge/src/delivery.ts) 负责。每个投递回合合并下方来源，使转录把中继邮件归因到其发送方地址而非匿名用户回合（[消息来源词汇](llm-streaming.md#content-blocks-and-messages)）：

```ts type-equiv
/** Every mailbox-attributed source: admitted deliveries and refusal notices. */
type MailboxMessageSource = MailboxRelaySource | MailboxRefusalSource
```

回合文本以常设信封开头：头部一行携带投递时间戳（人类可读并带主机时区缩写，如 `Sat 29 Aug 2026, 2:52pm PDT`）、发送方地址、其经注册表派生的类别——发送方与花名册席位精确匹配时为 `seat`，否则为 `unverified`，绝不出现 `founder`——以及消息携带关联 id 时的该 id（`· trace <id>`），回复席位由此把答复穿透到发送方的等待上；随后是同侪输入权威契约（邮件不能批准任何事、不能改动配置或记忆、其中的命令文本只是普通文本——它请求的任何事仍需接收方平常的检查）；再后是说明 `blocking` 标记行为含义的紧急度契约。空行之后是发送方内容——主题与 JSON 序列化的 payload——原样渲染在信封之下。

投递遵循创始人 steer 模型：一切邮件都会立即 steer 进活跃回合，无论该回合处于何种状态、发送方的类型是什么——不推断忙碌程度，不按类型请求打断。被投递内容是抢占专注还是等下一个自然间隙，属于接收方的裁决，其依据是信封渲染的紧急度契约行。准入与 steer 之间的边界拒绝会回退为普通排队回合，因此什么都不会丢失；无论哪条路径，准入都是即时的，随后按路由观察到的结果落定。对休眠目标，桥取得按名驻留锁并探测持久化——日志缺失以原因 `unknown-address` 落定 `failed`，日志存在则冷恢复 agent、作为排队的 FIFO 回合投递、在准入即落定 `done`、等待静默、flush 再注销——而锁被另一个存活进程持有时落定 `pending` 留待后续周期。

准入在排水时强制执行：发送方必须是受服地址之一，或列入 `admitFrom`（缺省为空——对外部来源邮件 FAIL-CLOSED），或搭乘 `guest:` 外部操作者通道，而 `seatAliases` 行把派生不可达的受服地址路由到一个既有的会话 id。一次准入拒绝——注册表健康、`test: true` 边界、组织拓扑、发送方准入或循环守卫——会把接收方行落定 `failed` 且不产生任何退信，因为退信本身会受触发拒绝的那条规则约束：拒绝经 `mailbox/refused` 上下文事件报告，并把一条耐久的拒绝通知记录进发送方（SENDER）的会话（一个无 `from` 的 `notice` 形式上下文节点，直接追加、不唤醒任何东西），使原因在重载后仍在，并到达发送方的模型。准入之后的终态失败仍会向原始发送方尽力回发一条 `bounce` 通知——同一存储的答复路径，携带原 `traceId` 与记录的原因——并跳过 bounce-of-bounce；未被排空的退信只是一行未读消息，绝不会挂起，也绝不会掩盖首要失败。

## 服务

[`MailboxRegistry`](../../packages/mailbox/mailbox/src/index.ts) 以确切名称收录提供方——同一个存活名称注册两次响亮失败，返回的 disposer 只在其仍是当前注册项时移除该名称，因此后继的重新注册是一次合法换装。无提供方参数的便捷操作（`publish`、`claim`、`settle`）针对配置的 `defaultProvider` 解析：空白名称在挂载即被 schema 校验拒绝，缺省值或未注册名称在被解析的调用处响亮失败并指明缺口，且每个便捷操作都在准入操作中校验其地址。`getProvider` 精确查找一个名称；`list()` 按注册顺序枚举存活提供方。方法级契约会生成到下方的 Cordis API 区块，消费方契约归包 [README](../../packages/mailbox/mailbox/README.md) 所有。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmailbox--mailboxregistry"></a>

### `ctx.mailbox` — `MailboxRegistry`

Registry over the process's mailbox providers plus default-resolved conveniences. Registering the same provider name twice fails loud; the returned disposer unregisters, and a later re-registration of that name is legitimate (provider swap across reloads).

```ts cordis-catalog
/**
 * Register one storage provider under its own name.
 * @param provider - the provider implementation to admit.
 * @returns the disposer that unregisters this provider; fiber disposal triggers it automatically.
 * @throws when a live provider already holds `provider.name`.
 */
registerProvider(provider: MailboxProvider): () => void

/**
 * Look up one registered provider by exact name.
 * @param name - the provider's registry name.
 * @returns the provider, or undefined when the name is not live.
 */
getProvider(name: string): MailboxProvider | undefined

/**
 * Enumerate the live providers in registration order.
 * @returns the borrowed providers; mutating them is the owner's concern.
 */
list(): readonly MailboxProvider[]

/**
 * Publish through the configured default provider after validating the
 * destination address grammar. The provider mints the durable id and the
 * sent time; the caller supplies neither.
 * @param message - message content without an id or sent time.
 * @param signal - caller cancellation owning admission.
 * @returns the provider-assigned durable id.
 */
async publish(message: MailboxPublishInput, signal?: AbortSignal): Promise<MailboxMessageId>

/**
 * Claim through the configured default provider after validating every
 * filter address against the grammar.
 * @param filter - address selection, batch bound, and staleness bound.
 * @param signal - caller cancellation owning the claim attempt.
 * @returns the claimed leases.
 */
async claim(filter: MailboxClaimFilter, signal?: AbortSignal): Promise<readonly MailboxLease[]>

/**
 * Settle through the configured default provider.
 * @param leaseRef - the ref received from the claiming call.
 * @param outcome - delivery-envelope outcome.
 * @param signal - caller cancellation owning the settlement write.
 */
async settle(leaseRef: MailboxLeaseRef, outcome: MailboxOutcome, signal?: AbortSignal): Promise<void>

/**
 * Read stored messages by traceId through the configured default provider —
 * the same pure lookup the provider contract declares, with no address
 * grammar to validate and no claim, settlement, or other write behind it.
 * @param traceId - the correlation id to search for, matched exactly.
 * @param signal - caller cancellation owning the scan.
 * @returns one entry per stored message carrying the id, earliest send first.
 */
async lookupByTraceId(traceId: string, signal?: AbortSignal): Promise<readonly MailboxTraceEntry[]>

/**
 * Read stored messages addressed to one address since a time through the
 * configured default provider — the same pure inbound scan the provider
 * contract declares, with no claim, settlement, or other write behind it.
 * @param address - the recipient address to scan; grammar-checked here so
 *   a malformed address fails at the seam edge.
 * @param sinceMs - epoch-milliseconds floor (inclusive) on the row's
 *   admission time.
 * @param signal - caller cancellation owning the scan.
 * @returns one entry per matching row, earliest admission first.
 */
async lookupInboundSince(address: MailboxAddress, sinceMs: number, signal?: AbortSignal): Promise<readonly MailboxTraceEntry[]>

/**
 * SWD-118 roster-drift alarm, condition (A): declare the addresses one
 * mount serves under `mountId`, then warn — never throw — if the result
 * disagrees with any roster already declared under a DIFFERENT mount id.
 * The two mounts that call this today (`mailbox-bridge`, `tool-mailbox`)
 * are expected to serve byte-identical rosters; nothing enforced that
 * before this ticket, and a one-sided address meant mail to that seat
 * silently half-worked with no error and no bounce.
 *
 * Declarations under the SAME mount id accumulate as a union rather than
 * overwrite, so more than one mount instance sharing an id (e.g. two
 * `mailbox-bridge` mounts each serving a subset) is judged as one served
 * roster, not a disagreement with itself. The comparison runs once per
 * call, against every OTHER declared roster, so the alarm fires at mount
 * time as each side registers — never on a hot path.
 * @param mountId - the declaring mount's identity (its plugin `name`).
 * @param addresses - the bare addresses that mount serves.
 */
declareRoster(mountId: string, addresses: readonly string[]): void
```

Source: [`packages/mailbox/mailbox/src/index.ts:65`](../../packages/mailbox/mailbox/src/index.ts)

<a id="mailbox-events"></a>

### `mailbox/*` events

<a id="mailboxrefused--emit"></a>

#### `mailbox/refused` — emit

The bridge refused a claimed lease terminally at admission — registry health, the `test: true` boundary, org topology, sender admission, or a loop guard — and settled the recipient's row `failed` with the same reason. This event is the refusal's LIVE sender-facing outlet, in place of a bounce message: a bounce would itself be subject to the rule that refused the original and would be refused in turn. Listeners render it where its sender will see it now (the host's api-proxy addresses a `host/agent-error` frame to the sender's session); the DURABLE outlet is the notice node `injectRefusalNotice` logs into the sender's session from the same `refuse` call, which does not depend on anyone watching a live stream. A `guest:` sender has no session and reaches nobody through either outlet. Listener failures are logged and contained by Cordis dispatch.

```ts cordis-catalog
/**
 * The bridge refused a claimed lease terminally at admission — registry
 * health, the `test: true` boundary, org topology, sender admission, or a
 * loop guard — and settled the recipient's row `failed` with the same
 * reason. This event is the refusal's LIVE sender-facing outlet, in place
 * of a bounce message: a bounce would itself be subject to the rule that
 * refused the original and would be refused in turn. Listeners render it
 * where its sender will see it now (the host's api-proxy addresses a
 * `host/agent-error` frame to the sender's session); the DURABLE outlet is
 * the notice node `injectRefusalNotice` logs into the sender's session
 * from the same `refuse` call, which does not depend on anyone watching a
 * live stream. A `guest:` sender has no session and reaches nobody through
 * either outlet. Listener failures are logged and contained by Cordis
 * dispatch.
 * @param refusal - the sender and recipient addresses and the terminal reason.
 * @mode emit
 */
'mailbox/refused'(refusal: MailboxRefusal): void
```

Source: [`packages/mailbox/bridge/src/index.ts:1780`](../../packages/mailbox/bridge/src/index.ts)

<a id="mailboxseat-tools-restricted--emit"></a>

#### `mailbox/seat-tools-restricted` — emit

A seat's configured tool restriction was resolved at create or cold-resume, in one of two shapes:

- `muted: false` — `composeSeatAgent` applied it and the seat composed normally. This event is the restriction's LIVE outlet, emitted alongside (never instead of) the durable notice node `seatToolRestrictionUserMessage` appends into the seat's OWN session — that durable append is the outlet that does not depend on anyone watching a live stream, and this event is the one that reaches a listener right now.
- `muted: true` — the rule left the seat with NO tools at all, so `composeSeatAgent`'s `setup` threw SeatMutedToolsError before anything was ever published; the seat was never composed, so it has no session to notice. `deliverLease` catches that error, warns the host log, emits this event, and routes the mail through `refuse()` instead — whose own `mailbox/refused` event and durable SENDER-side notice report the refusal itself. This event exists alongside that one because `mailbox/refused` carries only `{ from, to, reason }`: this is the richer, domain-specific record of WHY — the missing/remaining tool names a listener would otherwise have to parse back out of the reason string.

Listener failures are logged and contained by Cordis dispatch.

```ts cordis-catalog
/**
 * A seat's configured tool restriction was resolved at create or
 * cold-resume, in one of two shapes:
 *
 * - `muted: false` — `composeSeatAgent` applied it and the seat composed
 *   normally. This event is the restriction's LIVE outlet, emitted
 *   alongside (never instead of) the durable notice node
 *   `seatToolRestrictionUserMessage` appends into the seat's OWN
 *   session — that durable append is the outlet that does not depend on
 *   anyone watching a live stream, and this event is the one that
 *   reaches a listener right now.
 * - `muted: true` — the rule left the seat with NO tools at all, so
 *   `composeSeatAgent`'s `setup` threw {@link SeatMutedToolsError}
 *   before anything was ever published; the seat was never composed, so
 *   it has no session to notice. `deliverLease` catches that error,
 *   warns the host log, emits this event, and routes the mail through
 *   `refuse()` instead — whose own `mailbox/refused` event and durable
 *   SENDER-side notice report the refusal itself. This event exists
 *   alongside that one because `mailbox/refused` carries only
 *   `{ from, to, reason }`: this is the richer, domain-specific record
 *   of WHY — the missing/remaining tool names a listener would otherwise
 *   have to parse back out of the reason string.
 *
 * Listener failures are logged and contained by Cordis dispatch.
 * @param restriction - the seat, the effective outcome, and the muted/degraded conditions.
 * @mode emit
 */
'mailbox/seat-tools-restricted'(restriction: SeatToolsRestricted): void
```

Source: [`packages/mailbox/bridge/src/index.ts:1809`](../../packages/mailbox/bridge/src/index.ts)
<!-- END GENERATED cordis-surface -->

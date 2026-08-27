# 邮箱（mailbox）

[English](mailbox.md) | 中文

邮箱 seam —— 把持久化 agent（智能体）间消息作为用户回合投递、具备 publish/claim/settle 语义的能力 seam，是一项[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)，拆分为：Service Definition（[dsh-mailbox](../../packages/mailbox/mailbox)，`ctx.mailbox`）、Service Provider（[dsh-mailbox-local](../../packages/mailbox/local)）和 Consumer（[dsh-mailbox-bridge](../../packages/mailbox/bridge)）。seam 既不拥有持久性也不拥有独占性；两者都归某个提供方所有。本页记录 [`packages/mailbox/mailbox/src/types.ts`](../../packages/mailbox/mailbox/src/types.ts) 中的确切契约；各包的配置与模型效果由该 seam 的[包族 README](../../packages/mailbox/README.md) 负责。

## 地址

端点的线路身份是一个 `<namespace>:<name>` 地址，两段均复用具名会话名称文法（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`），因此路由可由名称段直接派生目标会话 id，无需第二套编码（[named-sessions](../../packages/session/named-sessions/README.md)）。完整地址硬性上限 160 字符；且由于名称段文法禁止 `:`，仅校验名称段即可拒绝多冒号形式。

[`parseMailboxAddress`](../../packages/mailbox/mailbox/src/address.ts) 针对段文法校验一条原始地址并为其加品牌（[品牌化 id](core.md#branded-ids)）；`formatMailboxAddress` 由已校验的部分组合地址，这对函数天然往返一致，未经校验的裸字符串无法越过提供方边界。

```ts type-equiv
/**
 * Opaque wire identity of one mailbox endpoint, `<namespace>:<name>`.
 * Grammar and validation live in {@link ./address.ts}; this brand keeps raw
 * strings from crossing a provider boundary unvalidated.
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
  /** Destination address in the `<namespace>:<name>` grammar. */
  readonly to: MailboxAddress
  /** Sender address in the same grammar; free-form provenance, never validated against live endpoints. */
  readonly from: string
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
   * the next natural gap. Delivered turns render the mark visibly (`[BLOCKING]`).
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

提供方在“一个部署命名空间对应一个逻辑存储”上实现这四种操作；地址不携带提供方限定符，因此今天不存在跨提供方寻址。

| 操作 | 契约 |
|---|---|
| `publish(message, signal?)` | 把一条消息持久化存储并分配新 id；signal 拥有从发起到存储接受之间的准入。 |
| `claim(filter, signal?)` | 原子地把可认领的赢家移到 `claimed` 并返回其租约；返回少于 `limit` 属正常。 |
| `settle(leaseRef, outcome, signal?)` | 记录一条租约的终态，或以 `pending` 顺延；只有现行 ref 才能落定。 |
| `claimableAddresses(filter, signal?)` | 枚举持有至少一条可认领消息的地址，镜像 `claim` 的选择；唤醒驱动器通过它发现工作，而不是自持座位花名册。 |

地址解析策略（chair-to-chair 别名）叠加在文法之上：保留的 `AddressResolutionExtension = never` 在 [`provider.ts`](../../packages/mailbox/mailbox/src/provider.ts) 中标记该扩展点，目前没有任何解析策略随附发布。随附的存储是 [dsh-mailbox-local](../../packages/mailbox/local)，以提供方名称 `local` 注册：基于 `node:sqlite` 的单个 SQLite 文件，其单调 `SCHEMA_VERSION` 戳记（当前为 2）使打开任何外来、更旧或更新的数据库响亮失败而非就地迁移，其守卫式事务认领保证每条消息恰有一个赢家（[sqlite.ts](../../packages/mailbox/local/src/sqlite.ts)）。

[seat-runner 守护进程](../../packages/mailbox/seat-runner/README.md) 消费 `claimableAddresses`，在宿主旁边启动唤醒运行——与人工运行相同的 headless 入口点和按名称锁，因此邮件永远不会把宿主变成会话日志的写入者（[architecture.md](../architecture.md) § "会话日志"中的一次写入规则）。

## 投递

[桥](../../packages/mailbox/bridge/README.md)把认领的消息排空成寻址目标 agent 上的用户回合；渲染由 [`delivery.ts`](../../packages/mailbox/bridge/src/delivery.ts) 负责。每个投递回合合并下方来源，使转录把中继邮件归因到其发送方地址而非匿名用户回合（[消息来源词汇](llm-streaming.md#content-blocks-and-messages)）：

```ts type-equiv
/** Attribution carried by every message the bridge delivers from a mailbox. */
interface MailboxMessageSource {
  readonly kind: 'mailbox'
  /** The message is addressed-to-this-agent content (`relay` context form). */
  readonly form: 'relay'
  /** Destination address that admitted this delivery (this agent's endpoint). */
  readonly address: MailboxAddress
  /** Sender address as published; free-form, never resolved. */
  readonly from: string
  /** Provider id of the stored message this delivery consumed. */
  readonly messageId: MailboxMessageId
  /** Correlation id threaded from the publisher, when present. */
  readonly traceId?: string
}
```

回合文本以空行拼接 `[BLOCKING]`（仅当发送方标记 `blocking: true`）、主题与 JSON 序列化的 payload；来源信封随消息来源携带，绝不进入文本。

投递遵循创始人 steer 模型：一切邮件都会立即 steer 进活跃回合，无论该回合处于何种状态、发送方的类型是什么——不推断忙碌程度，不按类型请求打断。被投递内容是抢占专注还是等下一个自然间隙，属于接收方的裁决，其依据是可见的 `[BLOCKING]` 标记。准入与 steer 之间的边界拒绝会回退为普通排队回合，因此什么都不会丢失；无论哪条路径，准入都是即时的，随后按路由观察到的结果落定。对休眠目标，桥取得按名驻留锁并探测持久化——日志缺失以原因 `unknown-address` 落定 `failed`，日志存在则冷恢复 agent、作为排队的 FIFO 回合投递、在准入即落定 `done`、等待静默、flush 再注销——而锁被另一个存活进程持有时落定 `pending` 留待后续周期。

准入在排水时强制执行：发送方命名空间必须被花名册服务，或列入 `admitFromNamespaces`（缺省为空——对外部来源邮件 FAIL-CLOSED），而 `seatAliases` 行把派生不可达的受服地址路由到一个既有的会话 id。每个终态失败还会向原始发送方尽力回发一条 `bounce` 通知——同一存储的答复路径，携带原 `traceId` 与记录的原因——并跳过 bounce-of-bounce；未被排空的退信只是一行未读消息，绝不会挂起，也绝不会掩盖首要失败。

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
 * destination address grammar.
 * @param message - message content without an id.
 * @param signal - caller cancellation owning admission.
 * @returns the provider-assigned durable id.
 */
async publish(message: Omit<MailboxMessage, 'id'>, signal?: AbortSignal): Promise<MailboxMessageId>

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
```

Source: [`packages/mailbox/mailbox/src/index.ts:55`](../../packages/mailbox/mailbox/src/index.ts)
<!-- END GENERATED cordis-surface -->

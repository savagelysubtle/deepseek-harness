# Mailbox

English | [中文](mailbox.zh.md)

The mailbox seam — durable agent-to-agent messaging delivered as user turns with publish/claim/settle semantics, split as a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): Service Definition ([dsh-mailbox](../../packages/mailbox/mailbox), `ctx.mailbox`), Service Provider ([dsh-mailbox-local](../../packages/mailbox/local)), and Consumer ([dsh-mailbox-bridge](../../packages/mailbox/bridge)). The seam owns neither durability nor exclusivity; a provider owns both. This page records the exact contracts from [`packages/mailbox/mailbox/src/types.ts`](../../packages/mailbox/mailbox/src/types.ts); per-package configuration and model effects live in the seam's [package-family README](../../packages/mailbox/README.md).

## Addresses

An endpoint's wire identity is a `<namespace>:<name>` address whose segments both reuse the named-session name grammar (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), so routing derives the target session id from the name half with no second encoding ([named-sessions](../../packages/session/named-sessions/README.md)). A full address is hard-bounded at 160 characters, and because the name segment grammar forbids `:`, validating the name half alone rejects multi-colon forms.

[`parseMailboxAddress`](../../packages/mailbox/mailbox/src/address.ts) validates one raw address against the segment grammar and brands it ([branded ids](core.md#branded-ids)); `formatMailboxAddress` composes from validated parts, so the pair round-trips by construction and raw strings cannot cross a provider boundary unvalidated.

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

## Stored messages

One published message is sender-owned data the transport never interprets; semantic structure belongs entirely to producers and consumers.

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

## Claims and settlement

A claim batches its selection and bounds itself explicitly:

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

`claim` atomically moves matching messages from `pending` (or stale `claimed`) to `claimed`; concurrent claimers of one message observe exactly one winner, and fewer leases than `limit` is normal. Delivery is **at-least-once**: a claimer that crashes before settling leaves its lease reclaimable after `staleClaimMs`, and reclaim mints a fresh claim token that disqualifies the abandoned ref — consumers tolerate duplicated claims.

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

Settlement records the terminal record of one delivery attempt, never the business result of the delivered work:

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

`done` means inbox admission — the message reached its target's queue — stamped `{ deliveredAt, messageId }`; answers travel only as newly published messages, never through settlement. `pending` defers the message back to its store for a later claim cycle, and `failed` records the reason. Only the issuing provider instance can settle a given ref.

## The provider contract

A provider implements the four operations over one logical store per deployment namespace; addresses carry no provider qualifier, so cross-provider addressing does not exist today.

| Operation | Contract |
|---|---|
| `publish(message, signal?)` | Stores one message durably and assigns it a fresh id; the signal owns admission until the store accepts. |
| `claim(filter, signal?)` | Atomically moves claimable winners to `claimed` and returns their leases; fewer than `limit` is normal. |
| `settle(leaseRef, outcome, signal?)` | Records one lease's terminal outcome, deferring with `pending`; only a current ref settles. |
| `claimableAddresses(filter, signal?)` | Enumerates addresses holding at least one claimable message, mirroring `claim`'s selection; wake drivers discover work through it instead of keeping their own seat roster. |

Address-resolution policies (chair-to-chair aliasing) layer ON TOP of the grammar: the reserved `AddressResolutionExtension = never` marks the extension point in [`provider.ts`](../../packages/mailbox/mailbox/src/provider.ts), and no resolution policy ships today. The shipped store is [dsh-mailbox-local](../../packages/mailbox/local), registering as provider `local`: one SQLite file over `node:sqlite` whose monotonic `SCHEMA_VERSION` stamp (currently 2) makes opening any foreign, older, or newer database fail loud instead of migrating, and whose guarded transaction claims admit exactly one winner per message ([sqlite.ts](../../packages/mailbox/local/src/sqlite.ts)).

The [seat-runner daemon](../../packages/mailbox/seat-runner/README.md) consumes `claimableAddresses` to start wake runs beside the host — the same headless entrypoint and per-name lock a human run takes, so mail never turns the host into a session-log writer (the one-writer rule in [architecture.md](../architecture.md) § "Session log").

## Delivery

The [bridge](../../packages/mailbox/bridge/README.md) drains claimed messages into user-role turns on the addressed agents; rendering is owned by [`delivery.ts`](../../packages/mailbox/bridge/src/delivery.ts). Every delivered turn merges the provenance below, so transcripts credit relayed mail to its sender address rather than an anonymous user turn ([message-source vocabulary](llm-streaming.md#content-blocks-and-messages)):

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

The turn's text joins `[BLOCKING]` (only when the sender marked `blocking: true`), the subject, and the JSON-serialized payload with blank lines; the provenance envelope rides the message source and never enters the text.

Delivering follows the founder steering model: ALL mail steers into a live turn immediately, whatever its state or the sender's type — no busyness inference, no type-based interrupt requests. Whether delivered content preempts focus waits on the RECEIVER's judging call, driven by the visible `[BLOCKING]` mark. A boundary refusal between admission and steer falls back to an ordinary queued turn, so nothing is lost; either way admission is immediate and settlement follows what routing observed. For a dormant target the bridge takes the per-name residency lock and probes persistence — an absent log settles `failed` with reason `unknown-address`, a present log cold-resumes the agent, delivers as a queued FIFO turn, settles `done` at admission, awaits quiescence, flushes, and disposes — while a lock held by another live process settles `pending` for a later cycle.

Admission is enforced at drain time: a sender namespace must be served by the roster or listed in `admitFromNamespaces` (empty by default — fail-closed against external-origin mail), and a `seatAliases` row routes a served address to an existing session id where derivation cannot reach one. Every terminal failure also publishes a best-effort `bounce` notice back to the original sender — same-store reply path carrying the original `traceId` and the recorded reason — skipping bounce-of-bounce; an undrainable bounce is an unread row, never a hang, and never masks the primary failure.

## The service

[`MailboxRegistry`](../../packages/mailbox/mailbox/src/index.ts) admits providers keyed by exact name — registering a live name twice fails loud, and the returned disposer removes its name only while it is still the registered entry, so a replacement re-registration is a legitimate swap. The no-provider conveniences (`publish`, `claim`, `settle`) resolve against the configured `defaultProvider`: a blank name fails schema validation at mount, an absent value or unregistered name fails loud at the resolved call naming the gap, and every convenience validates its addresses at the admitting operation. `getProvider` looks up one exact name; `list()` enumerates live providers in registration order. Method-level contracts generate into the Cordis API section below, and the package [README](../../packages/mailbox/mailbox/README.md) owns the consumer contract.

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

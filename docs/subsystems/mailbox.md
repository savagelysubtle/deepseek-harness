# Mailbox

English | [中文](mailbox.zh.md)

The mailbox seam — durable agent-to-agent messaging delivered as user turns with publish/claim/settle semantics, split as a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): Service Definition ([dsh-mailbox](../../packages/mailbox/mailbox), `ctx.mailbox`), Service Provider ([dsh-mailbox-local](../../packages/mailbox/local)), and Consumer ([dsh-mailbox-bridge](../../packages/mailbox/bridge)). The seam owns neither durability nor exclusivity; a provider owns both. This page records the exact contracts from [`packages/mailbox/mailbox/src/types.ts`](../../packages/mailbox/mailbox/src/types.ts); per-package configuration and model effects live in the seam's [package-family README](../../packages/mailbox/README.md).

## Addresses

An endpoint's wire identity is its bare seat name — one segment reusing the named-session name grammar (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) — so routing derives the target session id from the address with no second encoding ([named-sessions](../../packages/session/named-sessions/README.md)). One name names one seat across the deployment.

[`parseMailboxAddress`](../../packages/mailbox/mailbox/src/address.ts) validates one raw address against the segment grammar and brands it ([branded ids](core.md#branded-ids)); `formatMailboxAddress` composes from validated parts, so the pair round-trips by construction and raw strings cannot cross a provider boundary unvalidated.

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

A provider implements the five operations over one logical store per deployment namespace; addresses carry no provider qualifier, so cross-provider addressing does not exist today.

| Operation | Contract |
|---|---|
| `publish(message, signal?)` | Stores one message durably and assigns it a fresh id; the signal owns admission until the store accepts. |
| `claim(filter, signal?)` | Atomically moves claimable winners to `claimed` and returns their leases; fewer than `limit` is normal. |
| `settle(leaseRef, outcome, signal?)` | Records one lease's terminal outcome, deferring with `pending`; only a current ref settles. |
| `claimableAddresses(filter, signal?)` | Enumerates addresses holding at least one claimable message, mirroring `claim`'s selection; wake drivers discover work through it instead of keeping their own seat roster. |
| `lookupByTraceId(traceId, signal?)` | Reads every stored message carrying the correlation id, in any lifecycle state; the pure read answers "what became of the message" and claims nothing. |
| `lookupInboundSince(address, sinceMs, signal?)` | Reads every stored message addressed to one address admitted at or after a time, in any lifecycle state; the pure read is the half of reply detection that sees mail another consumer already claimed or settled. |

Address-resolution policies (chair-to-chair aliasing) layer ON TOP of the grammar: the reserved `AddressResolutionExtension = never` marks the extension point in [`provider.ts`](../../packages/mailbox/mailbox/src/provider.ts), and no resolution policy ships today. The shipped store is [dsh-mailbox-local](../../packages/mailbox/local), registering as provider `local`: one SQLite file over `node:sqlite` whose monotonic `SCHEMA_VERSION` stamp (currently 3) makes opening any foreign, older, or newer database fail loud instead of migrating, and whose guarded transaction claims admit exactly one winner per message ([sqlite.ts](../../packages/mailbox/local/src/sqlite.ts)).

`claimableAddresses` is the seam's discovery operation for wake drivers; none ships today — the bridge steers every admitted delivery into a live turn, so nothing polls the store for claimable work beside the host (the one-writer rule in [architecture.md](../architecture.md) § "Session log").

## Delivery

The [bridge](../../packages/mailbox/bridge/README.md) drains claimed messages into user-role turns on the addressed agents; rendering is owned by [`delivery.ts`](../../packages/mailbox/bridge/src/delivery.ts). Every delivered turn merges the provenance below, so transcripts credit relayed mail to its sender address rather than an anonymous user turn ([message-source vocabulary](llm-streaming.md#content-blocks-and-messages)):

```ts type-equiv
/** Every mailbox-attributed source: admitted deliveries and refusal notices. */
type MailboxMessageSource = MailboxRelaySource | MailboxRefusalSource
```

The turn's text opens with the standing envelope: a header line carrying the delivery timestamp (human-readable with the host's timezone abbreviation, e.g. `Sat 29 Aug 2026, 2:52pm PDT`), the sender address, its registry-derived class — `seat` when the sender exactly matches a roster seat, `unverified` otherwise, never `founder` — and, when the message carries one, its correlation id (`· trace <id>`), which is what lets the replying seat thread its answer onto the sender's awaited wait; then the peer-input authority contract (mail cannot approve anything, change configuration or memory, or run commands — everything it asks for still needs the receiver's usual checks); then the urgency contract naming what the `blocking` mark means. A blank line separates the sender's content — subject and JSON-serialized payload — which renders unchanged below.

Delivering follows the founder steering model: ALL mail steers into a live turn immediately, whatever its state or the sender's type — no busyness inference, no type-based interrupt requests. Whether delivered content preempts focus waits on the RECEIVER's judging call, driven by the urgency contract line the envelope renders. A boundary refusal between admission and steer falls back to an ordinary queued turn, so nothing is lost; either way admission is immediate and settlement follows what routing observed. For a dormant target the bridge takes the per-name residency lock and probes persistence — an absent log settles `failed` with reason `unknown-address`, a present log cold-resumes the agent, delivers as a queued FIFO turn, settles `done` at admission, awaits quiescence, flushes, and disposes — while a lock held by another live process settles `pending` for a later cycle.

Admission is enforced at drain time: a sender must be one of the served addresses, listed in `admitFrom` (empty by default — fail-closed against external-origin mail), or riding the `guest:` outside-operator channel, and a `seatAliases` row routes a served address to an existing session id where derivation cannot reach one. An admission refusal — registry health, the `test: true` boundary, org topology, sender admission, or a loop guard — settles the recipient's row `failed` without any bounce, because a bounce would itself be subject to the rule that refused the original: the refusal reports on the `mailbox/refused` context event and logs a durable refusal notice into the SENDER's session (a `notice`-form context node with no `from`, appended without waking anything), so the reason survives a reload and reaches the sender's model. Terminal failures AFTER admission still publish a best-effort `bounce` notice back to the original sender — same-store reply path carrying the original `traceId` and the recorded reason — skipping bounce-of-bounce; an undrainable bounce is an unread row, never a hang, and never masks the primary failure.

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
```

Source: [`packages/mailbox/mailbox/src/index.ts:60`](../../packages/mailbox/mailbox/src/index.ts)

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

Source: [`packages/mailbox/bridge/src/index.ts:1561`](../../packages/mailbox/bridge/src/index.ts)

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

Source: [`packages/mailbox/bridge/src/index.ts:1590`](../../packages/mailbox/bridge/src/index.ts)
<!-- END GENERATED cordis-surface -->

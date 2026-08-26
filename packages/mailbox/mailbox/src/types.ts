/**
 * Durable data contracts of the mailbox seam. Types only — every runtime
 * behavior lives in the service or a provider implementation.
 *
 * @module @deepseek-ai/dsh-mailbox/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque wire identity of one mailbox endpoint, `<namespace>:<name>`.
 * Grammar and validation live in {@link ./address.ts}; this brand keeps raw
 * strings from crossing a provider boundary unvalidated.
 */
export type MailboxAddress = Branded<'mailbox-address'>

/**
 * Provider-minted durable identity of one stored message. Unique within the
 * issuing provider; no cross-provider meaning.
 */
export type MailboxMessageId = Branded<'mailbox-message-id'>

/**
 * Provider-opaque handle returned by {@link MailboxProvider.claim} and
 * consumed by {@link MailboxProvider.settle}. The issuing provider instance
 * is the only legitimate settler; refs are meaningless across providers.
 */
export type MailboxLeaseRef = Branded<'mailbox-lease-ref'>

/** Lifecycle of one stored message inside a provider's store. */
export type MailboxState = 'pending' | 'claimed' | 'done' | 'failed'

/** One durable message accepted for delivery to a mailbox address. */
export interface MailboxMessage {
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
}

/**
 * Terminal record of one claim's settlement. `result` is the DELIVERY ENVELOPE
 * only — it records what became of the transport attempt, never the business
 * result of the delivered work; replies travel as new published messages.
 */
export type MailboxOutcome =
  | { readonly state: 'done'; readonly result: { readonly deliveredAt: number; readonly messageId: MailboxMessageId } }
  | { readonly state: 'failed'; readonly result: { readonly reason: string } }
  | { readonly state: 'pending'; readonly result: undefined }

/**
 * A message handed to exactly one claimer, paired with the ref its settlement
 * must arrive under. Delivery is at-least-once: a crashed claimer's lease is
 * reclaimed after `staleClaimMs`, so consumers tolerate duplicate claims.
 */
export interface MailboxLease {
  /** The stored message being delivered. */
  readonly message: MailboxMessage
  /** Provider-opaque settlement handle for exactly this claim. */
  readonly leaseRef: MailboxLeaseRef
  /** Epoch milliseconds at which this claim was made; staleness accounting input. */
  readonly claimedAt: number
}

/** Bounds and selection for one claim batch. */
export interface MailboxClaimFilter {
  /** Addresses to claim against; providers must scope every lease to one of these. */
  readonly addresses: readonly MailboxAddress[]
  /** Maximum leases returned in this batch; providers may return fewer, never more. */
  readonly limit: number
  /** Age (milliseconds) past which an abandoned `claimed` message reverts to claimable. */
  readonly staleClaimMs: number
}

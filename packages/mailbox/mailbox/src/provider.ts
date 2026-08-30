/**
 * The provider contract of the mailbox seam: one durable, cross-process
 * message store with publish/claim/settle semantics. Implementations live in
 * their own packages (`mailbox-local`, `mailbox-rest`); this module only
 * declares what any store must do.
 *
 * @module @deepseek-ai/dsh-mailbox/provider
 */

import type { MailboxAddress, MailboxClaimFilter, MailboxLease, MailboxMessageId, MailboxOutcome, MailboxPublishInput, MailboxStalenessFilter, MailboxTraceEntry } from './types.ts'

/**
 * One swappable mailbox storage backend. Providers own durability and
 * exclusivity; the seam owns none.
 *
 * Delivery is **at-least-once**: a claimer that crashes before settling leaves
 * its lease to be reclaimed by `staleClaimMs`, so consumers must tolerate a
 * duplicated claim. `done` records INBOX ADMISSION — the message reached its
 * target's queue — never an answer; replies travel as newly published
 * messages.
 */
export interface MailboxProvider {
  /** Registry-unique provider name used by default-provider resolution. */
  readonly name: string

  /**
   * Store one message durably and assign it a fresh {@link MailboxMessageId}
   * and sent time (`MailboxMessage.sentAt`).
   * @param message - the message content without an id or sent time; providers ignore or reject foreign ids loudly.
   * @param signal - caller cancellation owning admission until the store accepts.
   * @returns the assigned durable id.
   */
  publish(message: MailboxPublishInput, signal?: AbortSignal): Promise<MailboxMessageId>

  /**
   * Atomically move up to `filter.limit` messages matching `filter.addresses`
   * from `pending` (or stale `claimed`) to `claimed`, returning the leases.
   * Concurrent claimers of one message must observe exactly one winner.
   * @param filter - address selection, batch bound, and staleness bound.
   * @param signal - caller cancellation owning the claim attempt.
   * @returns the claimed leases; fewer than `limit` (or none) is normal.
   */
  claim(filter: MailboxClaimFilter, signal?: AbortSignal): Promise<readonly MailboxLease[]>

  /**
   * Record one lease's terminal outcome. A `pending` outcome defers the
   * message back to its store for a later claim cycle.
   * @param leaseRef - the ref received from the claiming {@link claim} call.
   * @param outcome - delivery-envelope outcome; see {@link MailboxOutcome} for the no-business-payload rule.
   * @param signal - caller cancellation owning the settlement write.
   */
  settle(leaseRef: MailboxLease['leaseRef'], outcome: MailboxOutcome, signal?: AbortSignal): Promise<void>

  /**
   * Enumerate every address holding at least one claimable message —
   * `pending`, or `claimed` past the staleness bound — mirroring
   * {@link claim}'s selection exactly. A wake driver discovers work through
   * this instead of maintaining its own seat roster; a returned address
   * yields at least one lease from a subsequent claim against it, unless a
   * concurrent claimer wins the message first (the at-least-once contract).
   * @param filter - the staleness bound shared with {@link claim}.
   * @param signal - caller cancellation owning the scan.
   * @returns the addresses with claimable work, in provider-determined order.
   */
  claimableAddresses(filter: MailboxStalenessFilter, signal?: AbortSignal): Promise<readonly MailboxAddress[]>

  /**
   * Read every stored message carrying `traceId`, regardless of its current
   * claim or settlement state — a lookup answers "has this correlation id
   * traveled before, and in which direction", not "what is still queued". A
   * pure read: it claims nothing, settles nothing, and mutates nothing.
   * @param traceId - the correlation id to search for, matched exactly.
   * @param signal - caller cancellation owning the scan.
   * @returns one entry per stored message carrying the id, earliest send first.
   */
  lookupByTraceId(traceId: string, signal?: AbortSignal): Promise<readonly MailboxTraceEntry[]>

  /**
   * Read every stored message addressed to `address` admitted at or after
   * `sinceMs`, regardless of its current claim or settlement state — the
   * read half of reply detection: a reply another consumer (the bridge) has
   * already claimed or settled is invisible to `claim`, and this read is
   * what lets a waiter recognize it anyway. A pure read: it claims nothing,
   * settles nothing, and mutates nothing.
   * @param address - the recipient address to scan; the caller's own address
   *   in the reply-detection use.
   * @param sinceMs - epoch-milliseconds floor (inclusive) on the row's
   *   admission time.
   * @param signal - caller cancellation owning the scan.
   * @returns one entry per matching row, earliest admission first.
   */
  lookupInboundSince(address: MailboxAddress, sinceMs: number, signal?: AbortSignal): Promise<readonly MailboxTraceEntry[]>
}

/**
 * Extension point for future resolution policies: today an address's name
 * half routes by derivation agreement with `@deepseek-ai/dsh-named-sessions`
 * (the bridge derives the session id from the same name). Chair-to-chair and
 * other aliasing schemes layer ON TOP of this grammar — they must parse,
 * format, and round-trip through {@link ./address.ts} unchanged, then define
 * their own namespace conventions above it. No policy lives here yet by design.
 */
export type AddressResolutionExtension = never

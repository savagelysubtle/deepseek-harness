/**
 * The provider contract of the mailbox seam: one durable, cross-process
 * message store with publish/claim/settle semantics. Implementations live in
 * their own packages (`mailbox-local`, `mailbox-rest`); this module only
 * declares what any store must do.
 *
 * @module @deepseek-ai/dsh-mailbox/provider
 */

import type { MailboxClaimFilter, MailboxLease, MailboxMessage, MailboxMessageId, MailboxOutcome } from './types.ts'

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
   * Store one message durably and assign it a fresh {@link MailboxMessageId}.
   * @param message - the message content without an id; providers ignore or reject foreign ids loudly.
   * @param signal - caller cancellation owning admission until the store accepts.
   * @returns the assigned durable id.
   */
  publish(message: Omit<MailboxMessage, 'id'>, signal?: AbortSignal): Promise<MailboxMessageId>

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

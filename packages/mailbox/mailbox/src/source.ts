/**
 * Durable provenance for mailbox traffic that reached a session log through
 * the mailbox seam: an ADMITTED delivery credited to its sender address, and
 * a refusal NOTICE the harness logged into the sender's own session. Merged
 * into the shared `MessageSourceMap` so neither reads as an anonymous user
 * turn, and distinguished on `form` so a consumer can tell mail from the
 * harness's report on a refused send.
 *
 * @module @deepseek-ai/dsh-mailbox/source
 */

import type { MailboxAddress, MailboxMessageId } from './types.ts'
// A real import binds this file's declaration to the actual module — without
// it, `declare module` below declares a fresh ambient module instead of
// augmenting the shared source map.
import type { MessageSource } from '@deepseek-ai/dsh-llm'

/**
 * Attribution carried by an ADMITTED delivery: the merged source that credits
 * a delivered user turn to its sender address.
 */
export interface MailboxRelaySource {
  readonly kind: 'mailbox'
  /** The message is addressed-to-this-agent content (`relay` context form). */
  readonly form: 'relay'
  /** Destination address that admitted this delivery (this agent's endpoint). */
  readonly address: MailboxAddress
  /** Sender address as published; free-form, never resolved. */
  readonly from: string
  /** Provider id of the stored message this delivery consumed. */
  readonly messageId: MailboxMessageId
  /**
   * Sender class the bridge derived at delivery — `seat` when the sender
   * address exactly matched a roster seat, `unverified` for everything else,
   * including a forged name. Mirrors `SenderClass` in the bridge, duplicated
   * inline because the package that owns this source must not depend on the
   * package that stamps it. Consumers treat an absent field as an older row,
   * never as a third class.
   */
  readonly senderClass?: 'seat' | 'unverified'
  /** Subject line the sender carried, when the message had one. */
  readonly subject?: string
  /**
   * Whether the sender marked the mail blocking — the correspondent is
   * stopped waiting on a reply — when the message carried the mark. Absent
   * on a message that stated no urgency at all, which is not the same as
   * `false`.
   */
  readonly blocking?: boolean
  /** Correlation id threaded from the publisher, when present. */
  readonly traceId?: string
}

/**
 * Attribution carried by a refusal NOTICE the bridge logs into the SENDER's
 * own session after refusing one of its messages. The harness reporting on
 * the sender's own action — never correspondence from the refused recipient —
 * so it deliberately carries NO `from` field: a readable `from` is what makes
 * a mailbox source present as incoming mail (`mailboxRelay` on the client),
 * and a refusal must never render as mail from a peer. It is also not a store
 * message: nothing routes it, so no admission rule can ever judge it and a
 * refusal notice can never itself be refused.
 */
export interface MailboxRefusalSource {
  readonly kind: 'mailbox'
  /** The one-off account of what just happened (`notice` context form). */
  readonly form: 'notice'
  /** Recipient address the refused mail was addressed to. */
  readonly refusedTo: MailboxAddress
  /** Provider id of the refused message, tying the notice back to the send. */
  readonly messageId: MailboxMessageId
  /** The terminal reason recorded on the recipient's failed row, verbatim. */
  readonly reason: string
  /**
   * One-line account of what happened, shown without expanding the row — the
   * `notice` form's collapsed-row contract, bounded by the producer.
   */
  readonly summary: string
}

/** Every mailbox-attributed source: admitted deliveries and refusal notices. */
export type MailboxMessageSource = MailboxRelaySource | MailboxRefusalSource

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    mailbox: MailboxMessageSource
  }
}

/**
 * Compile-time proof that the augmented member joined the shared union:
 * consumers narrowing on `MessageSource['kind']` must observe `'mailbox'`.
 */
export type MailboxSourceIsMerged = MailboxMessageSource extends MessageSource ? true : never
const merged: MailboxSourceIsMerged = true
void merged

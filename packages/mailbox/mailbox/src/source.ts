/**
 * Durable provenance for a message admitted through the mailbox seam.
 * Merged into the shared `MessageSourceMap` so transcripts credit delivered
 * mailbox traffic to its sender address instead of an anonymous user turn.
 *
 * @module @deepseek-ai/dsh-mailbox/source
 */

import type { MailboxAddress, MailboxMessageId } from './types.ts'
// A real import binds this file's declaration to the actual module — without
// it, `declare module` below declares a fresh ambient module instead of
// augmenting the shared source map.
import type { MessageSource } from '@deepseek-ai/dsh-llm'

/** Attribution carried by every message the bridge delivers from a mailbox. */
export interface MailboxMessageSource {
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

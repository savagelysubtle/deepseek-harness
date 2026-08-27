/**
 * Delivery rendering shared by the bridge drain loop and the headless
 * served-address hook: one claimed {@link MailboxLease} becomes exactly one
 * user-role turn carrying the merged `mailbox` message source, so transcripts
 * credit the relayed mail to its sender address.
 *
 * @module @deepseek-ai/dsh-mailbox-bridge/delivery
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MailboxLease, MailboxMessageSource, MailboxOutcome } from '@deepseek-ai/dsh-mailbox'

/**
 * Fixed bound on how many backlog messages the headless served-address hook
 * admits ahead of a named run's task. The hook is a bounded courtesy drain,
 * not a paced consumer — deployments needing tuning run the bridge.
 */
export const HEADLESS_BACKLOG_LIMIT = 16

/**
 * Staleness bound the headless hook applies when reclaiming another claimer's
 * abandoned lease during its start-of-run backlog drain.
 */
export const HEADLESS_BACKLOG_STALE_CLAIM_MS = 120_000

/**
 * The admission outcome for one claimed lease: `done` stamped with now and
 * the store-assigned message id. Claimed messages always carry ids; this
 * fails loud instead of forging an envelope if a provider violates that.
 * @param lease - the claimed lease being admitted.
 * @returns the settlement payload both delivery paths record.
 */
export function admittedOutcome(lease: MailboxLease): MailboxOutcome {
  const { id, to } = lease.message
  if (id === undefined) {
    throw new Error(`mailbox delivery: claimed message for "${to}" has no provider id`)
  }
  return { state: 'done', result: { deliveredAt: Date.now(), messageId: id } }
}

/**
 * Render the model-visible text of one claimed message. The subject and the
 * payload body are the sender's content; the provenance envelope rides the
 * message source, never the text.
 * @param lease - the claimed lease being delivered.
 * @returns the plain-text turn content; an empty-string fallback keeps every
 *   delivered turn structurally renderable even for a contentless notice.
 */
export function relayText(lease: MailboxLease): string {
  const parts: string[] = []
  // Founder-model visibility rule: a blocked sender is distinguishable at a
  // glance in the transcript, before any model reasoning weighs the content.
  if (lease.message.blocking === true) parts.push('[BLOCKING]')
  if (lease.message.subject !== undefined) parts.push(lease.message.subject)
  if (lease.message.payload !== undefined) {
    parts.push(typeof lease.message.payload === 'string' ? lease.message.payload : JSON.stringify(lease.message.payload, null, 2))
  }
  return parts.join('\n\n')
}

/**
 * Build the merged mailbox message source for one claimed message. The store
 * assigns durable ids at publish, so a claimed lease always carries one; this
 * helper fails loud instead of forging a source if a provider ever violates
 * that expectation.
 * @param lease - the claimed lease being delivered.
 * @returns the attribution object merged into the delivered user turn.
 */
export function relaySource(lease: MailboxLease): MailboxMessageSource {
  const { id, to, from, traceId } = lease.message
  if (id === undefined) {
    throw new Error(`mailbox bridge: claimed message for "${to}" has no provider id and cannot be delivered`)
  }
  return {
    kind: 'mailbox',
    form: 'relay',
    address: to,
    from,
    messageId: id,
    ...traceId !== undefined ? { traceId } : {},
  }
}

/**
 * Render one claimed lease as its ordinary user-role delivery turn.
 * @param lease - the claimed lease being delivered.
 * @returns the identified prompt content for `Agent.steer` / `followup`.
 */
export function relayUserMessage(lease: MailboxLease): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: relayText(lease) }],
    source: relaySource(lease),
  })
}

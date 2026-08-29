/**
 * The two model-facing mailbox tools. Both carry the deployment-supplied
 * trusted session name and resolve their identity through
 * {@link resolveMailboxIdentity} inside `execute`: `mailbox_send` fills the
 * envelope's sender from it — the schema has no `from` to fill — and
 * `mailbox_check_inbox` drains it, taking no address argument at all. A seat
 * can address mail anywhere but can only ever be itself.
 *
 * @module @deepseek-ai/dsh-tool-mailbox/tools
 */

import { parseMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import type { MailboxLease, MailboxMessageId, MailboxRegistry } from '@deepseek-ai/dsh-mailbox'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveMailboxIdentity } from './identity.ts'
import type { IdentitySources } from './identity.ts'

/**
 * Batch bound of one `mailbox_check_inbox` drain. Aligned in value with the
 * `dsh-mailbox` CLI's `INBOX_DEFAULT_LIMIT` so a seat and the outside
 * operator drain the same amount per admission pass.
 */
export const CHECK_INBOX_DRAIN_LIMIT = 20

/**
 * Staleness bound applied while claiming, aligned in value with the CLI's
 * `INBOX_STALE_CLAIM_MS` and the bridge's `DEFAULT_STALE_CLAIM_MS`: a crashed
 * drainer's abandoned lease is reclaimable on one shared clock everywhere.
 */
export const CHECK_INBOX_STALE_CLAIM_MS = 60_000

/** Canonical outcome of one sent message. */
export interface SendResult {
  /** Provider-assigned durable id of the stored message. */
  readonly messageId: string
  /** Destination address as published. */
  readonly to: string
  /** Sender address the runtime filled from the trusted session name. */
  readonly from: string
}

/** One drained message in the tool's canonical output. */
export interface InboxEntry {
  /** Provider-assigned durable id of the delivered message. */
  readonly messageId: string
  /** Sender address as published; free-form provenance, never resolved. */
  readonly from: string
  /** Present only when the sender marked itself blocked waiting for an answer. */
  readonly blocking?: true
  /** The sender's subject line, when it supplied one. */
  readonly subject?: string
  /** The sender's body; non-string payloads render as their JSON text. */
  readonly body: string
  /** Epoch milliseconds at which this drain claimed the message. */
  readonly claimedAt: number
}

/** Canonical outcome of one inbox drain. */
export interface CheckInboxResult {
  /**
   * The drained messages, in claim order. Declared mutable to match the
   * output schema's inferred value type; the registry snapshots and freezes
   * the canonical value after the body returns.
   */
  readonly messages: InboxEntry[]
  /** Convenience count of {@link CheckInboxResult.messages}. */
  readonly count: number
}

/** Project one claimed lease's payload onto its string body form. */
function bodyOf(lease: MailboxLease): string {
  const { payload } = lease.message
  if (payload === undefined) return ''
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
}

/** Project one claimed lease onto its canonical inbox entry. */
function toEntry(lease: MailboxLease): InboxEntry {
  const { id, from, subject, blocking } = lease.message
  if (id === undefined) {
    throw new Error(`mailbox_check_inbox: claimed message from "${from}" has no provider id and cannot be delivered`)
  }
  return {
    messageId: id,
    from,
    ...blocking === true ? { blocking: true as const } : {},
    ...subject !== undefined ? { subject } : {},
    body: bodyOf(lease),
    claimedAt: lease.claimedAt,
  }
}

/**
 * Fold the calling agent's session id into the mount-time identity inputs.
 * Kept as a function rather than a spread at each call site so the two tools
 * cannot drift on which sources they consider.
 * @param mounted - the deployment-supplied identity inputs.
 * @param agentSessionId - the calling agent's durable session id, when the
 *   call runs inside an agent loop.
 * @returns the complete input to {@link resolveMailboxIdentity}.
 */
function callerIdentity(mounted: IdentitySources, agentSessionId: string | undefined): IdentitySources {
  return { ...mounted, ...agentSessionId !== undefined ? { agentSessionId } : {} }
}

/**
 * Build the `mailbox_send` tool: publish one message whose sender is the
 * trusted session name. The registry's `publish` validates the destination
 * address grammar; the stamped `from` needs no validation because it never
 * passes through the model.
 * @param mailbox - the mailbox registry whose default provider admits the message.
 * @param identity - the deployment's mount-time identity inputs; the calling
 *   agent's own session id is added per call.
 * @returns the registry-ready tool definition.
 */
export function mailboxSendTool(mailbox: MailboxRegistry, identity: IdentitySources) {
  return defineTool({
    name: 'mailbox_send',
    description: 'Send a mailbox message to another seat by its bare name. '
      + 'The sender is filled in by the runtime from this session\'s trusted name and cannot be chosen or changed — '
      + 'the recipient sees the message as coming from this seat. '
      + 'Replies travel as their own mailbox_send calls, not inside this one.',
    parameters: {
      to: {
        type: 'string',
        required: true,
        description: 'The recipient seat\'s bare name (for example "batman"). One name names one seat across the whole deployment.',
      },
      subject: {
        type: 'string',
        required: true,
        description: 'Short human-readable subject line.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The message text. Keep it self-contained: the recipient may read it without this conversation\'s context.',
      },
      blocking: {
        type: 'boolean',
        description: 'True when you are blocked waiting on an answer to this message and the recipient should handle it now; '
          + 'omit for ordinary mail the recipient can absorb at a natural gap.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
          to: { type: 'string', required: true },
          from: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Stored for ${value.to} as message ${value.messageId} (sender ${value.from}).`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Send mail to ${args.to}`,
      kind: 'other',
      rawInput: { to: args.to, subject: args.subject },
    }),
    async execute(args, exec) {
      const from = resolveMailboxIdentity(callerIdentity(identity, exec.agent?.id))
      // The branded boundary: the destination crosses into the seam here, so
      // the grammar check that admits it runs at this exact edge. The
      // registry re-validates by contract; this call gives the model the
      // grammar error with no intervening framing.
      const to = parseMailboxAddress(args.to)
      const messageId = await mailbox.publish({
        to,
        from,
        subject: args.subject,
        payload: args.body,
        ...args.blocking !== undefined ? { blocking: args.blocking } : {},
      }, exec.signal)
      const result: SendResult = { messageId, to, from }
      return result
    },
  })
}

/**
 * Build the `mailbox_check_inbox` tool: drain this seat's own address and
 * nothing else. The tool takes no address argument — the drained address IS
 * the trusted identity — so a seat cannot read another seat's mail by naming
 * it. Each claimed message settles as delivered (inbox admission); a crash
 * between claim and settle is reclaimed by the staleness bound.
 * @param mailbox - the mailbox registry whose default provider holds the queue.
 * @param identity - the deployment's mount-time identity inputs; the calling
 *   agent's own session id is added per call.
 * @returns the registry-ready tool definition.
 */
export function mailboxCheckInboxTool(mailbox: MailboxRegistry, identity: IdentitySources) {
  return defineTool({
    name: 'mailbox_check_inbox',
    description: 'Drain this seat\'s own mailbox: claim and deliver every pending message addressed to this seat. '
      + 'Takes no address argument — the runtime drains this session\'s own address, and only that one. '
      + 'Each returned message is removed from the pending queue (delivered); call it whenever you expect mail, '
      + 'for example after learning a coworker sent you something.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                messageId: { type: 'string', required: true },
                from: { type: 'string', required: true },
                blocking: { type: 'boolean' },
                subject: { type: 'string' },
                body: { type: 'string', required: true },
                claimedAt: { type: 'integer', required: true },
              },
            },
          },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? 'Inbox empty — no pending mail for this seat.'
          : value.messages.map((entry, index) => {
            const head = `${index + 1}. from ${entry.from}${entry.blocking === true ? ' [BLOCKING]' : ''}`
              + `${entry.subject !== undefined ? `: ${entry.subject}` : ''}`
            return entry.body === '' ? head : `${head}\n${entry.body}`
          }).join('\n\n'),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'Check inbox', kind: 'other' }),
    async execute(_args, exec) {
      const own = resolveMailboxIdentity(callerIdentity(identity, exec.agent?.id))
      const leases = await mailbox.claim({
        addresses: [own],
        limit: CHECK_INBOX_DRAIN_LIMIT,
        staleClaimMs: CHECK_INBOX_STALE_CLAIM_MS,
      }, exec.signal)
      const pairs = leases.map(lease => ({ lease, entry: toEntry(lease) }))
      // Receipts first — exactly what the seam calls inbox admission; a crash
      // before this loop finishes reclaims through the staleness bound.
      for (const { lease, entry } of pairs) {
        await mailbox.settle(lease.leaseRef, {
          state: 'done',
          // `toEntry` already failed loud on a missing id, so the settlement
          // envelope always carries the provider-assigned id it names.
          result: { deliveredAt: Date.now(), messageId: entry.messageId as MailboxMessageId },
        }, exec.signal)
      }
      const messages = pairs.map(({ entry }) => entry)
      const result: CheckInboxResult = { messages, count: messages.length }
      return result
    },
  })
}

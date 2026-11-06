/**
 * `mailbox_send`: the one tool through which a Claude Code seat speaks. Every rule below is enforced
 * here, in the host process, from the seat's closure, never from model input:
 *
 * - (a) `from` is the seat's own agent id captured at server construction. No input field can set
 *   it, and it is never the Claude session id.
 * - (b) the destination is `to`, and `to` must be in the host stanza's `send_to`. An empty `send_to`
 *   refuses every send and names the stanza key.
 * - (c) `replyToTraceId` is accepted only if the driver reports it as a delivered trace id. It is a
 *   label copied onto the outgoing message and is never used to find a destination.
 * - (d) `blocking: true` needs `allow_blocking: true` in the host stanza.
 * - (e) a send from a tainted session carries `tainted: true` and no `chain`: `from` already names the
 *   origin and the bridge appends each hop to `chain` itself.
 *   Stamping labels the message; it never denies the send.
 * - (f) the message goes through the mailbox publish API, which validates it.
 * - a per-closure send counter caps one query at {@link MAX_SENDS_PER_TURN} sends (the 21st is refused).
 * - (g) the result text is short and names only the seat that was mailed.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/mcp/send
 */

import { parseMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import type { MailboxPublishInput } from '@deepseek-ai/dsh-mailbox'
import { MAILBOX_SEND_TOOL } from '../contributors.ts'
import { SEND_SCHEMA } from './schema.ts'
import { defineSeatTool, textResult } from './types.ts'
import type { SeatTool, SeatToolContext } from './types.ts'

/** Most sends one server (one query) may make; the next is refused with a reason naming this cap. */
export const MAX_SENDS_PER_TURN = 20

/**
 * Build the `mailbox_send` tool over a seat's closure.
 * @param context - the seat closure; `context.seat` is the only source of `from`.
 * @returns the tool.
 */
export function createSendTool(context: SeatToolContext): SeatTool {
  let sends = 0
  const refuse = (why: string) => textResult(context, `mailbox_send refused: ${why}`, true)
  return defineSeatTool(context, {
    name: MAILBOX_SEND_TOOL,
    description: 'Send mail to another seat. Only the seats mailbox_directory lists can be mailed. Your own identity is attached for you.',
    inputSchema: SEND_SCHEMA,
    taint: 'never',
    taintReason: 'returns only a trace id and the destination name the operator configured in send_to; no mail body or external content comes back',
    handler: async (input) => {
      if (context.sendTo.length === 0) {
        return refuse('this seat has no send_to entries in its host stanza (key send_to), so it cannot send mail')
      }
      if (!context.sendTo.includes(input.to)) {
        return refuse(`${input.to} is not in this seat's send_to list (use mailbox_directory)`)
      }
      if (input.replyToTraceId !== undefined && !context.deliveredTraceIds().has(input.replyToTraceId)) {
        return refuse('replyToTraceId is not the trace id of a message delivered to this seat')
      }
      if (input.blocking === true && !context.allowBlocking) {
        return refuse('blocking mail is not allowed for this seat (allow_blocking is not set in its host stanza)')
      }
      if (sends >= MAX_SENDS_PER_TURN) {
        return refuse(`this turn already sent ${MAX_SENDS_PER_TURN} messages, which is the most one turn may send`)
      }
      sends += 1
      const traceId = input.replyToTraceId ?? context.newTraceId()
      const message: MailboxPublishInput = {
        to: parseMailboxAddress(input.to),
        from: context.seat,
        payload: input.body,
        traceId,
        ...input.blocking === undefined ? {} : { blocking: input.blocking },
        ...context.isTainted() ? { tainted: true } : {},
      }
      try {
        await context.publish(message)
      } catch (error: unknown) {
        // The mailbox's own text stays host-side: it can name stores, paths or other seats.
        context.warn(`agent-claude-code-tools: seat "${context.seat}": mailbox_send publish failed: ${String(error)}`)
        return refuse('the mailbox rejected the message')
      }
      return textResult(context, `Sent to ${input.to}. Trace id ${traceId}.`)
    },
  })
}

/** First-party semantic text extraction for session-query consumers. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Loose shape of a `mailbox/await` event's data, mirrored from
 * `packages/mailbox/tool-mailbox/src/await-event.ts` (SWD-99). That package
 * is not a dependency of session-query (see its package.json), so the
 * `SessionEventMap['mailbox/await']` type augmentation it declares is never
 * part of this package's compiled program and `event.type` cannot narrow to
 * it in a `switch` — fields are read through this locally-mirrored shape
 * instead of importing the owning package.
 */
interface MailboxAwaitEventData {
  outcome: 'reply' | 'refused' | 'timeout' | 'aborted' | 'error'
  sentState?: 'delivered' | 'claimed' | 'pending' | 'unknown'
  refusalReason?: string
  errorMessage?: string
  counterpart?: string
}

/**
 * Loose shape of a `subagent/settlement` event's data, mirrored from
 * `packages/subagent/subagent/src/settlement.ts` (SWD-95). session-query
 * does not depend on the subagent package either, for the same reason the
 * `mailbox/await` shape above is mirrored rather than imported.
 */
interface SubagentSettlementEventData {
  outcome: string
  parentSessionId: string
}

/**
 * Extract searchable semantic text from one first-party session event.
 *
 * Structural boundaries, raw stream chunks, request envelopes, and unknown
 * declaration-merged events contribute no text.
 * @param event - event to inspect.
 * @returns newline-joined semantic text, or an empty string when non-searchable.
 */
export function extractSessionEventText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return contentText(event.data.content)
    case 'assistant/message':
      return contentText(event.data.message.content)
    case 'tool/call':
      return joinText([event.data.name, event.data.arguments])
    case 'tool/result':
      return joinText([
        contentText(event.data.message.content),
        event.data.error?.name ?? '',
        event.data.error?.code ?? '',
      ])
    case 'todo/write':
      return joinText(event.data.todos.flatMap(todo => [todo.status, todo.content]))
    case 'turn/end':
      return turnEndText(event.data.reason)
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/chunk':
    case 'request/header':
      return ''
    // SessionEventMap is merge-extensible. Unknown events remain
    // non-searchable until a concrete first-party consumer defines semantics
    // — except `mailbox/await` and `subagent/settlement`, whose owning
    // packages are outside session-query's dependency graph (see the
    // interfaces above) and so cannot appear as typed `case` labels here.
    default:
      if ((event.type as string) === 'mailbox/await') {
        return mailboxAwaitText(event.data as unknown as MailboxAwaitEventData)
      }
      if ((event.type as string) === 'subagent/settlement') {
        return settlementText(event.data as unknown as SubagentSettlementEventData)
      }
      return ''
  }
}

function mailboxAwaitText(data: MailboxAwaitEventData): string {
  return joinText([
    data.outcome,
    data.sentState ?? '',
    data.refusalReason ?? '',
    data.errorMessage ?? '',
    data.counterpart ?? '',
  ])
}

function settlementText(data: SubagentSettlementEventData): string {
  return joinText([data.outcome, data.parentSessionId])
}

function turnEndText(reason: SessionEvent<'turn/end'>['data']['reason']): string {
  switch (reason.kind) {
    case 'error':
      return joinText(['error', reason.error.message])
    case 'aborted':
      return 'aborted'
    case 'max-tokens':
    case 'interrupted':
      return reason.kind
    case 'completed':
      return ''
    // TurnEndReasonMap is merge-extensible. Unknown outcomes stay out until
    // their owner defines which detail is semantic rather than structural.
    default:
      return ''
  }
}

type SessionContentBlock = SessionEvent<'user/message'>['data']['content'][number]

function contentText(content: readonly SessionContentBlock[]): string {
  return joinText(content.flatMap(blockText))
}

function blockText(block: SessionContentBlock): string[] {
  switch (block.type) {
    case 'text':
      return [block.text]
    case 'reasoning':
      return []
    case 'tool-call':
      return [block.name, block.arguments]
    case 'tool-result':
      return block.content.flatMap(blockText)
    // ContentBlockMap is merge-extensible. Unknown blocks do not become
    // searchable merely because their payload happens to contain strings.
    default:
      return []
  }
}

function joinText(parts: readonly string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join('\n')
}

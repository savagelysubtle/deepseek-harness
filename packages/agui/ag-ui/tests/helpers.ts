/**
 * Shared fixtures for the dsh-ag-ui test suites: minimal session-event
 * constructors with deterministic sequence numbers.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'

let nextSeq = 0

/**
 * Build one log event with an auto-assigned (or explicit) seq number.
 * @param type - event discriminant.
 * @param data - payload matching the discriminant.
 * @param seq - explicit sequence override; defaults to a running counter.
 * @returns the event cast to the envelope union.
 */
export function ev<K extends SessionEventType>(type: K, data: SessionEventMap[K], seq: number = nextSeq++): SessionEvent {
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

/** Reset the shared sequence counter for a fresh deterministic run. */
export function resetSeq(): void {
  nextSeq = 0
}

/** A minimal user message fixture; only id/role/content are read by the projection. */
export function userMessage(id: string, text: string): SessionEventMap['user/message'] {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as SessionEventMap['user/message']
}

/** A minimal assistant message fixture with one text block. */
export function assistantMessage(id: string, text: string): SessionEventMap['assistant/message']['message'] {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'test', model: 'test-model' },
  } as unknown as SessionEventMap['assistant/message']['message']
}

/**
 * The resolved listen port parsed back from the adapter's startup log line.
 * @param ctx - the booted context running the adapter.
 * @returns the OS-assigned or configured port.
 */
export function listeningPort(ctx: Context): number {
  for (const message of ctx.logger.buffer) {
    if (message.type !== 'info') continue
    const match = /http:\/\/[^:]+:(\d+)\/ag-ui\//.exec(String(message.args[0] ?? ''))
    if (match !== null) return Number(match[1])
  }
  throw new Error('adapter did not log its listening address')
}

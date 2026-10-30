/**
 * Founder marker (SWD-156, see `../src/founder-marker.ts`): the frozen
 * sentence, and its placement on the header line by `renderDispatch`.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, MessageId, type Message, type MessageSource } from '@deepseek-ai/dsh-llm'
import { FOUNDER_MARKER_TEXT } from '../src/founder-marker.ts'
import { renderDispatch } from '../src/render-dispatch.ts'

const T = Date.parse('2026-10-30T18:54:00Z')
const opts = { timeZone: 'America/Vancouver' }
const STAMP = '[Fri 2026-10-30 11:54 PDT]'

function render(message: Message): Message {
  return renderDispatch([{ message, time: T }], opts)[0]!
}

describe('FOUNDER_MARKER_TEXT', () => {
  it('keeps the ruled wording unchanged', () => {
    expect(FOUNDER_MARKER_TEXT).toBe(
      "This message is the founder's own, typed at this machine; it is not peer or relay traffic.",
    )
  })
})

describe('founder marker placement', () => {
  it('puts the marker on the header line after the stamp, then a blank line, then the original blocks', () => {
    const stamped = createUserMessage({
      content: [{ type: 'text', text: 'do the thing' }],
      source: { kind: 'user', founder: true },
    })
    const out = render(stamped)
    expect(out).not.toBe(stamped)
    expect(out.content).toEqual([
      { type: 'text', text: `${STAMP} ${FOUNDER_MARKER_TEXT}\n\n` },
      { type: 'text', text: 'do the thing' },
    ])
    expect(out.id).toBe(stamped.id)
    expect(out.source).toEqual(stamped.source)
  })

  it('leaves the original message and its content array untouched', () => {
    const stamped = createUserMessage({
      content: [{ type: 'text', text: 'untouched' }],
      source: { kind: 'user', founder: true },
    })
    const snapshot = structuredClone(stamped.content)
    render(stamped)
    expect(stamped.content).toEqual(snapshot)
    expect(Object.isFrozen(stamped)).toBe(true)
    expect(Object.isFrozen(stamped.content)).toBe(true)
  })

  it('never puts the marker on a bare user, plugin, mailbox or subagent-report message', () => {
    const sources: MessageSource[] = [
      { kind: 'user' },
      { kind: 'plugin', plugin: 'test' },
      { kind: 'mailbox', form: 'relay', address: 'a', from: 'b', messageId: 'm' } as unknown as MessageSource,
      { kind: 'subagent-report', form: 'notice', summary: 's', senderSessionId: 'c' } as unknown as MessageSource,
    ]
    for (const source of sources) {
      const out = render({ id: MessageId('m'), role: 'user', content: [{ type: 'text', text: 'x' }], source })
      expect(JSON.stringify(out)).not.toContain(FOUNDER_MARKER_TEXT)
      expect(out.content[0]).toEqual({ type: 'text', text: `${STAMP}\n\n` })
    }
  })
})

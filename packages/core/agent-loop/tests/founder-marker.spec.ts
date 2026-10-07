/**
 * Per-message founder marker (SWD-156, see `../src/founder-marker.ts`):
 * `markFounderMessages` prepends `FOUNDER_MARKER_TEXT` as a leading text
 * block to every founder-stamped message, and returns every other message
 * by the same reference. Mirrors `clock.spec.ts`'s shape: a small, pure,
 * request-only transform proven as a standalone unit, with the loop-level
 * presence guarantee owned by `request-reconstruction.spec.ts` instead.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, MessageId, type Message, type MessageSource } from '@deepseek-ai/dsh-llm'
import { FOUNDER_MARKER_TEXT, markFounderMessages } from '../src/founder-marker.ts'

/** See `packages/llm/llm/tests/message.spec.ts`'s identical fixture doc comment. */
function mailboxRelaySource(): MessageSource {
  return {
    kind: 'mailbox', form: 'relay', address: 'addr', from: 'sender', messageId: 'msg-1',
  } as unknown as MessageSource
}

/** See `packages/llm/llm/tests/message.spec.ts`'s identical fixture doc comment. */
function subagentReportSource(): MessageSource {
  return {
    kind: 'subagent-report', form: 'notice', summary: 'report', senderSessionId: 'child-1',
  } as unknown as MessageSource
}

function founderMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', founder: true },
  })
}

function plainUserMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

describe('markFounderMessages', () => {
  it('prepends the marker as the first content block, keeping the original blocks after it, for a founder-stamped message', () => {
    const stamped = founderMessage('do the thing')

    const [marked] = markFounderMessages([stamped])

    expect(marked).not.toBe(stamped)
    expect(marked?.content).toEqual([
      { type: 'text', text: `${FOUNDER_MARKER_TEXT}\n\n` },
      { type: 'text', text: 'do the thing' },
    ])
    expect(marked?.id).toBe(stamped.id)
    expect(marked?.role).toBe(stamped.role)
    expect(marked?.source).toEqual(stamped.source)
  })

  it('leaves the original message and its content array completely untouched', () => {
    const stamped = founderMessage('untouched')
    const originalContentSnapshot = structuredClone(stamped.content)

    markFounderMessages([stamped])

    expect(stamped.content).toEqual(originalContentSnapshot)
    expect(Object.isFrozen(stamped)).toBe(true)
    expect(Object.isFrozen(stamped.content)).toBe(true)
  })

  it('returns a bare user source (no founder field) by the same reference, unchanged', () => {
    const bare = plainUserMessage('hello')

    const [result] = markFounderMessages([bare])

    expect(result).toBe(bare)
  })

  it('returns assistant, tool, plugin, mailbox, and subagent-report messages by the same reference, unchanged', () => {
    const assistant = {
      id: MessageId('a1'), role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'answer' }],
      source: { kind: 'model' as const, provider: 'p', model: 'm' },
    } satisfies Message
    const tool = {
      id: MessageId('t1'), role: 'user' as const,
      content: [{ type: 'tool-result' as const, toolCallId: 'c1' as never, content: [], isError: false }],
      source: { kind: 'tool' as const, callId: 'c1' as never },
    } satisfies Message
    const plugin = {
      id: MessageId('p1'), role: 'user' as const,
      content: [{ type: 'text' as const, text: 'context' }],
      source: { kind: 'plugin' as const, plugin: 'test' },
    } satisfies Message
    const mailbox = {
      id: MessageId('m1'), role: 'user' as const,
      content: [{ type: 'text' as const, text: 'relayed' }],
      source: mailboxRelaySource(),
    } satisfies Message
    const subagentReport = {
      id: MessageId('s1'), role: 'user' as const,
      content: [{ type: 'text' as const, text: 'reported' }],
      source: subagentReportSource(),
    } satisfies Message
    const input = [assistant, tool, plugin, mailbox, subagentReport]

    const result = markFounderMessages(input)

    expect(result).toEqual(input)
    result.forEach((message, index) => { expect(message).toBe(input[index]) })
  })

  it('preserves order in a mixed array, marking only the founder-stamped elements', () => {
    const first = plainUserMessage('one')
    const second = founderMessage('two')
    const third = plainUserMessage('three')
    const fourth = founderMessage('four')

    const result = markFounderMessages([first, second, third, fourth])

    expect(result).toHaveLength(4)
    expect(result[0]).toBe(first)
    expect(result[1]).not.toBe(second)
    expect(result[1]?.content[0]).toEqual({ type: 'text', text: `${FOUNDER_MARKER_TEXT}\n\n` })
    expect(result[2]).toBe(third)
    expect(result[3]).not.toBe(fourth)
    expect(result[3]?.content[0]).toEqual({ type: 'text', text: `${FOUNDER_MARKER_TEXT}\n\n` })
  })

  it('keeps a founder-stamped message with multiple existing content blocks in order after the marker', () => {
    const stamped = {
      id: MessageId('multi'), role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'look at this' },
        { type: 'tool-call' as const, id: 'c1' as never, name: 'read', arguments: '{}' },
      ],
      source: { kind: 'user' as const, founder: true as const },
    } satisfies Message

    const [marked] = markFounderMessages([stamped])

    expect(marked?.content).toEqual([
      { type: 'text', text: `${FOUNDER_MARKER_TEXT}\n\n` },
      { type: 'text', text: 'look at this' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(markFounderMessages([])).toEqual([])
  })

  it('is deterministic: two calls on an equal input produce deep-equal output', () => {
    const input = [plainUserMessage('a'), founderMessage('b'), founderMessage('c')]

    const first = markFounderMessages(input)
    const second = markFounderMessages(input)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('carries the exact, founder-ruled marker sentence (2026-10-06, final)', () => {
    expect(FOUNDER_MARKER_TEXT).toBe(
      "This message is the founder's own, typed at this machine; it is not peer or relay traffic.",
    )
  })
})

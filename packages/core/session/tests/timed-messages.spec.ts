/**
 * `Session.deriveTimedMessages` contract: the same messages as
 * `deriveMessages`, each paired with its own logged event time, over the same
 * cache (extension, replace rebuild, null-deriving nodes skipped).
 */

import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

function userEvent(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }
}

function assistantEvent(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: text === '' ? [] : [{ type: 'text', text }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    },
    surfaceOp: 'append',
  }
}

describe('Session.deriveTimedMessages', () => {
  it('pairs each message with its event time and matches deriveMessages', () => {
    const session = Session.create(SessionId('timed-basic'), [
      userEvent(0, 1000, 'one'),
      assistantEvent(1, 2000, 'reply'),
      userEvent(2, 3000, 'two'),
    ])
    const timed = session.deriveTimedMessages()
    expect(timed.map(entry => entry.time)).toEqual([1000, 2000, 3000])
    expect(timed.map(entry => entry.message)).toEqual(session.deriveMessages())
    expect(timed[0]!.message).toBe(session.deriveMessages()[0])
  })

  it('skips an empty assistant node so messages stay parallel to deriveMessages', () => {
    const session = Session.create(SessionId('timed-empty'), [
      userEvent(0, 1000, 'one'),
      assistantEvent(1, 2000, ''),
      userEvent(2, 3000, 'two'),
    ])
    const timed = session.deriveTimedMessages()
    expect(timed.map(entry => entry.time)).toEqual([1000, 3000])
    expect(timed.map(entry => entry.message)).toEqual(session.deriveMessages())
  })

  it('extends as the log grows and returns fresh arrays', () => {
    const session = Session.create(SessionId('timed-grow'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const first = session.deriveTimedMessages()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'b' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const second = session.deriveTimedMessages()
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(2)
    expect(second[0]!.message).toBe(first[0]!.message)
    expect(second.map(entry => entry.time)).toEqual(session.events.map(event => event.time))
  })

  it('rebuilds on a surface replace; the replacement node carries its own time', () => {
    const session = Session.create(SessionId('timed-replace'), [
      userEvent(0, 1000, 'one'),
      userEvent(1, 2000, 'two'),
    ])
    expect(session.deriveTimedMessages()).toHaveLength(2)
    const nodes = session.surface.nodes
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[1]! }, sourceEventSeqs: [nodes[0]!, nodes[1]!] })
    const timed = session.deriveTimedMessages()
    expect(timed).toHaveLength(1)
    expect(timed[0]!.time).toBe(replacement.time)
    expect(timed.map(entry => entry.message)).toEqual(session.deriveMessages())
  })
})

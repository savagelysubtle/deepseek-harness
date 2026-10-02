import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  isFounderMessage,
  MessageId,
  type MessageSourceMap,
} from '@deepseek-ai/dsh-llm'

describe('message construction', () => {
  it('assigns identity immediately and returns a detached deep-frozen message', () => {
    const input = {
      content: [{ type: 'text' as const, text: 'original' }],
      source: { kind: 'plugin' as const, plugin: 'test' },
    }

    const message = createUserMessage(input)

    expect(message.id).toEqual(expect.any(String))
    expect(message.role).toBe('user')
    expect(message.id).not.toHaveLength(0)
    expect(message).not.toBe(input)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)

    input.content[0]!.text = 'caller mutation'
    expect(message.content).toEqual([{ type: 'text', text: 'original' }])
    expect(() => {
      (message.content[0] as { text: string }).text = 'observer mutation'
    }).toThrow()
  })

  it('freezes an existing identity without minting a replacement', () => {
    const id = MessageId('existing')
    const input = {
      id,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'answer' }],
      source: { kind: 'model' as const, provider: 'test', model: 'test' },
    }

    const message = freezeMessage(input)

    expect(message).not.toBe(input)
    expect(message.id).toBe(id)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })

  it('fixes the assistant role and model source kind at creation', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: {
        provider: 'test-provider',
        model: 'test-model',
        replayState: { request: 1 },
      },
    })

    expect(message).toMatchObject({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'test-provider',
        model: 'test-model',
        replayState: { request: 1 },
      },
    })
    expect(message.id).not.toHaveLength(0)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
  })

  it('couples tool-result content and its cited call seq to one call identity', () => {
    const callId = CallId('call-1')
    const message = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    })

    expect(message).toMatchObject({
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }],
    })
    expect(message.id).not.toHaveLength(0)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })
})

describe('isFounderMessage', () => {
  it('is true only for a user source explicitly stamped founder: true', () => {
    expect(isFounderMessage({ kind: 'user', founder: true })).toBe(true)
  })

  it('is false for a bare user source carrying no founder field', () => {
    expect(isFounderMessage({ kind: 'user' })).toBe(false)
  })

  it('is false for every other source kind, founder field or not', () => {
    expect(isFounderMessage({ kind: 'model', provider: 'test', model: 'test' })).toBe(false)
    expect(isFounderMessage({ kind: 'tool', callId: CallId('call-1') })).toBe(false)
    expect(isFounderMessage({ kind: 'plugin', plugin: 'test' })).toBe(false)
  })

  it('rejects a founder value other than the literal true at the type level', () => {
    // @ts-expect-error founder must be the literal `true`, never `false`
    const rejectedFalse: MessageSourceMap['user'] = { kind: 'user', founder: false }
    // @ts-expect-error founder must be the literal `true`, never the string "true"
    const rejectedString: MessageSourceMap['user'] = { kind: 'user', founder: 'true' }
    expect(rejectedFalse).toBeDefined()
    expect(rejectedString).toBeDefined()
  })
})

import type { Message } from '@deepseek-ai/dsh-llm'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { findLastToolResult } from '../src/scripted-messages.ts'

describe('findLastToolResult', () => {
  it('returns an empty string for an empty message list', () => {
    expect(findLastToolResult([])).toBe('')
  })

  it('returns an empty string when no message carries a tool result', () => {
    const messages = [
      createAssistantMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { provider: 'test', model: 'test' },
      }),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: CallId('call-1'), name: 'search', arguments: '{}' }],
        source: { provider: 'test', model: 'test' },
      }),
    ]

    expect(findLastToolResult(messages)).toBe('')
  })

  it('joins the text blocks of a tool result nested among other content blocks, ignoring non-text blocks', () => {
    const messages = [
      createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'narration' },
          {
            type: 'tool-result',
            toolCallId: CallId('call-1'),
            content: [
              { type: 'reasoning', text: 'skipped' },
              { type: 'text', text: 'answer ' },
              { type: 'text', text: 'continued' },
            ],
          },
        ],
      }),
    ]

    expect(findLastToolResult(messages)).toBe('answer continued')
  })

  it('scans backward and returns only the most recent tool result, whether alone or alongside other blocks', () => {
    const messages = [
      createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text: 'first' }],
        isError: false,
      }),
      createAssistantMessage({
        content: [{ type: 'text', text: 'between' }],
        source: { provider: 'test', model: 'test' },
      }),
      createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'tool-call', id: CallId('call-2'), name: 'search', arguments: '{}' },
          {
            type: 'tool-result',
            toolCallId: CallId('call-2'),
            content: [{ type: 'text', text: 'second' }],
          },
        ],
      }),
    ]

    expect(findLastToolResult(messages)).toBe('second')
  })

  it('treats a tool result with no text content as empty and keeps scanning for an earlier one', () => {
    const messages = [
      createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text: 'earlier' }],
        isError: false,
      }),
      createToolResultMessage({
        callId: CallId('call-2'),
        content: [{ type: 'reasoning', text: 'no text here' }],
        isError: false,
      }),
    ]

    expect(findLastToolResult(messages)).toBe('earlier')
  })

  it('tolerates a missing (malformed) entry in the message list without throwing', () => {
    const messages = [
      createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text: 'value' }],
        isError: false,
      }),
      undefined,
    ] as unknown as readonly Message[]

    expect(() => findLastToolResult(messages)).not.toThrow()
    expect(findLastToolResult(messages)).toBe('value')
  })

  it('returns an empty string when every reachable entry is malformed or lacks a tool result', () => {
    const messages = [
      undefined,
      createAssistantMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { provider: 'test', model: 'test' },
      }),
    ] as unknown as readonly Message[]

    expect(findLastToolResult(messages)).toBe('')
  })
})

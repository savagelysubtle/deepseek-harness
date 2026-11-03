import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { OFFLOADED_IMAGE_TEXT, toPiContext } from '../src/context.ts'
import { toPiAssistant } from '../src/replay.ts'

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

const attachments = {
  readImage: vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1) })),
} as unknown as AttachmentStore

function request(messages: GenerateOptions['messages']): GenerateOptions {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    system: 'system prompt',
    tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object' } }],
    messages,
  }
}

function user(content: ContentBlock[]): Message {
  return createUserMessage({ content, source: { kind: 'plugin', plugin: 'test' } })
}

function history(role: 'system' | 'assistant', content: ContentBlock[]): Message {
  return createMessage({ role, content, source: { kind: 'plugin', plugin: 'test' } })
}

describe('pi-ai request context conversion', () => {
  it('omits absent and empty request-level optional fields', () => {
    const base = { provider: 'openai', model: 'gpt-4.1', messages: [] }
    expect(toPiContext(base)).toEqual({ messages: [] })
    expect(toPiContext({ ...base, tools: [] })).toEqual({ messages: [] })
  })

  it('converts complete text-only history and rejects nested images without storage', () => {
    const callId = CallId('call-1')
    expect(toPiContext(request([
      history('system', [{ type: 'text', text: 'history system' }]),
      history('assistant', [{ type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' }]),
      user([
        { type: 'text', text: 'after tool' },
        {
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: '' }],
        },
      ]),
    ]))).toMatchObject({
      systemPrompt: 'system prompt',
      tools: [{ name: 'lookup' }],
      messages: [
        { role: 'user', content: 'history system' },
        { role: 'assistant' },
        { role: 'user', content: 'after tool' },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'lookup',
          content: [{ type: 'text', text: '(no output)' }],
          isError: false,
        },
      ],
    })

    expect(() => toPiContext(request([user([{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'image', attachment: ref }],
    }])]))).toThrow(/durable attachment service/)
  })

  it('resolves user and tool-result images while preserving explicit fallbacks', async () => {
    const callId = CallId('missing-call')
    const knownCallId = CallId('known-call')
    const context = await toPiContext(request([
      user([{ type: 'text', text: '' }]),
      history('assistant', [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: knownCallId, name: 'lookup', arguments: '{}' },
      ]),
      user([
        { type: 'image', attachment: ref },
        { type: 'text', text: 'caption' },
        { type: 'reasoning', text: 'ignored' },
      ]),
      user([{
        type: 'tool-result',
        toolCallId: knownCallId,
        content: [{ type: 'text', text: '' }],
      }]),
      user([{
        type: 'tool-result',
        toolCallId: callId,
        isError: true,
        content: [
          { type: 'tool-result', toolCallId: callId, content: [] },
          { type: 'image', attachment: ref },
        ],
      }]),
    ]), attachments)

    expect(context.messages).toEqual([
      { role: 'user', content: '', timestamp: 0 },
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'user',
        content: [
          { type: 'image', data: 'AQ==', mimeType: 'image/png' },
          { type: 'text', text: 'caption' },
        ],
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'known-call',
        toolName: 'lookup',
        content: [{ type: 'text', text: '(no output)' }],
        isError: false,
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'missing-call',
        toolName: 'unknown',
        content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
        isError: true,
        timestamp: 0,
      },
    ])
  })

  it('replaces the oldest images with placeholders once the request payload bound is exceeded', async () => {
    const readImage = vi.fn(() => Promise.resolve({ ref: { ...ref, bytes: 3 }, data: Uint8Array.of(1, 2, 3) }))
    const store = { readImage } as unknown as AttachmentStore
    const sized: ImageAttachmentRef = { ...ref, bytes: 3 }
    const callId = CallId('shot-call')
    // Three 3-byte images cost 4 base64 characters each (12 total); a bound of
    // 8 forces exactly the oldest one out, including one nested in a tool result.
    const context = await toPiContext(request([
      user([{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'image', attachment: sized }],
      }]),
      user([{ type: 'image', attachment: sized }, { type: 'text', text: 'newer' }]),
      user([{ type: 'image', attachment: sized }]),
    ]), store, undefined, 8)

    expect(context.messages).toEqual([
      {
        role: 'toolResult',
        toolCallId: 'shot-call',
        toolName: 'unknown',
        content: [{ type: 'text', text: OFFLOADED_IMAGE_TEXT }],
        isError: false,
        timestamp: 0,
      },
      {
        role: 'user',
        content: [
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
          { type: 'text', text: 'newer' },
        ],
        timestamp: 0,
      },
      { role: 'user', content: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }], timestamp: 0 },
    ])
    expect(readImage).toHaveBeenCalledTimes(2)
  })

  it('keeps every image at exactly the payload bound and drops all of them when even the newest cannot fit', async () => {
    const sized: ImageAttachmentRef = { ...ref, bytes: 3 }
    const exact = await toPiContext(request([
      user([{ type: 'image', attachment: sized }]),
      user([{ type: 'image', attachment: sized }]),
    ]), attachments, undefined, 8)
    expect(exact.messages).toEqual([
      { role: 'user', content: [expect.objectContaining({ type: 'image' })], timestamp: 0 },
      { role: 'user', content: [expect.objectContaining({ type: 'image' })], timestamp: 0 },
    ])

    const readImage = vi.fn()
    const store = { readImage } as unknown as AttachmentStore
    const oversized = await toPiContext(request([
      user([{ type: 'image', attachment: { ...ref, bytes: 300 } }]),
    ]), store, undefined, 8)
    // All-text content collapses to the string form; the placeholder still reaches the model.
    expect(oversized.messages).toEqual([
      { role: 'user', content: OFFLOADED_IMAGE_TEXT, timestamp: 0 },
    ])
    expect(readImage).not.toHaveBeenCalled()
  })

  it('keeps empty text-only users while separating result-only messages', () => {
    const callId = CallId('unknown-call')
    expect(toPiContext(request([
      user([]),
      history('assistant', [
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: CallId('other-call'), name: 'lookup', arguments: '{}' },
      ]),
      user([{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'result' }],
      }]),
    ]))).toMatchObject({
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant' },
        { role: 'toolResult', toolName: 'unknown' },
      ],
    })
  })

  it('serializes a marker-led user message as the marker, a blank line, then the original text (SWD-156)', () => {
    // The marker rides in block 0 of a founder message, built at dispatch time by
    // packages/core/agent-loop/src/render-dispatch.ts (renderDispatch) as part of
    // the per-message stamp header, never by this adapter. Built literally here (not imported from
    // agent-loop) to keep llm-pi-ai independent of agent-loop; this proves
    // only that the existing generic `type:'text'` flattening (flattenText,
    // context.ts ~line 14) carries a leading marker block to the wire for
    // free, with no adapter changes.
    const markerBlock: ContentBlock = {
      type: 'text',
      text: "This message is the founder's own, typed at this machine; it is not peer or relay traffic.\n\n",
    }
    const markerText = "This message is the founder's own, typed at this machine; it is not peer or relay traffic.\n\n"

    const context = toPiContext(request([
      createUserMessage({
        content: [markerBlock, { type: 'text', text: 'what time is it' }],
        source: { kind: 'user', founder: true },
      }),
    ]))
    expect(context.messages[0]).toEqual({
      role: 'user',
      content: `${markerText}what time is it`,
      timestamp: 0,
    })

    // Key presence, not prose: the marker's own text legitimately contains
    // the word "founder" ("founder's own"), so this checks for the
    // structural `"founder":`/`"source":` fields, never for the word.
    const payload = JSON.stringify(context)
    expect(payload).not.toMatch(/"founder"\s*:/)
    expect(payload).not.toMatch(/"source"\s*:/)
  })

  it('leaves a message with no marker block unchanged from today (SWD-156)', () => {
    const context = toPiContext(request([
      createUserMessage({
        content: [{ type: 'text', text: 'plain question' }],
        source: { kind: 'user', founder: true },
      }),
    ]))
    expect(context.messages[0]).toEqual({ role: 'user', content: 'plain question', timestamp: 0 })
  })

  it('handles in-history system and assistant messages explicitly on the image path', async () => {
    await expect(toPiContext(request([
      history('system', [{ type: 'image', attachment: ref }]),
    ]), attachments)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })

    await expect(toPiContext(request([
      history('system', [{ type: 'text', text: 'history system' }]),
      history('assistant', [{ type: 'text', text: 'answer' }]),
      user([{ type: 'text', text: 'plain' }]),
    ]), attachments)).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'history system' },
        { role: 'assistant' },
        { role: 'user', content: 'plain' },
      ],
    })

    expect(() => toPiAssistant(
      history('assistant', [{ type: 'image', attachment: ref }]),
    )).toThrow(/assistant image output/)
  })

  // Dispatch no longer ends in a clock message: a stamped, merged user message
  // (header, notice, separator, head) must become exactly one pi-ai user message.
  describe('merged dispatch messages', () => {
    const merged = (): Message => user([
      { type: 'text', text: '[Fri 2026-10-30 11:54 PDT]\n\n' },
      { type: 'text', text: 'skill catalog notice' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'the task' },
    ])
    const expectedText = '[Fri 2026-10-30 11:54 PDT]\n\nskill catalog notice\n\nthe task'

    it('converts to one user message with the blocks concatenated (text-only path)', () => {
      const context = toPiContext(request([merged()]))
      expect(context.messages).toEqual([{ role: 'user', content: expectedText, timestamp: 0 }])
    })

    it('converts to one user message whose text parts concatenate exactly (image-capable path)', async () => {
      const context = await toPiContext(request([merged()]), attachments)
      expect(context.messages).toHaveLength(1)
      const only = context.messages[0]
      expect(only?.role).toBe('user')
      const content = (only as { content: unknown }).content
      const text = typeof content === 'string'
        ? content
        : (content as { type: string; text?: string }[]).map(part => part.text ?? '').join('')
      expect(text).toBe(expectedText)
    })

    it('keeps assistant(toolCall) directly followed by toolResult on both paths', async () => {
      const messages = [
        history('assistant', [{ type: 'tool-call', id: CallId('call-1'), name: 'lookup', arguments: '{}' }]),
        user([{ type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'result' }] }]),
      ]
      for (const context of [toPiContext(request(messages)), await toPiContext(request(messages), attachments)]) {
        expect(context.messages.map(message => message.role)).toEqual(['assistant', 'toolResult'])
      }
    })
  })
})

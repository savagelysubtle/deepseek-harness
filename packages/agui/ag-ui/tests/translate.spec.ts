import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  createBracketState,
  isOpenTurn,
  projectMessages,
  synthesizeRunStart,
  translateAgentError,
  translateSessionEvent,
} from '../src/translate.ts'

/** Minimal event builder: only `type`, `seq`, and `data` matter to the translator. */
function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq = 1,
): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

function state(runId = 'run-base') {
  return createBracketState('thread-a', runId)
}

describe('translateSessionEvent', () => {
  it('opens a run on turn/start with the per-turn run id', () => {
    const s = state()
    expect(translateSessionEvent(event('turn/start', { turn: 3 }), s)).toEqual([
      { type: 'RUN_STARTED', threadId: 'thread-a', runId: 'run-base-3' },
    ])
    expect(s.runOpen).toBe(true)
    expect(s.openRunId).toBe('run-base-3')
  })

  it('drops a second turn/start while a run is open', () => {
    const s = state()
    translateSessionEvent(event('turn/start', { turn: 1 }), s)
    const frames = translateSessionEvent(event('turn/start', { turn: 2 }), s)
    expect(frames).toEqual([])
    expect(s.droppedUnmapped).toBe(1)
  })

  it('finishes the run on a completed turn/end and clears streamed-call memory', () => {
    const s = state()
    translateSessionEvent(event('turn/start', { turn: 1 }), s)
    const frames = translateSessionEvent(
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      s,
    )
    expect(frames).toEqual([{ type: 'RUN_FINISHED', threadId: 'thread-a', runId: 'run-base-1' }])
    expect(s.runOpen).toBe(false)
  })

  it('maps non-error turn endings (aborted) to RUN_FINISHED', () => {
    const s = state()
    translateSessionEvent(event('turn/start', { turn: 2 }), s)
    const frames = translateSessionEvent(
      event('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
      s,
    )
    expect(frames).toEqual([{ type: 'RUN_FINISHED', threadId: 'thread-a', runId: 'run-base-2' }])
  })

  it('emits RUN_ERROR with the failure message on an errored turn/end', () => {
    const s = state()
    translateSessionEvent(event('turn/start', { turn: 1 }), s)
    const frames = translateSessionEvent(
      event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'X' } } }),
      s,
    )
    expect(frames).toEqual([{ type: 'RUN_ERROR', message: 'boom' }])
    expect(s.runOpen).toBe(false)
  })

  it('closes leftover stream brackets at turn/end before closing the run', () => {
    const s = state()
    translateSessionEvent(event('turn/start', { turn: 1 }), s)
    translateSessionEvent(
      event('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'partial' } }),
      s,
    )
    const frames = translateSessionEvent(
      event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'cut', code: 'E' } } }),
      s,
    )
    expect(frames).toEqual([
      { type: 'TEXT_MESSAGE_END', messageId: MessageId('msg-1-0') },
      { type: 'RUN_ERROR', message: 'cut' },
    ])
    expect(s.openMessage).toBeUndefined()
  })

  it('suppresses a stray turn/end that arrives after an out-of-band run error', () => {
    const s = state()
    translateSessionEvent(event('turn/start', { turn: 1 }), s)
    expect(translateAgentError(s, 'agent blew up')).toEqual([{ type: 'RUN_ERROR', message: 'agent blew up' }])
    const frames = translateSessionEvent(
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      s,
    )
    expect(frames).toEqual([])
    expect(s.droppedUnmapped).toBe(0)
  })
})

describe('text streaming brackets', () => {
  const delta = (text: string, turn = 1, step = 0): SessionEvent =>
    event('assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text } })

  it('opens TEXT_MESSAGE_START on the first delta of a step and contents afterwards', () => {
    const s = state()
    const first = translateSessionEvent(delta('Hel'), s)
    expect(first).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: MessageId('msg-1-0'), role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: MessageId('msg-1-0'), delta: 'Hel' },
    ])
    expect(translateSessionEvent(delta('lo'), s)).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: MessageId('msg-1-0'), delta: 'lo' },
    ])
  })

  it('starts a new message bracket when the step changes', () => {
    const s = state()
    translateSessionEvent(delta('a', 1, 0), s)
    const next = translateSessionEvent(delta('b', 1, 1), s)
    expect(next[0]).toEqual({ type: 'TEXT_MESSAGE_START', messageId: MessageId('msg-1-1'), role: 'assistant' })
  })

  it('closes the open message at assistant/message for the same step', () => {
    const s = state()
    translateSessionEvent(delta('hi'), s)
    const frames = translateSessionEvent(
      event('assistant/message', {
        turn: 1,
        step: 0,
        message: {
          id: MessageId('asst-1'),
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }),
      s,
    )
    expect(frames).toEqual([{ type: 'TEXT_MESSAGE_END', messageId: MessageId('msg-1-0') }])
    expect(s.openMessage).toBeUndefined()
  })

  it('keeps the message open when assistant/message belongs to another step', () => {
    const s = state()
    translateSessionEvent(delta('hi', 1, 0), s)
    const frames = translateSessionEvent(
      event('assistant/message', {
        turn: 1,
        step: 7,
        message: {
          id: MessageId('asst-9'),
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }),
      s,
    )
    expect(frames).toEqual([])
    expect(s.openMessage).not.toBeUndefined()
  })
})

describe('tool streaming brackets', () => {
  const toolDelta = (
    id: CallId,
    argsDelta: string,
    name?: string,
    turn = 1,
    step = 0,
  ): SessionEvent =>
    event('assistant/chunk', {
      turn,
      step,
      chunk: name === undefined
        ? { type: 'tool-call-delta', index: 1, id, argumentsDelta: argsDelta }
        : { type: 'tool-call-delta', index: 1, id, name, argumentsDelta: argsDelta },
    })

  it('opens TOOL_CALL_START on the first delta then streams args', () => {
    const s = state()
    const first = translateSessionEvent(toolDelta(CallId('call-1'), '{"a"', 'grep'), s)
    expect(first).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: CallId('call-1'), toolCallName: 'grep' },
      { type: 'TOOL_CALL_ARGS', toolCallId: CallId('call-1'), delta: '{"a"' },
    ])
    expect(translateSessionEvent(toolDelta(CallId('call-1'), ':1}'), s)).toEqual([
      { type: 'TOOL_CALL_ARGS', toolCallId: CallId('call-1'), delta: ':1}' },
    ])
  })

  it('uses an empty toolCallName when the first delta carries none', () => {
    const s = state()
    const [start] = translateSessionEvent(toolDelta(CallId('call-x'), '{}'), s)
    expect(start).toMatchObject({ toolCallName: '' })
  })

  it('marks streamed calls so the later tool/call does not duplicate them', () => {
    const s = state()
    translateSessionEvent(toolDelta(CallId('call-1'), '{}', 'ls'), s)
    translateSessionEvent(
      event('assistant/message', {
        turn: 1,
        step: 0,
        message: {
          id: MessageId('asst-1'),
          role: 'assistant',
          content: [{ type: 'tool-call', id: CallId('call-1'), name: 'ls', arguments: '{}' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }),
      s,
    )
    expect(translateSessionEvent(event('tool/call', { turn: 1, step: 0, callId: CallId('call-1'), name: 'ls', arguments: '{}' }), s)).toEqual([])
  })

  it('emits the full START+ARGS+END triad for an unstreamed tool/call', () => {
    const s = state()
    expect(translateSessionEvent(event('tool/call', { turn: 4, step: 1, callId: CallId('call-9'), name: 'web_fetch', arguments: '{"url":"x"}' }), s))
      .toEqual([
        { type: 'TOOL_CALL_START', toolCallId: CallId('call-9'), toolCallName: 'web_fetch' },
        { type: 'TOOL_CALL_ARGS', toolCallId: CallId('call-9'), delta: '{"url":"x"}' },
        { type: 'TOOL_CALL_END', toolCallId: CallId('call-9') },
      ])
  })

  it('closes streamed tool brackets at assistant/message', () => {
    const s = state()
    translateSessionEvent(toolDelta(CallId('call-1'), '{}', 'ls'), s)
    const frames = translateSessionEvent(
      event('assistant/message', {
        turn: 1,
        step: 0,
        message: {
          id: MessageId('asst-1'),
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }),
      s,
    )
    expect(frames).toEqual([{ type: 'TOOL_CALL_END', toolCallId: CallId('call-1') }])
    expect(s.openTools.size).toBe(0)
  })

  it('projects tool/result as TOOL_CALL_RESULT with joined text content', () => {
    const s = state()
    const frames = translateSessionEvent(
      event('tool/result', {
        turn: 1,
        step: 0,
        message: {
          id: MessageId('tr-1'),
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: CallId('call-9'),
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image', attachment: { attachmentId: AttachmentId('a'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
              { type: 'text', text: 'line two' },
            ],
            isError: false,
          }],
          source: { kind: 'tool', callId: CallId('call-9') },
        },
      }),
      s,
    )
    expect(frames).toEqual([{
      type: 'TOOL_CALL_RESULT',
      messageId: MessageId('tr-1'),
      toolCallId: CallId('call-9'),
      content: 'line oneline two',
      role: 'tool',
    }])
  })
})

describe('allowlist drops', () => {
  it('drops unmapped session events and counts them once each', () => {
    const s = state()
    expect(translateSessionEvent(event('todo/write', { todos: [] }), s)).toEqual([])
    expect(translateSessionEvent(event('request/header', { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' }), s)).toEqual([])
    expect(translateSessionEvent(event('step/start', { turn: 1, step: 0 }), s)).toEqual([])
    expect(s.droppedUnmapped).toBe(3)
  })

  it('drops unmapped chunk subtypes such as reasoning deltas and usage', () => {
    const s = state()
    expect(translateSessionEvent(
      event('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } }),
      s,
    )).toEqual([])
    expect(translateSessionEvent(
      event('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } }),
      s,
    )).toEqual([])
    expect(s.droppedUnmapped).toBe(2)
  })

  it('projects approval/asked as a display-only CUSTOM frame', () => {
    const s = state()
    const frames = translateSessionEvent(
      event('approval/asked', { id: ApprovalRequestId('apr-1'), toolName: 'bash', callId: CallId('call-1'), reason: 'needs write' }),
      s,
    )
    expect(frames).toEqual([{
      type: 'CUSTOM',
      name: 'dsh.approval.requested',
      value: { id: ApprovalRequestId('apr-1'), toolName: 'bash', callId: CallId('call-1'), reason: 'needs write' },
    }])
    expect(s.droppedUnmapped).toBe(0)
  })

  it('projects approval/asked without optional fields verbatim-absent', () => {
    const s = state()
    const [frame] = translateSessionEvent(event('approval/asked', { id: ApprovalRequestId('apr-2'), toolName: 'fs' }), s)
    expect(frame).toEqual({
      type: 'CUSTOM',
      name: 'dsh.approval.requested',
      value: { id: ApprovalRequestId('apr-2'), toolName: 'fs' },
    })
  })
})

describe('log projection helpers', () => {
  it('projects user and assistant messages into MESSAGES_SNAPSHOT shape', () => {
    const events: SessionEvent[] = [
      event('user/message', {
        id: MessageId('u1'),
        role: 'user',
        content: [{ type: 'text', text: 'question' }],
        source: { kind: 'user' },
      }, 0),
      event('assistant/message', {
        turn: 1,
        step: 0,
        message: {
          id: MessageId('a1'),
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'secret thoughts' }, { type: 'text', text: 'answer' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }, 1),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
    ]
    expect(projectMessages(events)).toEqual([
      { id: MessageId('u1'), role: 'user', content: 'question' },
      { id: MessageId('a1'), role: 'assistant', content: 'answer' },
    ])
  })

  it('finds the open turn from the log tail', () => {
    expect(isOpenTurn([])).toBeUndefined()
    const ended: SessionEvent[] = [
      event('turn/start', { turn: 1 }, 0),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1),
    ]
    expect(isOpenTurn(ended)).toBeUndefined()
    const open: SessionEvent[] = [
      ...ended,
      event('turn/start', { turn: 2 }, 2),
    ]
    expect(isOpenTurn(open)).toBe(2)
  })
})

describe('mid-run synthesis', () => {
  it('synthesizes RUN_STARTED for the open turn right after attach', () => {
    const s = state('watch-1')
    expect(synthesizeRunStart(s, 5)).toEqual([
      { type: 'RUN_STARTED', threadId: 'thread-a', runId: 'watch-1-5' },
    ])
    expect(s.runOpen).toBe(true)
  })

  it('synthesizes nothing when no turn is open or a run is already open', () => {
    const idle = state()
    expect(synthesizeRunStart(idle, undefined)).toEqual([])
    const live = state()
    synthesizeRunStart(live, 1)
    expect(synthesizeRunStart(live, 2)).toEqual([])
  })

  it('pairs the synthesized run with its later turn/end RUN_FINISHED', () => {
    const s = state('watch-1')
    synthesizeRunStart(s, 5)
    const frames = translateSessionEvent(
      event('turn/end', { turn: 5, reason: { kind: 'completed' } }),
      s,
    )
    expect(frames).toEqual([{ type: 'RUN_FINISHED', threadId: 'thread-a', runId: 'watch-1-5' }])
  })
})

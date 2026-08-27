/**
 * Pure SessionEvent → AG-UI frame translation. The module owns the allowlist:
 * every mapped event type appears as a `switch` case, everything else is
 * dropped and counted on {@link BracketState.droppedUnmapped} — unmapped
 * session data never reaches the external wire. No I/O, no clock, no
 * randomness: the only state is the caller-owned {@link BracketState}, which
 * is updated in place so consecutive calls close the brackets they opened.
 *
 * @module @deepseek-ai/dsh-ag-ui/translate
 */

import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgUiCustom, AgUiEvent, AgUiMessage, BracketState } from './types.ts'

/** Name of the CUSTOM event carrying a display-only approval question. */
export const APPROVAL_CUSTOM_EVENT = 'dsh.approval.requested'

/** Runtime allowlist over the emitted frame union; the invariant companion reads it. */
export const AG_UI_EVENT_TYPES: ReadonlySet<string> = new Set([
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'STATE_SNAPSHOT',
  'MESSAGES_SNAPSHOT',
  'CUSTOM',
])

/** Structural shape of the `approval/asked` payload this adapter projects (owner: dsh-user-approval). */
interface ApprovalAskedData {
  id: string
  toolName: string
  callId?: string
  reason?: string
}

/**
 * Concatenate the text blocks of one content list; non-text content is not
 * projected onto the external wire.
 * @param blocks - exact model-facing content blocks of one message.
 * @returns the text content, in block order.
 */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Tracking key pairing a streamed bracket with its owning turn step.
 * @param turn - turn number of the streaming step.
 * @param step - step number of the streaming step.
 * @returns the bracket tracking key.
 */
function messageKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/**
 * Wire id of the assistant text message streamed by one turn step.
 * @param turn - turn number of the streaming step.
 * @param step - step number of the streaming step.
 * @returns the deterministic messageId shared by that message's frames.
 */
function wireMessageId(turn: number, step: number): string {
  return `msg-${turn}-${step}`
}

/**
 * Run id stamped onto one turn's lifecycle frames: the connection-level base
 * suffixed with the turn number so sequential turns stay distinguishable.
 * @param state - bracket tracker carrying the connection's run-id base.
 * @param turn - turn number the run bracket belongs to.
 * @returns the per-turn run id.
 */
function runIdFor(state: BracketState, turn: number): string {
  return `${state.runId}-${turn}`
}

/**
 * Project the durable log into the MESSAGES_SNAPSHOT transcript. Only
 * committed user and assistant messages appear; chunks fold away because the
 * assembled message carries their text, and tool traffic is served through
 * TOOL_CALL_* frames instead.
 * @param events - the session log to project (live tail included).
 * @returns the ordered transcript projection.
 */
export function projectMessages(events: readonly SessionEvent[]): AgUiMessage[] {
  const messages: AgUiMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      messages.push({ id: event.data.id, role: 'user', content: textOf(event.data.content) })
    } else if (event.type === 'assistant/message') {
      messages.push({ id: event.data.message.id, role: 'assistant', content: textOf(event.data.message.content) })
    }
  }
  return messages
}

/**
 * Find the currently open turn of a log: the last `turn/start` whose turn has
 * no later matching `turn/end`. A mid-run attacher synthesizes RUN_STARTED
 * from this so external clients always see a closed RUN_* bracket sequence.
 * @param events - the session log to scan (live tail included).
 * @returns the open turn number, or undefined when every started turn ended.
 */
export function isOpenTurn(events: readonly SessionEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/end') return undefined
    if (event.type === 'turn/start') return event.data.turn
  }
  return undefined
}

/**
 * Create an empty bracket tracker for one attached stream.
 * @param threadId - thread (session id) stamped onto lifecycle frames.
 * @param runId - connection-level run-id base supplied by the client or generated at attach.
 * @returns the fresh tracker with no open brackets.
 */
export function createBracketState(threadId: string, runId: string): BracketState {
  return {
    threadId,
    runId,
    runOpen: false,
    openRunId: undefined,
    openMessage: undefined,
    openTools: new Map(),
    streamedCalls: new Set(),
    droppedUnmapped: 0,
  }
}

/**
 * Translate one live session event into the frames this connection still
 * owes. Bracket rules: TEXT_MESSAGE_START/TOOL_CALL_OPEN frames are emitted
 * only when the corresponding bracket is not yet open; RUN_* frames follow
 * the open-run state, so a `turn/start` while a run is open is dropped rather
 * than double-opened.
 *
 * Allowlist contract: any event type or chunk subtype without a case below
 * increments {@link BracketState.droppedUnmapped} and produces no frames —
 * plugin-merged event vocabulary must be added here explicitly before it
 * crosses this package's trust boundary.
 *
 * @param event - the session event to translate.
 * @param state - the connection's bracket tracker, updated in place.
 * @returns the frames to enqueue, in emission order.
 */
export function translateSessionEvent(event: SessionEvent, state: BracketState): AgUiEvent[] {
  switch (event.type) {
    case 'turn/start': {
      if (state.runOpen) return drop(state)
      const runId = runIdFor(state, event.data.turn)
      state.runOpen = true
      state.openRunId = runId
      return [{ type: 'RUN_STARTED', threadId: state.threadId, runId }]
    }
    case 'turn/end': {
      // An ending turn closes any brackets left open by an interrupted stream,
      // then closes the run itself.
      const closing = closeStreamBrackets(state)
      state.streamedCalls.clear()
      // A run already closed out-of-band (agent/error) leaves only the stray
      // bracket closings; nothing further is owed on the wire.
      if (!state.runOpen) return closing
      const runId = state.openRunId as string
      state.runOpen = false
      state.openRunId = undefined
      if (event.data.reason.kind === 'error') {
        return [...closing, { type: 'RUN_ERROR', message: event.data.reason.error.message }]
      }
      // Completed, aborted, blocked, max-tokens, and plugin-merged endings all
      // read as a finished run: the observable difference is which turn comes next.
      return [...closing, { type: 'RUN_FINISHED', threadId: state.threadId, runId }]
    }
    case 'assistant/chunk':
      return translateChunk(event.data.chunk, event.data.turn, event.data.step, state)
    case 'assistant/message': {
      const { turn, step } = event.data
      const key = messageKey(turn, step)
      const frames: AgUiEvent[] = []
      for (const [toolCallId, position] of state.openTools) {
        if (position.turn === turn && position.step === step) {
          state.openTools.delete(toolCallId)
          frames.push({ type: 'TOOL_CALL_END', toolCallId })
        }
      }
      if (state.openMessage?.key === key) {
        frames.push({ type: 'TEXT_MESSAGE_END', messageId: state.openMessage.messageId })
        state.openMessage = undefined
      }
      return frames
    }
    case 'tool/call': {
      // Calls already projected through streamed deltas had their END emitted
      // at assistant/message; re-emitting the triad would duplicate the call.
      if (state.streamedCalls.has(event.data.callId)) return []
      return [
        { type: 'TOOL_CALL_START', toolCallId: event.data.callId, toolCallName: event.data.name },
        { type: 'TOOL_CALL_ARGS', toolCallId: event.data.callId, delta: event.data.arguments },
        { type: 'TOOL_CALL_END', toolCallId: event.data.callId },
      ]
    }
    case 'tool/result': {
      const result = event.data.message.content[0]
      return [{
        type: 'TOOL_CALL_RESULT',
        messageId: event.data.message.id,
        toolCallId: result.toolCallId,
        content: textOf(result.content),
        role: 'tool',
      }]
    }
    case 'approval/asked': {
      // Display-only projection of a pending approval question; decided outcomes stay internal.
      const data = event.data as unknown as ApprovalAskedData
      const value: Record<string, unknown> = { id: data.id, toolName: data.toolName }
      if (data.callId !== undefined) value.callId = data.callId
      if (data.reason !== undefined) value.reason = data.reason
      const custom: AgUiCustom = { type: 'CUSTOM', name: APPROVAL_CUSTOM_EVENT, value }
      return [custom]
    }
    default:
      // Merge-extensible event unions fall through to the allowlist drop:
      // unknown vocabulary never leaks to the external wire.
      return drop(state)
  }
}

/**
 * Translate one raw stream chunk into text-message or tool-call frames.
 * @param chunk - the raw adapter chunk carried by the logged event.
 * @param turn - turn number of the streaming step.
 * @param step - step number of the streaming step.
 * @param state - the connection's bracket tracker, updated in place.
 * @returns the frames to enqueue, in emission order.
 */
function translateChunk(chunk: StreamChunk, turn: number, step: number, state: BracketState): AgUiEvent[] {
  switch (chunk.type) {
    case 'text-delta': {
      const key = messageKey(turn, step)
      const messageId = wireMessageId(turn, step)
      if (state.openMessage?.key !== key) {
        state.openMessage = { key, messageId }
        return [
          { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: chunk.text },
        ]
      }
      return [{ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: chunk.text }]
    }
    case 'tool-call-delta': {
      const frames: AgUiEvent[] = []
      if (!state.openTools.has(chunk.id)) {
        state.openTools.set(chunk.id, { turn, step })
        state.streamedCalls.add(chunk.id)
        frames.push({ type: 'TOOL_CALL_START', toolCallId: chunk.id, toolCallName: chunk.name ?? '' })
      }
      frames.push({ type: 'TOOL_CALL_ARGS', toolCallId: chunk.id, delta: chunk.argumentsDelta })
      return frames
    }
    default:
      // Block framing, reasoning deltas, usage, and finish markers are
      // assembly internals; the committed assistant/message serves their content.
      return drop(state)
  }
}

/**
 * Close every open streamed bracket, regardless of which turn opened it.
 * Used at turn/end: an interrupted stream leaves brackets that would otherwise
 * leak into the next turn's frames.
 * @param state - the connection's bracket tracker, updated in place.
 * @returns the closing END frames, tools before the open text message.
 */
function closeStreamBrackets(state: BracketState): AgUiEvent[] {
  const frames: AgUiEvent[] = []
  for (const [toolCallId] of state.openTools) {
    frames.push({ type: 'TOOL_CALL_END', toolCallId })
  }
  state.openTools.clear()
  if (state.openMessage !== undefined) {
    frames.push({ type: 'TEXT_MESSAGE_END', messageId: state.openMessage.messageId })
    state.openMessage = undefined
  }
  return frames
}

/**
 * Count one allowlisted-out input and produce no frames.
 * @param state - the connection's bracket tracker, updated in place.
 * @returns an empty frame list.
 */
function drop(state: BracketState): [] {
  state.droppedUnmapped += 1
  return []
}

/**
 * Translate an out-of-band agent failure into the run-closing frame. Unlike
 * `turn/end` errors this failure carries no LlmFailure record, only a rendered
 * message; the run closes only when one is actually open.
 * @param state - the connection's bracket tracker, updated in place.
 * @param message - rendered failure message for the RUN_ERROR frame.
 * @returns the RUN_ERROR frame, or nothing when no run is open.
 */
export function translateAgentError(state: BracketState, message: string): AgUiEvent[] {
  if (!state.runOpen) return []
  state.runOpen = false
  state.openRunId = undefined
  return [{ type: 'RUN_ERROR', message }]
}

/**
 * Frames synthesized when a stream attaches mid-run: RUN_STARTED for the
 * already-open turn, emitted right after the snapshot so external clients see
 * a well-formed bracket sequence even though the run began before they
 * connected. A no-op when the log shows no open turn.
 * @param state - the connection's bracket tracker, updated in place.
 * @param openTurn - open turn number reported by {@link isOpenTurn}, if any.
 * @returns the synthesized RUN_STARTED, or nothing when no turn is open.
 */
export function synthesizeRunStart(state: BracketState, openTurn: number | undefined): AgUiEvent[] {
  if (openTurn === undefined || state.runOpen) return []
  const runId = runIdFor(state, openTurn)
  state.runOpen = true
  state.openRunId = runId
  return [{ type: 'RUN_STARTED', threadId: state.threadId, runId }]
}

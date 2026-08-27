/**
 * AG-UI wire vocabulary served by this adapter: the emitted event union, the
 * per-connection bracket tracker, and the plugin config shape.
 *
 * Field names are the AG-UI protocol's JSON names verbatim
 * ([Events](https://docs.ag-ui.com/concepts/events)); this module is types-only
 * by package convention — the runtime allowlist over {@link AgUiEvent} lives in
 * `translate.ts`.
 *
 * @module @deepseek-ai/dsh-ag-ui/types
 */

/** One message in a MESSAGES_SNAPSHOT projection of the durable log. */
export interface AgUiMessage {
  /** Stable message id (the session log's own message id). */
  id: string
  /** Conversation role; this adapter projects user and assistant messages only. */
  role: 'user' | 'assistant'
  /** Concatenated text blocks; non-text content is not projected. */
  content: string
}

/** RUN_STARTED — opens an agent run. */
export interface AgUiRunStarted {
  type: 'RUN_STARTED'
  threadId: string
  runId: string
}

/** RUN_FINISHED — closes an agent run successfully. */
export interface AgUiRunFinished {
  type: 'RUN_FINISHED'
  threadId: string
  runId: string
}

/** RUN_ERROR — closes an agent run with a failure. */
export interface AgUiRunError {
  type: 'RUN_ERROR'
  message: string
}

/** TEXT_MESSAGE_START — opens one streamed assistant text message. */
export interface AgUiTextMessageStart {
  type: 'TEXT_MESSAGE_START'
  messageId: string
  role: 'assistant'
}

/** TEXT_MESSAGE_CONTENT — one streamed text delta. */
export interface AgUiTextMessageContent {
  type: 'TEXT_MESSAGE_CONTENT'
  messageId: string
  delta: string
}

/** TEXT_MESSAGE_END — closes one streamed assistant text message. */
export interface AgUiTextMessageEnd {
  type: 'TEXT_MESSAGE_END'
  messageId: string
}

/** TOOL_CALL_START — opens one tool call. */
export interface AgUiToolCallStart {
  type: 'TOOL_CALL_START'
  toolCallId: string
  toolCallName: string
}

/** TOOL_CALL_ARGS — one streamed tool-arguments delta. */
export interface AgUiToolCallArgs {
  type: 'TOOL_CALL_ARGS'
  toolCallId: string
  delta: string
}

/** TOOL_CALL_END — closes one tool call's argument stream. */
export interface AgUiToolCallEnd {
  type: 'TOOL_CALL_END'
  toolCallId: string
}

/** TOOL_CALL_RESULT — the complete result of one executed tool call. */
export interface AgUiToolCallResult {
  type: 'TOOL_CALL_RESULT'
  messageId: string
  toolCallId: string
  content: string
  role: 'tool'
}

/** STATE_SNAPSHOT — complete agent state; reserved vocabulary this adapter does not emit yet. */
export interface AgUiStateSnapshot {
  type: 'STATE_SNAPSHOT'
  snapshot: unknown
}

/** MESSAGES_SNAPSHOT — complete conversation transcript projection. */
export interface AgUiMessagesSnapshot {
  type: 'MESSAGES_SNAPSHOT'
  messages: AgUiMessage[]
}

/** CUSTOM — application-defined extension event. */
export interface AgUiCustom {
  type: 'CUSTOM'
  name: string
  value: unknown
}

/**
 * Every frame this adapter may put on the wire. Closed on purpose: the
 * translation allowlist can only emit members of this union, and the package
 * invariant rejects any frame outside it.
 */
export type AgUiEvent =
  | AgUiRunStarted
  | AgUiRunFinished
  | AgUiRunError
  | AgUiTextMessageStart
  | AgUiTextMessageContent
  | AgUiTextMessageEnd
  | AgUiToolCallStart
  | AgUiToolCallArgs
  | AgUiToolCallEnd
  | AgUiToolCallResult
  | AgUiStateSnapshot
  | AgUiMessagesSnapshot
  | AgUiCustom

/**
 * Per-connection protocol bracket tracker threaded through
 * {@link translateSessionEvent}. The server owns one instance per attached
 * stream; the translator updates it in place so consecutive calls see the
 * bracket history that determines which START/END frames are still owed.
 */
export interface BracketState {
  /** Thread (session id) stamped onto lifecycle frames. */
  threadId: string
  /**
   * Connection-level run-id base supplied by the client or generated at
   * attach; each turn's frames carry `${runId}-${turn}` so sequential turns
   * of one watched connection stay distinguishable.
   */
  runId: string
  /** True between RUN_STARTED and its RUN_FINISHED/RUN_ERROR. */
  runOpen: boolean
  /** Run id of the open run bracket; undefined while no run is open. */
  openRunId: string | undefined
  /** Open streamed-text bracket: tracking key and the wire messageId. */
  openMessage: { key: string; messageId: string } | undefined
  /** Tool-call brackets opened by deltas and not yet closed, keyed by CallId. */
  openTools: Map<string, { turn: number; step: number }>
  /** Call ids already projected through streamed deltas during this turn. */
  streamedCalls: Set<string>
  /** Session events (and chunk subtypes) dropped by the allowlist, for one debug line at close. */
  droppedUnmapped: number
}

/** Deployment configuration for the AG-UI outbound adapter plugin. */
export interface AgUiConfig {
  /** Bind address of the adapter's own HTTP listener. Defaults to loopback. */
  host?: string
  /** TCP port of the adapter's own HTTP listener; 0 selects an ephemeral port. */
  port: number
  /**
   * Required bearer token every request must present. Fewer than 8 characters
   * fails schema validation at load.
   */
  bearerToken: string
  /** Interval in milliseconds between SSE keepalive comments. Defaults to 15000. */
  keepAliveMs?: number
  /** Per-connection event queue bound; overflow terminates that stream. Defaults to 256. */
  maxBufferedEvents?: number
}

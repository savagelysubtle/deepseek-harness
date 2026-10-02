/** Message value types, identity, and immutable construction helpers. */

import { MessageId, type CallId } from './brand.ts'
import { deepFreeze } from './call-config.ts'
import type { ContentBlock, StreamChunk, ToolResultBlock } from './types.ts'

/** Provider/model identity and adapter-private replay data for an assistant message. */
export interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string
  /** Provider model id that produced the message. */
  model: string
  /**
   * Lossless-JSON adapter state needed to replay the provider response.
   * `LlmRuntime` exposes it to a target adapter only when that adapter instance
   * currently owns both this historical provider and the target provider.
   */
  replayState?: unknown
}

/** Required source of an assistant message produced by a routed model. */
export interface ModelMessageSource extends AssistantProvenance {
  kind: 'model'
}

/** Required source of a user-role message carrying one tool result. */
export interface ToolMessageSource {
  kind: 'tool'
  callId: CallId
}

/**
 * The kind of information in producer-supplied context, declared by the
 * producer beside its provenance.
 *
 * `MessageSource.kind` answers *who produced this*; `form` answers *what kind
 * of thing it is*, and the two axes are deliberately independent — several
 * producers share one form, and one producer may emit more than one form over
 * a session.
 *
 * The vocabulary is SEMANTIC, never visual: a value states that the content is
 * a file's instructions or a catalog of available items, and a consumer decides
 * what that looks like. Colors, icons, ordering, and collapse defaults are the
 * consumer's business and must not enter this union. It grows one value at a
 * time as producers gain the structured fields their form needs; an absent or
 * unknown value is the documented default, presented as opaque content.
 */
export type ContextForm =
  /** Instructions read out of workspace files the model is expected to follow. */
  | 'instructions'
  /** A catalog of items available in this session, republished as it changes. */
  | 'catalog'
  /** Current state, where a later snapshot from the same producer supersedes an earlier one. */
  | 'snapshot'
  /** A one-off account of something that just happened; it supersedes nothing. */
  | 'notice'
  /** A message another agent addressed to this one. */
  | 'relay'
  /** Material lifted out of another session's log, possibly reduced on the way in. */
  | 'recall'

/** One named contribution to a `snapshot`-form context, in assembly order. */
export interface ContextSnapshotSection {
  /** The contributing subsystem's name. */
  readonly name: string
  /** That contribution's model-facing text, exactly as assembled. */
  readonly text: string
}

/**
 * Producer-declared {@link ContextForm} and the fields that form requires,
 * mixed into the source types that carry one.
 *
 * Discriminated by `form` so a producer cannot select a form without the
 * fields needed to present it: a `notice` must record its one-line
 * account, a `snapshot` its sections. Omitting `form` stays valid — an
 * undeclared context is the documented default.
 */
export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | {
    readonly form: 'snapshot'
    /** The named contributions this snapshot assembled, in order. */
    readonly sections: readonly ContextSnapshotSection[]
  }
  | {
    readonly form: 'notice'
    /** One-line account of what happened, shown without expanding the row. */
    readonly summary: string
  }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }

/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
export interface MessageSourceMap {
  user: {
    kind: 'user'
    /**
     * Whether this message is the founder's own, typed directly at this
     * machine. Minted only by trusted harness code at loopback-proven direct
     * channels — never derived from tool arguments, mailbox payloads, or
     * model output; there is no signature, so the guarantee is entirely
     * architectural (which first-party call sites are allowed to set it),
     * the same boundary `ToolMessageSource.callId` already relies on.
     * Literal `true` only; no other source kind carries this field, and its
     * absence means "not the founder" and fails closed — a resumed log
     * written before this field existed renders as unstamped, never as an
     * error.
     */
    founder?: true
  }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource
  tool: ToolMessageSource
}

/**
 * Bound for a `notice` summary. The account rides a collapsed transcript row
 * and is committed to the durable log, while its inputs — task labels, goal
 * objectives, tool arguments — are caller text with no length of their own.
 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * Bound one `notice` summary to {@link CONTEXT_SUMMARY_MAX_CHARS}.
 * @param summary - the producer's one-line account, of any length.
 * @returns the account, ellipsized when it exceeds the bound.
 */
export function boundContextSummary(summary: string): string {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/** Any known message source, derived from {@link MessageSourceMap}; switch on `kind` and fall through unknowns (merge-extensible). */
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

/**
 * Whether a message source is the founder's own, typed directly at this
 * machine (see {@link MessageSourceMap.user.founder}). The only source kind
 * that can ever carry the field is `'user'`; every other kind, and a bare
 * `'user'` source without the field, is not the founder.
 * @param source - the message source to test.
 * @returns true only when `kind === 'user'` and `founder === true`.
 */
export function isFounderMessage(source: MessageSource): boolean {
  return source.kind === 'user' && source.founder === true
}

/**
 * Harness-authored source `kind`s that are pure mechanical context: never the
 * founder's own input, and never third-party content injected mid-turn.
 * Compared as plain strings rather than literal members of the
 * locally-declared {@link MessageSourceMap}, because `'skill-catalog'` and
 * `'agent-instructions'` are declared by `declare module` augmentation in
 * packages this one must not depend on (importing them back would be
 * circular — they depend on `@deepseek-ai/dsh-llm`, not the reverse).
 *
 * CLOSED ON PURPOSE (sentinel ruling, 2026-10-02): a design that skipped
 * EVERY non-`'user'` kind when picking the open turn's authority-bearing
 * message was found unsafe, because several non-`'user'` kinds carry
 * OUTSIDE-controlled content appended mid-turn via `agent.steer()`
 * (`'next-step'`), and an earlier founder stamp must not persist over it:
 *  - mailbox relay (`kind: 'mailbox', form: 'relay'`,
 *    `packages/mailbox/bridge/src/delivery.ts:187-193`, delivered via
 *    `agent.steer()` at `packages/mailbox/bridge/src/index.ts:975-990`).
 *  - subagent settlement/report (`kind: 'subagent-settled'` /
 *    `'subagent-report'`, `packages/subagent/subagent/src/continuation.ts:
 *    1443-1479`, `parent.steer(message)` when the parent is busy).
 * A bare `kind: 'plugin'` is ALSO not safe to skip on `kind` alone — hook
 * steering uses it too (`packages/hooks/hooks-claude-code/src/index.ts:292`,
 * `packages/hooks/hooks-codex/src/index.ts:268`), so the one `'plugin'`
 * source that IS mechanical (the runtime-context snapshot) is recognized
 * below by its exact plugin id, never by `kind` alone.
 *
 * The allowlist is exactly these two `kind`s and nothing else:
 *  - `'skill-catalog'` — the pre-step skill-catalog waterfall
 *    (`packages/skill/tool-skill/src/index.ts:247-305`).
 *  - `'agent-instructions'` — pre-step workspace-instruction reconciliation
 *    (`packages/context/agent-instructions/src/state.ts:81-85`).
 */
const MECHANICAL_CONTEXT_SOURCE_KINDS: ReadonlySet<string> = new Set(['skill-catalog', 'agent-instructions'])

/**
 * Plugin id of the one `kind: 'plugin'` source that is also mechanical
 * context: the runtime-context snapshot
 * (`packages/core/agent-loop/src/runtime-context.ts:9-15,64-73`). See
 * {@link MECHANICAL_CONTEXT_SOURCE_KINDS}'s doc comment for why a bare
 * `kind: 'plugin'` is not, by itself, safe to treat as mechanical.
 */
const RUNTIME_CONTEXT_SNAPSHOT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

/**
 * Whether a message source is pure mechanical harness context, safe to skip
 * when selecting the message that carries founder authority (see
 * {@link selectFounderAuthorityMessage}) — never the founder's own input and
 * never third-party content. The allowlist is closed on purpose; see
 * {@link MECHANICAL_CONTEXT_SOURCE_KINDS}'s doc comment for the full
 * rationale and the sentinel ruling that produced it.
 * @param source - the message source to test.
 * @returns true only for the runtime-context snapshot, the skill catalog, or agent-instructions reconciliation.
 */
export function isMechanicalContextSource(source: MessageSource): boolean {
  return MECHANICAL_CONTEXT_SOURCE_KINDS.has(source.kind)
    || (source.kind === 'plugin' && source.plugin === RUNTIME_CONTEXT_SNAPSHOT_PLUGIN)
}

/**
 * The open turn's authority-bearing message: the last of `messages` whose
 * source is not {@link isMechanicalContextSource}. Shared selection behind
 * the founder-authority check in `@deepseek-ai/dsh-system-prompt`'s
 * `openTurnIsFounderStamped`, `@deepseek-ai/dsh-tool-goal`'s
 * `hasDirectHumanInput`, and `@deepseek-ai/dsh-plan-mode`'s
 * `openTurnIsFounderStamped` — each re-derives its own open-turn window
 * locally (to avoid depending on one another), then hands the ordered
 * `user/message` payloads of that window to this one shared selection, and
 * calls {@link isFounderMessage} on the result.
 * @param messages - candidate messages, in log order (oldest first).
 * @returns the last non-mechanical message, or `undefined` when every
 *   candidate (including an empty list) is mechanical.
 */
export function selectFounderAuthorityMessage<M extends { readonly source: MessageSource }>(
  messages: readonly M[],
): M | undefined {
  return messages.filter(message => !isMechanicalContextSource(message.source)).at(-1)
}

/** One immutable message representation shared by delivery, durable history, and model requests. */
export interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required source fields supplied by the producer. */
  readonly source: MessageSource
}

/** A user-role specialization of the one shared message representation. */
export interface UserMessage extends Message {
  readonly role: 'user'
}

/** A model-produced assistant specialization of the shared message representation. */
export interface AssistantMessage extends Message {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

/** A tool-result specialization whose model-facing block retains call correlation. */
export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: [ToolResultBlock]
  readonly source: ToolMessageSource
}

type NewMessage = Omit<Message, 'id'>
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>
type NewAssistantMessage = Omit<AssistantMessage, 'id' | 'role' | 'source'> & {
  readonly source: Omit<ModelMessageSource, 'kind'> & { readonly kind?: never }
}

/**
 * Detach and deep-freeze a message whose identity already exists.
 * @param message - complete message, including its stable identity.
 * @returns an immutable snapshot that preserves the identity.
 */
export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/**
 * Create one identified message and freeze it before publication.
 * @param input - complete role, content, and source for a new message.
 * @returns an immutable message with a fresh stable identity.
 */
export function createMessage<T extends NewMessage>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'> {
  return freezeMessage({
    ...input,
    id: MessageId(crypto.randomUUID()),
  })
}

/**
 * Create one identified user-role message and freeze it before publication.
 * @param input - complete content and source for a new user message.
 * @returns an immutable user message with a fresh stable identity.
 */
export function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  return createMessage({
    ...input,
    role: 'user',
  })
}

/**
 * Create one identified model-produced assistant message and freeze it before publication.
 * @param input - complete content plus the provider, model, and optional replay state for a new assistant message.
 * @returns an immutable assistant message with fixed role/source tags and a fresh stable identity.
 */
export function createAssistantMessage(
  input: NewAssistantMessage & { readonly id?: never; readonly role?: never },
): AssistantMessage {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: {
      kind: 'model',
      ...input.source,
    },
  })
}

/** Input whose acceptance creates one tool-result message. */
export interface ToolResultMessageInput {
  readonly callId: CallId
  readonly content: ContentBlock[]
  readonly isError: boolean
}

/**
 * Create and freeze one identified tool-result message.
 * @param input - call identity, raw result blocks, and outcome.
 * @returns an immutable user-role tool-result message.
 */
export function createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage {
  return createUserMessage({
    source: { kind: 'tool', callId: input.callId },
    content: [{
      type: 'tool-result',
      toolCallId: input.callId,
      content: input.content,
      isError: input.isError,
    }],
  })
}

/**
 * Whether a stream chunk carries visible model output (the first-token
 * boundary shared by client step timing and the whole-log sessionStats
 * projection). Empty deltas (heartbeats, empty tool-call frames) do not count
 * as a first token.
 * @param chunk - the stream chunk to test.
 * @returns true when the chunk contains a non-empty text/reasoning/tool delta.
 */
export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

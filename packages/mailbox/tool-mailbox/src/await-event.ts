/**
 * The durable `mailbox_await` outcome record: a versioned, log-only
 * `mailbox/await` session event appended once, on the one path that actually
 * exits `mailboxAwaitTool.execute()` — reply, refusal, timeout, abort, or any
 * thrown store error. SWD-99: today only the rendered prose
 * (`renderAwaitOutcome`'s `tool/result` text) survives; the structured
 * `MailboxAwaitResult` is computed and thrown away. This module makes that
 * fact a stable, queryable field instead.
 *
 * Mirrors `@deepseek-ai/dsh-subagent`'s `settlement.ts`
 * (`SubagentSettlementData`/`snapshotSubagentSettlement`)'s versioned,
 * validated, detached shape. Unlike that module, this one does **not** add a
 * fold-over-a-slice
 * helper: a settlement is one terminal fact per child (a last-wins fold is
 * meaningful), while a session can run many `mailbox_await` calls, so there
 * is no "current state" to fold — only individual events to decode. Per-event
 * decode and validation are the whole surface.
 *
 * @module @deepseek-ai/dsh-tool-mailbox/await-event
 */

import { snapshotJsonValue } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable outcome of one `mailbox_await` tool call, appended once inside
     * `mailboxAwaitTool.execute()`, on the single path that actually exits
     * (happy return or thrown error). Log-only: it carries no `surfaceOp`,
     * never enters model history, and survives compaction.
     */
    'mailbox/await': MailboxAwaitEventData
  }
}

/**
 * The current `mailbox/await` format version, stamped into every appended
 * event and required verbatim by {@link parseMailboxAwaitEvent}. Supporting
 * another recorded field is a deliberate version change, never an implicit
 * extra field.
 */
export const MAILBOX_AWAIT_EVENT_VERSION = 1

/** The durable outcome fact about one `mailbox_await` tool call. */
export interface MailboxAwaitEventData {
  /** Event format version ({@link MAILBOX_AWAIT_EVENT_VERSION}). */
  readonly version: number
  /** Superset of `MailboxAwaitOutcome`: the tool can also end by throwing. */
  readonly outcome: 'reply' | 'refused' | 'timeout' | 'aborted' | 'error'
  /** The caller's correlation id, when supplied. */
  readonly traceId?: string
  /** `sent.to`, when a `traceId` resolved to a sent row. */
  readonly counterpart?: string
  /** Epoch ms the wait began. */
  readonly startedAt: number
  /** Epoch ms the wait ended; redundant with the event's own `time`, kept explicit for a reader without access to event metadata. */
  readonly endedAt: number
  /** Milliseconds actually spent waiting. */
  readonly waitedMs: number
  /** Arrived-message count on `'reply'`, else `0`. */
  readonly messageCount: number
  /** `'refused'` only: why the awaited send was refused. */
  readonly refusalReason?: string
  /** `'timeout'` only: the awaited send's last known delivery state. */
  readonly sentState?: 'delivered' | 'claimed' | 'pending' | 'unknown'
  /** `'timeout'` and `sentState: 'delivered'` only: when delivery happened. */
  readonly deliveredAt?: number
  /** The caught error's name (constructor or `name`), present only for the `error` outcome. */
  readonly errorName?: string
  /** Capped at 200 characters with absolute filesystem path segments replaced by `<path>`; present only for the `error` outcome. */
  readonly errorMessage?: string
}

/** Input {@link snapshotMailboxAwaitEvent} validates and detaches. */
export interface MailboxAwaitEventInput {
  /** Superset of `MailboxAwaitOutcome`: the tool can also end by throwing. */
  readonly outcome: 'reply' | 'refused' | 'timeout' | 'aborted' | 'error'
  /** The caller's correlation id, when supplied. */
  readonly traceId?: string
  /** `sent.to`, when a `traceId` resolved to a sent row. */
  readonly counterpart?: string
  /** Epoch ms the wait began. */
  readonly startedAt: number
  /** Epoch ms the wait ended. */
  readonly endedAt: number
  /** Milliseconds actually spent waiting. */
  readonly waitedMs: number
  /** Arrived-message count on `'reply'`, else `0`. */
  readonly messageCount: number
  /** `'refused'` only: why the awaited send was refused. */
  readonly refusalReason?: string
  /** `'timeout'` only: the awaited send's last known delivery state. */
  readonly sentState?: 'delivered' | 'claimed' | 'pending' | 'unknown'
  /** `'timeout'` and `sentState: 'delivered'` only: when delivery happened. */
  readonly deliveredAt?: number
  /** The caught error's name (constructor or `name`), present only for the `error` outcome. */
  readonly errorName?: string
  /** Capped at 200 characters with absolute filesystem path segments replaced by `<path>`; present only for the `error` outcome. */
  readonly errorMessage?: string
}

/**
 * Non-indexed alias for {@link MailboxAwaitEventData.outcome}'s literal
 * union, so a narrowed `string` can be cast without
 * `exactOptionalPropertyTypes` re-adding `undefined` through an indexed
 * required-field type.
 */
type MailboxAwaitOutcomeValue = MailboxAwaitEventData['outcome']

/**
 * Non-indexed alias for {@link MailboxAwaitEventData.sentState}'s literal
 * union — indexing an *optional* field's type (unlike `outcome`, which is
 * required) widens to include `undefined`, so this alias is declared
 * directly instead.
 */
type MailboxAwaitSentStateValue = 'delivered' | 'claimed' | 'pending' | 'unknown'

const MAILBOX_AWAIT_EVENT_KEYS = new Set([
  'version',
  'outcome',
  'traceId',
  'counterpart',
  'startedAt',
  'endedAt',
  'waitedMs',
  'messageCount',
  'refusalReason',
  'sentState',
  'deliveredAt',
  'errorName',
  'errorMessage',
])

const MAILBOX_AWAIT_OUTCOMES = new Set(['reply', 'refused', 'timeout', 'aborted', 'error'])

const MAILBOX_AWAIT_SENT_STATES = new Set(['delivered', 'claimed', 'pending', 'unknown'])

/** Whether a persisted JSON value is an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an optional string field, or throw when present with the wrong type. */
function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key]
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`persisted mailbox await payload ${key} must be a string`)
  }
  return raw
}

/** Read an optional number field, or throw when present with the wrong type. */
function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key]
  if (raw === undefined) return undefined
  if (typeof raw !== 'number') {
    throw new Error(`persisted mailbox await payload ${key} must be a number`)
  }
  return raw
}

/** Read a required number field, or throw when missing or the wrong type. */
function requiredNumber(value: Record<string, unknown>, key: string): number {
  const raw = value[key]
  if (typeof raw !== 'number') {
    throw new Error(`persisted mailbox await payload ${key} must be a number`)
  }
  return raw
}

/**
 * Validate one persisted `mailbox/await` payload for the current runtime.
 * @param value - the candidate payload, from one session event's `data`.
 * @returns the validated event data, or `undefined` when the payload's
 *   `version` is not {@link MAILBOX_AWAIT_EVENT_VERSION} (the record cannot
 *   be classified by this runtime).
 * @throws when a current-version payload does not match its complete
 *   declared schema.
 */
export function parseMailboxAwaitEvent(value: unknown): MailboxAwaitEventData | undefined {
  if (!isRecord(value)) {
    throw new Error('persisted mailbox await payload must be an object')
  }
  const version = value['version']
  if (typeof version !== 'number') {
    throw new Error('persisted mailbox await payload version must be a number')
  }
  if (version !== MAILBOX_AWAIT_EVENT_VERSION) return undefined

  const unknown = Object.keys(value).find(key => !MAILBOX_AWAIT_EVENT_KEYS.has(key))
  if (unknown !== undefined) {
    throw new Error(`persisted mailbox await payload has unknown field "${unknown}"`)
  }

  const outcome = value['outcome']
  if (typeof outcome !== 'string' || !MAILBOX_AWAIT_OUTCOMES.has(outcome)) {
    throw new Error('persisted mailbox await payload outcome must be one of "reply", "refused", "timeout", "aborted", "error"')
  }
  const sentState = optionalString(value, 'sentState')
  if (sentState !== undefined && !MAILBOX_AWAIT_SENT_STATES.has(sentState)) {
    throw new Error('persisted mailbox await payload sentState must be one of "delivered", "claimed", "pending", "unknown"')
  }
  const traceId = optionalString(value, 'traceId')
  const counterpart = optionalString(value, 'counterpart')
  const refusalReason = optionalString(value, 'refusalReason')
  const deliveredAt = optionalNumber(value, 'deliveredAt')
  const errorName = optionalString(value, 'errorName')
  const errorMessage = optionalString(value, 'errorMessage')

  return {
    version: MAILBOX_AWAIT_EVENT_VERSION,
    outcome: outcome as MailboxAwaitOutcomeValue,
    ...traceId !== undefined ? { traceId } : {},
    ...counterpart !== undefined ? { counterpart } : {},
    startedAt: requiredNumber(value, 'startedAt'),
    endedAt: requiredNumber(value, 'endedAt'),
    waitedMs: requiredNumber(value, 'waitedMs'),
    messageCount: requiredNumber(value, 'messageCount'),
    ...refusalReason !== undefined ? { refusalReason } : {},
    ...sentState !== undefined ? { sentState: sentState as MailboxAwaitSentStateValue } : {},
    ...deliveredAt !== undefined ? { deliveredAt } : {},
    ...errorName !== undefined ? { errorName } : {},
    ...errorMessage !== undefined ? { errorMessage } : {},
  }
}

/**
 * Validate and detach a `mailbox/await` input into the durable payload, the
 * same detached lossless-JSON boundary `@deepseek-ai/dsh-subagent`'s
 * `snapshotSubagentSettlement` enforces for settlement, applied before the append so a synchronous
 * validation failure never produces a half-written durable fact.
 * @param input - the caller-collected outcome, timing, and outcome-specific fields.
 * @returns the versioned, detached event payload.
 * @throws when a field is not losslessly JSON-serializable.
 */
export function snapshotMailboxAwaitEvent(input: MailboxAwaitEventInput): MailboxAwaitEventData {
  const candidate: MailboxAwaitEventData = {
    version: MAILBOX_AWAIT_EVENT_VERSION,
    outcome: input.outcome,
    ...input.traceId !== undefined ? { traceId: input.traceId } : {},
    ...input.counterpart !== undefined ? { counterpart: input.counterpart } : {},
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    waitedMs: input.waitedMs,
    messageCount: input.messageCount,
    ...input.refusalReason !== undefined ? { refusalReason: input.refusalReason } : {},
    ...input.sentState !== undefined ? { sentState: input.sentState } : {},
    ...input.deliveredAt !== undefined ? { deliveredAt: input.deliveredAt } : {},
    ...input.errorName !== undefined ? { errorName: input.errorName } : {},
    ...input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {},
  }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) {
    throw new Error('mailbox await event is not losslessly JSON-serializable')
  }
  return snapshot
}

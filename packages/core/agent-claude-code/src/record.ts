/** Never-throwing, allowlisting recorder for Claude Code driver events. @module @deepseek-ai/dsh-agent-claude-code/record */

import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import {
  CLAUDE_CODE_COMPACT_TRIGGERS, CLAUDE_CODE_DRIVER_NAME, CLAUDE_CODE_EVENT_VERSION,
  CLAUDE_CODE_FLEET_REFUSAL_REASONS, CLAUDE_CODE_MAX_MODEL_USAGE_ENTRIES,
  CLAUDE_CODE_MAX_REASON_CHARS, CLAUDE_CODE_RATE_LIMIT_SOURCES, CLAUDE_CODE_STEER_KINDS,
} from './constants.ts'
import type { ClaudeCodeEventType } from './constants.ts'
import { sanitizeFreeText, sanitizeLabel } from './sanitize.ts'
import type {
  ClaudeCodeCompactData, ClaudeCodeFleetRefusedData, ClaudeCodeModelUsage,
  ClaudeCodeRateLimitedData, ClaudeCodeSessionBoundData, ClaudeCodeSteerData,
  ClaudeCodeUsage,
} from './types.ts'

/** SDK-sourced counter that may be absent; absent or invalid values are recorded as 0. */
export type ClaudeCodeMaybeNumber = number | null | undefined

/** Token counters as the mapper may supply them (any may be missing). */
export interface ClaudeCodeUsageInput {
  readonly inputTokens?: ClaudeCodeMaybeNumber
  readonly outputTokens?: ClaudeCodeMaybeNumber
  readonly cacheReadInputTokens?: ClaudeCodeMaybeNumber
  readonly cacheCreationInputTokens?: ClaudeCodeMaybeNumber
}

/** Per-model usage as the mapper may supply it. */
export interface ClaudeCodeModelUsageInput extends ClaudeCodeUsageInput {
  readonly estimatedCostUsd?: ClaudeCodeMaybeNumber
  readonly webSearchRequests?: ClaudeCodeMaybeNumber
}

/** `claude-code/turn-completed` input: SDK numbers may be missing and become 0. */
export interface ClaudeCodeTurnCompletedInput {
  readonly turnIndex: number
  readonly outcome: string
  readonly isError: boolean
  readonly model: string
  readonly numTurns?: ClaudeCodeMaybeNumber
  readonly durationMs?: ClaudeCodeMaybeNumber
  readonly durationApiMs?: ClaudeCodeMaybeNumber
  readonly estimatedCostUsd?: ClaudeCodeMaybeNumber
  readonly usage?: ClaudeCodeUsageInput | null
  readonly modelUsage?: { readonly [modelId: string]: ClaudeCodeModelUsageInput | null | undefined } | null
  readonly stopReason?: string | null
}

type WithoutVersion<T> = Omit<T, 'version'>

/** Caller-facing input per event type; `version` is stamped by the recorder. */
export interface ClaudeCodeEventInputMap {
  'claude-code/session-bound': WithoutVersion<ClaudeCodeSessionBoundData>
  'claude-code/turn-completed': ClaudeCodeTurnCompletedInput
  'claude-code/steer': WithoutVersion<ClaudeCodeSteerData>
  'claude-code/compact': WithoutVersion<ClaudeCodeCompactData>
  'claude-code/rate-limited': WithoutVersion<ClaudeCodeRateLimitedData>
  'claude-code/fleet-refused': WithoutVersion<ClaudeCodeFleetRefusedData>
}

/** Optional sink for the one-line reason a record was dropped (the recorder itself has no logger). */
export type ClaudeCodeRecordWarn = (message: string) => void

type Plain = Record<string, unknown>

/** Own data property read that survives getters that throw or proxies that lie. */
function read(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined
  try {
    return (source as Plain)[key]
  } catch {
    return undefined
  }
}

/** Finite non-negative number, else 0. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Non-negative safe integer, else 0. */
function wholeCount(value: unknown): number {
  const n = Math.trunc(count(value))
  return Number.isSafeInteger(n) ? n : 0
}

/** Epoch-milliseconds timestamp; missing or invalid falls back to now. */
function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now()
}

/** The value when it is one of the allowed literals, else undefined. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined
}

function normalizeUsage(source: unknown): ClaudeCodeUsage {
  return {
    inputTokens: wholeCount(read(source, 'inputTokens')),
    outputTokens: wholeCount(read(source, 'outputTokens')),
    cacheReadInputTokens: wholeCount(read(source, 'cacheReadInputTokens')),
    cacheCreationInputTokens: wholeCount(read(source, 'cacheCreationInputTokens')),
  }
}

function normalizeModelUsage(source: unknown): { [modelId: string]: ClaudeCodeModelUsage } {
  const out: { [modelId: string]: ClaudeCodeModelUsage } = {}
  if (source === null || typeof source !== 'object') return out
  let keys: string[]
  try {
    keys = Object.keys(source)
  } catch {
    return out
  }
  for (const key of keys.slice(0, CLAUDE_CODE_MAX_MODEL_USAGE_ENTRIES)) {
    const id = sanitizeLabel(key)
    if (id === '') continue
    const entry = read(source, key)
    out[id] = {
      ...normalizeUsage(entry),
      estimatedCostUsd: count(read(entry, 'estimatedCostUsd')),
      webSearchRequests: wholeCount(read(entry, 'webSearchRequests')),
    }
  }
  return out
}

/** Normalize one event payload to its allowlisted wire shape, or undefined when unusable. */
function normalize(type: ClaudeCodeEventType, data: unknown): Plain | undefined {
  const version = CLAUDE_CODE_EVENT_VERSION
  switch (type) {
    case 'claude-code/session-bound': {
      const sessionId = sanitizeLabel(read(data, 'sessionId'))
      const sdkSessionId = sanitizeLabel(read(data, 'sdkSessionId'))
      if (sessionId === '' || sdkSessionId === '') return undefined
      return {
        version, sessionId, sdkSessionId,
        model: sanitizeLabel(read(data, 'model')),
        driver: CLAUDE_CODE_DRIVER_NAME,
        at: timestamp(read(data, 'at')),
      }
    }
    case 'claude-code/turn-completed': {
      const turnIndex = wholeCount(read(data, 'turnIndex'))
      const outcome = sanitizeFreeText(read(data, 'outcome'))
      if (turnIndex < 1 || outcome === '') return undefined
      const stopReason = sanitizeFreeText(read(data, 'stopReason'))
      return {
        version, turnIndex, outcome,
        isError: read(data, 'isError') === true,
        model: sanitizeLabel(read(data, 'model')),
        numTurns: wholeCount(read(data, 'numTurns')),
        durationMs: count(read(data, 'durationMs')),
        durationApiMs: count(read(data, 'durationApiMs')),
        estimatedCostUsd: count(read(data, 'estimatedCostUsd')),
        usage: normalizeUsage(read(data, 'usage')),
        modelUsage: normalizeModelUsage(read(data, 'modelUsage')),
        ...stopReason === '' ? {} : { stopReason },
      }
    }
    case 'claude-code/steer': {
      const kind = oneOf(read(data, 'kind'), CLAUDE_CODE_STEER_KINDS)
      if (kind === undefined) return undefined
      return {
        version, kind,
        reason: sanitizeFreeText(read(data, 'reason'), CLAUDE_CODE_MAX_REASON_CHARS),
        at: timestamp(read(data, 'at')),
      }
    }
    case 'claude-code/compact': {
      const trigger = oneOf(read(data, 'trigger'), CLAUDE_CODE_COMPACT_TRIGGERS)
      if (trigger === undefined) return undefined
      return { version, preTokens: wholeCount(read(data, 'preTokens')), trigger, at: timestamp(read(data, 'at')) }
    }
    case 'claude-code/rate-limited': {
      const source = oneOf(read(data, 'source'), CLAUDE_CODE_RATE_LIMIT_SOURCES)
      if (source === undefined) return undefined
      const retryAfterMs = read(data, 'retryAfterMs')
      return {
        version, source,
        ...typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? { retryAfterMs: Math.trunc(retryAfterMs) }
          : {},
        breakerTripped: read(data, 'breakerTripped') === true,
        at: timestamp(read(data, 'at')),
      }
    }
    case 'claude-code/fleet-refused': {
      const reason = oneOf(read(data, 'reason'), CLAUDE_CODE_FLEET_REFUSAL_REASONS)
      if (reason === undefined) return undefined
      return {
        version, reason,
        limit: count(read(data, 'limit')),
        observed: count(read(data, 'observed')),
        at: timestamp(read(data, 'at')),
      }
    }
    default:
      return undefined
  }
}

/**
 * Append one Claude Code driver event to a Session without ever throwing.
 *
 * The payload is rebuilt from named fields only (an allowlist: unknown fields,
 * prompt text, tool results, and paths cannot ride along), free text is
 * control-stripped, token-redacted, and capped, SDK numbers that are missing or
 * invalid become 0, and the result is snapshotted to lossless JSON before the
 * append. Any failure (bad input, invariant rejection, closed session) is
 * contained and reported as `false`; the caller's turn is never affected.
 * @param session - the dsh Session to append to.
 * @param type - one of the six `claude-code/*` event types.
 * @param data - caller input; `version` is stamped here.
 * @param warn - optional sink for the reason a record was dropped.
 * @returns whether the event was appended.
 */
export function recordClaudeCodeEvent<Type extends ClaudeCodeEventType>(
  session: Session,
  type: Type,
  data: ClaudeCodeEventInputMap[Type],
  warn?: ClaudeCodeRecordWarn,
): boolean {
  try {
    const normalized = normalize(type, data)
    if (normalized === undefined) {
      warn?.(`${type}: dropped event with missing or invalid required fields`)
      return false
    }
    const snapshot = snapshotJsonValue(normalized)
    if (snapshot === undefined) {
      warn?.(`${type}: dropped event that is not lossless JSON`)
      return false
    }
    // All six events are log-only; narrowing the generic append face
    // discharges Session.append's conditional options tuple.
    const append = session.append.bind(session) as <Event extends ClaudeCodeEventType>(
      event: Event,
      value: SessionEventMap[Event],
    ) => void
    append(type, snapshot as unknown as SessionEventMap[Type])
    return true
  } catch (error: unknown) {
    try {
      warn?.(`${type}: append failed: ${error instanceof Error ? sanitizeFreeText(error.message, CLAUDE_CODE_MAX_REASON_CHARS) : 'non-error thrown'}`)
    } catch {
      // The warn sink is caller code; its failure must not escape either.
    }
    return false
  }
}

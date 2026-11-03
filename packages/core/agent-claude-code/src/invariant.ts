/** Package-owned durable Claude Code driver-record invariants. @module @deepseek-ai/dsh-agent-claude-code/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import {
  CLAUDE_CODE_COMPACT_TRIGGERS, CLAUDE_CODE_DRIVER_NAME, CLAUDE_CODE_EVENT_PREFIX,
  CLAUDE_CODE_EVENT_VERSION, CLAUDE_CODE_FLEET_REFUSAL_REASONS, CLAUDE_CODE_MAX_REASON_CHARS,
  CLAUDE_CODE_MAX_TEXT_CHARS, CLAUDE_CODE_RATE_LIMIT_SOURCES, CLAUDE_CODE_STEER_KINDS,
} from './constants.ts'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-claude-code'

/** Cordis companion plugin name. */
export const name = 'agent-claude-code-invariant'
/** Services required to validate existing and newly appended Session logs. */
export const inject = ['invariants']

interface DriverTrace {
  bound: boolean
  lastTurnIndex: number
}

/** Whether this package owns the candidate Session event. */
function isDriverRecordEvent(event: SessionEvent): boolean {
  return event.type.startsWith(CLAUDE_CODE_EVENT_PREFIX)
}

/** Read one plain payload without trusting restored plugin data. */
function recordOf(event: SessionEvent, fail: InvariantFailure): Record<string, unknown> {
  const data: unknown = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(`${event.type} data must be a JSON object`)
  }
  return data as Record<string, unknown>
}

/** Require a non-empty bounded string. */
function text(
  data: Record<string, unknown>, key: string, type: string, fail: InvariantFailure,
  max: number = CLAUDE_CODE_MAX_TEXT_CHARS,
): string {
  const value = data[key]
  if (typeof value !== 'string' || value.length === 0) fail(`${type} ${key} must be a non-empty string`)
  if (value.length > max) fail(`${type} ${key} must be at most ${max} characters`)
  return value
}

/** Require a bounded string that may be empty. */
function optionalText(
  data: Record<string, unknown>, key: string, type: string, fail: InvariantFailure, max: number,
): void {
  const value = data[key]
  if (typeof value !== 'string') fail(`${type} ${key} must be a string`)
  if (value.length > max) fail(`${type} ${key} must be at most ${max} characters`)
}

/** Require a finite non-negative number. */
function amount(data: Record<string, unknown>, key: string, type: string, fail: InvariantFailure): number {
  const value = data[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${type} ${key} must be a finite non-negative number`)
  }
  return value
}

/** Require a non-negative safe integer. */
function whole(data: Record<string, unknown>, key: string, type: string, fail: InvariantFailure): number {
  const value = amount(data, key, type, fail)
  if (!Number.isSafeInteger(value)) fail(`${type} ${key} must be a non-negative safe integer`)
  return value
}

/** Require a boolean. */
function flag(data: Record<string, unknown>, key: string, type: string, fail: InvariantFailure): boolean {
  const value = data[key]
  if (typeof value !== 'boolean') fail(`${type} ${key} must be a boolean`)
  return value
}

/** Require one of the allowed literals. */
function member(
  data: Record<string, unknown>, key: string, allowed: readonly string[], type: string, fail: InvariantFailure,
): void {
  if (!allowed.includes(data[key] as string)) fail(`${type} ${key} ${String(data[key])} is invalid`)
}

/** Require the four token counters. */
function usageOf(source: unknown, label: string, type: string, fail: InvariantFailure): void {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    fail(`${type} ${label} must be a JSON object`)
  }
  const usage = source as Record<string, unknown>
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
    whole(usage, key, type, fail)
  }
}

/** Copy only the trace one candidate can mutate. */
function cloneTrace(source: DriverTrace): DriverTrace {
  return { bound: source.bound, lastTurnIndex: source.lastTurnIndex }
}

/** Advance the driver-record fold with one relevant Session event. */
function applyEvent(trace: DriverTrace, event: SessionEvent, fail: InvariantFailure): void {
  const type = event.type
  const data = recordOf(event, fail)
  if (data.version !== CLAUDE_CODE_EVENT_VERSION) {
    fail(`${type} version must be ${CLAUDE_CODE_EVENT_VERSION}`)
  }
  switch (type) {
    case 'claude-code/session-bound': {
      text(data, 'sessionId', type, fail)
      text(data, 'sdkSessionId', type, fail)
      optionalText(data, 'model', type, fail, CLAUDE_CODE_MAX_TEXT_CHARS)
      if (data.driver !== CLAUDE_CODE_DRIVER_NAME) fail(`${type} driver must be ${CLAUDE_CODE_DRIVER_NAME}`)
      amount(data, 'at', type, fail)
      trace.bound = true
      return
    }
    case 'claude-code/turn-completed': {
      if (!trace.bound) fail(`${type} has no earlier claude-code/session-bound`)
      const turnIndex = whole(data, 'turnIndex', type, fail)
      if (turnIndex < 1) fail(`${type} turnIndex must be at least 1`)
      if (turnIndex <= trace.lastTurnIndex) {
        fail(`${type} turnIndex ${turnIndex} does not follow turn ${trace.lastTurnIndex}`)
      }
      text(data, 'outcome', type, fail)
      flag(data, 'isError', type, fail)
      optionalText(data, 'model', type, fail, CLAUDE_CODE_MAX_TEXT_CHARS)
      whole(data, 'numTurns', type, fail)
      amount(data, 'durationMs', type, fail)
      amount(data, 'durationApiMs', type, fail)
      amount(data, 'estimatedCostUsd', type, fail)
      usageOf(data.usage, 'usage', type, fail)
      const modelUsage = data.modelUsage
      if (modelUsage === null || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
        fail(`${type} modelUsage must be a JSON object`)
      }
      for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
        usageOf(entry, 'modelUsage entry', type, fail)
        const row = entry as Record<string, unknown>
        amount(row, 'estimatedCostUsd', type, fail)
        whole(row, 'webSearchRequests', type, fail)
      }
      if (data.stopReason !== undefined) text(data, 'stopReason', type, fail)
      trace.lastTurnIndex = turnIndex
      return
    }
    case 'claude-code/steer': {
      if (!trace.bound) fail(`${type} has no earlier claude-code/session-bound`)
      member(data, 'kind', CLAUDE_CODE_STEER_KINDS, type, fail)
      optionalText(data, 'reason', type, fail, CLAUDE_CODE_MAX_REASON_CHARS)
      amount(data, 'at', type, fail)
      return
    }
    case 'claude-code/compact': {
      if (!trace.bound) fail(`${type} has no earlier claude-code/session-bound`)
      whole(data, 'preTokens', type, fail)
      member(data, 'trigger', CLAUDE_CODE_COMPACT_TRIGGERS, type, fail)
      amount(data, 'at', type, fail)
      return
    }
    case 'claude-code/rate-limited': {
      member(data, 'source', CLAUDE_CODE_RATE_LIMIT_SOURCES, type, fail)
      if (data.retryAfterMs !== undefined) whole(data, 'retryAfterMs', type, fail)
      flag(data, 'breakerTripped', type, fail)
      amount(data, 'at', type, fail)
      return
    }
    case 'claude-code/fleet-refused': {
      member(data, 'reason', CLAUDE_CODE_FLEET_REFUSAL_REASONS, type, fail)
      amount(data, 'limit', type, fail)
      amount(data, 'observed', type, fail)
      amount(data, 'at', type, fail)
      return
    }
    default:
      fail(`unknown claude-code event type ${type}`)
  }
}

/** Install an independent incremental fold over every attached Session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, DriverTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; trace: DriverTrace }>()

  const seed = (session: Session): DriverTrace => {
    const trace: DriverTrace = { bound: false, lastTurnIndex: 0 }
    for (const event of session.events.filter(isDriverRecordEvent)) applyEvent(trace, event, fail)
    traces.set(session, trace)
    return trace
  }
  ctx.sessions.list().forEach(seed)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isDriverRecordEvent(event)) return
    // session/event dispatch follows list() or session/created seeding.
    const trace = cloneTrace(traces.get(session) as DriverTrace)
    applyEvent(trace, event, fail)
    staged.set(event, { session, trace })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (!isDriverRecordEvent(event)) return
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact session/event callback arguments. */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching driver-record validation')
    }
    staged.delete(event)
    traces.set(session, candidate.trace)
  }, { global: true })
}, { inject: ['sessions'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

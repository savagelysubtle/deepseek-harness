/**
 * Browser-safe durable session events written by the Claude Code seat driver.
 * Every event is log-only (no surface), carries `version: 1`, and holds only
 * allowlisted numbers, enums, and redacted short strings: never tool-result
 * bodies, prompt text, file paths, response bodies, or tokens.
 *
 * @module @deepseek-ai/dsh-agent-claude-code/types
 */

/** Payload schema version stamped on every Claude Code driver event. */
export type ClaudeCodeEventVersion = 1

/** The driver discriminator recorded in `claude-code/session-bound`. */
export type ClaudeCodeDriverName = 'claude-code'

/** Token counters of one Claude turn or one model within it. */
export interface ClaudeCodeUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
}

/** Per-model usage inside one turn: the four counters plus cost and web searches. */
export interface ClaudeCodeModelUsage extends ClaudeCodeUsage {
  readonly estimatedCostUsd: number
  readonly webSearchRequests: number
}

/** Binds a dsh Session to its Claude SDK session before the first prompt is sent. */
export interface ClaudeCodeSessionBoundData {
  readonly version: ClaudeCodeEventVersion
  /** The dsh Session id. */
  readonly sessionId: string
  /** The Claude SDK session id (UUID) used for `resume`. */
  readonly sdkSessionId: string
  readonly model: string
  readonly driver: ClaudeCodeDriverName
  /** Epoch milliseconds. */
  readonly at: number
}

/** Usage and outcome of one completed Claude turn (the SDK `result` message). */
export interface ClaudeCodeTurnCompletedData {
  readonly version: ClaudeCodeEventVersion
  readonly turnIndex: number
  /** `'success'` or the SDK error subtype (for example `error_max_turns`). */
  readonly outcome: string
  readonly isError: boolean
  readonly model: string
  readonly numTurns: number
  readonly durationMs: number
  readonly durationApiMs: number
  readonly estimatedCostUsd: number
  readonly usage: ClaudeCodeUsage
  readonly modelUsage: { readonly [modelId: string]: ClaudeCodeModelUsage }
  readonly stopReason?: string
}

/** How new input reached a live or resumed Claude session. */
export type ClaudeCodeSteerKind = 'push' | 'interrupt-push' | 'resume'

/** Records one steering action taken on a seat. */
export interface ClaudeCodeSteerData {
  readonly version: ClaudeCodeEventVersion
  readonly kind: ClaudeCodeSteerKind
  /** Control-stripped, redacted, at most 200 characters. */
  readonly reason: string
  readonly at: number
}

/** What triggered a Claude-side context compaction. */
export type ClaudeCodeCompactTrigger = 'auto' | 'manual'

/** Records a Claude Code `compact_boundary`: the context-rot signal. */
export interface ClaudeCodeCompactData {
  readonly version: ClaudeCodeEventVersion
  readonly preTokens: number
  readonly trigger: ClaudeCodeCompactTrigger
  readonly at: number
}

/** Where a rate limit was observed. */
export type ClaudeCodeRateLimitSource = 'sdk' | 'http'

/** Records a rate-limit observation; never carries response bodies or headers beyond retry-after. */
export interface ClaudeCodeRateLimitedData {
  readonly version: ClaudeCodeEventVersion
  readonly source: ClaudeCodeRateLimitSource
  readonly retryAfterMs?: number
  readonly breakerTripped: boolean
  readonly at: number
}

/** Why the fleet limiter refused a turn. */
export type ClaudeCodeFleetRefusalReason =
  | 'concurrency'
  | 'turns-per-hour'
  | 'breaker'
  | 'founder-reserve'

/** Records one fleet-limit refusal. */
export interface ClaudeCodeFleetRefusedData {
  readonly version: ClaudeCodeEventVersion
  readonly reason: ClaudeCodeFleetRefusalReason
  readonly limit: number
  readonly observed: number
  readonly at: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Binds the dsh Session to its Claude SDK session; written before the first prompt.
     * @param data - dsh session id, SDK session id, model, driver name, and time.
     */
    'claude-code/session-bound': ClaudeCodeSessionBoundData
    /**
     * Records one completed Claude turn with its usage and estimated cost.
     * @param data - turn index, outcome, durations, token usage, and per-model usage.
     */
    'claude-code/turn-completed': ClaudeCodeTurnCompletedData
    /**
     * Records one steering action (push, interrupt-then-push, or resume).
     * @param data - steering kind, short redacted reason, and time.
     */
    'claude-code/steer': ClaudeCodeSteerData
    /**
     * Records one Claude Code context compaction boundary.
     * @param data - pre-compaction token count, trigger, and time.
     */
    'claude-code/compact': ClaudeCodeCompactData
    /**
     * Records a rate-limit observation and whether the fleet breaker tripped.
     * @param data - source, optional retry-after, breaker state, and time.
     */
    'claude-code/rate-limited': ClaudeCodeRateLimitedData
    /**
     * Records a fleet-limit refusal.
     * @param data - refusal reason, configured limit, observed value, and time.
     */
    'claude-code/fleet-refused': ClaudeCodeFleetRefusedData
  }
}

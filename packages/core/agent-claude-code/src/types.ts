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
  /** True when the turn ran in a throwaway, tool-less Claude session (tainted mail), not the seat's own session. */
  readonly throwaway?: true
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
  /** Context size after compaction, when the SDK reported it. */
  readonly postTokens?: number
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

/** Why the Claude transcript could not be resumed. */
export type ClaudeCodeResumeFailedReason = 'transcript-missing' | 'transcript-unreadable'

/** Records a refused resume: the seat needs a deliberate re-seed, never a silent fresh start. */
export interface ClaudeCodeResumeFailedData {
  readonly version: ClaudeCodeEventVersion
  /** The Claude SDK session id that could not be resumed. */
  readonly sdkSessionId: string
  readonly reason: ClaudeCodeResumeFailedReason
  readonly at: number
}

/** Why a seat stopped taking turns until a later time. */
export type ClaudeCodePauseReason = 'rate-limit' | 'usage-exhausted'

/** Records that the Claude subscription window refused work: the per-seat pause signal. */
export interface ClaudeCodePausedData {
  readonly version: ClaudeCodeEventVersion
  readonly reason: ClaudeCodePauseReason
  /** Epoch milliseconds when the window is expected to reopen, when the SDK reported it. */
  readonly until?: number
  readonly at: number
}

/** One tool call observed in the stream: name, outcome, duration, and an argument digest; never bodies. */
export interface ClaudeCodeToolCallData {
  readonly version: ClaudeCodeEventVersion
  /** Tool name (label-sanitized). */
  readonly name: string
  /** Whether the tool result was not an error. */
  readonly ok: boolean
  /** Milliseconds from the tool_use block to its tool_result. */
  readonly ms: number
  /** Argument size (`len:<n>`) or a keyed HMAC prefix (`hmac:<hex>`), never a plain hash. */
  readonly argDigest: string
  readonly at: number
}

/** One thinking block observed in the stream: its length only, never its text. */
export interface ClaudeCodeThinkingData {
  readonly version: ClaudeCodeEventVersion
  readonly length: number
  readonly at: number
}

/** A stream message the mapper does not understand, recorded by type name only. */
export interface ClaudeCodeUnmappedData {
  readonly version: ClaudeCodeEventVersion
  /** SDK message `type` (or `type/subtype`), label-sanitized. */
  readonly type: string
  readonly at: number
}

/** A mailbox message claimed for a turn; written and flushed before the prompt is sent. */
export interface ClaudeCodeMailClaimedData {
  readonly version: ClaudeCodeEventVersion
  /** Mailbox message id (the idempotency key). */
  readonly messageId: string
  /** Whether the mail ran in a throwaway tool-less session because it was externally tainted. */
  readonly tainted: boolean
  readonly at: number
}

/** A turn that runs in a throwaway, tool-less Claude session (tainted mail); everything logged for that turn is untrusted. */
export interface ClaudeCodeThrowawayTurnData {
  readonly version: ClaudeCodeEventVersion
  /** The dsh turn number whose user and assistant messages must never feed a trusted re-seed digest. */
  readonly turnIndex: number
  readonly at: number
}

/** How a claimed mailbox message ended. */
export type ClaudeCodeMailOutcome = 'settled' | 'failed' | 'paused'

/** The deterministic end of a claimed mailbox message. */
export interface ClaudeCodeMailOutcomeData {
  readonly version: ClaudeCodeEventVersion
  readonly messageId: string
  readonly outcome: ClaudeCodeMailOutcome
  /** Control-stripped, redacted, at most 200 characters. */
  readonly reason: string
  readonly at: number
}

/** Why the driver refused to run a turn or accept a message (the budget cap is the SDK's own max-budget result, not a refusal). */
export type ClaudeCodeRefusalReason =
  | 'admission'
  | 'kill-switch'
  | 'call-window'
  | 'duplicate-in-flight'

/** A loud refusal record: the mail was not run, and a lease failure carries the same reason. */
export interface ClaudeCodeRefusedData {
  readonly version: ClaudeCodeEventVersion
  readonly reason: ClaudeCodeRefusalReason
  /** The mailbox message id, when the refused input was mail. */
  readonly messageId?: string
  /** Control-stripped, redacted, at most 200 characters. */
  readonly detail: string
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
    /**
     * Records a refused resume (missing or unreadable Claude transcript).
     * @param data - SDK session id, reason, and time.
     */
    'claude-code/resume-failed': ClaudeCodeResumeFailedData
    /**
     * Records the per-seat pause after a rate-limit or usage-exhausted signal.
     * @param data - pause reason, optional reopen time, and time.
     */
    'claude-code/paused': ClaudeCodePausedData
    /**
     * Records one tool call (name, success, duration, argument digest; no bodies).
     * @param data - tool name, ok flag, milliseconds, digest, and time.
     */
    'claude-code/tool-call': ClaudeCodeToolCallData
    /**
     * Records one thinking block by length only.
     * @param data - thinking length and time.
     */
    'claude-code/thinking': ClaudeCodeThinkingData
    /**
     * Records a stream message the mapper does not understand.
     * @param data - SDK message type name and time.
     */
    'claude-code/unmapped': ClaudeCodeUnmappedData
    /**
     * Records that a mailbox message was claimed; flushed before the prompt is sent.
     * @param data - message id, taint flag, and time.
     */
    'claude-code/mail-claimed': ClaudeCodeMailClaimedData
    /**
     * Records the deterministic outcome of a claimed mailbox message.
     * @param data - message id, outcome, short reason, and time.
     */
    'claude-code/mail-outcome': ClaudeCodeMailOutcomeData
    /**
     * Records a loud refusal (admission, kill switch, call window, duplicate).
     * @param data - reason, optional message id, short detail, and time.
     */
    'claude-code/refused': ClaudeCodeRefusedData
    /**
     * Marks a turn as a throwaway (tainted-mail) turn, before any of its messages are logged.
     * @param data - the dsh turn number and time.
     */
    'claude-code/throwaway-turn': ClaudeCodeThrowawayTurnData
  }
}

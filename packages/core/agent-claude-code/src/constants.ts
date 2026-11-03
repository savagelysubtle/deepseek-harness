/** Event names and limits shared by the driver recorder and invariant. @module @deepseek-ai/dsh-agent-claude-code/constants */

import type {
  ClaudeCodeCompactTrigger, ClaudeCodeEventVersion, ClaudeCodeFleetRefusalReason,
  ClaudeCodeRateLimitSource, ClaudeCodeSteerKind,
} from './types.ts'

/** Payload schema version stamped on every driver event. */
export const CLAUDE_CODE_EVENT_VERSION: ClaudeCodeEventVersion = 1

/** Session event-type prefix owned by this package. */
export const CLAUDE_CODE_EVENT_PREFIX = 'claude-code/'

/** Every durable session event type this package writes. */
export const CLAUDE_CODE_EVENT_TYPES = [
  'claude-code/session-bound',
  'claude-code/turn-completed',
  'claude-code/steer',
  'claude-code/compact',
  'claude-code/rate-limited',
  'claude-code/fleet-refused',
] as const

/** One of {@link CLAUDE_CODE_EVENT_TYPES}. */
export type ClaudeCodeEventType = typeof CLAUDE_CODE_EVENT_TYPES[number]

/** The only driver name recorded in `claude-code/session-bound`. */
export const CLAUDE_CODE_DRIVER_NAME = 'claude-code'

/** Allowed `claude-code/steer` kinds. */
export const CLAUDE_CODE_STEER_KINDS: readonly ClaudeCodeSteerKind[] = ['push', 'interrupt-push', 'resume']

/** Allowed `claude-code/compact` triggers. */
export const CLAUDE_CODE_COMPACT_TRIGGERS: readonly ClaudeCodeCompactTrigger[] = ['auto', 'manual']

/** Allowed `claude-code/rate-limited` sources. */
export const CLAUDE_CODE_RATE_LIMIT_SOURCES: readonly ClaudeCodeRateLimitSource[] = ['sdk', 'http']

/** Allowed `claude-code/fleet-refused` reasons. */
export const CLAUDE_CODE_FLEET_REFUSAL_REASONS: readonly ClaudeCodeFleetRefusalReason[] = [
  'concurrency', 'turns-per-hour', 'breaker', 'founder-reserve',
]

/** Maximum length of any recorded string (identifiers, models, outcomes). */
export const CLAUDE_CODE_MAX_TEXT_CHARS = 500

/** Maximum length of the `claude-code/steer` reason. */
export const CLAUDE_CODE_MAX_REASON_CHARS = 200

/** Maximum number of per-model entries kept in `modelUsage`. */
export const CLAUDE_CODE_MAX_MODEL_USAGE_ENTRIES = 16

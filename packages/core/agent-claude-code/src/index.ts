/**
 * The Claude Code seat driver package. This slice ships the durable event
 * vocabulary (`./types`), the never-throwing redacting recorder, the redaction
 * helpers, and the invariant companion (`./invariant`). The SDK-backed `Agent`
 * implementation registers against the keyed agent-factory seam in a later
 * slice; until then `apply` installs nothing, so loading the plugin is inert.
 * @module @deepseek-ai/dsh-agent-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from './types.ts'

/** Cordis plugin name. */
export const name = 'agent-claude-code'

export {
  CLAUDE_CODE_COMPACT_TRIGGERS, CLAUDE_CODE_DRIVER_NAME, CLAUDE_CODE_EVENT_PREFIX,
  CLAUDE_CODE_EVENT_TYPES, CLAUDE_CODE_EVENT_VERSION, CLAUDE_CODE_FLEET_REFUSAL_REASONS,
  CLAUDE_CODE_MAX_MODEL_USAGE_ENTRIES, CLAUDE_CODE_MAX_REASON_CHARS, CLAUDE_CODE_MAX_TEXT_CHARS,
  CLAUDE_CODE_RATE_LIMIT_SOURCES, CLAUDE_CODE_STEER_KINDS,
} from './constants.ts'
export type { ClaudeCodeEventType } from './constants.ts'
export { recordClaudeCodeEvent } from './record.ts'
export type {
  ClaudeCodeEventInputMap, ClaudeCodeMaybeNumber, ClaudeCodeModelUsageInput,
  ClaudeCodeRecordWarn, ClaudeCodeTurnCompletedInput, ClaudeCodeUsageInput,
} from './record.ts'
export {
  REDACTED_PATH, REDACTED_TOKEN, redactLongRuns, redactPaths, redactTokens, sanitizeFreeText, sanitizeLabel, stripControl,
} from './sanitize.ts'
export type * from './types.ts'

/**
 * Plugin entry. Inert in this slice; the driver registers its keyed agent
 * factory here once the SDK runtime lands.
 * @param _ctx - the Cordis context the plugin is loaded into.
 */
export function apply(_ctx: Context): void {}

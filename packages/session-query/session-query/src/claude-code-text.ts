/**
 * Searchable text for the Claude Code seat driver's `claude-code/*` events.
 * The owning package (`@deepseek-ai/dsh-agent-claude-code`) is outside
 * session-query's dependency graph, so the payloads are read through these
 * locally mirrored loose shapes, the same way `mailbox/await` is.
 */

interface ClaudeCodeSessionBoundData {
  model?: string
  sdkSessionId?: string
}

interface ClaudeCodeTurnCompletedData {
  outcome?: string
  model?: string
  estimatedCostUsd?: number
}

interface ClaudeCodeRateLimitedData {
  source?: string
  retryAfterMs?: number
  breakerTripped?: boolean
}

interface ClaudeCodeFleetRefusedData {
  reason?: string
  limit?: number
  observed?: number
}

interface ClaudeCodeResumeFailedData {
  reason?: string
  sdkSessionId?: string
}

interface ClaudeCodePausedData {
  reason?: string
  until?: number
}

/** Render `label=value` when the value is present, else nothing. */
function field(label: string, value: string | number | boolean | undefined): string[] {
  return value === undefined ? [] : [`${label}=${String(value)}`]
}

/**
 * Searchable text for one `claude-code/*` event, or `undefined` when the type
 * is not one this module owns. `steer` and `compact` stay non-searchable
 * (structural counters, no semantic text).
 * @param type - the session event type.
 * @param data - the event payload, read through loose mirrored shapes.
 * @returns newline-joined text, the empty string for a structural claude-code event, or `undefined`.
 */
export function claudeCodeEventText(type: string, data: unknown): string | undefined {
  switch (type) {
    case 'claude-code/session-bound': {
      const d = data as ClaudeCodeSessionBoundData
      return ['claude-code session-bound', ...field('model', d.model), ...field('sdkSessionId', d.sdkSessionId)].join('\n')
    }
    case 'claude-code/turn-completed': {
      const d = data as ClaudeCodeTurnCompletedData
      return [
        'claude-code turn-completed',
        ...d.outcome === undefined ? [] : [d.outcome],
        ...field('model', d.model),
        ...field('estimatedCostUsd', d.estimatedCostUsd),
      ].join('\n')
    }
    case 'claude-code/rate-limited': {
      const d = data as ClaudeCodeRateLimitedData
      return [
        'claude-code rate-limited',
        ...field('source', d.source),
        ...field('retryAfterMs', d.retryAfterMs),
        ...field('breakerTripped', d.breakerTripped),
      ].join('\n')
    }
    case 'claude-code/fleet-refused': {
      const d = data as ClaudeCodeFleetRefusedData
      return [
        'claude-code fleet-refused',
        ...field('reason', d.reason),
        ...field('limit', d.limit),
        ...field('observed', d.observed),
      ].join('\n')
    }
    case 'claude-code/resume-failed': {
      const d = data as ClaudeCodeResumeFailedData
      return ['claude-code resume-failed', ...field('reason', d.reason), ...field('sdkSessionId', d.sdkSessionId)].join('\n')
    }
    case 'claude-code/paused': {
      const d = data as ClaudeCodePausedData
      return ['claude-code paused', ...field('reason', d.reason), ...field('until', d.until)].join('\n')
    }
    case 'claude-code/steer':
    case 'claude-code/compact':
      return ''
    default:
      return undefined
  }
}

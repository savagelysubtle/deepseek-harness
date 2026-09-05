/**
 * Turns a loop-guard detection into a loud, structured turn abort.
 * `loop-guard.ts` stays pure detection — "callers feed it text/signatures
 * and act on `true`" — this module is the acting side the agent loop calls
 * into: a stable error code the existing `turn/end` error path already
 * surfaces, a bounded quoted fragment a human can actually read, and
 * resolved, deployment-overridable thresholds with the detectors' own
 * defaults.
 * @module dsh-agent-loop/loop-abort
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LoopAbortChannel } from '@deepseek-ai/dsh-agent'
import {
  DEFAULT_DRIFT_THRESHOLD,
  DEFAULT_SHINGLE_SIZE,
  DEFAULT_TOOL_REPEAT_THRESHOLD,
  DEFAULT_WINDOW_SIZE,
} from './loop-guard.ts'

/** Stable machine-routable code for a loop-guard-triggered abort; route on this, never on message text. */
export const LOOP_ABORTED_CODE = 'LOOP_ABORTED'

/**
 * Characters of the offending fragment kept for the abort event and error
 * message: enough for a human to recognize the repeating pattern, far short
 * of the ~100KB real incident this guard was built to catch.
 */
const FRAGMENT_MAX_CHARS = 500

/**
 * Bound a reported fragment so a degenerate stream cannot balloon the
 * event/log payload. Keeps the tail — the most recent text is the most
 * representative of what just tripped the detector.
 */
export function boundFragment(text: string, max: number = FRAGMENT_MAX_CHARS): string {
  return text.length <= max ? text : `…${text.slice(-max)}`
}

/**
 * Keeps the trailing `max` characters of a live text stream, so the
 * reasoning-channel guard can quote back what tripped it without retaining
 * the whole stream (which is exactly the ~100KB-per-turn shape the real
 * incident produced).
 */
export class FragmentTail {
  private buf = ''

  constructor(private readonly max: number = FRAGMENT_MAX_CHARS) {}

  /** Append the next chunk of text, keeping only the trailing `max` characters. */
  push(text: string): void {
    this.buf = (this.buf + text).slice(-this.max)
  }

  /** The trailing text accumulated so far. */
  snapshot(): string {
    return this.buf
  }
}

/**
 * Thrown when a loop-guard detector trips. Extends {@link LlmError} so it
 * flows through the agent loop's existing terminal-failure path (`turn/end`
 * with `{ kind: 'error', error: failure }`) carrying a stable, named code
 * instead of flattening to `UNKNOWN`. The loop also emits the dedicated
 * `agent/loop-aborted` notification at the detection site with the same
 * channel/fragment, for a listener that would rather not parse the error.
 */
export class LoopAbortedError extends LlmError {
  /** Which stream tripped the guard. */
  readonly channel: LoopAbortChannel
  /** The repeated text or tool call quoted back for a human to inspect; length-bounded. */
  readonly fragment: string

  constructor(channel: LoopAbortChannel, reason: string, fragment: string) {
    super(`agent loop aborted (${channel}): ${reason}`, LOOP_ABORTED_CODE)
    this.name = 'LoopAbortedError'
    this.channel = channel
    this.fragment = fragment
  }
}

/** Loop-guard thresholds a deployment may override; unset fields take the detector's own defaults. */
export interface LoopGuardConfig {
  /** Words per reasoning/output shingle. */
  reasoningShingleSize?: number
  /** Trailing shingles the drift guard keeps live counts for. */
  reasoningWindowSize?: number
  /** In-window shingle recurrences that trip the reasoning/output drift guard. */
  reasoningDriftThreshold?: number
  /** Consecutive identical tool-call signatures that trip the tool-repeat guard. */
  toolRepeatThreshold?: number
}

/** Resolved loop-guard thresholds after defaults; every field always present. */
export interface ResolvedLoopGuardConfig extends Required<LoopGuardConfig> {}

/** Reject a non-positive-integer override before it reaches a detector constructor. */
function positiveInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) throw new Error(`loopGuard.${field} must be a positive integer`)
  return value
}

/**
 * Fill in unset loop-guard thresholds with the detectors' own defaults,
 * validating any override.
 * @param config - deployment-supplied overrides, or `undefined` for all defaults.
 */
export function resolveLoopGuardConfig(config: LoopGuardConfig | undefined): ResolvedLoopGuardConfig {
  return {
    reasoningShingleSize: positiveInt(config?.reasoningShingleSize, DEFAULT_SHINGLE_SIZE, 'reasoningShingleSize'),
    reasoningWindowSize: positiveInt(config?.reasoningWindowSize, DEFAULT_WINDOW_SIZE, 'reasoningWindowSize'),
    reasoningDriftThreshold: positiveInt(config?.reasoningDriftThreshold, DEFAULT_DRIFT_THRESHOLD, 'reasoningDriftThreshold'),
    toolRepeatThreshold: positiveInt(config?.toolRepeatThreshold, DEFAULT_TOOL_REPEAT_THRESHOLD, 'toolRepeatThreshold'),
  }
}

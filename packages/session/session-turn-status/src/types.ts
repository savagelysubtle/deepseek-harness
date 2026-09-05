/**
 * Pure types of the session-turn-status domain: the ONE home of the
 * `turnStatus` projection-key declaration, free of this package's host-side
 * value imports (cordis context, zod). Two namespace projections serve it —
 * `./types` for host consumers, `./client` for client aggregates — with zero
 * content duplication.
 *
 * SWD-120: a deliberate stop and a crash are recorded differently in the
 * durable log (`turn/end` with `reason.kind === 'aborted'` vs a crash-repair
 * synthesized `reason.kind === 'interrupted'`), but neither fact reached any
 * consumer that could act on it — a session-list row, a watchdog polling the
 * host — without replaying the whole log. This projection folds the one bit
 * and the one cause every such consumer actually needs.
 *
 * @module @deepseek-ai/dsh-session-turn-status/types
 */

// Marks this file a module so the declaration below AUGMENTS the projection
// table instead of declaring an ambient module.
export {}

/**
 * Sub-cause of a programmatic (non-user) cancellation, mirroring
 * `TurnEndCancelCause`'s non-`'user'` arms one-to-one so a watchdog can tell
 * "the founder pressed stop" apart from "a parent session, a hook, or
 * disposal cancelled this" without importing the host-only session package.
 */
export type SessionTurnStopCause =
  /** The user pressed stop. */
  | { readonly kind: 'user' }
  /** A parent session cancelled this subagent. */
  | { readonly kind: 'parent' }
  /** A hook requested cancellation, with its own reason text. */
  | { readonly kind: 'hook'; readonly reason: string }
  /** The owning Agent was disposed while the turn was live. */
  | { readonly kind: 'disposed' }
  /** Imported from a coarse historical record that carried no cause. */
  | { readonly kind: 'legacy' }

/**
 * Why the session's most recently CLOSED turn ended. A lossy, wire-stable
 * re-encoding of the durable `TurnEndReason`: known arms carry the same facts
 * (renamed `error.error` to flat `code`/`message` for a small wire payload);
 * an arm this unit does not yet recognize — `TurnEndReasonMap` is
 * merge-extensible, so a future plugin may add one — degrades to `'other'`
 * rather than throwing, the same fail-soft rule `dsh-session-query` already
 * applies to unknown turn-end reasons.
 */
export type SessionTurnEndCause =
  /** The turn ran to completion. */
  | { readonly kind: 'completed' }
  /** The turn was cancelled — by the user or programmatically; see `cause`. */
  | { readonly kind: 'aborted'; readonly cause: SessionTurnStopCause }
  /** The turn closed with no entered step (rejection or empty input). */
  | { readonly kind: 'blocked' }
  /** A step reached its output-token ceiling. */
  | { readonly kind: 'max-tokens' }
  /** The turn failed with a structured LLM failure. */
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  /**
   * A persistence backend closed a crash-orphaned turn on reload
   * (`interruptedTurnClosers` in dsh-session). The events recorded before the
   * crash remain intact; only the boundary is synthetic.
   */
  | { readonly kind: 'interrupted' }
  /** A `TurnEndReasonMap` arm this unit does not yet recognize. */
  | { readonly kind: 'other' }

/**
 * Whole-log fold of the session's turn boundary: whether the latest turn is
 * still open, and — only once it is not — how the last one that closed ended.
 *
 * `open: true` covers BOTH an actively executing turn and the SWD-120 gotcha
 * case: a process that crashed mid-turn leaves a durable `turn/start` with no
 * matching `turn/end` until the session is next loaded (crash repair runs at
 * load time, not at crash time). This unit folds exactly what the log
 * contains, so a crashed-but-not-yet-reloaded session reports `open: true`
 * here — never `aborted` or any other settled cause — while the session-list
 * row's own `running` bit (agent attachment) is independently `false`. That
 * combination — `open: true` with the row not running — IS the crash signal:
 * still open, but nothing is attached to keep it open. A caller must read
 * both fields; neither alone tells the whole story.
 */
export interface SessionTurnStatusProjection {
  /** Whether the latest turn has no matching `turn/end` yet. */
  open: boolean
  /**
   * How the most recently closed turn ended. `null` before the session's
   * first closed turn, and — deliberately — while `open` is `true`: a prior
   * turn's cause must never be read as describing a turn that has not
   * finished yet.
   */
  cause: SessionTurnEndCause | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-log turn-open bit and last end cause; see {@link SessionTurnStatusProjection}. */
    turnStatus: SessionTurnStatusProjection
  }
}

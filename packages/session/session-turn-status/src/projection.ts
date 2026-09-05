/**
 * The `turnStatus` projection unit: a pure fold of `turn/start`/`turn/end`
 * boundaries into whether the latest turn is still open and, once it is not,
 * the cause that closed the last one. See `types.ts` for why `open` is the
 * load-bearing bit for the SWD-120 crash-vs-stop distinction.
 *
 * @module @deepseek-ai/dsh-session-turn-status/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnEndCancelCause, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { SessionTurnEndCause, SessionTurnStatusProjection, SessionTurnStopCause } from './types.ts'

const stopCauseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('parent') }).strict(),
  z.object({ kind: z.literal('hook'), reason: z.string() }).strict(),
  z.object({ kind: z.literal('disposed') }).strict(),
  z.object({ kind: z.literal('legacy') }).strict(),
])

const causeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('aborted'), cause: stopCauseSchema }).strict(),
  z.object({ kind: z.literal('blocked') }).strict(),
  z.object({ kind: z.literal('max-tokens') }).strict(),
  z.object({ kind: z.literal('error'), code: z.string(), message: z.string() }).strict(),
  z.object({ kind: z.literal('interrupted') }).strict(),
  z.object({ kind: z.literal('other') }).strict(),
])

const turnStatusSchema = z.object({
  open: z.boolean(),
  cause: causeSchema.nullable(),
}).strict()

/** Fold state — identical in shape to the served view (nothing else to derive). */
interface SessionTurnStatusState {
  open: boolean
  cause: SessionTurnEndCause | null
}

/**
 * Re-encode one durable cancellation sub-cause onto the wire type.
 * @param reason - the durable `TurnEndCancelCause`.
 * @returns the equivalent wire {@link SessionTurnStopCause}.
 */
function stopCauseFrom(reason: TurnEndCancelCause): SessionTurnStopCause {
  switch (reason.kind) {
    case 'user': return { kind: 'user' }
    case 'parent': return { kind: 'parent' }
    case 'hook': return { kind: 'hook', reason: reason.reason }
    case 'disposed': return { kind: 'disposed' }
    case 'legacy': return { kind: 'legacy' }
    // Not documented as merge-extensible today, but a closed switch over a
    // durable wire value is one crash away from a future arm; degrade rather
    // than throw, same as the outer TurnEndReason fold below.
    default: return { kind: 'legacy' }
  }
}

/**
 * Re-encode one durable `turn/end` reason onto the wire cause type.
 * @param reason - the durable `TurnEndReason` from the closing event.
 * @returns the equivalent wire {@link SessionTurnEndCause}; `'other'` for an
 *   arm this unit does not yet recognize (`TurnEndReasonMap` is
 *   merge-extensible).
 */
function causeFrom(reason: TurnEndReason): SessionTurnEndCause {
  switch (reason.kind) {
    case 'completed': return { kind: 'completed' }
    case 'aborted': return { kind: 'aborted', cause: stopCauseFrom(reason.reason) }
    case 'blocked': return { kind: 'blocked' }
    case 'max-tokens': return { kind: 'max-tokens' }
    case 'error': return { kind: 'error', code: reason.error.code, message: reason.error.message }
    case 'interrupted': return { kind: 'interrupted' }
    // TurnEndReasonMap is merge-extensible. Unknown outcomes degrade to
    // 'other' until this unit is taught their semantics (dsh-session-query
    // applies the same default-arm rule to unknown turn-end reasons).
    default: return { kind: 'other' }
  }
}

/** The `turnStatus` unit registered on `ctx.sessionProjections` (exported for the unit spec). */
export const sessionTurnStatusProjectionDefinition: ProjectionDefinition<'turnStatus', SessionTurnStatusState> = {
  key: 'turnStatus',
  schema: turnStatusSchema,
  init: () => ({ open: false, cause: null }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return state.open ? state : { ...state, open: true }
      case 'turn/end':
        return { open: false, cause: causeFrom(event.data.reason) }
      default:
        return state
    }
  },
  view: (state): SessionTurnStatusProjection => ({
    open: state.open,
    // A prior turn's cause never describes a turn still open — a fresh
    // `turn/start` must not read as an echo of what closed the one before it.
    cause: state.open ? null : state.cause,
  }),
  stateVersion: 1,
}

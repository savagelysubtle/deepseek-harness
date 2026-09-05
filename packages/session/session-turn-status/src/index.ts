/**
 * Function plugin registering the `turnStatus` projection unit: whether a
 * session's latest turn is still open and, once it is not, why the last one
 * closed — served through the session-projection seam (registry snapshot,
 * change feed, and every projection carrier: history tail page,
 * `session/projection` push frames, session-list rows) so clients and a
 * future watchdog can read the SWD-120 stop-vs-crash distinction without
 * replaying the log. The plugin owns only the fold; delivery is the seam's.
 *
 * @module @deepseek-ai/dsh-session-turn-status
 */

import type { Context } from '@deepseek-ai/cordis'
import { sessionTurnStatusProjectionDefinition } from './projection.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-turn-status'
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * Register the `turnStatus` unit; the registration is an effect on this
 * plugin's fiber, so unloading removes the key.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(sessionTurnStatusProjectionDefinition)
}

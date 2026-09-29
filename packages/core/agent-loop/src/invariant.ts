/**
 * Package-owned request-reconstruction invariant for loop-built LLM calls.
 * @module @deepseek-ai/dsh-agent-loop/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { foldRequestHeader, scrubNowLine } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-loop'

/**
 * `system` equality tolerant of the `harness:now` (SWD-113) clock line alone
 * — the same exemption `headerEquals` applies when deciding whether to log a
 * NEW `request/header` snapshot. A dispatched request always carries the
 * step's freshly-assembled system text (current clock); the folded header is
 * only as fresh as its last LOGGED snapshot. Once `headerEquals` stops
 * logging a snapshot for a clock-only difference, those two texts
 * legitimately diverge in that one line on every step the clock has ticked
 * since — this reconstructability check must ignore the same line or every
 * multi-step turn would fail it as soon as a minute rolled over.
 */
function systemReconstructs(dispatched: string | undefined, folded: string | undefined): boolean {
  if (dispatched === folded) return true
  if (dispatched === undefined || folded === undefined) return false
  return scrubNowLine(dispatched) === scrubNowLine(folded)
}

/** Cordis companion plugin name. */
export const name = 'agent-loop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install the request-reconstruction contribution into its child registration fiber. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  // Prepend prevents a short-circuiting replay listener from silencing the check.
  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    if (!isAgentLoopRequest(options)) return next()
    if (!Object.isFrozen(options)) fail('a loop-built request must be frozen')
    if (options.sessionId === undefined) fail('a loop-built request must carry a session id')
    const session = ctx.sessions.get(options.sessionId)
    if (!session) fail(`a loop-built request must carry a live session id, got "${String(options.sessionId)}"`)
    if (!Object.isFrozen(options.messages)) {
      fail('a loop-built request must carry a frozen messages array')
    }

    const events = session.events
    if (!events.some(event => event.type === 'step/start')) {
      return fail('a loop-built request with no step/start in its session log')
    }
    const header = foldRequestHeader(events)
    if (header === undefined) {
      return fail('a loop-built request with no request/header event in its session log')
    }
    const expected = session.deriveMessages()
    if (JSON.stringify(options.messages) !== JSON.stringify(expected)) {
      fail(`llm request for session "${String(session.id)}" diverges from the dispatch-time durable derivation (log-reconstruction desync)`)
    }

    const headerMatches = options.model === header.config.model
      && systemReconstructs(options.system, header.system)
      && options.temperature === header.config.temperature
      && options.maxTokens === header.config.maxTokens
      && JSON.stringify(options.stop) === JSON.stringify(header.config.stop)
      && JSON.stringify(options.tools ?? []) === JSON.stringify(header.tools ?? [])
    if (!headerMatches) {
      fail(`llm request for session "${String(session.id)}" diverges from the folded request header`)
    }
    return next()
  }, { global: true, prepend: true })
}, { inject: ['sessions'] })

/**
 * Register the agent-loop invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

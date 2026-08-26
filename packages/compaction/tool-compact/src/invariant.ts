/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-compact`: a
 * successful scheduled result must correspond to live process state — armed in
 * the pending set at claim time, and resolved by a `compaction/start` bracket,
 * a busy re-arm, an explicit settlement, or agent disposal rather than silently
 * dropped while the process lives.
 * @module @deepseek-ai/dsh-tool-compact/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { isArmed, settlementOf } from './pending.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-compact'

/** Cordis companion plugin name. */
export const name = 'tool-compact-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Shape of the tool's canonical value relevant to the scheduling relation. */
interface ScheduledValue {
  scheduled?: unknown
}

const install: InvariantInstaller = (ctx, fail) => {
  /** Sessions whose accepted schedule has not visibly resolved yet. */
  const open = new WeakSet<Session>()

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'compact' || exec.agent === undefined || result.isError) return
    if (!isArmed(exec.agent)) {
      fail(`compact result for agent ${exec.agent.id} claims a schedule while the pending set holds none`)
    }
    const value = result.value as ScheduledValue | undefined
    if (value?.scheduled === true) open.add(exec.agent.session)
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/start') open.delete(session)
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    open.delete(agent.session)
  }, { global: true })
  ctx.on('agent/status', ({ agent, status }) => {
    // A turn starting proves an idle boundary passed: the obligation must have
    // run to its bracket, still be re-armed for a future boundary, or carry an
    // explicit terminal settlement.
    if (status !== 'running' || !open.has(agent.session)) return
    if (isArmed(agent)) return
    if (settlementOf(agent) !== undefined) {
      open.delete(agent.session)
      return
    }
    fail(`scheduled compaction for agent ${agent.id} was dropped across an idle boundary `
      + 'without a bracket, re-arm, or settlement')
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

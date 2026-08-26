/**
 * Model-callable `compact` tool that defers real compaction to the next agent
 * idle boundary. Scheduling arms process-local state and returns immediately;
 * an `agent/status` idle listener hands the schedule to the engine's
 * `compactNow(agent, signal)`, which synchronously claims the idle
 * phase itself — the durable work happens entirely inside the engine's existing
 * idle claim and `compaction/start` lock, so this package adds no second queue
 * and no extra mutex. A waking send that wins the boundary (`busy`) keeps its
 * FIFO right of way and the schedule re-arms for the next idle. The
 * [queued manual compaction Agent Note](../../../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.md)
 * owns those admission decisions.
 * @module @deepseek-ai/dsh-tool-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { arm, discard, rearm, settle, take } from './pending.ts'

export const name = 'tool-compact'
export const inject = ['tools', 'compaction']

const DESCRIPTION =
  'Schedule compaction of older conversation history. Takes no arguments. '
  + 'The request is accepted immediately; the actual condensation runs right after the current turn ends, '
  + 'replacing older history with one summary checkpoint while recent context stays verbatim. '
  + 'Call it once when accumulated history is no longer needed in full; '
  + 'calling it again while a schedule is already pending changes nothing.'

const SCHEDULED_TEXT = 'Compaction scheduled; it runs when this turn ends.'
const ALREADY_SCHEDULED_TEXT = 'Compaction was already scheduled; it runs when this turn ends.'

/**
 * Classify one rejected deferred attempt. An aborted scheduling signal records
 * cancellation ahead of any backend diagnosis, matching the human command's
 * outcome mapping. `busy` re-arms because a waking send won the idle claim;
 * every other outcome is terminal because the engine already recorded its
 * bracket in the log, so the failure is logged here without rethrowing.
 * @param ctx - context carrying the logger for the non-durable failure record.
 * @param agent - agent whose deferred attempt rejected.
 * @param signal - the original scheduling call's cancellation signal.
 * @param error - the rejection or synchronous-throw reason from `compactNow`.
 * @param owned - the fiber's disposal set; a `busy` re-arm re-adds the agent so disposal still discards it.
 */
function handleFailure(ctx: Context, agent: Agent, signal: AbortSignal, error: unknown, owned: Set<Agent>): void {
  if (signal.aborted) {
    settle(agent, 'cancelled')
    return
  }
  if (!(error instanceof ManualCompactionError)) {
    settle(agent, 'failed')
    ctx.logger.warn(`tool-compact: deferred compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  switch (error.code) {
    case 'busy':
      // A re-armed schedule stays owned by this fiber so the disposal sweep discards it.
      rearm(agent, signal)
      owned.add(agent)
      return
    case 'cancelled':
      settle(agent, 'cancelled')
      return
    case 'changed':
    case 'summary':
    case 'commit':
    case 'persistence':
      settle(agent, 'failed')
      break
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default:
      return assertNever(error.code)
  }
  ctx.logger.warn(`tool-compact: deferred compaction failed (${error.code}): ${error.message}`)
}

/**
 * Register the `compact` tool plus its idle-boundary runner. Both registrations
 * are fiber effects: disposal removes the tool schema and the status listener,
 * and drops any still-armed schedule so a remounted plugin starts clean.
 * @param ctx - context carrying the tool registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  // Strong set only for disposal bookkeeping of WeakSet members; it never
  // outlives this fiber and holds at most one entry per armed agent.
  const owned = new Set<Agent>()
  ctx.effect(() => () => {
    for (const agent of owned) discard(agent)
    owned.clear()
  }, 'tool-compact pending state')
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const signal = take(agent)
    if (signal === undefined) return
    owned.delete(agent)
    if (signal.aborted) {
      settle(agent, 'cancelled')
      return
    }
    // compactNow performs the one idle-phase claim itself; a claim it loses to
    // a waking send throws ManualCompactionError('busy') synchronously.
    let running: Promise<CompactionResult | null>
    try {
      running = ctx.compaction.compactNow(agent, signal)
    } catch (error: unknown) {
      handleFailure(ctx, agent, signal, error, owned)
      return
    }
    void running.then(
      (result) => { settle(agent, result === null ? 'nothing-to-compact' : 'started') },
      (error: unknown) => { handleFailure(ctx, agent, signal, error, owned) },
    )
  })
  ctx.tools.register(defineTool({
    name: 'compact',
    description: DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scheduled: {
            type: 'boolean',
            required: true,
            description: 'False when a schedule was already pending and this call changed nothing.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.scheduled ? SCHEDULED_TEXT : ALREADY_SCHEDULED_TEXT,
      }],
    },
    execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('compact requires an owning agent session')
      const newlyScheduled = arm(agent, exec.signal)
      if (newlyScheduled) owned.add(agent)
      return Promise.resolve({ scheduled: newlyScheduled })
    },
    presentCall: () => ({ card: 'generic', title: 'Schedule history compaction', kind: 'other' }),
  }))
}

/**
 * Process-local admission state for deferred compaction: the pending set the
 * `compact` tool arms and the idle runner consumes, plus the settlement journal
 * the package invariant reads. Deliberately not durable — a crash drops a
 * scheduled compaction, and the model naturally re-calls after observing no
 * checkpoint. The durable lock remains the engine's `compaction/start`; this
 * module adds no second queue.
 * @module @deepseek-ai/dsh-tool-compact/pending
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** How one consumed obligation left the pending set. */
export type CompactionSettlement =
  | 'started'
  | 'nothing-to-compact'
  | 'cancelled'
  | 'failed'

const armed = new WeakSet<Agent>()
const scheduleSignals = new WeakMap<Agent, AbortSignal>()
const settlements = new WeakMap<Agent, CompactionSettlement>()

/**
 * Whether the agent currently holds an armed, unconsumed schedule.
 * @param agent - agent whose admission state is read.
 * @returns true while a schedule waits for the next idle boundary.
 */
export function isArmed(agent: Agent): boolean {
  return armed.has(agent)
}

/**
 * Arm one schedule unless the agent already holds one.
 * @param agent - agent whose history the model asked to compact.
 * @param signal - scheduling call's cancellation signal, honored at the idle boundary.
 * @returns true when this call armed the agent; false when a schedule was already pending.
 */
export function arm(agent: Agent, signal: AbortSignal): boolean {
  if (armed.has(agent)) return false
  // A fresh obligation supersedes any settlement left by an earlier cycle, so
  // the invariant never reconciles a new drop against a stale outcome.
  settlements.delete(agent)
  armed.add(agent)
  scheduleSignals.set(agent, signal)
  return true
}

/**
 * Atomically consume the armed schedule at an idle boundary.
 * @param agent - agent that reached idle.
 * @returns the scheduling call's signal so the runner can honor cancellation, or undefined when nothing was armed.
 */
export function take(agent: Agent): AbortSignal | undefined {
  const signal = scheduleSignals.get(agent)
  if (!armed.delete(agent)) return undefined
  scheduleSignals.delete(agent)
  return signal
}

/**
 * Re-arm after losing the idle claim, preserving the original signal.
 * @param agent - agent whose waking send won the boundary.
 * @param signal - the original scheduling call's cancellation signal.
 */
export function rearm(agent: Agent, signal: AbortSignal): void {
  armed.add(agent)
  scheduleSignals.set(agent, signal)
}

/**
 * Drop armed state without a settlement; used when the owning fiber disposes,
 * so a remounted plugin starts with a clean admission set instead of deduping
 * against a schedule nothing will ever run.
 * @param agent - agent whose pending schedule is discarded.
 */
export function discard(agent: Agent): void {
  armed.delete(agent)
  scheduleSignals.delete(agent)
}

/**
 * Record how a consumed obligation ended, for the package invariant.
 * @param agent - agent whose obligation settled.
 * @param outcome - terminal classification of the attempt.
 */
export function settle(agent: Agent, outcome: CompactionSettlement): void {
  settlements.set(agent, outcome)
}

/**
 * Read the recorded settlement for one explicit terminal outcome.
 * @param agent - agent whose last settlement is read.
 * @returns the settlement classification, or undefined while unresolved.
 */
export function settlementOf(agent: Agent): CompactionSettlement | undefined {
  return settlements.get(agent)
}

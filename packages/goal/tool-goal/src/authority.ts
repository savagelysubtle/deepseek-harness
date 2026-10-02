/** Execution-time authority checks for the model-facing goal tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { HarnessError, isFounderMessage, selectFounderAuthorityMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

type TurnStartEvent = Extract<SessionEvent, { type: 'turn/start' }>

/** Current open turn plus the events accepted after its start boundary. */
export interface GoalToolExecution {
  readonly agent: Agent
  readonly start: TurnStartEvent
  readonly events: readonly SessionEvent[]
}

/** Hard authority granted to one state-changing call. */
export type GoalToolAuthority =
  | { readonly kind: 'direct-human' }
  | { readonly kind: 'goal-round'; readonly goal: GoalView }

/** Throw one structured tool-policy failure. */
function reject(message: string, code = 'GOAL_TOOL_AUTHORITY_REQUIRED'): never {
  throw new HarnessError(message, code)
}

/** Locate the open turn enclosing a model tool call. */
function openTurn(agent: Agent): { start: TurnStartEvent; events: readonly SessionEvent[] } {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') {
      reject('goal tools require an open model turn', 'GOAL_TOOL_DRIVER_REQUIRED')
    }
    if (boundary?.type === 'turn/start') {
      return { start: boundary, events: events.slice(index + 1) }
    }
  }
  return reject('goal tools require an open model turn', 'GOAL_TOOL_DRIVER_REQUIRED')
}

/**
 * Resolve and authenticate the calling agent and its driver boundary.
 * @param ctx - Context carrying the live agent registry.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns The authenticated agent and its current turn window.
 */
export function goalToolExecution(ctx: Context, exec: ToolRunContext): GoalToolExecution {
  const agent = exec.agent
  if (agent === undefined) {
    return reject('goal tools require a calling agent', 'GOAL_TOOL_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    return reject(
      'goal tools require the exact live calling agent inside its active driver',
      'GOAL_TOOL_DRIVER_REQUIRED',
    )
  }
  return { agent, ...openTurn(agent) }
}

/**
 * Whether host-attested human input appears in the current root-agent turn.
 * An omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human
 * producers must supply their own source rather than inheriting this authority.
 *
 * A bare `user` source is not enough: it is also what subagent task delivery
 * and the plan-mode re-steer inject, so `kind === 'user'` alone is not proof a
 * human typed it. The founder stamp (`MessageSourceMap.user.founder`) is
 * minted only by trusted harness code at a channel independently proven to be
 * the loopback interface, so only a stamped `user` source grants direct-human
 * authority here. Only the open turn's ONE authority-bearing message is
 * checked, never any earlier one: a later, unstamped steer (for example a
 * trusted-host but non-loopback caller) must not inherit authority from an
 * earlier stamped message in the same turn.
 *
 * That authority-bearing message is picked by `@deepseek-ai/dsh-llm`'s
 * shared `selectFounderAuthorityMessage`, over every `user/message` of the
 * open turn in order, regardless of `source.kind` — it skips only the
 * closed, mechanical-context allowlist (`isMechanicalContextSource`: the
 * runtime-context snapshot, the skill catalog, and agent-instructions
 * reconciliation), per a sentinel ruling (2026-10-02). In particular the
 * agent loop appends a `plugin`-sourced runtime-context snapshot immediately
 * after the human's own message within the same step
 * (`packages/core/agent-loop/src/agent.ts`), and that snapshot can never
 * carry `founder` (only `kind: 'user'` can), so letting it shadow the human
 * message would deny authority on every turn that happens to carry one.
 * Every OTHER non-`user` kind — mailbox relay, subagent settlement/report,
 * and so on — is NOT on that allowlist and therefore DOES count as the
 * latest message, correctly denying authority when outside-controlled
 * content lands after an earlier founder stamp in the same turn.
 */
function hasDirectHumanInput(ctx: Context, execution: GoalToolExecution): boolean {
  if (!ctx.agents.roots().includes(execution.agent)) return false
  const messages = execution.events
    .filter(event => event.type === 'user/message')
    .map(event => event.data)
  const authority = selectFounderAuthorityMessage(messages)
  return authority !== undefined && isFounderMessage(authority.source)
}

/** Whether this turn is the current goal's exact admitted round. */
function isMatchingGoalRound(execution: GoalToolExecution, goal: GoalView): boolean {
  return execution.events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'goal'
    && event.data.source.goalId === goal.id
    && event.data.source.revision === goal.revision
    && event.data.source.round === goal.roundsStarted)
}

/**
 * Require authority originating in a human message accepted by a runtime root.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - Authenticated current tool execution.
 */
export function requireDirectHuman(ctx: Context, execution: GoalToolExecution): void {
  if (hasDirectHumanInput(ctx, execution)) return
  reject('this goal operation requires a direct human turn on a top-level agent')
}

/**
 * Resolve completion authority from either direct human input or the exact goal round.
 * @param ctx - Context carrying live agents and goal state.
 * @param execution - Authenticated current tool execution.
 * @returns The direct-human or exact-goal-round authority grant.
 */
export function completionAuthority(ctx: Context, execution: GoalToolExecution): GoalToolAuthority {
  if (hasDirectHumanInput(ctx, execution)) return { kind: 'direct-human' }
  const goal = ctx.goals.get(execution.agent)
  if (goal !== undefined && isMatchingGoalRound(execution, goal)) {
    return { kind: 'goal-round', goal }
  }
  return reject('complete and blocked require a direct human turn or the current goal round')
}

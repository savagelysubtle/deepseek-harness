/**
 * SWD-120: a deliberate stop and a crash were durably recorded differently
 * (`turn/end` reason `aborted` vs the crash-repair-synthesized
 * `interrupted`) but the transcript rendered neither — every non-completion
 * fell through to the same generic "Stopped" tool-row label. This notice
 * gives the turn itself a persistent, turn-positioned banner that names which
 * of the three actually happened, mirroring turn-error.ts and
 * turn-max-tokens.ts for the other two turn/end outcomes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnStoppedNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Turn ended by a deliberate stop, a programmatic cancellation, or a crash-repair interruption. */
    'turn-stopped': TurnStoppedNode
  }
}

interface TurnStoppedState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly cause: TurnStoppedNode['cause']
}

function lastStep(context: ConversationNodeContext<TurnStoppedState>): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return 0
  return location.turn.steps.at(-1)?.step ?? 0
}

/**
 * Re-encode the durable `turn/end` reason onto the banner's three-way cause.
 * @param match - the matched `turn/end` event; only `aborted` and
 *   `interrupted` reasons ever reach this (see `match` below).
 * @returns the banner cause, or undefined for any other reason (never matched).
 */
function stateFrom(match: ConversationMatch): TurnStoppedState | undefined {
  if (match.event.type !== 'turn/end') return undefined
  const reason = match.event.data.reason
  const cause: TurnStoppedNode['cause'] | undefined = reason.kind === 'interrupted'
    ? 'crash'
    : reason.kind === 'aborted'
      ? (reason.reason.kind === 'user' ? 'user' : 'system')
      : undefined
  if (cause === undefined) return undefined
  return { turn: match.event.data.turn, seq: match.event.seq, time: match.event.time, cause }
}

/** Notice Definition for a turn ended by cancellation (user, programmatic, or crash-repair). */
export const turnStoppedDefinition: ConversationNodeDefinition<TurnStoppedState> = {
  kind: 'turn-stopped',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/end' && (event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted')) {
      return { id: String(event.data.turn), role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    const state = stateFrom(match)
    if (state === undefined) throw new Error('turn-stopped start requires an aborted or interrupted turn/end')
    return state
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const node: TurnStoppedNode = {
      kind: 'turn-stopped',
      seq: state.seq,
      time: state.time,
      turn: state.turn,
      step: lastStep(context),
      cause: state.cause,
    }
    return chatNode(context, 'turn-stopped', state.seq, node)
  },
}

/**
 * Register the stop/crash turn-end notice contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnStoppedConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(turnStoppedDefinition)
}

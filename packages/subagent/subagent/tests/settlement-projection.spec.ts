import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import { subagentSettlementProjectionDefinition } from '../src/projection.ts'

function event(type: SessionEvent['type'], seq: number, time: number, data: unknown = {}): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

function fold(events: SessionEvent[]) {
  let state = subagentSettlementProjectionDefinition.init()
  for (const item of events) state = subagentSettlementProjectionDefinition.apply(state, item)
  return subagentSettlementProjectionDefinition.view(state)
}

const SETTLEMENT_VERSION = 1

function settlementData(outcome: string, settledAt: number, parentSessionId = 'parent-1') {
  return { version: SETTLEMENT_VERSION, parentSessionId, outcome, settledAt }
}

describe('subagent settlement projection', () => {
  it('registers with the optional session projection registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const serviceFiber = await ctx.plugin(SubagentRuntime)

    const before = ctx.sessionProjections.snapshot(ctx.sessions.create()).values
    expect(before.subagentSettlement).toBeNull()
    await serviceFiber.dispose()
    const after = ctx.sessionProjections.snapshot(ctx.sessions.create()).values
    expect(after.subagentSettlement).toBeUndefined()
  })

  it('serves the null sentinel before any settlement event', () => {
    expect(fold([
      event('turn/start', 0, 1),
      event('turn/end', 1, 2),
    ])).toBeNull()
  })

  it('folds the one settlement event present', () => {
    expect(fold([
      event('turn/start', 0, 1),
      event('subagent/settlement', 1, 2, settlementData('completed', 100)),
    ])).toEqual({ parentSessionId: 'parent-1', outcome: 'completed', settledAt: 100 })
  })

  it('folds the latest of two settlement events, last-wins', () => {
    expect(fold([
      event('subagent/settlement', 0, 1, settlementData('error', 50, 'parent-a')),
      event('subagent/settlement', 1, 2, settlementData('completed', 100, 'parent-b')),
    ])).toEqual({ parentSessionId: 'parent-b', outcome: 'completed', settledAt: 100 })
  })

  it('resets to the null sentinel when a later event is malformed', () => {
    const settled = subagentSettlementProjectionDefinition.apply(
      subagentSettlementProjectionDefinition.init(),
      event('subagent/settlement', 0, 1, settlementData('completed', 1)),
    )
    expect(subagentSettlementProjectionDefinition.view(settled)).toEqual({
      parentSessionId: 'parent-1', outcome: 'completed', settledAt: 1,
    })
    const invalidated = subagentSettlementProjectionDefinition.apply(
      settled,
      event('subagent/settlement', 1, 2, { version: SETTLEMENT_VERSION, parentSessionId: 7 }),
    )
    expect(subagentSettlementProjectionDefinition.view(invalidated)).toBeNull()
  })

  it('ignores unrelated events and leaves the initial state untouched', () => {
    const initial = subagentSettlementProjectionDefinition.init()
    expect(subagentSettlementProjectionDefinition.apply(
      initial,
      event('assistant/chunk', 0, 1),
    )).toBe(initial)
  })
})

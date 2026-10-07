import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  foldSubagentSettlement,
  SUBAGENT_SETTLEMENT_VERSION,
  snapshotSubagentSettlement,
} from '../src/settlement.ts'

describe('subagent settlement', () => {
  const event = (data: unknown): SessionEvent<'subagent/settlement'> => ({
    type: 'subagent/settlement',
    data,
  } as unknown as SessionEvent<'subagent/settlement'>)

  it('round-trips a snapshotted settlement through the fold and rejects unsupported versions', () => {
    expect(foldSubagentSettlement([])).toBeUndefined()
    const settlement = snapshotSubagentSettlement({
      parentSessionId: SessionId('parent-1'),
      outcome: 'completed',
      settledAt: 1_000,
    })
    expect(settlement).toEqual({
      version: SUBAGENT_SETTLEMENT_VERSION,
      parentSessionId: SessionId('parent-1'),
      outcome: 'completed',
      settledAt: 1_000,
    })
    expect(foldSubagentSettlement([event(settlement)])).toEqual(settlement)

    // A merge-extensible outcome (not one of the known literal reasons) still
    // round-trips: the schema validates only that outcome is a string.
    const extended = snapshotSubagentSettlement({
      parentSessionId: SessionId('parent-2'),
      outcome: 'future-reason' as never,
      settledAt: 2_000,
    })
    expect(foldSubagentSettlement([event(extended)])).toEqual(extended)

    expect(foldSubagentSettlement([
      event({ version: SUBAGENT_SETTLEMENT_VERSION + 1, parentSessionId: 'parent-1', outcome: 'completed', settledAt: 1 }),
    ])).toBeUndefined()
  })

  it('returns the first matching event in a slice, leaving last-wins to the caller', () => {
    const first = snapshotSubagentSettlement({
      parentSessionId: SessionId('parent-1'),
      outcome: 'completed',
      settledAt: 1,
    })
    const second = snapshotSubagentSettlement({
      parentSessionId: SessionId('parent-1'),
      outcome: 'aborted',
      settledAt: 2,
    })
    expect(foldSubagentSettlement([event(first), event(second)])).toEqual(first)
  })

  it.each([
    ['string payload', 'invalid', 'payload must be an object'],
    ['null payload', null, 'payload must be an object'],
    ['array payload', [], 'payload must be an object'],
    ['missing version', { parentSessionId: 'p', outcome: 'completed', settledAt: 1 }, 'version must be a number'],
    ['string version', { version: '1', parentSessionId: 'p', outcome: 'completed', settledAt: 1 }, 'version must be a number'],
    ['unknown field', {
      version: SUBAGENT_SETTLEMENT_VERSION,
      parentSessionId: 'p',
      outcome: 'completed',
      settledAt: 1,
      extra: true,
    }, 'payload has unknown field "extra"'],
    ['missing parentSessionId', {
      version: SUBAGENT_SETTLEMENT_VERSION,
      outcome: 'completed',
      settledAt: 1,
    }, 'parentSessionId must be a string'],
    ['invalid parentSessionId', {
      version: SUBAGENT_SETTLEMENT_VERSION,
      parentSessionId: 7,
      outcome: 'completed',
      settledAt: 1,
    }, 'parentSessionId must be a string'],
    ['missing outcome', {
      version: SUBAGENT_SETTLEMENT_VERSION,
      parentSessionId: 'p',
      settledAt: 1,
    }, 'outcome must be a string'],
    ['invalid outcome', {
      version: SUBAGENT_SETTLEMENT_VERSION,
      parentSessionId: 'p',
      outcome: 7,
      settledAt: 1,
    }, 'outcome must be a string'],
    ['missing settledAt', {
      version: SUBAGENT_SETTLEMENT_VERSION,
      parentSessionId: 'p',
      outcome: 'completed',
    }, 'settledAt must be a number'],
    ['invalid settledAt', {
      version: SUBAGENT_SETTLEMENT_VERSION,
      parentSessionId: 'p',
      outcome: 'completed',
      settledAt: '1',
    }, 'settledAt must be a number'],
  ])('rejects a malformed persisted settlement: %s', (_case, data, detail) => {
    expect(() => foldSubagentSettlement([event(data)])).toThrow(detail)
  })

  it('rejects a settlement input that is not losslessly JSON-serializable', () => {
    expect(() => snapshotSubagentSettlement({
      parentSessionId: SessionId('parent-1'),
      outcome: 'completed',
      settledAt: Number.NaN,
    })).toThrow('not losslessly JSON-serializable')
  })
})

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as ClaudeCodeInvariant from '../src/invariant.ts'
import type {} from '../src/types.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ClaudeCodeInvariant)
  return ctx
}

const without = (source: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _omitted, ...rest } = source
  return rest
}

const raw = (session: Session, type: string, data: unknown): void => {
  (session.append.bind(session) as (eventType: string, eventData: unknown) => unknown)(type, data)
}

const bound = { version: 1, sessionId: 's', sdkSessionId: 'sdk', model: 'm', driver: 'claude-code', at: 1 }
const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
const turn = (turnIndex: number): Record<string, unknown> => ({
  version: 1, turnIndex, outcome: 'success', isError: false, model: 'm', numTurns: 1, durationMs: 1,
  durationApiMs: 1, estimatedCostUsd: 0.01, usage, modelUsage: { m: { ...usage, estimatedCostUsd: 0.01, webSearchRequests: 0 } },
})

describe('claude-code durable record invariants', () => {
  it('accepts a bound session with ordered turns, steers, compactions and limits', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('cc-valid'))
    session.append('turn/start', { turn: 1 })
    raw(session, 'claude-code/fleet-refused', { version: 1, reason: 'concurrency', limit: 2, observed: 2, at: 1 })
    raw(session, 'claude-code/session-bound', bound)
    raw(session, 'claude-code/turn-completed', turn(1))
    raw(session, 'claude-code/steer', { version: 1, kind: 'push', reason: '', at: 2 })
    raw(session, 'claude-code/compact', { version: 1, preTokens: 10, trigger: 'manual', at: 3 })
    raw(session, 'claude-code/rate-limited', { version: 1, source: 'sdk', breakerTripped: false, at: 4 })
    raw(session, 'claude-code/turn-completed', { ...turn(2), stopReason: 'end_turn' })
    raw(session, 'claude-code/resume-failed', { version: 1, sdkSessionId: 'sdk', reason: 'transcript-missing', at: 5 })
    raw(session, 'claude-code/paused', { version: 1, reason: 'rate-limit', until: 9, at: 6 })
    raw(session, 'claude-code/compact', { version: 1, preTokens: 10, postTokens: 4, trigger: 'auto', at: 7 })
    raw(session, 'claude-code/tool-call', { version: 1, name: 'Bash', ok: true, ms: 3, argDigest: 'len:4', at: 8 })
    raw(session, 'claude-code/thinking', { version: 1, length: 5, at: 9 })
    raw(session, 'claude-code/unmapped', { version: 1, type: 'system/x', at: 10 })
    raw(session, 'claude-code/mail-claimed', { version: 1, messageId: 'm', tainted: false, at: 11 })
    raw(session, 'claude-code/mail-outcome', { version: 1, messageId: 'm', outcome: 'settled', reason: '', at: 12 })
    raw(session, 'claude-code/refused', { version: 1, reason: 'admission', messageId: 'm', detail: 'd', at: 13 })
    raw(session, 'claude-code/refused', { version: 1, reason: 'kill-switch', detail: '', at: 14 })
    raw(session, 'claude-code/throwaway-turn', { version: 1, turnIndex: 3, at: 15 })
  })

  const cases: readonly [string, string, unknown, RegExp][] = [
    ['null data', 'claude-code/session-bound', null, /data must be a JSON object/],
    ['array data', 'claude-code/steer', [], /data must be a JSON object/],
    ['wrong version', 'claude-code/session-bound', { ...bound, version: 2 }, /version must be 1/],
    ['missing version', 'claude-code/session-bound', without(bound, 'version'), /version must be 1/],
    ['missing sessionId', 'claude-code/session-bound', { ...bound, sessionId: '' }, /sessionId must be a non-empty string/],
    ['missing sdkSessionId', 'claude-code/session-bound', without(bound, 'sdkSessionId'), /sdkSessionId must be a non-empty string/],
    ['wrong driver', 'claude-code/session-bound', { ...bound, driver: 'other' }, /driver must be claude-code/],
    ['negative at', 'claude-code/session-bound', { ...bound, at: -1 }, /at must be a finite non-negative number/],
    ['unknown type', 'claude-code/nonsense', { version: 1 }, /unknown claude-code event type/],
    ['turn before binding', 'claude-code/turn-completed', turn(1), /no earlier claude-code\/session-bound/],
    ['steer before binding', 'claude-code/steer', { version: 1, kind: 'push', reason: '', at: 1 }, /no earlier claude-code\/session-bound/],
    ['compact before binding', 'claude-code/compact', { version: 1, preTokens: 1, trigger: 'auto', at: 1 }, /no earlier claude-code\/session-bound/],
    ['rate-limited bad source', 'claude-code/rate-limited', { version: 1, source: 'ws', breakerTripped: true, at: 1 }, /source ws is invalid/],
    ['rate-limited missing breaker', 'claude-code/rate-limited', { version: 1, source: 'sdk', at: 1 }, /breakerTripped must be a boolean/],
    ['fleet-refused bad reason', 'claude-code/fleet-refused', { version: 1, reason: 'nope', limit: 1, observed: 1, at: 1 }, /reason nope is invalid/],
    ['resume-failed before binding', 'claude-code/resume-failed', { version: 1, sdkSessionId: 'sdk', reason: 'transcript-missing', at: 1 }, /no earlier claude-code\/session-bound/],
    ['paused bad reason', 'claude-code/paused', { version: 1, reason: 'nope', at: 1 }, /reason nope is invalid/],
    ['paused fractional until', 'claude-code/paused', { version: 1, reason: 'rate-limit', until: 1.5, at: 1 }, /until must be a non-negative safe integer/],
    ['fleet-refused missing observed', 'claude-code/fleet-refused', { version: 1, reason: 'breaker', limit: 1, at: 1 }, /observed must be a finite non-negative number/],
    ['tool-call missing name', 'claude-code/tool-call', { version: 1, name: '', ok: true, ms: 1, argDigest: 'len:1', at: 1 }, /name must be a non-empty string/],
    ['tool-call missing ok', 'claude-code/tool-call', { version: 1, name: 'x', ms: 1, argDigest: 'len:1', at: 1 }, /ok must be a boolean/],
    ['tool-call missing digest', 'claude-code/tool-call', { version: 1, name: 'x', ok: true, ms: 1, at: 1 }, /argDigest must be a non-empty string/],
    ['thinking fractional length', 'claude-code/thinking', { version: 1, length: 1.5, at: 1 }, /length must be a non-negative safe integer/],
    ['unmapped missing type', 'claude-code/unmapped', { version: 1, at: 1 }, /type must be a non-empty string/],
    ['mail-claimed missing id', 'claude-code/mail-claimed', { version: 1, tainted: false, at: 1 }, /messageId must be a non-empty string/],
    ['mail-claimed missing taint', 'claude-code/mail-claimed', { version: 1, messageId: 'm', at: 1 }, /tainted must be a boolean/],
    ['mail-outcome bad outcome', 'claude-code/mail-outcome', { version: 1, messageId: 'm', outcome: 'nope', reason: '', at: 1 }, /outcome nope is invalid/],
    ['mail-outcome non-string reason', 'claude-code/mail-outcome', { version: 1, messageId: 'm', outcome: 'failed', at: 1 }, /reason must be a string/],
    ['refused bad reason', 'claude-code/refused', { version: 1, reason: 'nope', detail: '', at: 1 }, /reason nope is invalid/],
    ['throwaway-turn without a turn', 'claude-code/throwaway-turn', { version: 1, turnIndex: 0, at: 1 }, /turnIndex must be at least 1/],
    ['refused empty message id', 'claude-code/refused', { version: 1, reason: 'admission', messageId: '', detail: '', at: 1 }, /messageId must be a non-empty string/],
  ]
  for (const [label, type, data, message] of cases) {
    it(`rejects ${label} before commit and keeps the fold reusable`, async () => {
      const ctx = await setup()
      const session = ctx.sessions.create(SessionId('cc-invalid'))
      const before = session.seq
      expect(() => { raw(session, type, data) }).toThrow(expect.objectContaining<Partial<InvariantError>>({
        code: 'INVARIANT', packageName: '@deepseek-ai/dsh-agent-claude-code', message: expect.stringMatching(message) as string,
      }))
      expect(session.seq).toBe(before)
      expect(() => { raw(session, 'claude-code/session-bound', bound) }).not.toThrow()
    })
  }

  it('rejects resume-failed with a bad reason once the session is bound', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('cc-bad-resume'))
    raw(session, 'claude-code/session-bound', bound)
    expect(() => { raw(session, 'claude-code/resume-failed', { version: 1, sdkSessionId: 'sdk', reason: 'nope', at: 1 }) })
      .toThrow(/reason nope is invalid/)
  })

  const bad: readonly [string, Record<string, unknown>, RegExp][] = [
    ['zero turnIndex', turn(0), /turnIndex must be at least 1/],
    ['missing outcome', without(turn(1), 'outcome'), /outcome must be a non-empty string/],
    ['non-boolean isError', { ...turn(1), isError: 'no' }, /isError must be a boolean/],
    ['missing usage', without(turn(1), 'usage'), /usage must be a JSON object/],
    ['negative token count', { ...turn(1), usage: { ...usage, inputTokens: -1 } }, /inputTokens must be a finite non-negative number/],
    ['fractional token count', { ...turn(1), usage: { ...usage, outputTokens: 1.5 } }, /outputTokens must be a non-negative safe integer/],
    ['missing modelUsage', without(turn(1), 'modelUsage'), /modelUsage must be a JSON object/],
    ['bad modelUsage entry', { ...turn(1), modelUsage: { m: usage } }, /estimatedCostUsd must be a finite non-negative number/],
    ['empty stopReason', { ...turn(1), stopReason: '' }, /stopReason must be a non-empty string/],
  ]
  for (const [label, data, message] of bad) {
    it(`rejects turn-completed with ${label}`, async () => {
      const ctx = await setup()
      const session = ctx.sessions.create(SessionId('cc-bad-turn'))
      raw(session, 'claude-code/session-bound', bound)
      expect(() => { raw(session, 'claude-code/turn-completed', data) }).toThrow(message)
    })
  }

  it('rejects a fractional post-compaction size once the session is bound', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('cc-post'))
    raw(session, 'claude-code/session-bound', bound)
    expect(() => {
      raw(session, 'claude-code/compact', { version: 1, preTokens: 1, postTokens: 0.5, trigger: 'auto', at: 1 })
    }).toThrow(/postTokens must be a non-negative safe integer/)
  })

  it('lets a throwaway turn-completed precede any binding but only when the flag is true', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('cc-throwaway'))
    raw(session, 'claude-code/turn-completed', { ...turn(1), throwaway: true })
    expect(() => { raw(session, 'claude-code/turn-completed', { ...turn(2), throwaway: false }) })
      .toThrow(/throwaway must be true when present/)
    expect(() => { raw(session, 'claude-code/turn-completed', turn(2)) }).toThrow(/no earlier claude-code\/session-bound/)
  })

  it('rejects a repeated or backwards turn index', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('cc-order'))
    raw(session, 'claude-code/session-bound', bound)
    raw(session, 'claude-code/turn-completed', turn(2))
    expect(() => { raw(session, 'claude-code/turn-completed', turn(2)) }).toThrow(/does not follow turn 2/)
    expect(() => { raw(session, 'claude-code/turn-completed', turn(1)) }).toThrow(/does not follow turn 2/)
    expect(() => { raw(session, 'claude-code/turn-completed', turn(3)) }).not.toThrow()
  })

  it('allows a repeated session-bound (re-binding) while turn numbering keeps increasing', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('cc-rebind'))
    raw(session, 'claude-code/session-bound', bound)
    raw(session, 'claude-code/turn-completed', turn(1))
    expect(() => { raw(session, 'claude-code/session-bound', { ...bound, sdkSessionId: 'sdk-2' }) }).not.toThrow()
    expect(() => { raw(session, 'claude-code/turn-completed', turn(1)) }).toThrow(/does not follow turn 1/)
    expect(() => { raw(session, 'claude-code/turn-completed', turn(2)) }).not.toThrow()
  })

  it('rejects an over-long steer reason and bad steer kind', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('cc-steer'))
    raw(session, 'claude-code/session-bound', bound)
    expect(() => { raw(session, 'claude-code/steer', { version: 1, kind: 'push', reason: 'x'.repeat(201), at: 1 }) }).toThrow(/at most 200/)
    expect(() => { raw(session, 'claude-code/steer', { version: 1, kind: 'kick', reason: '', at: 1 }) }).toThrow(/kind kick is invalid/)
    expect(() => { raw(session, 'claude-code/compact', { version: 1, preTokens: 1, trigger: 'sometimes', at: 1 }) }).toThrow(/trigger sometimes is invalid/)
  })

  it('re-validates an existing log when the companion attaches late', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('cc-late'))
    raw(session, 'claude-code/steer', { version: 1, kind: 'push', reason: '', at: 1 })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(ClaudeCodeInvariant)).rejects.toThrow(/no earlier claude-code\/session-bound/)
  })
})

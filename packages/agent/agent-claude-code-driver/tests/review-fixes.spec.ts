import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { recordClaudeCodeEvent } from '@deepseek-ai/dsh-agent-claude-code'
import { CLAUDE_CODE_TURN_ERROR_CODES } from '../src/seat-agent.ts'
import { harness, resultMessage, userMessage } from './fakes.ts'
import type { FakeQuery } from './fakes.ts'

interface EndData { reason: { kind: string; error: { code: string; message: string } } }

const lastEnd = (agent: { session: { events: readonly { type: string; data: unknown }[] } }): EndData =>
  agent.session.events.findLast(event => event.type === 'turn/end')?.data as EndData

const dataOf = (session: { events: readonly { type: string; data: unknown }[] }, type: string): Record<string, unknown>[] =>
  session.events.filter(event => event.type === type).map(event => event.data as Record<string, unknown>)

function answer(query: FakeQuery, overrides: Record<string, unknown> = {}): void {
  query.emit(resultMessage({ user_message_uuids: query.uuids(), ...overrides }))
}

describe('durable session binding (review B1)', () => {
  it('flushes the session after recording the binding and before the first query', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('hello'))
    const query = await h.query(0)
    expect(h.state.calls).toEqual(['flush', 'query'])
    answer(query)
    await agent.whenIdle()
    // The binding is durable once; later turns do not flush again.
    agent.followup(userMessage('again'))
    answer(await h.query(1))
    await agent.whenIdle()
    expect(h.state.calls).toEqual(['flush', 'query', 'query'])
  })

  it('sends no prompt when the flush fails, names the binding error, and retries the same binding next turn', async () => {
    const h = await harness()
    const agent = h.agent()
    h.state.flushError = new Error('disk full')
    agent.followup(userMessage('first'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(lastEnd(agent).reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.binding)
    expect(lastEnd(agent).reason.error.message).toMatch(/could not make claude-code\/session-bound durable \(.*disk full.*\)/)
    const bound = dataOf(agent.session, 'claude-code/session-bound')
    expect(bound).toHaveLength(1)

    h.state.flushError = undefined
    h.state.transcript = 'missing'
    agent.followup(userMessage('second'))
    const query = await h.query(0)
    expect(query.options.sessionId).toBe(bound[0]?.['sdkSessionId'])
    expect(dataOf(agent.session, 'claude-code/session-bound')).toHaveLength(1)
    expect(h.state.calls).toEqual(['flush', 'flush', 'query'])
    // each turn claims one queued message: 'first' (kept from the failed turn), then 'second'
    answer(query)
    answer(await h.query(1))
    await agent.whenIdle()
  })

  it('retries a flush that failed on a bound session found in the log', async () => {
    const h = await harness()
    const first = h.agent()
    h.state.flushError = new Error('disk full')
    first.followup(userMessage('one'))
    await first.whenIdle()
    expect(h.queries).toHaveLength(0)
    // A cold agent over the same log has no pending flag: it trusts what the store holds.
    const cold = h.agent({ session: first.session })
    h.state.flushError = undefined
    cold.followup(userMessage('two'))
    // each turn claims one queued message: 'one' (kept from the failed turn), then 'two'
    answer(await h.query(0))
    answer(await h.query(1))
    await cold.whenIdle()
  })
})

describe('session id validation (review S8)', () => {
  it('refuses a logged binding that is not a UUID and says the log is damaged', async () => {
    const h = await harness()
    const session = h.session()
    recordClaudeCodeEvent(session, 'claude-code/session-bound', {
      sessionId: session.id, sdkSessionId: '../../etc/passwd sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV', model: 'sonnet', driver: 'claude-code', at: h.state.now,
    }, () => undefined)
    const agent = h.agent({ session })
    agent.followup(userMessage('hello'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(lastEnd(agent).reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.binding)
    expect(lastEnd(agent).reason.error.message).toContain('is not a session UUID; the log is damaged')
    expect(lastEnd(agent).reason.error.message).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV')
  })
})

describe('binary re-check (review S4)', () => {
  it('refuses the turn before any query when the attested binary check throws', async () => {
    const h = await harness()
    const seen: string[] = []
    ;(h.deps as { attestedBinary?: (seat: string) => string }).attestedBinary = (seat) => {
      seen.push(seat)
      throw new Error('claude binary changed')
    }
    const agent = h.agent({ seat: 'tester' })
    agent.followup(userMessage('hello'))
    await agent.whenIdle()
    expect(seen).toEqual(['tester'])
    expect(h.queries).toHaveLength(0)
    expect(lastEnd(agent).reason.error.message).toContain('claude binary changed')
  })
})

describe('error text sanitization (review S7)', () => {
  it('caps and cleans a thrown error and a failing result before they reach the log', async () => {
    const h = await harness()
    h.state.failNextQuery = new Error(`boom \u001b[31m${'x'.repeat(5000)}`)
    const agent = h.agent()
    agent.followup(userMessage('hello'))
    await agent.whenIdle()
    const message = lastEnd(agent).reason.error.message
    expect(message.length).toBeLessThan(700)
    expect(message).not.toContain('\u001b')

    const h2 = await harness()
    const agent2 = h2.agent()
    agent2.followup(userMessage('hello'))
    const query = await h2.query(0)
    answer(query, { subtype: 'error_during_execution', is_error: true, errors: [`\u001b[31m${'y'.repeat(5000)}`] })
    await agent2.whenIdle()
    const resultMessageText = lastEnd(agent2).reason.error.message
    expect(resultMessageText.length).toBeLessThan(700)
    expect(resultMessageText).not.toContain('\u001b')
    expect(resultMessageText).toContain('Claude Code failed')
  })
})

describe('pause semantics (review S6)', () => {
  const rateEvent = (info: Record<string, unknown>): SDKMessage =>
    ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' }) as unknown as SDKMessage

  async function pausedBy(info: Record<string, unknown>) {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.emit(rateEvent(info))
    answer(query)
    await agent.whenIdle()
    return { h, agent, paused: dataOf(agent.session, 'claude-code/paused') }
  }

  it('does not pause while the request is served on overage credit', async () => {
    expect((await pausedBy({ status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true })).paused).toEqual([])
  })

  it.each(['allowed', 'allowed_warning'])('does not pause on a rejected window while overage is %s', async (overageStatus) => {
    expect((await pausedBy({ status: 'rejected', rateLimitType: 'seven_day', overageStatus })).paused).toEqual([])
  })

  it('pauses when the overage window itself is rejected, even if the status text says allowed', async () => {
    const { paused } = await pausedBy({ status: 'rejected', rateLimitType: 'overage', overageStatus: 'allowed' })
    expect(paused[0]).toMatchObject({ reason: 'usage-exhausted' })
  })

  it('pauses on a rejected window when overage is rejected too', async () => {
    const { paused } = await pausedBy({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'rejected' })
    expect(paused[0]).toMatchObject({ reason: 'rate-limit' })
  })

  it('caps a far-future reset time at 24 hours', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.emit(rateEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (h.state.now + 10 * 24 * 3_600_000) / 1000 }))
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/paused')[0]?.['until']).toBe(h.state.now + 24 * 3_600_000)
    expect(agent.pausedUntilMs).toBe(h.state.now + 24 * 3_600_000)
  })

  it('restores a pause that is still in force after a restart, and refuses the turn with its mail kept', async () => {
    const h = await harness()
    const session = h.session()
    recordClaudeCodeEvent(session, 'claude-code/paused', { reason: 'rate-limit', until: h.state.now + 3_600_000, at: h.state.now }, () => undefined)
    const agent = h.agent({ session })
    expect(agent.pausedUntilMs).toBe(h.state.now + 3_600_000)
    agent.followup(userMessage('work'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(lastEnd(agent).reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.paused)
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })

  it('caps a restored pause at 24 hours and ignores an expired or missing one', async () => {
    const h = await harness()
    const far = h.session()
    recordClaudeCodeEvent(far, 'claude-code/paused', { reason: 'rate-limit', until: h.state.now + 30 * 24 * 3_600_000, at: h.state.now }, () => undefined)
    expect(h.agent({ session: far }).pausedUntilMs).toBe(h.state.now + 24 * 3_600_000)
    const past = h.session()
    recordClaudeCodeEvent(past, 'claude-code/paused', { reason: 'rate-limit', until: h.state.now - 1, at: h.state.now - 10 }, () => undefined)
    expect(h.agent({ session: past }).pausedUntilMs).toBe(0)
    expect(h.agent().pausedUntilMs).toBe(0)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { CLAUDE_CODE_TURN_ERROR_CODES, SeatGate } from '../src/seat-agent.ts'
import type { SeatAgentDeps } from '../src/seat-agent.ts'
import { harness, mailMessage, resultMessage, seatConfig, tick, userMessage } from './fakes.ts'
import type { FakeQuery } from './fakes.ts'

const NEW_ID = '99999999-8888-4777-8666-555555555555'

function dataOf(session: Session, type: string): Record<string, unknown>[] {
  return session.events.filter(event => event.type === type).map(event => event.data as Record<string, unknown>)
}

function answer(query: FakeQuery, overrides: Record<string, unknown> = {}): void {
  query.emit(resultMessage({ user_message_uuids: query.uuids(), ...overrides }))
}

const turnEnd = (session: Session): { reason: { kind: string; error?: { code: string; message: string } } } =>
  session.events.findLast(event => event.type === 'turn/end')?.data as never

describe('the stream mapped into the session log', () => {
  it('logs assistant text redacted, tool calls without bodies, compaction, thinking, and unmapped types once', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('go'))
    const query = await h.query(0)
    query.emit({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'secret reasoning' },
      { type: 'text', text: `here is a key sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx and ghp_${'b'.repeat(30)}` },
      { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'password' } },
    ] } } as never)
    query.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'LEAKY BODY', is_error: false }] } } as never)
    query.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 30000 } } as never)
    query.emit({ type: 'system', subtype: 'hook_started' } as never)
    query.emit({ type: 'system', subtype: 'hook_started' } as never)
    await tick(5)
    answer(query)
    await agent.whenIdle()

    const assistant = dataOf(agent.session, 'assistant/message')
    expect(assistant).toHaveLength(1)
    const text = JSON.stringify(assistant[0])
    expect(text).toContain('[redacted]')
    expect(text).not.toMatch(/sk-ant|ghp_/)
    expect(assistant[0]).toMatchObject({ turn: 1, step: 1 })
    expect(dataOf(agent.session, 'claude-code/thinking')).toEqual([expect.objectContaining({ length: 16 })])
    expect(dataOf(agent.session, 'claude-code/tool-call')).toEqual([
      expect.objectContaining({ name: 'Grep', ok: true, argDigest: expect.stringMatching(/^hmac:[0-9a-f]{16}$/) as string }),
    ])
    expect(dataOf(agent.session, 'claude-code/compact')).toEqual([
      expect.objectContaining({ trigger: 'auto', preTokens: 180000, postTokens: 30000 }),
    ])
    expect(dataOf(agent.session, 'claude-code/unmapped')).toEqual([expect.objectContaining({ type: 'system/hook_started' })])
    const log = JSON.stringify(agent.session.events)
    expect(log).not.toContain('LEAKY BODY')
    expect(log).not.toContain('secret reasoning')
    expect(log).not.toContain('password')
  })

  it('rebinds only when Claude reports a different, valid session id, and never for a throwaway turn', async () => {
    const h = await harness()
    h.state.admit = () => ({ allow: true })
    const agent = h.agent()
    agent.followup(userMessage('one'))
    const first = await h.query(0)
    const bound = first.options.sessionId as string
    first.emit({ type: 'system', subtype: 'init', tools: [], session_id: bound, model: 'claude-sonnet-x' } as never)
    first.emit({ type: 'system', subtype: 'init', tools: [], session_id: 'not-a-uuid', model: 'x' } as never)
    first.emit({ type: 'system', subtype: 'init', tools: [], session_id: NEW_ID, model: 'claude-sonnet-x' } as never)
    first.emit({ type: 'system', subtype: 'init', tools: [], session_id: NEW_ID, model: '' } as never)
    await tick(5)
    answer(first)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/session-bound').map(data => data['sdkSessionId'])).toEqual([bound, NEW_ID])
    expect(dataOf(agent.session, 'claude-code/session-bound')[1]).toMatchObject({ model: 'claude-sonnet-x' })

    agent.followup(userMessage('two'))
    const second = await h.query(1)
    expect(second.options.resume).toBe(NEW_ID)
    answer(second)
    await agent.whenIdle()

    agent.followup(mailMessage('portal', 'm-t', { chain: ['portal'] }))
    const tainted = await h.query(2)
    tainted.emit({ type: 'system', subtype: 'init', tools: [], session_id: '12345678-1234-4234-8234-123456789012', model: 'x' } as never)
    await tick(5)
    answer(tainted)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/session-bound')).toHaveLength(2)
  })

  it('falls back to the configured model when Claude reports an empty one on a rebind', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('one'))
    const first = await h.query(0)
    first.emit({ type: 'system', subtype: 'init', tools: [], session_id: NEW_ID, model: '' } as never)
    await tick(5)
    answer(first)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/session-bound')[1]).toMatchObject({ sdkSessionId: NEW_ID, model: 'sonnet' })
  })

  it('warns and carries on when an assistant message cannot be logged', async () => {
    const h = await harness()
    const agent = h.agent()
    const original = agent.session.append.bind(agent.session) as (type: string, data: unknown, options?: unknown) => unknown
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, data: unknown, options?: unknown) => {
      if (type === 'assistant/message') throw new Error('log closed')
      return original(type, data, options)
    }) as never)
    agent.followup(userMessage('go'))
    const query = await h.query(0)
    query.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } } as never)
    await tick(5)
    answer(query)
    await agent.whenIdle()
    expect(h.warnings.some(line => line.includes('could not log an assistant message') && line.includes('log closed'))).toBe(true)
    expect(turnEnd(agent.session).reason.kind).toBe('completed')
  })
})

describe('per-seat limits', () => {
  it('passes the turn and budget caps to every query and ends a budget-capped turn as a coded error', async () => {
    const h = await harness()
    const agent = h.agent({ config: seatConfig({ max_turns: 7, max_budget_usd: 1.5 }) })
    agent.followup(userMessage('go'))
    const query = await h.query(0)
    expect(query.options.maxTurns).toBe(7)
    expect(query.options.maxBudgetUsd).toBe(1.5)
    answer(query, { subtype: 'error_max_budget_usd', is_error: true, errors: ['budget'] })
    await agent.whenIdle()
    expect(turnEnd(agent.session).reason.error?.code).toBe('CLAUDE_CODE_ERROR_MAX_BUDGET_USD')
  })

  it('refuses a turn once the seat used its calls for the window, with a record, and runs again when the window moves on', async () => {
    const h = await harness()
    const agent = h.agent({ config: seatConfig({ max_calls_per_window: 2, call_window_ms: 60_000 }) })
    for (const text of ['one', 'two']) {
      agent.followup(userMessage(text))
      answer(await h.query(text === 'one' ? 0 : 1))
      await agent.whenIdle()
      h.state.now += 100
    }
    agent.followup(userMessage('three'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(2)
    expect(turnEnd(agent.session).reason.error?.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.callWindow)
    expect(dataOf(agent.session, 'claude-code/refused')).toEqual([
      expect.objectContaining({ reason: 'call-window', detail: expect.stringContaining('2 of 2 calls') as string }),
    ])
    expect(agent.inbox.nextTurn).toHaveLength(1)

    h.state.now += 61_000
    agent.followup(userMessage('four'))
    answer(await h.query(2))
    await tick(5)
    answer(await h.query(3))
    await agent.whenIdle()
    expect(agent.inbox.hasPending).toBe(false)
  })

  it('rebuilds the call window from the log after a restart, once per seat, and ignores steps outside the window', async () => {
    const h = await harness()
    h.state.now = Date.now() + 1000
    const config = seatConfig({ max_calls_per_window: 2, call_window_ms: 60_000 })
    const session = h.session('s-restart')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('turn/start', { turn: 3 })
    const restarted = h.agent({ session, config })
    restarted.followup(userMessage('after the restart'))
    await restarted.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(dataOf(session, 'claude-code/refused')).toEqual([
      expect.objectContaining({ reason: 'call-window', detail: expect.stringContaining('2 of 2 calls') as string }),
    ])

    // A second agent of the same seat must not count the same history again.
    const other = h.session('s-other')
    other.append('step/start', { turn: 1, step: 1 })
    const second = h.agent({ session: other, config })
    second.followup(userMessage('second'))
    await second.whenIdle()
    expect(dataOf(other, 'claude-code/refused')).toEqual([
      expect.objectContaining({ detail: expect.stringContaining('2 of 2 calls') as string }),
    ])

    // History older than the window does not count.
    const old = h.session('s-old')
    old.append('step/start', { turn: 1, step: 1 })
    old.append('step/start', { turn: 2, step: 1 })
    h.state.now += 120_000
    const fresh = h.agent({ session: old, config, seat: 'another-seat' })
    fresh.followup(userMessage('fresh'))
    answer(await h.query(0))
    await fresh.whenIdle()
    expect(dataOf(old, 'claude-code/refused')).toEqual([])
  })

  it('counts calls per seat across agents through the shared gate', () => {
    const gate = new SeatGate()
    gate.noteCall('a', 1001, 1000)
    gate.noteCall('a', 1500, 1000)
    gate.noteCall('b', 1500, 1000)
    expect(gate.callsInWindow('a', 2000, 1000)).toBe(2)
    expect(gate.callsInWindow('a', 2400, 1000)).toBe(1)
    expect(gate.callsInWindow('a', 9000, 1000)).toBe(0)
    expect(gate.callsInWindow('b', 2000, 1000)).toBe(1)
    expect(gate.callsInWindow('none', 2000, 1000)).toBe(0)
  })

  it('prunes expired calls when it saves, never an active one, and excludes the boundary', () => {
    const written: Array<[string, readonly number[]]> = []
    const gate = new SeatGate({ load: () => undefined, save: (seat, times) => { written.push([seat, times]) } })
    gate.noteCall('a', 1000, 1000)
    gate.noteCall('a', 1500, 1000)
    // now - windowMs = 1000 here: the call at exactly 1000 is outside the window, the one at 1500 is inside.
    gate.noteCall('a', 2000, 1000)
    expect(written.at(-1)).toEqual(['a', [1500, 2000]])
    // An active call (inside the window) is never dropped, however many are saved.
    gate.noteCall('a', 2001, 1000)
    gate.noteCall('a', 2002, 1000)
    expect(written.at(-1)).toEqual(['a', [1500, 2000, 2001, 2002]])
    expect(gate.callsInWindow('a', 2002, 1000)).toBe(4)
    gate.noteCall('a', 9000, 1000)
    expect(written.at(-1)).toEqual(['a', [9000]])
  })
})

describe('the kill switch', () => {
  it('refuses a turn while the flag exists, with a record, and keeps the mail queued', async () => {
    const h = await harness()
    h.state.killSwitch = true
    const agent = h.agent()
    agent.followup(mailMessage('hello', 'm-ks'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(dataOf(agent.session, 'claude-code/refused')).toEqual([expect.objectContaining({ reason: 'kill-switch' })])
    expect(turnEnd(agent.session).reason.error?.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.killSwitch)
    expect(turnEnd(agent.session).reason.error?.message).toContain('kill-switch flag file is present')
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(h.state.leases).toEqual([])
    expect(dataOf(agent.session, 'claude-code/mail-claimed')).toEqual([])

    h.state.killSwitch = false
    agent.followup(userMessage('again'))
    answer(await h.query(0))
    await tick(5)
    answer(await h.query(1))
    await agent.whenIdle()
    expect(h.state.leases).toEqual(['settle:m-ks'])
  })

  it('looks once more right before the query starts, so a switch set during the awaits still stops the turn', async () => {
    const h = await harness()
    ;(h.deps as { flush: SeatAgentDeps['flush'] }).flush = () => {
      h.state.calls.push('flush')
      h.state.killSwitch = true
      return Promise.resolve()
    }
    const agent = h.agent()
    agent.followup(mailMessage('racing', 'm-race'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(h.state.calls).not.toContain('query')
    expect(dataOf(agent.session, 'claude-code/refused')).toEqual([expect.objectContaining({ reason: 'kill-switch', detail: expect.stringContaining('turn refused') as string })])
    expect(turnEnd(agent.session).reason.error?.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.killSwitch)
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-race:.*kill-switch flag file is present/)])
  })

  it('polls the flag during a live turn, so a switch set while a tool runs aborts the query with no message to notice it on', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('long tool', 'm-poll'))
    const query = await h.query(0)
    await tick(15)
    expect(query.closed).toBe(false)
    h.state.killSwitch = true
    await agent.whenIdle()
    expect(query.closed).toBe(true)
    expect(dataOf(agent.session, 'claude-code/refused')).toEqual([expect.objectContaining({ reason: 'kill-switch', detail: expect.stringContaining('aborted') as string })])
    expect(turnEnd(agent.session).reason.error?.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.killSwitch)
  })

  it('uses a 500 ms poll when no interval is configured, and clears the timer when the turn ends', async () => {
    const h = await harness()
    ;(h.deps as { killSwitchPollMs?: number | undefined }).killSwitchPollMs = undefined
    const started = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    try {
      const agent = h.agent()
      agent.followup(userMessage('quick'))
      answer(await h.query(0))
      await agent.whenIdle()
      expect(turnEnd(agent.session).reason.kind).toBe('completed')
      const index = started.mock.calls.findIndex(call => call[1] === 500)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(cleared).toHaveBeenCalledWith(started.mock.results[index]?.value)
    } finally {
      started.mockRestore()
      cleared.mockRestore()
    }
  })

  it('treats an injected kill-switch check that throws as the switch being up', async () => {
    const h = await harness()
    let broken = false
    ;(h.deps as { killSwitchActive: SeatAgentDeps['killSwitchActive'] }).killSwitchActive = () => {
      if (broken) throw new Error('flag directory unreadable')
      return false
    }
    const agent = h.agent()
    agent.followup(userMessage('long tool'))
    const query = await h.query(0)
    await tick(15)
    expect(query.closed).toBe(false)
    broken = true
    await agent.whenIdle()
    expect(query.closed).toBe(true)
    expect(dataOf(agent.session, 'claude-code/refused')).toEqual([expect.objectContaining({ reason: 'kill-switch', detail: expect.stringContaining('aborted') as string })])
  })

  it('aborts the running query when the flag appears mid-turn, once, and fails its mail', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('long job', 'm-long'))
    const query = await h.query(0)
    h.state.killSwitch = true
    query.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } } as never)
    query.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'still working' }] } } as never)
    await agent.whenIdle()
    expect(query.closed).toBe(true)
    expect(dataOf(agent.session, 'claude-code/refused')).toEqual([expect.objectContaining({ reason: 'kill-switch' })])
    expect(turnEnd(agent.session).reason.error?.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.killSwitch)
    expect(dataOf(agent.session, 'claude-code/mail-outcome')).toEqual([expect.objectContaining({ outcome: 'failed' })])
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-long:.*kill-switch flag file appeared/)])
    expect(h.queries).toHaveLength(1)
  })
})

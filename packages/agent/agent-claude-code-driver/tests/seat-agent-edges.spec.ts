import { describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CODE_TURN_ERROR_CODES, SeatGate } from '../src/seat-agent.ts'
import { harness, resultMessage, tick, userMessage } from './fakes.ts'
import type { FakeQuery } from './fakes.ts'

/** Answer every consumed prompt message, the way the CLI's result names the messages it answers. */
function answer(query: FakeQuery, overrides: Record<string, unknown> = {}): void {
  query.emit(resultMessage({ user_message_uuids: query.uuids(), ...overrides }))
}

interface EndData { reason: { kind: string; error: { code: string; message: string } } }

const lastEnd = (agent: { session: { events: readonly { type: string; data: unknown }[] } }): EndData =>
  agent.session.events.findLast(event => event.type === 'turn/end')?.data as EndData

describe('seat gate', () => {
  it('ignores a release from a holder that does not own the slot', () => {
    const gate = new SeatGate()
    gate.acquire('seat', 'owner')
    gate.release('seat', 'someone-else')
    expect(gate.isHeld('seat')).toBe(true)
    gate.release('seat', 'owner')
    expect(gate.isHeld('seat')).toBe(false)
  })
})

describe('teardown edge cases', () => {
  it('warns and falls back to a direct group kill when waiting for the child exit fails', async () => {
    const h = await harness({ childWaitFails: true })
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.spawn()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(h.warnings.join('\n')).toContain('waiting for child exit failed')
    expect(h.killed).toEqual([4242])
  })

  it('warns, and still ends the turn, when the direct group kill itself throws', async () => {
    const h = await harness({ childExitsOnWait: false })
    ;(h.deps as { killProcessGroup: (pid: number) => void }).killProcessGroup = () => { throw new Error('EPERM') }
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.spawn()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(h.warnings.join('\n')).toContain('killing process group 4242 failed')
    expect(lastEnd(agent).reason.kind).toBe('aborted')
  })

  it('skips the ledger for a child without a usable pid', async () => {
    const h = await harness({ childPid: 0 })
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.spawn()
    h.children[0]?.finish()
    await tick(10)
    expect(h.ledger.entries()).toEqual([])
    answer(query)
    await agent.whenIdle()
  })

  it('treats a crashed child as exited and clears its ledger entry', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.spawn()
    expect(h.ledger.entries()).toHaveLength(1)
    h.children[0]?.crash()
    await tick(10)
    expect(h.ledger.entries()).toEqual([])
    answer(query)
    await agent.whenIdle()
  })
})

describe('wake, latch, and disposal', () => {
  it('queues steering that arrives after an abort for the next turn and runs it afterwards', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const first = await h.query(0)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    agent.steer(userMessage('late steer'))
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(first.closed).toBe(true)
    const second = await h.query(1)
    answer(second)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('does not restart after disposal even when mail was latched during the abort', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    await h.query(0)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    agent.followup(userMessage('latched'))
    agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await agent.whenIdle()
    expect(h.queries).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })

  it('does not restart when the latched mail is gone by the time the turn ends', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    await h.query(0)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    agent.followup(userMessage('latched'))
    agent.inbox.clear()
    await agent.whenIdle()
    expect(h.queries).toHaveLength(1)
  })

  it('refuses a send while the disposed turn is still winding down, and refuses a wake once idle', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    await h.query(0)
    agent.cancel({ kind: 'disposed' })
    expect(() => { agent.followup(userMessage('too late')) }).toThrow(/send refused, agent is disposed/)
    await agent.whenIdle()
    await expect(agent.interruptAndResume(userMessage('nope'))).rejects.toThrow(/dispatch blocked, agent is disposed/)
  })

  it('logs a turn that fails before its query starts and returns to idle', async () => {
    const h = await harness()
    const agent = h.agent()
    const original = agent.session.append.bind(agent.session)
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: unknown[]) => {
      if (type === 'turn/start') throw new Error('log is full')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as never)
    agent.followup(userMessage('work'))
    await agent.whenIdle()
    expect(h.warnings.join('\n')).toContain('turn failed: ')
    expect(h.warnings.join('\n')).toContain('log is full')
    expect(agent.status).toBe('idle')
  })
})

describe('maintenance edge cases', () => {
  it('can be cancelled while a maintenance job runs, and a quiet maintenance leaves the agent idle', async () => {
    const h = await harness()
    const agent = h.agent()
    const job = agent.runMaintenance(signal => new Promise<string>((resolve) => {
      signal.addEventListener('abort', () => { resolve('aborted') }, { once: true })
    }))
    expect(agent.cancel({ kind: 'user' })).toBe(true)
    expect(await job).toBe('aborted')
    expect(await agent.runMaintenance(() => Promise.resolve('quiet'))).toBe('quiet')
    expect(agent.status).toBe('idle')
  })

  it('does not wake after maintenance when the latched mail was discarded or the agent was disposed', async () => {
    const h = await harness()
    const agent = h.agent()
    const gone = agent.runMaintenance(() => tick(5))
    agent.followup(userMessage('latched'))
    agent.inbox.clear()
    await gone
    expect(h.queries).toHaveLength(0)
    const kept = agent.runMaintenance(() => tick(5))
    agent.followup(userMessage('latched again'))
    agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await kept
    expect(h.queries).toHaveLength(0)
  })
})

describe('result and stream edge cases', () => {
  it('names a success result that is marked as an error', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    answer(await h.query(0), { is_error: true, result: 'something odd' })
    await agent.whenIdle()
    expect(lastEnd(agent).reason.error.message).toContain('success result marked as an error')
  })

  it('falls back to the subtype when an error result carries no error list', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    answer(await h.query(0), { subtype: 'error_during_execution', is_error: true, errors: [] })
    await agent.whenIdle()
    expect(lastEnd(agent).reason.error.message).toContain('error_during_execution')
    expect(lastEnd(agent).reason.error.code).toBe('CLAUDE_CODE_ERROR_DURING_EXECUTION')
  })

  it('fails the turn with the stream error when the iterator throws without an abort', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.fail(new Error('stream broke'))
    await agent.whenIdle()
    expect(lastEnd(agent).reason.error.code).toBe('UNKNOWN')
    expect(lastEnd(agent).reason.error.message).toContain('stream broke')
    expect(lastEnd(agent).reason.error.code).not.toBe(CLAUDE_CODE_TURN_ERROR_CODES.paused)
  })
})

describe('pause signal shapes', () => {
  const assistantError = (error: string, content?: unknown[]): SDKMessage => ({
    type: 'assistant', error, message: content === undefined ? {} : { content }, uuid: 'a', session_id: 's', parent_tool_use_id: null,
  }) as unknown as SDKMessage

  it('reads a rate_limit assistant message with non-text blocks as a plain rate limit', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.emit(assistantError('rate_limit', [{ type: 'tool_use' }, { type: 'text', text: 42 }]))
    await agent.whenIdle()
    const paused = agent.session.events.filter(event => event.type === 'claude-code/paused').map(event => event.data as { reason: string })
    expect(paused).toMatchObject([{ reason: 'rate-limit' }])
  })

  it('does not pause on an unrelated assistant error', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.emit(assistantError('server_error'))
    answer(query)
    await agent.whenIdle()
    expect(agent.session.events.some(event => event.type === 'claude-code/paused')).toBe(false)
    expect(agent.pausedUntilMs).toBe(0)
  })
})

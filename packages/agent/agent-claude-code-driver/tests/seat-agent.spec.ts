import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CODE_TURN_ERROR_CODES } from '../src/seat-agent.ts'
import { framed, harness, resultMessage, seatConfig, tick, userMessage } from './fakes.ts'
import type { FakeQuery, Harness } from './fakes.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const types = (h: Harness, sessionId: string): string[] =>
  h.ctx.sessions.get(sessionId as never)?.events.map(event => event.type) ?? []

function dataOf(session: { events: readonly { type: string; data: unknown }[] }, type: string): Record<string, unknown>[] {
  return session.events.filter(event => event.type === type).map(event => event.data as Record<string, unknown>)
}

/** Answer every consumed prompt message, the way the CLI's result names the messages it answers. */
function answer(query: FakeQuery, overrides: Record<string, unknown> = {}): void {
  query.emit(resultMessage({ user_message_uuids: query.uuids(), ...overrides }))
}

describe('session binding', () => {
  it('records session-bound BEFORE the first prompt reaches the query and pins that id', async () => {
    const h = await harness()
    const agent = h.agent()
    let boundAtQueryTime: Record<string, unknown> | undefined
    const original = h.deps.query
    ;(h.deps as { query: typeof original }).query = (params) => {
      boundAtQueryTime = dataOf(agent.session, 'claude-code/session-bound')[0]
      return original(params)
    }
    agent.followup(userMessage('hello'))
    const query = await h.query(0)
    expect(boundAtQueryTime).toMatchObject({ sessionId: agent.id, model: 'sonnet', driver: 'claude-code', version: 1 })
    const sdkSessionId = boundAtQueryTime?.['sdkSessionId'] as string
    expect(sdkSessionId).toMatch(UUID)
    expect(query.options.sessionId).toBe(sdkSessionId)
    expect(query.options).not.toHaveProperty('resume')
    expect(query.options.persistSession).toBe(true)
    await tick(5)
    expect(query.consumed.map(message => message.message.content)).toEqual([framed('hello')])
    answer(query)
    await agent.whenIdle()
  })

  it('leaves the binding recorded when the query fails before any prompt is processed', async () => {
    const h = await harness()
    const agent = h.agent()
    h.state.failNextQuery = new Error('spawn exploded')
    h.state.transcript = 'missing'
    agent.followup(userMessage('first'))
    await agent.whenIdle()
    const bound = dataOf(agent.session, 'claude-code/session-bound')
    expect(bound).toHaveLength(1)
    expect(dataOf(agent.session, 'claude-code/turn-completed')).toEqual([])
    const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { kind: string; error?: { message: string } } }
    expect(end.reason.kind).toBe('error')
    expect(end.reason.error?.message).toContain('spawn exploded')
    // The next turn must reuse the SAME bound id (nothing was completed, so nothing is lost), not mint a second binding.
    agent.followup(userMessage('retry'))
    const query = await h.query(0)
    expect(query.options.sessionId).toBe(bound[0]?.['sdkSessionId'])
    expect(dataOf(agent.session, 'claude-code/session-bound')).toHaveLength(1)
    answer(query)
    await agent.whenIdle()
  })

  it('refuses to send a prompt when the binding cannot be written durably', async () => {
    const h = await harness()
    const agent = h.agent()
    ;(agent.session as unknown as { append: unknown }).append = ((type: string, data: unknown) => {
      if (type === 'claude-code/session-bound') throw new Error('disk full')
      return (Object.getPrototypeOf(agent.session) as { append: (t: string, d: unknown) => unknown }).append.call(agent.session, type, data)
    })
    agent.followup(userMessage('x'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(h.warnings.join('\n')).toContain('append failed')
  })

  it('resumes the bound session on later turns with persistSession and the same id', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('one'))
    const first = await h.query(0)
    answer(first)
    await agent.whenIdle()
    h.state.transcript = 'missing' // already verified in-process: must not be re-checked
    agent.followup(userMessage('two'))
    const second = await h.query(1)
    expect(second.options.resume).toBe(first.options.sessionId)
    expect(second.options).not.toHaveProperty('sessionId')
    expect(second.options.persistSession).toBe(true)
    answer(second)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/session-bound')).toHaveLength(1)
    expect(dataOf(agent.session, 'claude-code/turn-completed').map(event => event['turnIndex'])).toEqual([1, 2])
  })

  it('resumes after a cold start from the log (fresh agent, same session)', async () => {
    const h = await harness()
    const first = h.agent()
    first.followup(userMessage('one'))
    const q0 = await h.query(0)
    answer(q0)
    await first.whenIdle()
    const cold = h.agent({ session: first.session })
    h.state.transcript = 'ok'
    cold.followup(userMessage('after restart'))
    const q1 = await h.query(1)
    expect(q1.options.resume).toBe(q0.options.sessionId)
    answer(q1)
    await cold.whenIdle()
    expect(dataOf(cold.session, 'claude-code/turn-completed').map(event => event['turnIndex'])).toEqual([1, 2])
  })

  it('rejects a resume with a missing transcript loudly, records resume-failed, and keeps the mail queued', async () => {
    const h = await harness()
    const first = h.agent()
    first.followup(userMessage('one'))
    answer(await h.query(0))
    await first.whenIdle()
    const cold = h.agent({ session: first.session })
    h.state.transcript = 'missing'
    cold.followup(userMessage('please continue'))
    await cold.whenIdle()
    expect(h.queries).toHaveLength(1)
    const failed = dataOf(cold.session, 'claude-code/resume-failed')
    expect(failed).toEqual([expect.objectContaining({ reason: 'transcript-missing', version: 1 })])
    const end = cold.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { kind: string; error: { code: string; message: string } } }
    expect(end.reason.kind).toBe('error')
    expect(end.reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.resumeFailed)
    expect(end.reason.error.message).toMatch(/needs a re-seed.*will not start fresh silently/)
    expect(cold.inbox.nextTurn).toHaveLength(1)
    expect(dataOf(cold.session, 'claude-code/session-bound')).toHaveLength(1)
  })

  it('treats an unreadable transcript as a failed resume even before any turn completed', async () => {
    const h = await harness()
    const agent = h.agent()
    h.state.failNextQuery = new Error('boom')
    agent.followup(userMessage('a'))
    await agent.whenIdle()
    h.state.transcript = 'unreadable'
    agent.followup(userMessage('b'))
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/resume-failed')).toEqual([expect.objectContaining({ reason: 'transcript-unreadable' })])
    expect(h.queries).toHaveLength(0)
  })

  it('records the turn result, mapped from named fields only', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('go'))
    answer(await h.query(0))
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/turn-completed')).toEqual([{
      version: 1, turnIndex: 1, outcome: 'success', isError: false, model: 'sonnet', numTurns: 2, durationMs: 50,
      durationApiMs: 40, estimatedCostUsd: 0.02, stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
      modelUsage: { 'claude-sonnet-x': {
        inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 4,
        estimatedCostUsd: 0.02, webSearchRequests: 0,
      } },
    }])
    expect(types(h, agent.id)).toEqual(expect.arrayContaining(['turn/start', 'step/start', 'user/message', 'step/end', 'turn/end']))
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('maps an error result to a coded failed turn and does not spin on queued mail', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('go'))
    agent.followup(userMessage('and then'))
    const query = await h.query(0)
    answer(query, { subtype: 'error_max_turns', is_error: true, errors: ['too many'] })
    await agent.whenIdle()
    const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { code: string; message: string } } }
    expect(end.reason.error.code).toBe('CLAUDE_CODE_ERROR_MAX_TURNS')
    expect(end.reason.error.message).toContain('too many')
    expect(h.queries).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })

  it('fails a turn whose query ends without a result', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('go'))
    const query = await h.query(0)
    query.finish()
    await agent.whenIdle()
    const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { code: string } } }
    expect(end.reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.noResult)
  })
})

describe('steering', () => {
  it('pushes a second message into the open stream while a tool is running, then closes after the result', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('start the long job'))
    const query = await h.query(0)
    await tick(5)
    expect(query.consumed).toHaveLength(1)
    expect(query.promptEnded).toBe(false) // stream stays open while the turn is running

    agent.steer(userMessage('actually, stop and report'))
    await tick(5)
    expect(query.consumed.map(message => message.message.content)).toEqual([framed('start the long job'), framed('actually, stop and report')])
    expect(query.promptEnded).toBe(false)
    expect(h.queries).toHaveLength(1) // one live query, not a second one
    expect(dataOf(agent.session, 'claude-code/steer')).toEqual([expect.objectContaining({ kind: 'push' })])
    expect(dataOf(agent.session, 'user/message')).toHaveLength(2)
    expect(agent.inbox.hasPending).toBe(false)

    answer(query)
    await agent.whenIdle()
    expect(query.promptEnded).toBe(true)
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
    expect(h.queries).toHaveLength(1)
  })

  it('keeps the stream open when a result answers only part of what was pushed', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('one'))
    const query = await h.query(0)
    await tick(5)
    agent.steer(userMessage('two'))
    await tick(5)
    const [firstUuid, secondUuid] = query.uuids()
    query.emit(resultMessage({ user_message_uuids: [firstUuid] }))
    await tick(5)
    expect(query.promptEnded).toBe(false)
    query.emit(resultMessage({ user_message_uuids: [secondUuid] }))
    await agent.whenIdle()
    expect(query.promptEnded).toBe(true)
    expect(dataOf(agent.session, 'claude-code/turn-completed')).toHaveLength(1)
  })

  it('treats a result that names none of our messages as answering everything', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('one'))
    const query = await h.query(0)
    query.emit(resultMessage())
    await agent.whenIdle()
    expect(query.promptEnded).toBe(true)
  })

  it('starts a turn when steered while idle, and follow-ups wait for the next turn', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.steer(userMessage('wake up'))
    const query = await h.query(0)
    agent.followup(userMessage('later'))
    await tick(5)
    expect(query.consumed).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    answer(query)
    const second = await h.query(1)
    answer(second)
    await agent.whenIdle()
    expect(second.consumed.map(message => message.message.content)).toEqual([framed('later')])
    expect(second.options.resume).toBeDefined()
  })

  it('uses the interrupt fallback: interrupt, tolerate the throwing iterator, deliver by resumed query', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('long task'))
    const first = await h.query(0)
    await tick(5)
    const delivery = agent.interruptAndResume(userMessage('urgent change'))
    const second = await h.query(1)
    await delivery
    expect(first.interrupted).toBe(true)
    expect(first.closed).toBe(true)
    expect(second.options.resume).toBe(first.options.sessionId)
    await tick(5)
    expect(second.consumed.map(message => message.message.content)).toEqual([framed('urgent change')])
    expect(dataOf(agent.session, 'claude-code/steer')).toEqual([expect.objectContaining({ kind: 'interrupt-push' })])
    const ends = dataOf(agent.session, 'turn/end') as { reason: { kind: string } }[]
    expect(ends[0]?.reason.kind).toBe('aborted')
    answer(second)
    await agent.whenIdle()
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data).toEqual({ turn: 2, reason: { kind: 'completed' } })
  })

  it('wakes an idle agent when the interrupt fallback has nothing to interrupt', async () => {
    const h = await harness()
    const agent = h.agent()
    await agent.interruptAndResume(userMessage('wake'))
    const query = await h.query(0)
    answer(query)
    await agent.whenIdle()
    expect(query.consumed).toHaveLength(1)
  })

  it('logs but survives a failing interrupt', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('task'))
    const first = await h.query(0)
    first.interrupt = () => Promise.reject(new Error('already gone'))
    const delivery = agent.interruptAndResume(userMessage('next'))
    const second = await h.query(1)
    await delivery
    expect(h.warnings.join('\n')).toContain('interrupt failed: already gone')
    answer(second)
    await agent.whenIdle()
  })
})

describe('cancel and process ownership', () => {
  it('aborts the controller, closes the query, terminates the group, ends the turn cancelled, and clears the inbox', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.spawn()
    expect(agent.inbox.hasPending).toBe(false)
    agent.followup(userMessage('queued behind'))
    expect(agent.cancel({ kind: 'user' })).toBe(true)
    expect(query.options.abortController?.signal.aborted).toBe(true)
    expect(agent.inbox.hasPending).toBe(false)
    await agent.whenIdle()
    expect(query.closed).toBe(true)
    expect(h.children[0]?.terminate).toHaveBeenCalled()
    expect(h.killed).toEqual([]) // the subprocess owner proved the tree gone
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data).toEqual({
      turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    expect(dataOf(agent.session, 'claude-code/turn-completed')).toEqual([])
    expect(h.gate.isHeld('tester')).toBe(false)
  })

  it('kills the process group directly when the owner cannot prove the tree exited', async () => {
    const h = await harness({ childPid: 5151, childExitsOnWait: false })
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.spawn()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(h.children[0]?.terminate).toHaveBeenCalled()
    expect(h.killed).toEqual([5151])
  })

  it('keeps pending mail when cancelled with keepInbox, and reports an idle cancel as a no-op', async () => {
    const h = await harness()
    const agent = h.agent()
    expect(agent.cancel({ kind: 'user' })).toBe(false)
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    agent.followup(userMessage('keep me'))
    expect(agent.cancel({ kind: 'user' }, { keepInbox: true })).toBe(true)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(query.closed).toBe(true)
    // the kept mail starts a fresh turn on the next wake
    agent.followup(userMessage('and wake'))
    // each turn claims one queued message: the kept mail first, then the wake mail
    answer(await h.query(1))
    answer(await h.query(2))
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('records the pid at spawn, spawns through the pinned absolute path, and clears the ledger at exit', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    expect(query.options.pathToClaudeCodeExecutable).toBe('/opt/claude/versions/2.1.317/claude')
    const process = query.spawn()
    expect(h.ledger.entries()).toEqual([{ seat: 'tester', pid: 4242, startTime: 'tick-1', hostPid: 777, hostStartTime: 'host-tick', bootId: 'boot-1' }])
    expect(process).toBeDefined()
    h.children[0]?.finish()
    await tick(10)
    expect(h.ledger.entries()).toEqual([])
    answer(query)
    await agent.whenIdle()
  })

  it('survives ledger failures with a warning', async () => {
    const h = await harness()
    ;(h.deps as { ledger: unknown }).ledger = {
      record: () => { throw new Error('read-only fs') },
      clear: () => { throw new Error('read-only fs') },
    }
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.spawn()
    h.children[0]?.finish()
    await tick(10)
    answer(query)
    await agent.whenIdle()
    expect(h.warnings.filter(w => w.includes('ledger'))).toHaveLength(2)
  })

  it('tolerates close() and terminate() throwing during teardown', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.close = () => { throw new Error('already closed') }
    query.spawn()
    ;(h.children[0] as unknown as { terminate: () => void }).terminate = () => { throw new Error('gone') }
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(h.warnings.join('\n')).toContain('query.close() failed')
    expect(h.warnings.join('\n')).toContain('terminate failed')
  })
})

describe('environment and the phase machine', () => {
  it('passes a child environment with no credential overrides and refuses to run when the host has one', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    expect(query.options.env).toEqual({ PATH: '/usr/bin', HOME: '/home/x' })
    answer(query)
    await agent.whenIdle()

    h.state.hostEnv = { ANTHROPIC_API_KEY: 'sk-live' }
    agent.followup(userMessage('again'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(1)
    const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { message: string } } }
    expect(end.reason.error.message).toMatch(/refusing to run: ANTHROPIC_API_KEY/)
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })

  it('runs exactly one live query per agent: a follow-up during a turn queues instead of starting another', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('one'))
    const query = await h.query(0)
    agent.followup(userMessage('two'))
    await tick(5)
    expect(h.queries).toHaveLength(1)
    expect(agent.status).toBe('running')
    expect(agent.inbox.nextTurn).toHaveLength(1)
    answer(query)
    const second = await h.query(1)
    answer(second)
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
  })

  it('rejects a second agent turn for the same seat while one is live, with a clear coded error', async () => {
    const h = await harness()
    const a = h.agent()
    const b = h.agent()
    a.followup(userMessage('first'))
    const query = await h.query(0)
    b.followup(userMessage('second'))
    await b.whenIdle()
    expect(h.queries).toHaveLength(1)
    const end = b.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { code: string; message: string } } }
    expect(end.reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.busy)
    expect(end.reason.error.message).toMatch(/already has a live Claude Code query/)
    expect(b.inbox.nextTurn).toHaveLength(1)
    answer(query)
    await a.whenIdle()
    // once the first turn is over the slot is free
    b.followup(userMessage('third'))
    // each turn claims one queued message: the refused 'second' first, then 'third'
    answer(await h.query(1))
    answer(await h.query(2))
    await b.whenIdle()
    expect(b.inbox.nextTurn).toHaveLength(0)
  })

  it('refuses non-text content instead of dropping it', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup({ ...userMessage('x'), content: [{ type: 'image', url: 'u' }] } as never)
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { message: string } } }
    expect(end.reason.error.message).toContain('text only')
  })

  it('refuses sends after disposal and runs maintenance only when idle', async () => {
    const h = await harness()
    const agent = h.agent()
    const done = agent.runMaintenance(() => tick(5).then(() => 'ok'))
    expect(() => agent.runMaintenance(() => Promise.resolve())).toThrow(/already has active work/)
    agent.followup(userMessage('latched during maintenance'))
    expect(await done).toBe('ok')
    answer(await h.query(0))
    await agent.whenIdle()
    agent.cancel({ kind: 'disposed' })
    expect(() => { agent.followup(userMessage('too late')) }).toThrow(/agent is disposed/)
    agent.inject(userMessage('context is still accepted'))
  })
})

describe('subscription-window pause', () => {
  const rateLimited = (resetsAt?: number): SDKMessage => ({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', ...resetsAt === undefined ? {} : { resetsAt } },
    uuid: 'u', session_id: 's',
  }) as unknown as SDKMessage

  it('pauses the seat on a rejected rate-limit event: paused record with the reset time, failed turn, mail kept', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    const resetsAtSeconds = h.state.now / 1000 + 3600
    query.emit(rateLimited(resetsAtSeconds))
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/paused')).toEqual([
      { version: 1, reason: 'rate-limit', until: resetsAtSeconds * 1000, at: h.state.now },
    ])
    const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { kind: string; error: { code: string; message: string } } }
    expect(end.reason.kind).toBe('error')
    expect(end.reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.paused)
    expect(end.reason.error.message).toContain('retry after that time')
    expect(dataOf(agent.session, 'claude-code/turn-completed')).toEqual([])
    expect(query.closed).toBe(true)
    expect(agent.pausedUntilMs).toBe(resetsAtSeconds * 1000)

    // while paused no new query starts and the mail stays queued
    agent.followup(userMessage('another'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    const refused = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { message: string } } }
    expect(refused.reason.error.message).toMatch(/is paused until .* its mail stays queued/)

    // the window reopens
    h.state.now += 3601_000
    agent.followup(userMessage('and again'))
    // each turn claims one queued message: 'another' first, then 'and again'
    answer(await h.query(1))
    answer(await h.query(2))
    await agent.whenIdle()
    expect(agent.pausedUntilMs).toBe(0)
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('uses the default pause when no reset time is known, and clearPause lifts it early', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.emit({ type: 'assistant', error: 'rate_limit', message: {}, uuid: 'a', session_id: 's', parent_tool_use_id: null } as unknown as SDKMessage)
    query.emit(rateLimited()) // a second signal in the same turn does not double-record
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/paused')).toEqual([{ version: 1, reason: 'rate-limit', until: h.state.now + 60_000, at: h.state.now }])
    agent.clearPause()
    expect(agent.pausedUntilMs).toBe(0)
  })

  it.each([
    ['a billing error on an assistant message', { type: 'assistant', error: 'billing_error', message: {}, uuid: 'a', session_id: 's', parent_tool_use_id: null }, 'usage-exhausted'],
    ['an overage rejection', { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'overage', resetsAt: 1_900_000_000_000 }, uuid: 'u', session_id: 's' }, 'usage-exhausted'],
    ['a credits-required rejection', { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', errorCode: 'credits_required' }, uuid: 'u', session_id: 's' }, 'usage-exhausted'],
    ['a usage-limit message on a rate_limit assistant error', { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit" }] }, uuid: 'a', session_id: 's', parent_tool_use_id: null }, 'usage-exhausted'],
    ['a usage-limit message as an error result', { ...resultMessage(), is_error: true, result: "You're out of usage credits" }, 'usage-exhausted'],
    ['an HTTP 429 on the result', { ...resultMessage(), api_error_status: 429 }, 'rate-limit'],
  ])('pauses on %s', async (_label, message, reason) => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.emit(message as unknown as SDKMessage)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/paused')[0]).toMatchObject({ reason })
  })

  it('ignores an allowed rate-limit event and a clean assistant message', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' }, uuid: 'u', session_id: 's' } as unknown as SDKMessage)
    query.emit({ type: 'assistant', message: {}, uuid: 'a', session_id: 's', parent_tool_use_id: null } as unknown as SDKMessage)
    answer(query)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/paused')).toEqual([])
  })
})

describe('config wiring', () => {
  it('records the configured model in the binding', async () => {
    const h = await harness()
    const agent = h.agent({ config: seatConfig({ model: 'haiku', role: 'mail-only' }) })
    agent.followup(userMessage('triage'))
    const query = await h.query(0)
    expect(query.options.model).toBe('haiku')
    expect(query.options.tools).toEqual([])
    expect(dataOf(agent.session, 'claude-code/session-bound')[0]).toMatchObject({ model: 'haiku' })
    answer(query)
    await agent.whenIdle()
  })
})

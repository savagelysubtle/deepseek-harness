import { describe, expect, it, vi } from 'vitest'
import { recordClaudeCodeEvent } from '@deepseek-ai/dsh-agent-claude-code'
import type { Session } from '@deepseek-ai/dsh-session'
import { MailLog } from '../src/mail-lease.ts'
import type { SeatAgentDeps } from '../src/seat-agent.ts'
import { framed, harness, mailMessage, resultMessage, tick, userMessage } from './fakes.ts'
import type { FakeQuery, Harness } from './fakes.ts'

function dataOf(session: Session, type: string): Record<string, unknown>[] {
  return session.events.filter(event => event.type === type).map(event => event.data as Record<string, unknown>)
}

function answer(query: FakeQuery, overrides: Record<string, unknown> = {}): void {
  query.emit(resultMessage({ user_message_uuids: query.uuids(), ...overrides }))
}

const claim = (session: Session, messageId: string): void => {
  recordClaudeCodeEvent(session, 'claude-code/mail-claimed', { messageId, tainted: false, at: 1 })
}
const outcome = (session: Session, messageId: string, state: 'settled' | 'failed' | 'paused'): void => {
  recordClaudeCodeEvent(session, 'claude-code/mail-outcome', { messageId, outcome: state, reason: '', at: 2 })
}

/** Run one mailbox message through a whole turn and return the harness pieces. */
async function runOne(h: Harness, messageId: string, overrides: Record<string, unknown> = {}) {
  const agent = h.agent()
  agent.followup(mailMessage('please help', messageId))
  const query = await h.query(0)
  answer(query, overrides)
  await agent.whenIdle()
  return { agent, query }
}

describe('MailLog', () => {
  it('rebuilds states from the log, last record winning, and ignores records without an id', async () => {
    const h = await harness()
    const session = h.session()
    claim(session, 'a')
    claim(session, 'b')
    outcome(session, 'b', 'settled')
    outcome(session, 'c', 'paused')
    session.append('user/message', userMessage('x'), { surfaceOp: 'append' })
    const log = new MailLog(session)
    expect([log.get('a'), log.get('b'), log.get('c'), log.get('z')]).toEqual(['claimed', 'settled', 'paused', undefined])
    log.set('a', 'failed')
    expect(log.get('a')).toBe('failed')
  })
})

describe('claim, flush, prompt, settle ordering', () => {
  it('writes the claim record and flushes it before the prompt, then records the outcome and settles the lease', async () => {
    const h = await harness()
    const agent = h.agent()
    let claimedAtQuery: Record<string, unknown>[] = []
    const original = h.deps.query
    ;(h.deps as { query: typeof original }).query = (params) => {
      claimedAtQuery = dataOf(agent.session, 'claude-code/mail-claimed')
      return original(params)
    }
    agent.followup(mailMessage('please help', 'm-1', { tainted: false }))
    const query = await h.query(0)
    expect(claimedAtQuery).toEqual([expect.objectContaining({ messageId: 'm-1', tainted: false })])
    // binding flush, claim flush, then the query: nothing is sent before the claim is durable.
    expect(h.state.calls).toEqual(['flush', 'flush', 'query'])
    expect(h.state.leases).toEqual([])
    answer(query)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/mail-outcome')).toEqual([
      expect.objectContaining({ messageId: 'm-1', outcome: 'settled', reason: '' }),
    ])
    expect(h.state.leases).toEqual(['settle:m-1'])
    const order = agent.session.events.map(event => event.type)
    expect(order.indexOf('claude-code/mail-claimed')).toBeLessThan(order.indexOf('claude-code/mail-outcome'))
    expect(query.consumed.map(message => message.message.content)).toEqual([framed('please help')])
  })

  it('does not record or settle anything for a message that is not mailbox mail', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('typed by hand'))
    answer(await h.query(0))
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/mail-claimed')).toEqual([])
    expect(dataOf(agent.session, 'claude-code/mail-outcome')).toEqual([])
    expect(h.state.leases).toEqual([])
  })

  it('works without a lease sink: records are written, no lease call is made', async () => {
    const h = await harness()
    ;(h.deps as { lease: undefined }).lease = undefined
    const { agent } = await runOne(h, 'm-nolease')
    expect(dataOf(agent.session, 'claude-code/mail-outcome')).toEqual([expect.objectContaining({ outcome: 'settled' })])
    expect(h.state.leases).toEqual([])
  })

  it('fails the lease and sends nothing when the claim record cannot be made durable', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('warm up'))
    answer(await h.query(0))
    await agent.whenIdle()
    h.state.flushError = new Error('disk full')
    agent.followup(mailMessage('second', 'm-flush'))
    await tick(20)
    await agent.whenIdle()
    expect(h.queries).toHaveLength(1)
    expect(dataOf(agent.session, 'claude-code/mail-outcome')).toEqual([expect.objectContaining({ messageId: 'm-flush', outcome: 'failed' })])
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-flush:.*claim records durable/)])
  })

  it('a lease call that throws is a warning, never a failed turn', async () => {
    const h = await harness()
    h.state.leaseError = new Error('bridge down')
    const { agent } = await runOne(h, 'm-throw')
    expect(h.warnings.some(line => line.includes('mailbox lease call failed') && line.includes('bridge down'))).toBe(true)
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })
})

describe('how a turn ends decides the lease', () => {
  it('fails the lease with the error text when the turn fails', async () => {
    const h = await harness()
    const { agent } = await runOne(h, 'm-err', { subtype: 'error_max_turns', is_error: true, errors: ['too many'] })
    expect(dataOf(agent.session, 'claude-code/mail-outcome')).toEqual([expect.objectContaining({ outcome: 'failed' })])
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-err:Claude Code failed: too many/)])
  })

  it('records paused and fails the lease when the subscription window refuses work mid-turn', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('go', 'm-pause'))
    const query = await h.query(0)
    query.emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_800_000_900 },
      uuid: 'u', session_id: 's',
    } as never)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/mail-outcome')).toEqual([expect.objectContaining({ outcome: 'paused' })])
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-pause:.*subscription window refused work.*paused until/)])
  })

  it('fails the running mail and the queued mail when the agent is cancelled', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('running', 'm-run'))
    await h.query(0)
    agent.followup(mailMessage('queued', 'm-queued'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(h.state.leases).toHaveLength(2)
    expect(h.state.leases.some(line => line.startsWith('fail:m-queued:cancelled before delivery'))).toBe(true)
    expect(h.state.leases.some(line => line.startsWith('fail:m-run:the turn was cancelled or interrupted'))).toBe(true)
    expect(dataOf(agent.session, 'claude-code/mail-outcome').map(data => data['outcome'])).toEqual(['failed', 'failed'])
  })

  it('ends the turn quietly when every claimed mail was a duplicate', async () => {
    const h = await harness()
    const session = h.session()
    claim(session, 'm-dup')
    outcome(session, 'm-dup', 'settled')
    const agent = h.agent({ session })
    agent.followup(mailMessage('again', 'm-dup'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(h.state.leases).toEqual(['settle:m-dup'])
    expect(session.events.findLast(event => event.type === 'turn/end')?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })
})

describe('redelivery', () => {
  it('settles a message whose first copy already settled, without running it again', async () => {
    const h = await harness()
    const { agent } = await runOne(h, 'm-redo')
    expect(h.state.leases).toEqual(['settle:m-redo'])
    agent.followup(mailMessage('please help', 'm-redo'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(1)
    expect(h.state.leases).toEqual(['settle:m-redo', 'settle:m-redo'])
    expect(dataOf(agent.session, 'claude-code/mail-claimed')).toHaveLength(1)
  })

  it('never runs mail claimed before a crash and left without an outcome; fails the lease loudly instead', async () => {
    const h = await harness()
    const session = h.session()
    claim(session, 'm-crash')
    const agent = h.agent({ session })
    agent.followup(mailMessage('again', 'm-crash'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(dataOf(session, 'claude-code/refused')).toEqual([
      expect.objectContaining({ reason: 'duplicate-in-flight', messageId: 'm-crash', detail: expect.stringContaining('already claimed') as string }),
    ])
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-crash:redelivered after it was already claimed; not run again/)])
    expect(h.warnings.some(line => line.includes('dropped mailbox message m-crash'))).toBe(true)
  })

  it.each(['failed', 'paused'] as const)('does not rerun mail whose first copy ended %s', async (state) => {
    const h = await harness()
    const session = h.session()
    claim(session, 'm-end')
    outcome(session, 'm-end', state)
    const agent = h.agent({ session })
    agent.followup(mailMessage('again', 'm-end'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(h.state.leases).toEqual([expect.stringContaining(`already ${state}`)])
  })

  it('drops a copy redelivered while the first is still running, without failing the shared lease', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('first', 'm-live'))
    const query = await h.query(0)
    agent.steer(mailMessage('first again', 'm-live'))
    await tick(5)
    expect(query.consumed).toHaveLength(1)
    expect(dataOf(agent.session, 'claude-code/refused')).toEqual([
      expect.objectContaining({ reason: 'duplicate-in-flight', detail: expect.stringContaining('still running') as string }),
    ])
    expect(h.state.leases).toEqual([])
    answer(query)
    await agent.whenIdle()
    expect(h.state.leases).toEqual(['settle:m-live'])
  })

  it('does not run mail whose claim record cannot be written, and fails its lease', async () => {
    const h = await harness()
    const agent = h.agent()
    const original = agent.session.append.bind(agent.session) as (type: string, data: unknown, options?: unknown) => unknown
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, data: unknown, options?: unknown) => {
      if (type === 'claude-code/mail-claimed') throw new Error('log closed')
      return original(type, data, options)
    }) as never)
    agent.followup(mailMessage('odd', 'm-noclaim'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-noclaim:the claim record could not be written/)])
  })

  it('leaves no record for a failure before the claim, so the retry runs the mail exactly once', async () => {
    const h = await harness()
    const agent = h.agent()
    h.state.killSwitch = true
    agent.followup(mailMessage('important', 'm-retry'))
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/mail-claimed')).toEqual([])
    expect(h.state.leases).toEqual([])
    expect(agent.inbox.nextTurn).toHaveLength(1)

    h.state.killSwitch = false
    agent.followup(userMessage('nudge'))
    answer(await h.query(0))
    await tick(10)
    answer(await h.query(1))
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/mail-claimed')).toEqual([expect.objectContaining({ messageId: 'm-retry' })])
    expect(h.state.leases).toEqual(['settle:m-retry'])
  })

  it('fails the lease of queued mail when the seat cannot resume, and takes it off the queue; typed input stays', async () => {
    const h = await harness()
    const first = h.agent()
    first.followup(userMessage('warm up'))
    answer(await h.query(0))
    await first.whenIdle()
    h.state.transcript = 'missing'
    const second = h.agent({ session: first.session })
    second.inject(mailMessage('queued steering', 'm-step'))
    second.followup(mailMessage('important', 'm-resume'))
    second.followup(userMessage('typed'))
    await second.whenIdle()
    expect(dataOf(second.session, 'claude-code/resume-failed')).toHaveLength(1)
    expect(dataOf(second.session, 'claude-code/mail-claimed')).toEqual([])
    expect(h.state.leases).toHaveLength(2)
    expect(h.state.leases.every(line => line.includes('needs a re-seed'))).toBe(true)
    expect(dataOf(second.session, 'claude-code/mail-outcome').map(data => data['outcome'])).toEqual(['failed', 'failed'])
    expect(second.inbox.nextStep).toHaveLength(0)
    expect(second.inbox.nextTurn).toHaveLength(1)
    expect(second.inbox.nextTurn[0]?.source.kind).toBe('user')
    expect(h.state.leases.some(line => line.startsWith('fail:m-resume:') && line.includes('The queued mail was not delivered'))).toBe(true)
  })
})

describe('steered mail', () => {
  it('claims and flushes before it pushes, then settles both mails when the turn is answered', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('start', 'm-a'))
    const query = await h.query(0)
    await tick(5)
    const flushesBefore = h.state.calls.filter(call => call === 'flush').length
    agent.steer(mailMessage('change course', 'm-b'))
    expect(query.consumed).toHaveLength(1) // not pushed until the claim record is durable
    await tick(5)
    expect(h.state.calls.filter(call => call === 'flush').length).toBe(flushesBefore + 1)
    expect(query.consumed.map(message => message.message.content)).toEqual([framed('start'), framed('change course')])
    answer(query)
    await agent.whenIdle()
    expect(h.state.leases.sort()).toEqual(['settle:m-a', 'settle:m-b'])
  })

  it('fails a steered mail whose claim record is not durable, and still lets the turn finish', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('start', 'm-a'))
    const query = await h.query(0)
    await tick(5)
    h.state.flushError = new Error('disk full')
    agent.steer(mailMessage('change course', 'm-b'))
    await tick(10)
    expect(query.consumed).toHaveLength(1)
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-b:.*claim records durable/)])
    h.state.flushError = undefined
    answer(query)
    await agent.whenIdle()
    expect(query.promptEnded).toBe(true)
    expect(h.state.leases).toContain('settle:m-a')
  })

  it('ends the stream when the answer came while a failing flush was pending', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('start', 'm-a'))
    const query = await h.query(0)
    await tick(5)
    const pending = Promise.withResolvers<undefined>()
    ;(h.deps as { flush: SeatAgentDeps['flush'] }).flush = () => pending.promise
    agent.steer(mailMessage('late', 'm-late'))
    answer(query)
    await tick(5)
    expect(query.promptEnded).toBe(false) // the steered mail is still on its way
    pending.reject(new Error('disk full'))
    await agent.whenIdle()
    expect(query.promptEnded).toBe(true)
    expect(h.state.leases.some(line => line.startsWith('fail:m-late:'))).toBe(true)
  })

  it('pushes a steered mail whose flush finishes after the first answer, and keeps the stream open for it', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('start', 'm-a'))
    const query = await h.query(0)
    await tick(5)
    const pending = Promise.withResolvers<undefined>()
    ;(h.deps as { flush: SeatAgentDeps['flush'] }).flush = () => pending.promise
    agent.steer(mailMessage('late', 'm-late'))
    answer(query)
    await tick(5)
    pending.resolve(undefined)
    await tick(5)
    expect(query.consumed).toHaveLength(2)
    expect(query.promptEnded).toBe(false)
    answer(query)
    await agent.whenIdle()
    expect(h.state.leases.sort()).toEqual(['settle:m-a', 'settle:m-late'])
  })

  it('fails a steered mail whose turn ended while its claim record was being flushed', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('start', 'm-a'))
    const query = await h.query(0)
    await tick(5)
    const pending = Promise.withResolvers<undefined>()
    ;(h.deps as { flush: SeatAgentDeps['flush'] }).flush = () => pending.promise
    agent.steer(mailMessage('late', 'm-late'))
    agent.cancel({ kind: 'user' })
    await tick(10)
    pending.resolve(undefined)
    await agent.whenIdle()
    expect(query.consumed).toHaveLength(1)
    expect(h.state.leases.some(line => line.startsWith('fail:m-late:'))).toBe(true)
  })
})

describe('whenIdle', () => {
  it('waits for lease calls that are still running', async () => {
    const h = await harness()
    const slow = Promise.withResolvers<undefined>()
    ;(h.deps as { lease: unknown }).lease = { settle: () => slow.promise, fail: () => undefined }
    const agent = h.agent()
    agent.followup(mailMessage('please help', 'm-slow'))
    answer(await h.query(0))
    let done = false
    void agent.whenIdle().then(() => { done = true })
    await tick(10)
    expect(done).toBe(false)
    slow.resolve(undefined)
    await agent.whenIdle()
    expect(done).toBe(true)
  })
})

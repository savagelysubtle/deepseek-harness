import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { createUserMessage, markAgentLoopRequest, type GenerateOptions  } from '@deepseek-ai/dsh-llm'
import { buildClockMessage } from '../src/clock.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AgentLoopInvariant)
  return ctx
}

function dispatch(ctx: Context, options: unknown): void {
  void ctx.waterfall('llm/stream', options as never, () => (async function* () {})() as never)
}

function loopRequest<T extends object>(options: T): Readonly<T> {
  markAgentLoopRequest(options as GenerateOptions)
  return Object.freeze(options)
}

async function requestSetup() {
  const ctx = await setup()
  const session = ctx.sessions.create(SessionId('req-check'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const boundary = session.deriveMessages()
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'mock', model: 'm' } }, reason: 'initial' })
  return { ctx, session, boundary }
}

/** A well-formed clock tail, fixed so tests stay deterministic. */
function clockTail() {
  return buildClockMessage(() => new Date('2026-09-29T16:13:00Z'))
}

describe('request-reconstruction invariant', () => {
  it('accepts a frozen request equal to the boundary derivation plus a trailing clock message and folded header', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const options = loopRequest({
      model: 'm',
      messages: Object.freeze([...boundary, clockTail()]),
      sessionId: session.id,
    })
    expect(() => { dispatch(ctx, options) }).not.toThrow()
  })

  it('includes context appended inside the open step before dispatch', async () => {
    const { ctx, session } = await requestSetup()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[step context]' }], source: { kind: 'plugin', plugin: 'x' },
    }), { surfaceOp: 'append' })
    const options = loopRequest({
      model: 'm',
      messages: Object.freeze([...session.deriveMessages(), clockTail()]),
      sessionId: session.id,
    })
    expect(() => { dispatch(ctx, options) }).not.toThrow()
  })

  it('requires the messages to equal the boundary derivation exactly (no unlogged prefix), clock tail aside', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const extra = { role: 'user' as const, content: [{ type: 'text' as const, text: '<system-reminder>catalog</system-reminder>' }] }
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze([...boundary, clockTail()]), sessionId: session.id })) })
      .not.toThrow()
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze([extra, ...boundary, clockTail()]), sessionId: session.id })) })
      .toThrow(/diverges from the dispatch-time durable derivation/)
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze([...boundary, extra, clockTail()]), sessionId: session.id })) })
      .toThrow(/diverges from the dispatch-time durable derivation/)
  })

  it('rejects message and header divergence', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const divergent = [...boundary, { role: 'user', content: [{ type: 'text', text: 'phantom' }] }, clockTail()]
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze(divergent), sessionId: session.id })) })
      .toThrow(/diverges from the dispatch-time durable derivation/)
    expect(() => { dispatch(ctx, loopRequest({ model: 'other', messages: Object.freeze([...boundary, clockTail()]), sessionId: session.id })) })
      .toThrow(/diverges from the folded request header/)
  })

  describe('the unconditional clock tail message (SWD-113)', () => {
    it('accepts a dispatched request whose messages are the boundary plus one trailing clock message', async () => {
      const { ctx, session, boundary } = await requestSetup()
      const options = loopRequest({
        model: 'm',
        messages: Object.freeze([...boundary, buildClockMessage(() => new Date('2026-09-29T16:13:00Z'))]),
        sessionId: session.id,
      })
      expect(() => { dispatch(ctx, options) }).not.toThrow()
    })

    it('still rejects a trailing message that is not the recognized clock message', async () => {
      const { ctx, session, boundary } = await requestSetup()
      const notTheClock = createUserMessage({
        content: [{ type: 'text', text: 'Current date and time: not really' }],
        source: { kind: 'plugin', plugin: 'someone-else' },
      })
      const options = loopRequest({
        model: 'm',
        messages: Object.freeze([...boundary, notTheClock]),
        sessionId: session.id,
      })
      expect(() => { dispatch(ctx, options) }).toThrow(/missing its required unconditional clock tail message/)
    })

    it('rejects a request with no trailing message at all (an empty-tail regression the reviewer flagged: '
      + 'a code path that omitted the clock must not pass silently)', async () => {
      const { ctx, session, boundary } = await requestSetup()
      const options = loopRequest({ model: 'm', messages: Object.freeze(boundary), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).toThrow(/missing its required unconditional clock tail message/)
    })

    it('rejects a loop request with an empty messages array (no clock tail to find at all)', async () => {
      const { ctx, session } = await requestSetup()
      const options = loopRequest({ model: 'm', messages: Object.freeze([]), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).toThrow(/missing its required unconditional clock tail message/)
    })

    it('still rejects two trailing clock-shaped messages (only the very last may be discounted)', async () => {
      const { ctx, session, boundary } = await requestSetup()
      const options = loopRequest({
        model: 'm',
        messages: Object.freeze([
          ...boundary,
          buildClockMessage(() => new Date('2026-09-29T16:12:00Z')),
          buildClockMessage(() => new Date('2026-09-29T16:13:00Z')),
        ]),
        sessionId: session.id,
      })
      expect(() => { dispatch(ctx, options) }).toThrow(/diverges from the dispatch-time durable derivation/)
    })
  })

  it('rejects loop requests with no boundary or header', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('req-bare'))
    session.append('turn/start', { turn: 1 })
    const bare = loopRequest({ model: 'm', messages: Object.freeze([]), sessionId: session.id })
    expect(() => { dispatch(ctx, bare) }).toThrow(/no step\/start/)
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => { dispatch(ctx, bare) }).toThrow(/no request\/header event/)
  })

  it('rejects an unfrozen messages array but skips requests outside the loop contract', async () => {
    const { ctx, session, boundary } = await requestSetup()
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: [...boundary], sessionId: session.id })) })
      .toThrow(/frozen messages array/)
    expect(() => { dispatch(ctx, { model: 'summarizer', messages: [], sessionId: session.id }) }).not.toThrow()
    expect(() => { dispatch(ctx, Object.freeze({ model: 'm', messages: Object.freeze([]) })) }).not.toThrow()
    expect(() => { dispatch(ctx, Object.freeze({ model: 'm', messages: Object.freeze([]), sessionId: SessionId('ghost') })) })
      .not.toThrow()

    const directSession = ctx.sessions.create(SessionId('direct-one-shot'))
    expect(() => {
      dispatch(ctx, Object.freeze({ model: 'one-shot', messages: Object.freeze([]), sessionId: directSession.id }))
    }).not.toThrow()
  })

  it('rejects malformed requests carrying the loop marker', async () => {
    const { ctx, session } = await requestSetup()
    const messages: GenerateOptions['messages'] = []
    Object.freeze(messages)
    expect(() => {
      dispatch(ctx, markAgentLoopRequest({ provider: 'p', model: 'm', messages, sessionId: session.id }))
    }).toThrow(/request must be frozen/)
    expect(() => {
      dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze([]) }))
    }).toThrow(/carry a session id/)
    expect(() => {
      dispatch(ctx, loopRequest({
        model: 'm',
        messages: Object.freeze([]),
        sessionId: SessionId('missing-loop-session'),
      }))
    }).toThrow(/live session id/)
  })

  it('prepends ahead of a short-circuiting stream listener', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.on('llm/stream', () => (async function* () {})() as never)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AgentLoopInvariant)
    const session = ctx.sessions.create(SessionId('prepend-check'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'm' } }, reason: 'initial' })
    const divergent = loopRequest({
      model: 'm',
      messages: Object.freeze([{ role: 'user', content: [{ type: 'text', text: 'phantom' }] }, clockTail()]),
      sessionId: session.id,
    })
    expect(() => { dispatch(ctx, divergent) }).toThrow(/diverges from the dispatch-time durable derivation/)
  })
})

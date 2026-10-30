import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { createUserMessage, markAgentLoopRequest, type GenerateOptions  } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { FOUNDER_MARKER_TEXT } from '../src/founder-marker.ts'
import { renderDispatch, resolveDispatchTimeZone } from '../src/render-dispatch.ts'

const DIVERGES = /diverges from renderDispatch\(log\)/

/** What a faithful dispatch of `session` looks like right now. */
function rendered(session: Session) {
  return renderDispatch(session.deriveTimedMessages(), { timeZone: resolveDispatchTimeZone() })
}

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
  const boundary = rendered(session)
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'mock', model: 'm' } }, reason: 'initial' })
  return { ctx, session, boundary }
}

/** Like {@link requestSetup}, but the logged `user/message` carries the founder stamp. */
async function founderRequestSetup() {
  const ctx = await setup()
  const session = ctx.sessions.create(SessionId('req-check-founder'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', founder: true },
  }), { surfaceOp: 'append' })
  const boundary = rendered(session)
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'mock', model: 'm' } }, reason: 'initial' })
  return { ctx, session, boundary }
}

describe('request-reconstruction invariant', () => {
  it('accepts a frozen request equal to renderDispatch(log) and a folded header', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const options = loopRequest({ model: 'm', messages: Object.freeze([...boundary]), sessionId: session.id })
    expect(() => { dispatch(ctx, options) }).not.toThrow()
  })

  it('includes context appended inside the open step before dispatch (merged into the head)', async () => {
    const { ctx, session } = await requestSetup()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[step context]' }], source: { kind: 'plugin', plugin: 'context-pressure' },
    }), { surfaceOp: 'append' })
    const options = loopRequest({ model: 'm', messages: Object.freeze(rendered(session)), sessionId: session.id })
    expect(rendered(session)).toHaveLength(1)
    expect(() => { dispatch(ctx, options) }).not.toThrow()
  })

  it('accepts the exact rendering and rejects extra, missing and standalone-clock messages', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const extra = { role: 'user' as const, content: [{ type: 'text' as const, text: '<system-reminder>catalog</system-reminder>' }] }
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze([...boundary]), sessionId: session.id })) })
      .not.toThrow()
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze([extra, ...boundary]), sessionId: session.id })) })
      .toThrow(DIVERGES)
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze([...boundary, extra]), sessionId: session.id })) })
      .toThrow(DIVERGES)
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze([]), sessionId: session.id })) })
      .toThrow(DIVERGES)
  })

  it('rejects message and header divergence', async () => {
    const { ctx, session, boundary } = await requestSetup()
    const divergent = [...boundary, { role: 'user', content: [{ type: 'text', text: 'phantom' }] }]
    expect(() => { dispatch(ctx, loopRequest({ model: 'm', messages: Object.freeze(divergent), sessionId: session.id })) })
      .toThrow(DIVERGES)
    expect(() => { dispatch(ctx, loopRequest({ model: 'other', messages: Object.freeze([...boundary]), sessionId: session.id })) })
      .toThrow(/diverges from the folded request header/)
  })

  describe('the per-message stamp', () => {
    it('rejects a user message dispatched WITHOUT its stamp (the raw logged derivation)', async () => {
      const { ctx, session } = await requestSetup()
      const options = loopRequest({ model: 'm', messages: Object.freeze(session.deriveMessages()), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).toThrow(DIVERGES)
    })

    it('rejects a stamp built from the wrong time', async () => {
      const { ctx, session } = await requestSetup()
      const wrong = renderDispatch(
        session.deriveTimedMessages().map(t => ({ ...t, time: t.time + 3 * 3_600_000 })),
        { timeZone: resolveDispatchTimeZone() },
      )
      const options = loopRequest({ model: 'm', messages: Object.freeze(wrong), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).toThrow(DIVERGES)
    })

    it('rejects a run that was wrongly merged (notice folded into a head that should not carry it)', async () => {
      const { ctx, session } = await requestSetup()
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'relayed' }],
        source: { kind: 'mailbox', form: 'relay', address: 'a', from: 'b', messageId: 'm' } as never,
      }), { surfaceOp: 'append' })
      const [head, relayed] = rendered(session)
      const merged = { ...head!, content: [...head!.content, ...relayed!.content] }
      const options = loopRequest({ model: 'm', messages: Object.freeze([merged]), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).toThrow(DIVERGES)
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
      messages: Object.freeze([{ role: 'user', content: [{ type: 'text', text: 'phantom' }] }]),
      sessionId: session.id,
    })
    expect(() => { dispatch(ctx, divergent) }).toThrow(DIVERGES)
  })

  describe('the founder marker on the header line', () => {
    it('accepts a founder-stamped message rendered with the marker', async () => {
      const { ctx, session, boundary } = await founderRequestSetup()
      expect(JSON.stringify(boundary)).toContain(FOUNDER_MARKER_TEXT)
      const options = loopRequest({ model: 'm', messages: Object.freeze([...boundary]), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).not.toThrow()
    })

    it('rejects the marker on a message that was never founder-stamped', async () => {
      const { ctx, session, boundary } = await requestSetup()
      const wronglyMarked = boundary.map(message => ({
        ...message,
        content: [{ type: 'text' as const, text: `${FOUNDER_MARKER_TEXT}\n\n` }, ...message.content],
      }))
      const options = loopRequest({ model: 'm', messages: Object.freeze(wronglyMarked), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).toThrow(DIVERGES)
    })

    it('rejects a founder-stamped message dispatched with a stamp but WITHOUT the marker (unmarked founder)', async () => {
      const { ctx, session } = await founderRequestSetup()
      const [founderMessage] = session.deriveTimedMessages()
      const plainStamp = renderDispatch(
        [{ ...founderMessage!, message: { ...founderMessage!.message, source: { kind: 'user' } } }],
        { timeZone: resolveDispatchTimeZone() },
      )
      const options = loopRequest({ model: 'm', messages: Object.freeze(plainStamp), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).toThrow(DIVERGES)
    })

    it('still rejects unrelated divergence on a founder-stamped session', async () => {
      const { ctx, session, boundary } = await founderRequestSetup()
      const extra = { role: 'user' as const, content: [{ type: 'text' as const, text: 'phantom' }] }
      const options = loopRequest({ model: 'm', messages: Object.freeze([...boundary, extra]), sessionId: session.id })
      expect(() => { dispatch(ctx, options) }).toThrow(DIVERGES)
    })
  })
})

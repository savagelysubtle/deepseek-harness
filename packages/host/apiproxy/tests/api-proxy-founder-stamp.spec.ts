/**
 * SWD-125: the two host-inbound mint sites for `founder: true` — session.prompt
 * and session.sendAll — stamp the durable `user/message` source and report
 * `founderStamped` on the response ONLY when the raw TCP peer was
 * independently proven loopback (`request.peerIsLoopback === true`, set
 * exclusively by `handleUnary` from the real socket). The fact never comes
 * from the payload, a header, config, or an env var; absence of the fact
 * fails closed to "not founder", the same as an explicit `false`.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { RpcRequest } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
/**
 * Builds an RpcRequest for these tests. `peerIsLoopback` is passed per call,
 * never defaulted — an omitted third argument leaves the key entirely absent
 * from the request object, matching how every carrier path other than
 * `handleUnary`'s host-inbound dispatch actually produces one.
 */
function request<P>(payload: P, peerIsLoopback?: boolean): RpcRequest<P> {
  return {
    rpcId: RpcId(`founder-stamp-${String(nextRpc++)}`),
    payload,
    ...(peerIsLoopback === undefined ? {} : { peerIsLoopback }),
  }
}

/** Minimal live-session bench for session.prompt: one registered Agent whose `followup` is spied. */
async function promptBench(): Promise<{ api: ReturnType<typeof createApiProxy>; agent: Agent; followup: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const session = ctx.sessions.create(sid('session-founder-stamp'), { meta: { cwd: '/proj' } })
  const followup = vi.fn()
  const agent = { id: session.id, session, status: 'idle', ctx, followup } as unknown as Agent
  ctx.agents.register(agent)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { api, agent, followup }
}

describe('session.prompt founder stamp', () => {
  it('mints founder:true on the durable source and reports founderStamped:true over a proven-loopback peer', async () => {
    const { api, agent, followup } = await promptBench()
    const req = request({
      sessionId: agent.id,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'founder work' }],
    }, true)

    const response = await api.sessions.prompt(req)

    expect(response.result).toEqual({
      ok: true,
      value: { accepted: true, founderStamped: true },
    })
    expect(followup).toHaveBeenCalledOnce()
    const delivered = followup.mock.calls[0]?.[0] as UserMessage
    expect(delivered.source).toEqual({ kind: 'user', founder: true, rpcId: req.rpcId })
  })

  it('leaves the source bare and reports founderStamped:false when the peer is proven non-loopback', async () => {
    const { api, agent, followup } = await promptBench()
    const req = request({
      sessionId: agent.id,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'ordinary work' }],
    }, false)

    const response = await api.sessions.prompt(req)

    expect(response.result).toEqual({
      ok: true,
      value: { accepted: true, founderStamped: false },
    })
    const delivered = followup.mock.calls[0]?.[0] as UserMessage
    expect(delivered.source).toEqual({ kind: 'user', rpcId: req.rpcId })
  })

  it('fails closed to a bare source and founderStamped:false when peerIsLoopback is absent from the request', async () => {
    const { api, agent, followup } = await promptBench()
    // No third argument: peerIsLoopback is not merely false, it does not
    // exist on the request object at all — the same shape a push frame or an
    // old test fixture would produce.
    const req = request({
      sessionId: agent.id,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'no fact at all' }],
    })
    expect('peerIsLoopback' in req).toBe(false)

    const response = await api.sessions.prompt(req)

    expect(response.result).toEqual({
      ok: true,
      value: { accepted: true, founderStamped: false },
    })
    const delivered = followup.mock.calls[0]?.[0] as UserMessage
    expect(delivered.source).toEqual({ kind: 'user', rpcId: req.rpcId })
  })

  it('ignores a client-supplied founder field smuggled onto the payload over a non-loopback peer', async () => {
    const { api, agent, followup } = await promptBench()
    // A hostile or buggy client cannot mint the stamp by putting `founder`
    // on the payload: the handler never reads request.payload.founder when
    // building the source, only named fields plus the independently proven
    // request.peerIsLoopback fact.
    const req = request({
      sessionId: agent.id,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'smuggled' }],
      founder: true,
    }, false)

    const response = await api.sessions.prompt(req)

    expect(response.result).toEqual({
      ok: true,
      value: { accepted: true, founderStamped: false },
    })
    const delivered = followup.mock.calls[0]?.[0] as UserMessage
    expect(delivered.source).toEqual({ kind: 'user', rpcId: req.rpcId })
  })
})

/** A live-agent stand-in for session.sendAll: only the fields the broadcast actually reads. */
interface FakeAgent {
  id: SessionId
  session: { header: SessionHeader }
  steer: ReturnType<typeof vi.fn>
}

function fakeAgent(id: SessionId): FakeAgent {
  return {
    id,
    session: { header: { version: 0, id, createdAt: 1, cwd: '/proj' } satisfies SessionHeader },
    steer: vi.fn(),
  }
}

function sendAllBench(agents: FakeAgent[]): { api: ReturnType<typeof createApiProxy> } {
  const registry = new Map<SessionId, FakeAgent>()
  for (const agent of agents) registry.set(agent.id, agent)
  const ctx = new Context()
  ctx.provide('agents', { get: (id: SessionId) => registry.get(id) })
  ctx.provide('subagents', { interrupt: vi.fn(), drainContinuableDescendants: vi.fn(() => Promise.resolve()) })
  ctx.provide('sessions', { list: () => agents.map(agent => ({ id: agent.id, header: agent.session.header })) })
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([]),
    inspect: () => Promise.reject(new Error('cold inspection is unused by these cases')),
    locate: () => undefined,
  })
  ctx.provide('sessionProjections', {
    snapshot: () => undefined,
    restore: () => undefined,
    onChanged: () => () => {},
    register: () => () => {},
  })
  ctx.provide('userQuestions', { registerProvider: () => () => {} })
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { api }
}

describe('session.sendAll founder stamp', () => {
  it('stamps founder:true on every root session message and reports founderStamped:true over loopback', async () => {
    const first = fakeAgent(sid('top-founder-1'))
    const second = fakeAgent(sid('top-founder-2'))
    const { api } = sendAllBench([first, second])

    const req = request({ content: [{ type: 'text' as const, text: 'stand down' }] }, true)
    const response = await api.sessions.sendAll(req)

    expect(response.result).toEqual({
      ok: true,
      value: { sentCount: 2, result: 'ok', founderStamped: true },
    })
    const firstDelivered = first.steer.mock.calls[0]?.[0] as UserMessage
    const secondDelivered = second.steer.mock.calls[0]?.[0] as UserMessage
    expect(firstDelivered.source).toEqual({ kind: 'user', founder: true, rpcId: req.rpcId })
    expect(secondDelivered.source).toEqual({ kind: 'user', founder: true, rpcId: req.rpcId })
  })

  it('stamps no root session message and reports founderStamped:false over a non-loopback peer', async () => {
    const first = fakeAgent(sid('top-plain-1'))
    const second = fakeAgent(sid('top-plain-2'))
    const { api } = sendAllBench([first, second])

    const req = request({ content: [{ type: 'text' as const, text: 'stand down' }] }, false)
    const response = await api.sessions.sendAll(req)

    expect(response.result).toEqual({
      ok: true,
      value: { sentCount: 2, result: 'ok', founderStamped: false },
    })
    const firstDelivered = first.steer.mock.calls[0]?.[0] as UserMessage
    const secondDelivered = second.steer.mock.calls[0]?.[0] as UserMessage
    expect(firstDelivered.source).toEqual({ kind: 'user', rpcId: req.rpcId })
    expect(secondDelivered.source).toEqual({ kind: 'user', rpcId: req.rpcId })
  })

  it('reports founderStamped:true over loopback even with zero live top-level sessions to steer', async () => {
    const { api } = sendAllBench([])

    const req = request({ content: [{ type: 'text' as const, text: 'stand down' }] }, true)
    const response = await api.sessions.sendAll(req)

    // The founder-stamp decision is independent of root selection: it is
    // taken from request.peerIsLoopback alone, so an empty broadcast still
    // reports founderStamped:true. sentCount:0 and result:'ok' are the
    // existing zero-root outcome (see api-proxy-send-all.spec.ts's own
    // "accepted zero-count no-op" case) — no root is ever steered, so the
    // per-root failure list stays empty.
    expect(response.result).toEqual({
      ok: true,
      value: { sentCount: 0, result: 'ok', founderStamped: true },
    })
  })
})

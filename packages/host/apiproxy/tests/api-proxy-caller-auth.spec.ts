/**
 * OP-270 slice C1: capability-granting answers need the per-boot caller token.
 * Covers `respond()` (approvals, the plan-review question, generic questions),
 * the LAN switch, the fetch carrier's 4th `callerAuthenticated` argument
 * (default false), and its threading onto the unary RpcRequest.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApiProxy, MuxFrame, RespondCaller, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import {
  APPROVAL_NEEDS_CALLER_TOKEN_MESSAGE, APPROVAL_NEEDS_LOOPBACK_MESSAGE,
  DEFAULT_ALLOW_NON_LOOPBACK_APPROVAL_ANSWERS, createApiProxy,
} from '../src/api-proxy.ts'
import { toFetchHandler } from '../src/fetch/handler.ts'

async function harness(allowNonLoopbackApprovalAnswers?: boolean): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ApprovalService)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
    ...allowNonLoopbackApprovalAnswers === undefined ? {} : { allowNonLoopbackApprovalAnswers },
  })
  return { ctx, api }
}

/** An agent stand-in inside an open turn, registered so userQuestions can address it. */
function agentOf(ctx: Context): Agent {
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, status: 'idle', ctx } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

function collectMux(api: ApiProxy, abort: AbortController): RpcRequest<MuxFrame>[] {
  const envelopes: RpcRequest<MuxFrame>[] = []
  void (async () => {
    for await (const envelope of api.events.mux({ rpcId: RpcId('caller-auth-mux'), payload: {} }, abort.signal)) {
      envelopes.push(envelope)
    }
  })()
  return envelopes
}

async function waitForFrame<T extends MuxFrame['type']>(
  envelopes: RpcRequest<MuxFrame>[], type: T,
): Promise<RpcRequest<Extract<MuxFrame, { type: T }>>> {
  for (let i = 0; i < 400; i += 1) {
    const found = envelopes.find(envelope => envelope.payload.type === type)
    if (found !== undefined) return found as RpcRequest<Extract<MuxFrame, { type: T }>>
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`no ${type} frame arrived`)
}

/** A pending approval and the answer builder for it. */
async function pendingApproval(ctx: Context, envelopes: RpcRequest<MuxFrame>[]): Promise<{
  asked: Promise<string>
  answer: () => Parameters<ApiProxy['respond']>[0]
}> {
  const asked = ctx.approval.request({ agent: agentOf(ctx), toolName: 'bash', reason: 'escalation' })
  const envelope = await waitForFrame(envelopes, 'approval/requested')
  return {
    asked,
    answer: () => ({
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: envelope.payload.sessionId,
          approvalId: envelope.payload.approvalId,
          outcome: 'allowed-once',
        },
      },
    }),
  }
}

const NOT_AUTHENTICATED = {
  accepted: false, reason: 'caller-not-authenticated', message: APPROVAL_NEEDS_CALLER_TOKEN_MESSAGE,
}
const NOT_LOOPBACK = {
  accepted: false, reason: 'caller-not-loopback', message: APPROVAL_NEEDS_LOOPBACK_MESSAGE,
}

describe('approval answers need the per-boot caller token (OP-270)', () => {
  it('the refusal text is the plain-words reason the client surfaces', () => {
    expect(APPROVAL_NEEDS_CALLER_TOKEN_MESSAGE)
      .toBe('approval answers need the per-boot caller token; reopen dsh from the launcher link')
  })

  it('refuses every unauthenticated caller shape and leaves the approval pending', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const envelopes = collectMux(api, abort)
    const { asked, answer } = await pendingApproval(ctx, envelopes)
    let settled = false
    void asked.then(() => { settled = true })

    const callers: (RespondCaller | undefined)[] = [
      undefined,
      {},
      { peerIsLoopback: true },
      { peerIsLoopback: true, callerAuthenticated: false },
      { peerIsLoopback: false, callerAuthenticated: false },
    ]
    for (const caller of callers) {
      expect(await api.respond(answer(), caller)).toEqual(NOT_AUTHENTICATED)
    }
    expect(await api.respond(answer())).toEqual(NOT_AUTHENTICATED)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    expect(envelopes.some(envelope => envelope.payload.type === 'approval/resolved')).toBe(false)

    // Still pending: the real UI (loopback + token) can answer it afterwards.
    expect(await api.respond(answer(), { peerIsLoopback: true, callerAuthenticated: true }))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    abort.abort()
  })

  it('accepts loopback + token', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const { asked, answer } = await pendingApproval(ctx, collectMux(api, abort))

    expect(await api.respond(answer(), { peerIsLoopback: true, callerAuthenticated: true }))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    abort.abort()
  })

  it('LAN switch defaults to refuse: non-loopback + token is refused', async () => {
    expect(DEFAULT_ALLOW_NON_LOOPBACK_APPROVAL_ANSWERS).toBe(false)
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const { asked, answer } = await pendingApproval(ctx, collectMux(api, abort))

    expect(await api.respond(answer(), { peerIsLoopback: false, callerAuthenticated: true }))
      .toEqual(NOT_LOOPBACK)
    expect(await api.respond(answer(), { callerAuthenticated: true })).toEqual(NOT_LOOPBACK)
    // An explicit false switch is the same as the default.
    expect(await api.respond(answer(), { peerIsLoopback: true, callerAuthenticated: true }))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    abort.abort()
  })

  it('LAN switch permitting: non-loopback + token is accepted, non-loopback without a token is still refused', async () => {
    const { ctx, api } = await harness(true)
    const abort = new AbortController()
    const { asked, answer } = await pendingApproval(ctx, collectMux(api, abort))

    expect(await api.respond(answer(), { peerIsLoopback: false, callerAuthenticated: false }))
      .toEqual(NOT_AUTHENTICATED)
    expect(await api.respond(answer(), { peerIsLoopback: false, callerAuthenticated: true }))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    abort.abort()
  })
})

describe('question answers (OP-270)', () => {
  it('generic ask_user_question answers are unchanged: accepted with no caller facts at all', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const envelopes = collectMux(api, abort)
    const asked = ctx.userQuestions.ask({
      agent: agentOf(ctx),
      questions: [{ id: 'target', question: 'Pick one', options: [{ label: 'Code' }, { label: 'Docs' }] }],
    })
    const envelope = await waitForFrame(envelopes, 'question/requested')

    expect(await api.respond({
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: {
        ok: true,
        value: { sessionId: envelope.payload.sessionId, answer: { answers: [{ id: 'target', selected: ['Code'] }] } },
      },
    })).toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({ answers: [{ id: 'target', selected: ['Code'] }] })
    abort.abort()
  })

  it('the plan-review question grants capability (leaves plan mode): refused without the token, pending stays', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const envelopes = collectMux(api, abort)
    const asked = ctx.userQuestions.ask({
      agent: agentOf(ctx),
      questions: [{
        id: 'plan-review',
        question: 'Approve this plan and leave plan mode?',
        detail: 'the plan',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    const envelope = await waitForFrame(envelopes, 'question/requested')
    const approve = (): Parameters<ApiProxy['respond']>[0] => ({
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: {
        ok: true,
        value: { sessionId: envelope.payload.sessionId, answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] } },
      },
    })
    let settled = false
    void asked.then(() => { settled = true }, () => { settled = true })

    expect(await api.respond(approve())).toEqual(NOT_AUTHENTICATED)
    expect(await api.respond(approve(), { peerIsLoopback: true })).toEqual(NOT_AUTHENTICATED)
    expect(await api.respond(approve(), { peerIsLoopback: false, callerAuthenticated: true })).toEqual(NOT_LOOPBACK)
    // A dismissal ("cancelled") is gated the same way: fail closed.
    expect(await api.respond({
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: { ok: false, error: { code: 'cancelled', message: 'dismissed', details: {} } },
    })).toEqual(NOT_AUTHENTICATED)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    expect(await api.respond(approve(), { peerIsLoopback: true, callerAuthenticated: true }))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
    abort.abort()
  })
})

describe('fetch carrier: callerAuthenticated is the 4th argument and defaults to false', () => {
  const respondRequest = (body: unknown): Request => new Request('http://x/api/respond', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  it('/api/respond forwards (peerIsLoopback, callerAuthenticated) and a 3-argument call is unauthenticated', async () => {
    const respond = vi.fn((): Promise<{ accepted: true }> => Promise.resolve({ accepted: true }))
    const handler = toFetchHandler({ respond } as unknown as ApiProxy)
    const body = { type: 'client-response', rpcId: 'r1', result: { ok: true, value: null } }

    await handler.fetch(respondRequest(body))
    await handler.fetch(respondRequest(body), undefined, true)
    await handler.fetch(respondRequest(body), undefined, true, true)
    await handler.fetch(respondRequest(body), undefined, false, true)

    expect(respond.mock.calls.map(call => (call as unknown[])[1])).toEqual([
      { peerIsLoopback: false, callerAuthenticated: false },
      { peerIsLoopback: true, callerAuthenticated: false },
      { peerIsLoopback: true, callerAuthenticated: true },
      { peerIsLoopback: false, callerAuthenticated: true },
    ])
  })

  it('end to end: an approval POSTed with the default arguments is refused and stays pending; with both facts it is accepted', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const { asked, answer } = await pendingApproval(ctx, collectMux(api, abort))
    const handler = toFetchHandler(api)

    const refused: unknown = await (await handler.fetch(respondRequest(answer()))).json()
    expect(refused).toEqual(NOT_AUTHENTICATED)
    const loopbackOnly: unknown = await (await handler.fetch(respondRequest(answer()), undefined, true)).json()
    expect(loopbackOnly).toEqual(NOT_AUTHENTICATED)
    const accepted: unknown = await (await handler.fetch(respondRequest(answer()), undefined, true, true)).json()
    expect(accepted).toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    abort.abort()
  })

  it('unary dispatch places callerAuthenticated on the RpcRequest (default absent-argument = false)', async () => {
    const list = vi.fn((request: RpcRequest<unknown>) => Promise.resolve({
      rpcId: request.rpcId, result: { ok: true as const, value: { sessions: [] } },
    }))
    const handler = toFetchHandler({ sessions: { list } } as unknown as ApiProxy)
    const post = (): Request => new Request('http://x/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'u1', method: 'session.list', payload: {} }),
    })

    await handler.fetch(post())
    await handler.fetch(post(), undefined, true, true)

    const seen = list.mock.calls.map(([request]) => ({
      peerIsLoopback: request.peerIsLoopback, callerAuthenticated: request.callerAuthenticated,
    }))
    expect(seen).toEqual([
      { peerIsLoopback: false, callerAuthenticated: false },
      { peerIsLoopback: true, callerAuthenticated: true },
    ])
  })
})

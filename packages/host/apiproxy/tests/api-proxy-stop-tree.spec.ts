/**
 * session.stopTree / session.stopAll: the cascading stop that neither
 * `session.cancel` (refuses subagent ownership outright) nor
 * `subagent.interrupt` (single child, no descendant cascade) provides.
 * Every case exercises `createApiProxy` directly over a minimal mocked
 * Context, mirroring the subagent-gateway bench's mocking depth.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '../src/api/rpc.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (value: string): SessionId => value as SessionId

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('stop-rpc'), payload }
}

/** A live-agent stand-in: only the fields stopTree/stopAll actually read. */
interface FakeAgent {
  id: SessionId
  session: { header: SessionHeader }
  cancel: ReturnType<typeof vi.fn>
}

function fakeAgent(id: SessionId, header: Partial<SessionHeader> = {}): FakeAgent {
  return {
    id,
    session: {
      header: { version: 0, id, createdAt: 1, cwd: '/proj', ...header } satisfies SessionHeader,
    },
    cancel: vi.fn(),
  }
}

function bench(options: {
  /** Live agents the registry answers `get` for. */
  agents?: FakeAgent[]
  /** `ctx.sessions.list()` rows: every session stopAll considers before filtering to live top-level roots. */
  sessionRows?: { id: SessionId; origin?: 'subagent' }[]
  interruptError?: Error
  drainError?: Error
} = {}) {
  const registry = new Map<SessionId, FakeAgent>()
  for (const agent of options.agents ?? []) registry.set(agent.id, agent)
  const getAgent = vi.fn((id: SessionId) => registry.get(id))
  const interrupt = vi.fn((
    _targetSessionId: SessionId,
    _authority: { kind: 'user'; parentSessionId: SessionId },
  ) => {
    if (options.interruptError !== undefined) throw options.interruptError
  })
  const drainContinuableDescendants = vi.fn(() => options.drainError === undefined
    ? Promise.resolve()
    : Promise.reject(options.drainError))
  const sessionRows = (options.sessionRows ?? []).map(row => ({
    id: row.id,
    header: {
      version: 0, id: row.id, createdAt: 1, cwd: '/proj',
      ...(row.origin === undefined ? {} : { origin: row.origin }),
    } satisfies SessionHeader,
  }))
  const ctx = new Context()
  ctx.provide('agents', { get: getAgent })
  ctx.provide('subagents', { interrupt, drainContinuableDescendants })
  ctx.provide('sessions', { list: () => sessionRows })
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
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
  })
  return { api, getAgent, interrupt, drainContinuableDescendants }
}

describe('session.stopTree', () => {
  it('is an accepted no-op when no live agent answers the sessionId', async () => {
    const { api, interrupt, drainContinuableDescendants } = bench()
    const response = await api.sessions.stopTree(request({ sessionId: sid('ghost') }))
    expect(response.result).toEqual({
      ok: true,
      value: { ownTurnStopped: false, descendants: 'ok' },
    })
    expect(interrupt).not.toHaveBeenCalled()
    expect(drainContinuableDescendants).not.toHaveBeenCalled()
  })

  it('stops a subagent-owned target through the interrupt primitive, never through cancel', async () => {
    const parent = sid('parent')
    const child = fakeAgent(sid('child'), { origin: 'subagent', parentSession: parent })
    const { api, interrupt, drainContinuableDescendants } = bench({ agents: [child] })
    const response = await api.sessions.stopTree(request({ sessionId: child.id }))
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(child.id, { kind: 'user', parentSessionId: parent })
    expect(child.cancel).not.toHaveBeenCalled()
    expect(drainContinuableDescendants).toHaveBeenCalledExactlyOnceWith([child])
    expect(response.result).toEqual({
      ok: true,
      value: { ownTurnStopped: true, descendants: 'ok' },
    })
  })

  it('stops a top-level target through cancel, never through interrupt', async () => {
    const top = fakeAgent(sid('top'))
    const { api, interrupt, drainContinuableDescendants } = bench({ agents: [top] })
    const response = await api.sessions.stopTree(request({ sessionId: top.id }))
    expect(top.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(interrupt).not.toHaveBeenCalled()
    expect(drainContinuableDescendants).toHaveBeenCalledExactlyOnceWith([top])
    expect(response.result).toEqual({
      ok: true,
      value: { ownTurnStopped: true, descendants: 'ok' },
    })
  })

  it('surfaces a partial descendant-teardown failure as { failed }, never as a bare success', async () => {
    const top = fakeAgent(sid('top'))
    const { api } = bench({
      agents: [top],
      drainError: new Error('continuable subagent teardown failed for 1 scoped activation(s): boom'),
    })
    const response = await api.sessions.stopTree(request({ sessionId: top.id }))
    expect(response.result).toEqual({
      ok: true,
      value: {
        ownTurnStopped: true,
        descendants: { failed: 'continuable subagent teardown failed for 1 scoped activation(s): boom' },
      },
    })
  })
})

describe('session.stopAll', () => {
  it('cancels every live top-level session once and drains all roots in exactly one shared call', async () => {
    const first = fakeAgent(sid('top-1'))
    const second = fakeAgent(sid('top-2'))
    const subagentOwned = fakeAgent(sid('child-1'), { origin: 'subagent', parentSession: first.id })
    const { api, drainContinuableDescendants } = bench({
      agents: [first, second, subagentOwned],
      sessionRows: [
        { id: first.id },
        { id: second.id },
        // A cold top-level row with no live agent must be dropped, not counted.
        { id: sid('top-cold') },
        // A subagent-owned row must never become a root: it stops as a descendant.
        { id: subagentOwned.id, origin: 'subagent' },
      ],
    })
    const response = await api.sessions.stopAll(request({}))
    expect(first.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(second.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(subagentOwned.cancel).not.toHaveBeenCalled()
    expect(drainContinuableDescendants).toHaveBeenCalledExactlyOnceWith([first, second])
    expect(response.result).toEqual({
      ok: true,
      value: { stoppedCount: 2, descendants: 'ok' },
    })
  })
})

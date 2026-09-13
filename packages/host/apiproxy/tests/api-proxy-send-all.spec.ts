/**
 * session.sendAll (SWD-131): the org-wide broadcast that steers every live
 * top-level session with the same content, mid-turn, in one call. Modeled on
 * `session.stopAll`'s own bench (api-proxy-stop-tree.spec.ts) — same root
 * selection, same "every root is attempted regardless of what it reports"
 * posture, and the same never-fold-a-failure-into-success discipline: a
 * per-root `steer` throw must surface in `result: { failed }`, never vanish
 * into a bare `sentCount`.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { RpcId } from '../src/api/rpc.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (value: string): SessionId => value as SessionId

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('send-all-rpc'), payload }
}

/** A live-agent stand-in: only the fields sendAll actually reads. */
interface FakeAgent {
  id: SessionId
  session: { header: SessionHeader }
  steer: ReturnType<typeof vi.fn>
}

function fakeAgent(id: SessionId, header: Partial<SessionHeader> = {}, steerError?: Error): FakeAgent {
  return {
    id,
    session: {
      header: { version: 0, id, createdAt: 1, cwd: '/proj', ...header } satisfies SessionHeader,
    },
    steer: vi.fn((): void => {
      if (steerError !== undefined) throw steerError
    }),
  }
}

function bench(options: {
  /** Live agents the registry answers `get` for. */
  agents?: FakeAgent[]
  /** `ctx.sessions.list()` rows: every session sendAll considers before filtering to live top-level roots. */
  sessionRows?: { id: SessionId; origin?: 'subagent' }[]
} = {}) {
  const registry = new Map<SessionId, FakeAgent>()
  for (const agent of options.agents ?? []) registry.set(agent.id, agent)
  const getAgent = vi.fn((id: SessionId) => registry.get(id))
  const sessionRows = (options.sessionRows ?? []).map(row => ({
    id: row.id,
    header: {
      version: 0, id: row.id, createdAt: 1, cwd: '/proj',
      ...(row.origin === undefined ? {} : { origin: row.origin }),
    } satisfies SessionHeader,
  }))
  const ctx = new Context()
  ctx.provide('agents', { get: getAgent })
  ctx.provide('subagents', { interrupt: vi.fn(), drainContinuableDescendants: vi.fn(() => Promise.resolve()) })
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
  return { api, getAgent }
}

describe('session.sendAll', () => {
  it('steers every live top-level session with the same content, skipping subagent-owned and cold rows', async () => {
    const first = fakeAgent(sid('top-1'))
    const second = fakeAgent(sid('top-2'))
    const subagentOwned = fakeAgent(sid('child-1'), { origin: 'subagent', parentSession: first.id })
    const { api } = bench({
      agents: [first, second, subagentOwned],
      sessionRows: [
        { id: first.id },
        { id: second.id },
        // A cold top-level row with no live agent must be dropped, not counted.
        { id: sid('top-cold') },
        // A subagent-owned row must never be steered directly.
        { id: subagentOwned.id, origin: 'subagent' },
      ],
    })
    const response = await api.sessions.sendAll(request({ content: [{ type: 'text', text: 'stand down' }] }))
    expect(first.steer).toHaveBeenCalledOnce()
    expect(second.steer).toHaveBeenCalledOnce()
    expect(subagentOwned.steer).not.toHaveBeenCalled()
    const delivered = first.steer.mock.calls[0]?.[0] as UserMessage
    expect(delivered.role).toBe('user')
    expect(delivered.source).toEqual({ kind: 'user', rpcId: 'send-all-rpc' })
    expect(delivered.content).toEqual([{ type: 'text', text: 'stand down' }])
    expect(response.result).toEqual({
      ok: true,
      value: { sentCount: 2, result: 'ok' },
    })
  })

  it('is an accepted zero-count no-op when no live top-level session exists', async () => {
    const { api } = bench({ sessionRows: [{ id: sid('top-cold') }] })
    const response = await api.sessions.sendAll(request({ content: [{ type: 'text', text: 'hi' }] }))
    expect(response.result).toEqual({
      ok: true,
      value: { sentCount: 0, result: 'ok' },
    })
  })

  it('surfaces a per-root steer failure as { failed }, never as a bare success, while still reaching every other root', async () => {
    const healthy = fakeAgent(sid('top-healthy'))
    const disposing = fakeAgent(sid('top-disposing'), {}, new Error('agent "top-disposing": send refused, agent is disposed'))
    const { api } = bench({
      agents: [healthy, disposing],
      sessionRows: [{ id: healthy.id }, { id: disposing.id }],
    })
    const response = await api.sessions.sendAll(request({ content: [{ type: 'text', text: 'stand down' }] }))
    expect(healthy.steer).toHaveBeenCalledOnce()
    expect(disposing.steer).toHaveBeenCalledOnce()
    expect(response.result).toEqual({
      ok: true,
      value: {
        sentCount: 1,
        result: { failed: 'top-disposing: agent "top-disposing": send refused, agent is disposed' },
      },
    })
  })
})

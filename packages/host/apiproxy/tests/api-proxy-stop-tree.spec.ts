/**
 * session.stopTree / session.stopAll: the cascading stop that neither
 * `session.cancel` (refuses subagent ownership outright) nor
 * `subagent.interrupt` (single child, no descendant cascade) provides.
 * Every case exercises `createApiProxy` directly over a minimal mocked
 * Context, mirroring the subagent-gateway bench's mocking depth.
 *
 * `ownTurnStopped` / `stoppedCount` report only work this RPC actually cut
 * off — never the number of agents merely considered or cancelled against
 * (SWD-124: a stop control must never report having stopped work that was
 * already idle). The fake agent's `cancel` therefore models the real
 * `Agent.cancel` contract: it returns whether the target had active work
 * aborted, `true` only while the fake is "running".
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

/**
 * `running` defaults `true` so existing top-level-target cases keep exercising
 * the "actually stopped something" path without every call site naming it;
 * idle-target cases opt in with `running: false`. Cancelling flips it to
 * `false`, mirroring the real agent settling into idle once aborted.
 */
function fakeAgent(
  id: SessionId,
  header: Partial<SessionHeader> = {},
  options: { running?: boolean } = {},
): FakeAgent {
  let running = options.running ?? true
  return {
    id,
    session: {
      header: { version: 0, id, createdAt: 1, cwd: '/proj', ...header } satisfies SessionHeader,
    },
    cancel: vi.fn((): boolean => {
      const wasRunning = running
      running = false
      return wasRunning
    }),
  }
}

function bench(options: {
  /** Live agents the registry answers `get` for. */
  agents?: FakeAgent[]
  /** `ctx.sessions.list()` rows: every session stopAll considers before filtering to live top-level roots. */
  sessionRows?: { id: SessionId; origin?: 'subagent' }[]
  interruptError?: Error
  /** What `subagents.interrupt` reports it actually aborted; defaults `true`. */
  interruptResult?: boolean
  drainError?: Error
} = {}) {
  const registry = new Map<SessionId, FakeAgent>()
  for (const agent of options.agents ?? []) registry.set(agent.id, agent)
  const getAgent = vi.fn((id: SessionId) => registry.get(id))
  const interrupt = vi.fn((
    _targetSessionId: SessionId,
    _authority: { kind: 'user'; parentSessionId: SessionId },
  ): boolean => {
    if (options.interruptError !== undefined) throw options.interruptError
    return options.interruptResult ?? true
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

  it('reports ownTurnStopped: false for a subagent-owned target interrupt found already idle', async () => {
    const parent = sid('parent')
    const child = fakeAgent(sid('child'), { origin: 'subagent', parentSession: parent })
    const { api, interrupt } = bench({ agents: [child], interruptResult: false })
    const response = await api.sessions.stopTree(request({ sessionId: child.id }))
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(child.id, { kind: 'user', parentSessionId: parent })
    expect(response.result).toEqual({
      ok: true,
      value: { ownTurnStopped: false, descendants: 'ok' },
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

  it('reports ownTurnStopped: false for an already-idle top-level target, while still draining descendants', async () => {
    const top = fakeAgent(sid('top'), {}, { running: false })
    const { api, drainContinuableDescendants } = bench({ agents: [top] })
    const response = await api.sessions.stopTree(request({ sessionId: top.id }))
    expect(top.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(drainContinuableDescendants).toHaveBeenCalledExactlyOnceWith([top])
    expect(response.result).toEqual({
      ok: true,
      value: { ownTurnStopped: false, descendants: 'ok' },
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

  it('rejects with an internal error when a subagent-owned target records no parent session', async () => {
    // `origin: 'subagent'` alone routes this through the ownership branch;
    // omitting `parentSession` reaches the header-integrity guard that
    // branch depends on, never `interrupt` or the descendant drain.
    const orphan = fakeAgent(sid('orphan'), { origin: 'subagent' })
    const { api, interrupt, drainContinuableDescendants } = bench({ agents: [orphan] })
    const response = await api.sessions.stopTree(request({ sessionId: orphan.id }))
    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'session "orphan" is subagent-owned but its header records no parent session',
        details: {},
      },
    })
    expect(interrupt).not.toHaveBeenCalled()
    expect(drainContinuableDescendants).not.toHaveBeenCalled()
  })

  it('rejects with an internal error when interrupt throws for a subagent-owned target', async () => {
    const parent = sid('parent')
    const child = fakeAgent(sid('child'), { origin: 'subagent', parentSession: parent })
    const { api, drainContinuableDescendants } = bench({
      agents: [child],
      interruptError: new Error('activation admission is closing'),
    })
    const response = await api.sessions.stopTree(request({ sessionId: child.id }))
    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'stopping the subagent-owned turn for session "child" failed: activation admission is closing',
        details: {},
      },
    })
    expect(drainContinuableDescendants).not.toHaveBeenCalled()
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

  it('counts only roots that actually had active work aborted, while still cancelling every root', async () => {
    const running = fakeAgent(sid('top-running'))
    const idle = fakeAgent(sid('top-idle'), {}, { running: false })
    const { api, drainContinuableDescendants } = bench({
      agents: [running, idle],
      sessionRows: [{ id: running.id }, { id: idle.id }],
    })
    const response = await api.sessions.stopAll(request({}))
    // Every root is cancelled regardless of what it reports back -- the
    // count is about honest reporting, never about skipping a cancel call.
    expect(running.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(idle.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(drainContinuableDescendants).toHaveBeenCalledExactlyOnceWith([running, idle])
    expect(response.result).toEqual({
      ok: true,
      value: { stoppedCount: 1, descendants: 'ok' },
    })
  })
})

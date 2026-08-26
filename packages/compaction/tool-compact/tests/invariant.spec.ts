import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as invariant from '../src/invariant.ts'
import { arm, settle, take } from '../src/pending.ts'

type Listener = (...args: never[]) => unknown

interface Captured {
  readonly listeners: Map<string, Listener[]>
  readonly fail: ReturnType<typeof vi.fn>
}

/** Invoke the real installer against a recording context and capture its listeners and fail reporter. */
async function captured(): Promise<Captured> {
  const register = vi.fn().mockReturnValue(() => {})
  await invariant.apply({ invariants: { register } } as never)
  const install = register.mock.calls[0]![1] as unknown as (
    ctx: { on: (event: string, listener: Listener) => void },
    fail: (message: string) => never,
  ) => void
  const listeners = new Map<string, Listener[]>()
  const fail = vi.fn((message: string): never => {
    throw new Error(message)
  })
  install({
    on: (event, listener) => {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
    },
  }, fail)
  return { listeners, fail }
}

function fire(capturedListeners: Captured['listeners'], event: string, ...args: unknown[]): void {
  for (const listener of capturedListeners.get(event) ?? []) {
    ;(listener as (...listenerArgs: unknown[]) => unknown)(...args)
  }
}

function agentWithSession(id: string): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

function compactExec(agent: Agent): { name: string; agent: Agent } {
  return { name: 'compact', agent }
}

function successResult(scheduled: boolean): { isError: false; value: { scheduled: boolean } } {
  return { isError: false, value: { scheduled } }
}

describe('tool-compact invariant companion', () => {
  it('registers the package-owned installer under the manifest name', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    await invariant.apply({ invariants: { register } } as never)
    expect(invariant.name).toBe('tool-compact-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-tool-compact', expect.any(Function))
  })

  it('fails when a successful result claims a schedule without pending state', async () => {
    const { listeners, fail } = await captured()
    const agent = agentWithSession('unarmed-claim')

    expect(() => {
      fire(listeners, 'tools/result', compactExec(agent), successResult(true))
    }).toThrow(/pending set holds none/)
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('ignores failed results, other tools, non-agent callers, and dedup results', async () => {
    const { listeners, fail } = await captured()
    const agent = agentWithSession('ignored')

    fire(listeners, 'tools/result', { name: 'todo_write', agent }, successResult(true))
    fire(listeners, 'tools/result', compactExec(agent), { isError: true, value: undefined })
    fire(listeners, 'tools/result', { name: 'compact' }, successResult(true))
    // A live schedule backs dedup-shaped results: neither opens an obligation.
    arm(agent, new AbortController().signal)
    fire(listeners, 'tools/result', compactExec(agent), successResult(false))
    fire(listeners, 'tools/result', compactExec(agent), { isError: false, value: undefined })
    fire(listeners, 'session/event', agent.session, { type: 'user/message', seq: 0, time: 0, data: {} })
    fire(listeners, 'agent/status', { agent, status: 'running' })

    expect(fail).not.toHaveBeenCalled()
  })

  it('discharges the obligation through a compaction bracket before the next turn', async () => {
    const { listeners, fail } = await captured()
    const agent = agentWithSession('bracketed')
    arm(agent, new AbortController().signal)

    fire(listeners, 'tools/result', compactExec(agent), successResult(true))
    fire(listeners, 'session/event', agent.session, { type: 'compaction/start', seq: 1, time: 0, data: {} })
    fire(listeners, 'agent/status', { agent, status: 'running' })

    expect(fail).not.toHaveBeenCalled()
  })

  it('accepts a busy re-arm still holding pending state across the boundary', async () => {
    const { listeners, fail } = await captured()
    const agent = agentWithSession('rearmed')
    arm(agent, new AbortController().signal)

    fire(listeners, 'tools/result', compactExec(agent), successResult(true))
    fire(listeners, 'agent/status', { agent, status: 'running' })

    expect(fail).not.toHaveBeenCalled()
  })

  it('accepts an explicit terminal settlement instead of a bracket', async () => {
    const { listeners, fail } = await captured()
    const agent = agentWithSession('settled')
    arm(agent, new AbortController().signal)

    fire(listeners, 'tools/result', compactExec(agent), successResult(true))
    take(agent)
    settle(agent, 'cancelled')
    fire(listeners, 'agent/status', { agent, status: 'running' })
    fire(listeners, 'agent/status', { agent, status: 'idle' })
    fire(listeners, 'agent/status', { agent, status: 'running' })

    expect(fail).not.toHaveBeenCalled()
  })

  it('fails when the schedule is silently dropped across an idle boundary', async () => {
    const { listeners, fail } = await captured()
    const agent = agentWithSession('dropped')
    const signal = new AbortController().signal
    arm(agent, signal)

    fire(listeners, 'tools/result', compactExec(agent), successResult(true))
    // Simulate the armed state disappearing without any runner action.
    take(agent)

    expect(() => {
      fire(listeners, 'agent/status', { agent, status: 'running' })
    }).toThrow(/dropped across an idle boundary/)
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('stops tracking a session once its agent is disposed', async () => {
    const { listeners, fail } = await captured()
    const agent = agentWithSession('disposed')
    arm(agent, new AbortController().signal)

    fire(listeners, 'tools/result', compactExec(agent), successResult(true))
    fire(listeners, 'agent/disposed', { agent })
    fire(listeners, 'agent/status', { agent, status: 'running' })

    expect(fail).not.toHaveBeenCalled()
  })
})

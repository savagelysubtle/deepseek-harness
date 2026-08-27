/**
 * Follow-mode ownership fence: when a live headless process
 * (`dsh --profile headless --session-name <name>`) holds a named session's
 * lock, this host must serve its transcript read-only and refuse every entry
 * point that would resume or create an Agent for the same identity — the
 * fix for the cross-process double-writer bug (two independent next-seq
 * counters corrupting the same log). Once the owner releases the lock,
 * ordinary resume behavior returns.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { deriveNamedSessionId, internals, lockPathForToken } from '@deepseek-ai/dsh-named-sessions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let dirs: string[] = []
const originalInternals = { ...internals }

afterEach(() => {
  Object.assign(internals, originalInternals)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  delete process.env.DSH_HOME
})

/** A pid that is definitely not this process; paired with a stubbed liveness probe. */
const FOREIGN_PID = process.pid + 1

/**
 * Hold the seat's lock as ANOTHER process would.
 *
 * The real `acquireNamedSessionLock` records `process.pid`, and a test cannot
 * hold a genuinely foreign lock through the real API — simulating a FOREIGN
 * owner therefore means writing the same payload with another pid. This host
 * has no legitimate self-held case: any held lock names a foreign owner (the
 * one-writer rule, docs/architecture.md § "Session log").
 */
function holdForeignLock(name: string): { release(): void } {
  const path = lockPathForToken(deriveNamedSessionId(name).slice('named-'.length))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid: FOREIGN_PID, createdAt: Date.now() }), 'utf8')
  internals.isPidAlive = pid => pid === FOREIGN_PID
  return {
    release() {
      rmSync(path, { force: true })
      Object.assign(internals, originalInternals)
    },
  }
}

function tempDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-apiproxy-follow-'))
  dirs.push(dir)
  process.env.DSH_HOME = dir
  return dir
}

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`follow-${String(nextRpc++)}`), payload }
}

const SEAT_NAME = 'owned-seat'

describe('named-session follow mode (headless ownership fence)', () => {
  it('serves history read-only, and refuses create/prompt, while a live headless process holds the lock', async () => {
    tempDshHome()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)

    const sessionId = deriveNamedSessionId(SEAT_NAME)
    const header: SessionHeader = { version: 0, id: sessionId, createdAt: 1000, cwd: '/proj' }
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const inspect = vi.fn(() => Promise.resolve({ meta: header, events }))
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header]),
      inspect,
      locate: () => undefined, // no on-disk artifact to tail in this fixture; ownership gating is what's under test
    } as never)
    const resume = vi.spyOn(ctx.agents, 'resume')
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const lock = holdForeignLock(SEAT_NAME)
    try {
      const history = await api.sessions.history(request({ sessionId }))
      expect(history.result.ok).toBe(true)
      if (history.result.ok) {
        expect(history.result.value.events.map(entry => entry.event.type)).toEqual(['turn/start', 'turn/end'])
      }
      expect(ctx.agents.get(sessionId)).toBeUndefined()

      const create = await api.sessions.create(request({ sessionId, cwd: '/proj' }))
      expect(create.result.ok).toBe(false)
      if (!create.result.ok) {
        expect(create.result.error).toMatchObject({ code: 'agent-busy', details: { reason: 'headless-owned' } })
      }

      const prompt = await api.sessions.prompt(request({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'are you there?' }],
      }))
      expect(prompt.result.ok).toBe(false)
      if (!prompt.result.ok) {
        expect(prompt.result.error).toMatchObject({ code: 'agent-busy', details: { reason: 'headless-owned' } })
      }

      expect(resume).not.toHaveBeenCalled()
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    } finally {
      lock.release()
    }
  })

  it('resumes ordinary local ownership once the headless owner releases the lock', async () => {
    tempDshHome()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)

    const sessionId = deriveNamedSessionId('freed-seat')
    const header: SessionHeader = { version: 0, id: sessionId, createdAt: 1000, cwd: '/proj' }
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({ meta: header, events: [] as SessionEvent[] }),
      locate: () => undefined,
    } as never)
    const resumedSession = { id: sessionId, header, events: [] } as unknown as import('@deepseek-ai/dsh-session').Session
    const resumedAgent = { id: sessionId, session: resumedSession, status: 'idle', ctx } as Agent
    const resume = vi.spyOn(ctx.agents, 'resume')
      .mockResolvedValue({ agent: resumedAgent, dispose: () => Promise.resolve() })
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const lock = holdForeignLock('freed-seat')
    const refused = await api.sessions.create(request({ sessionId, cwd: '/proj' }))
    expect(refused.result.ok).toBe(false)
    lock.release()

    const created = await api.sessions.create(request({ sessionId, cwd: '/proj' }))
    expect(created.result.ok).toBe(true)
    expect(resume).toHaveBeenCalledTimes(1)
  })
})

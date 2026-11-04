/**
 * The host door's driver guard: `session.create` with an explicit id (the
 * open/resume path) and `session.fork` refuse a session whose stored log
 * records a non-default driver. A Claude Code seat's log is never resumed or
 * seeded by the default agent loop; a default log opens as before. Logs are
 * served by a persistence double and temp directories (nothing here reads
 * ~/.dsh).
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`driver-guard-${String(nextRpc++)}`), payload }
}

/** A stored event as persistence would return it; the guard reads only `type`. */
function stored(type: string, seq: number): { type: string; seq: number; time: number; data: object } {
  return { type, seq, time: 0, data: {} }
}

/** Append an event of a type the typed map may not list (the guard reads only `type`). */
function appendRaw(session: Session, type: string): void {
  const loose = session as unknown as { append: (type: string, data: object, options?: object) => void }
  if (type === 'assistant/message') loose.append(type, {}, { surfaceOp: 'append' })
  else loose.append(type, {})
}

interface Harness {
  readonly api: ReturnType<typeof createApiProxy>
  readonly ctx: Context
  readonly cwd: string
  readonly resumed: string[]
  readonly created: string[]
}

/**
 * A composed host with a stub factory that records which sessions the default
 * loop was asked to resume or create, and a persistence double that serves the
 * given stored logs (cold, no live agent).
 */
async function harness(logs: Record<string, readonly string[]> = {}): Promise<Harness> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-driver-guard-')))
  expect(cwd.startsWith(realpathSync(tmpdir()))).toBe(true)
  dirs.push(cwd)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  const metas = Object.keys(logs).map(id => ({ id: SessionId(id), createdAt: 1, cwd }))
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve(metas),
    inspect: (id: string) => Promise.resolve({
      meta: metas.find(meta => meta.id === id),
      events: (logs[id] ?? []).map((type, index) => stored(type, index)),
    }),
  } as never)
  const resumed: string[] = []
  const created: string[] = []
  const publish = (session: Session): Promise<{ agent: Agent; dispose: () => Promise<void> }> => {
    const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
    const unregister = ctx.agents.register(agent)
    return Promise.resolve({ agent, dispose: () => { unregister(); return Promise.resolve() } })
  }
  const factory: AgentFactory = {
    createAgent(_ownerCtx, options) {
      created.push(options.sessionId)
      return publish(ctx.sessions.create(options.sessionId, options.meta === undefined ? {} : { meta: options.meta }))
    },
    resume(_ownerCtx, options) {
      resumed.push(options.resumeSessionId)
      return publish(ctx.sessions.create(options.resumeSessionId, { meta: { cwd } }))
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
  })
  return { api, ctx, cwd, resumed, created }
}

describe('session.create (open/resume) driver guard', () => {
  it('refuses to resume a claude-code log under the default loop', async () => {
    const h = await harness({ cc: ['user/message', 'claude-code/session-bound', 'assistant/message'] })
    const response = await h.api.sessions.create(request({ sessionId: SessionId('cc') }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-busy')
    expect(response.result.error.details).toEqual({ reason: 'session-driver-mismatch' })
    expect(response.result.error.message).toContain('"claude-code" driver history')
    expect(h.resumed).toEqual([])
    expect(h.created).toEqual([])
  })

  it('refuses a mixed log (both drivers left history) as well', async () => {
    const h = await harness({ mixed: ['request/header', 'claude-code/session-bound'] })
    const response = await h.api.sessions.create(request({ sessionId: SessionId('mixed') }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.details).toEqual({ reason: 'session-driver-mismatch' })
    expect(response.result.error.message).toContain('"mixed" driver history')
    expect(h.resumed).toEqual([])
  })

  it('still resumes a default log', async () => {
    const h = await harness({ plain: ['request/header', 'user/message', 'assistant/message'] })
    const response = await h.api.sessions.create(request({ sessionId: SessionId('plain') }))
    expect(response.result.ok).toBe(true)
    expect(h.resumed).toEqual(['plain'])
  })

  it('still resumes a log that makes no driver claim (only unanswered messages)', async () => {
    const h = await harness({ quiet: ['user/message'] })
    const response = await h.api.sessions.create(request({ sessionId: SessionId('quiet') }))
    expect(response.result.ok).toBe(true)
    expect(h.resumed).toEqual(['quiet'])
  })

  it('refuses to adopt a live agent whose session recorded claude-code history', async () => {
    const h = await harness()
    const session = h.ctx.sessions.create(SessionId('live-cc'), { meta: { cwd: h.cwd } })
    appendRaw(session, 'claude-code/session-bound')
    h.ctx.agents.register({ id: session.id, session, status: 'idle', ctx: h.ctx } as unknown as Agent)
    const response = await h.api.sessions.create(request({ sessionId: SessionId('live-cc') }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.details).toEqual({ reason: 'session-driver-mismatch' })
  })

  it('still adopts a live default agent', async () => {
    const h = await harness()
    const session = h.ctx.sessions.create(SessionId('live-default'), { meta: { cwd: h.cwd } })
    h.ctx.agents.register({ id: session.id, session, status: 'idle', ctx: h.ctx } as unknown as Agent)
    const response = await h.api.sessions.create(request({ sessionId: SessionId('live-default') }))
    expect(response.result.ok).toBe(true)
  })
})

describe('session.fork driver guard', () => {
  /** A live source session with one completed turn so the fork would otherwise succeed. */
  function liveSource(h: Harness, id: string, extraTypes: readonly string[]): Session {
    const session = h.ctx.sessions.create(SessionId(id), { meta: { cwd: h.cwd } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (const type of extraTypes) appendRaw(session, type)
    h.ctx.agents.register({ id: session.id, session, status: 'idle', ctx: h.ctx } as unknown as Agent)
    return session
  }

  it('refuses to fork a claude-code log with fork-unavailable, creating no child', async () => {
    const h = await harness()
    const source = liveSource(h, 'fork-cc', ['claude-code/session-bound'])
    const response = await h.api.sessions.fork(request({ sessionId: source.id }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('fork-unavailable')
    expect(response.result.error.message).toContain('cannot be opened or forked by the default agent loop')
    expect(h.created).toEqual([])
  })

  it('still forks a default log', async () => {
    const h = await harness()
    const source = liveSource(h, 'fork-default', ['request/header', 'assistant/message'])
    const response = await h.api.sessions.fork(request({ sessionId: source.id }))
    expect(response.result.ok, JSON.stringify(response.result)).toBe(true)
    expect(h.created).toHaveLength(1)
  })
})

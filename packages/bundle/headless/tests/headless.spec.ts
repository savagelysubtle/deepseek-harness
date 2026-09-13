/** Direct one-shot Agent driving, durable aggregation, flushing, and exit mapping. */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { apply, Config, internals, resolveRunSpec } from '../src/index.ts'
import {
  acquireNamedSessionLock,
  deriveNamedSessionId,
  namedLockPath,
} from '@deepseek-ai/dsh-named-sessions'

const originalInternals = { ...internals }
afterEach(() => {
  Object.assign(internals, originalInternals)
  delete process.env.DSH_HOME
})

interface Script {
  before?(session: Session): void
  afterPrompt(session: Session, message: UserMessage): Promise<void> | void
  /** Session ids the stand-in persistence backend reports as materialized. */
  persisted?: SessionId[]
  /** When true, `agents.create` rejects instead of building an Agent. */
  createRejects?: string | undefined
  /** When set, `agents.resume` rejects instead of building an Agent. */
  resumeRejects?: string | undefined
}

function appendTurn(
  session: Session,
  turn: number,
  message: UserMessage,
  text: string | undefined,
  completed: boolean,
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  if (text !== undefined) {
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', {
    turn,
    reason: completed
      ? { kind: 'completed' }
      : { kind: 'aborted', reason: { kind: 'user' } },
  })
}

/** Mount the real registries around a small scripted Agent factory. */
async function bench(script: Script): Promise<{
  ctx: Context
  created: SessionId[]
  resumed: SessionId[]
  run(config?: Partial<Config>): Promise<{ code: number; out: string; err: string; order: string[] }>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  const created: SessionId[] = []
  const resumed: SessionId[] = []
  const buildAgent = async (
    ownerCtx: Context,
    sessionId: SessionId,
    options: Omit<CreateAgentOptions, 'sessionId'>,
  ): Promise<AgentHandle> => {
    const session = ctx.sessions.create(sessionId, {
      ...options.meta === undefined ? {} : { meta: options.meta },
    })
    let idle = Promise.resolve()
    const agent = {} as Agent
    const agentCtx = ownerCtx.extend({ agent })
    Object.assign(agent, {
      id: session.id,
      options: options.agentOptions ?? {},
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: agentCtx,
      cancel: () => false,
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        agent.inbox.append('next-turn', message)
        idle = Promise.resolve().then(() => script.afterPrompt(session, message))
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => idle,
    } satisfies Partial<Agent>)
    await options.setup?.(agentCtx)
    script.before?.(session)
    ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      if (script.createRejects !== undefined) throw new Error(script.createRejects)
      created.push(options.sessionId)
      const { sessionId, ...rest } = options
      return buildAgent(ownerCtx, sessionId, rest)
    },
    async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
      resumed.push(options.resumeSessionId)
      if (script.resumeRejects !== undefined) throw new Error(script.resumeRejects)
      return buildAgent(ownerCtx, options.resumeSessionId, {
        // ResumeAgentOptions carries these as optional; the builder's contract
        // requires present values, and the resume path always supplies them.
        agentOptions: options.agentOptions as NonNullable<ResumeAgentOptions['agentOptions']>,
        setup: options.setup as NonNullable<ResumeAgentOptions['setup']>,
        meta: { cwd: process.cwd() },
      })
    },
  })
  ctx.provide('sessionPersistence', {
    list: async () => (script.persisted ?? []).map(id => ({ id })),
  } as never)
  return {
    ctx,
    created,
    resumed,
    run: async (config?: Partial<Config>) => {
      let out = ''
      let err = ''
      const order: string[] = []
      ctx.on('session/flush', () => { order.push('flush') })
      internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
      internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
      const exited = new Promise<number>((resolve) => {
        ctx.provide('appExit', (code: number) => { order.push('exit'); resolve(code) })
      })
      apply(ctx, { task: 'do the thing', ...config })
      return { code: await exited, out, err, order }
    },
  }
}

describe('headless runner', () => {
  it('aggregates the final text across the complete idle-to-idle interval and flushes before exit', async () => {
    const test = await bench({
      before(session) {
        const setupMessage = {
          role: 'user', content: [{ type: 'text', text: 'setup' }], source: { kind: 'user' }, id: 'setup',
        } as UserMessage
        appendTurn(session, 0, setupMessage, 'pre-task noise', true)
      },
      async afterPrompt(session, message) {
        await Promise.resolve()
        appendTurn(session, 1, message, '', true)
        appendTurn(session, 2, message, 'final answer', true)
      },
    })
    const result = await test.run()
    expect(result).toEqual({
      code: 0,
      out: 'final answer\n',
      err: '',
      order: ['flush', 'exit'],
    })
    await test.ctx.fiber.dispose()
  })

  it('waits for asynchronously appended events instead of racing Agent idleness', async () => {
    const test = await bench({
      afterPrompt: async (session, message) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        appendTurn(session, 1, message, 'race-free answer', true)
      },
    })
    expect(await test.run()).toMatchObject({ code: 0, out: 'race-free answer\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('exits 1 when the final turn does not complete', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, undefined, false) },
    })
    expect(await test.run()).toMatchObject({ code: 1, out: '\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('prints the durable model failure when the final turn ends in error', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } },
        })
      },
    })
    expect(await test.run()).toMatchObject({
      code: 1,
      out: '\n',
      err: 'dsh: SERVER: provider unavailable\n',
    })
    await test.ctx.fiber.dispose()
  })

  it('exits 1 when the owned interval contains no turn', async () => {
    const test = await bench({ afterPrompt: () => {} })
    expect(await test.run()).toMatchObject({ code: 1, out: '\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('reports a direct Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.stdout = { write: () => true }
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agents', { create: () => Promise.reject(new Error('factory exploded')) } as never)
    apply(ctx, { task: 't' })
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('stringifies a non-Error Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.stdout = { write: () => true }
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    const rejected = {
      then(_resolve: (value: never) => void, reject: (reason: unknown) => void): void {
        reject('factory exploded')
      },
    }
    ctx.provide('agents', { create: () => rejected } as never)
    apply(ctx, { task: 't' })
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('abandons a run when the tree is disposed during Loader settlement', async () => {
    const ctx = new Context()
    let exited = false
    internals.stdout = { write: () => true }
    internals.stderr = { write: () => true }
    ctx.provide('appExit', () => { exited = true })
    const services = ctx.plugin((child: Context) => {
      child.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
      child.provide('sessions', {} as never)
      child.provide('agents', {} as never)
    })
    await services
    let release: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('loader', { await: () => settlement } as never)
    apply(ctx, { task: 't' })
    await services.dispose()
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })

  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, { task: 't' }) }).toThrow('must provide ctx.appExit')
  })

  it('validates config: the task is required', () => {
    expect(() => new Config({} as never)).toThrow()
    expect(new Config({ task: 'x' })).toEqual({ task: 'x', format: 'text' })
  })
})

describe('headless named sessions', () => {
  /** A temp DSH_HOME so lock artifacts land outside the user home. */
  function useTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-runner-'))
    process.env.DSH_HOME = dir
    return dir
  }

  it('creates on the derived id when no log is persisted', async () => {
    useTempHome()
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'first answer', true) },
    })
    const result = await test.run({ sessionName: 'work' })
    const id = deriveNamedSessionId('work')
    expect(test.created).toEqual([id])
    expect(test.resumed).toEqual([])
    expect(result.code).toBe(0)
    expect(result.out).toBe('first answer\n')
    await test.ctx.fiber.dispose()
  })

  it('resumes when a log is persisted instead of recreating', async () => {
    useTempHome()
    const id = deriveNamedSessionId('work')
    const test = await bench({
      persisted: [id],
      before(session) {
        const setupMessage = {
          role: 'user', content: [{ type: 'text', text: 'earlier' }], source: { kind: 'user' }, id: 'earlier',
        } as UserMessage
        appendTurn(session, 0, setupMessage, 'prior answer', true)
      },
      afterPrompt(session, message) { appendTurn(session, 1, message, 'second answer', true) },
    })
    const result = await test.run({ sessionName: 'work' })
    expect(test.resumed).toEqual([id])
    expect(test.created).toEqual([])
    // The resumed session replays prior context before this run's interval.
    expect(result.out).toBe('second answer\n')
    await test.ctx.fiber.dispose()
  })

  it('streams NDJSON lines scoped to this run and suppresses the plain summary', async () => {
    useTempHome()
    const id = deriveNamedSessionId('stream')
    const test = await bench({
      persisted: [id],
      before(session) {
        const setupMessage = {
          role: 'user', content: [{ type: 'text', text: 'setup' }], source: { kind: 'user' }, id: 'setup',
        } as UserMessage
        appendTurn(session, 0, setupMessage, 'pre-task noise', true)
      },
      afterPrompt(session, message) {
        appendTurn(session, 1, message, undefined, false)
        appendTurn(session, 2, message, '', true)
        session.append('turn/start', { turn: 3 })
        session.append('step/start', { turn: 3, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn: 3,
          step: 1,
          message: createAssistantMessage({
            content: [
              { type: 'text', text: 'joined ' },
              { type: 'text', text: 'blocks' },
            ],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 3, step: 1 })
        session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
      },
    })
    const result = await test.run({ sessionName: 'stream', format: 'json' })
    const lines = result.out.split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(2)
    const parsed = lines.map(line => JSON.parse(line) as unknown)
    expect(parsed[0]).toEqual({
      type: 'text',
      sessionID: id,
      part: { type: 'text', text: '' },
    })
    expect(parsed[1]).toEqual({
      type: 'text',
      sessionID: id,
      part: { type: 'text', text: 'joined blocks' },
    })
    expect(result.out).not.toContain('pre-task noise')
    await test.ctx.fiber.dispose()
  })

  it('surfaces an unloadable persisted log loudly instead of recreating', async () => {
    useTempHome()
    const id = deriveNamedSessionId('broken')
    const test = await bench({
      persisted: [id],
      resumeRejects: 'log unreadable',
      afterPrompt(session, message) { appendTurn(session, 1, message, 'recreated', true) },
    })
    const result = await test.run({ sessionName: 'broken' })
    expect(test.resumed).toEqual([id])
    expect(test.created).toEqual([])
    expect(result.code).toBe(1)
    expect(result.err).toBe('dsh: log unreadable\n')
    expect(existsSync(namedLockPath('broken'))).toBe(false)
  })

  it('releases the lock when the run fails at Agent creation', async () => {
    useTempHome()
    const test = await bench({
      createRejects: 'factory exploded',
      afterPrompt() {},
    })
    const result = await test.run({ sessionName: 'doomed' })
    expect(result.code).toBe(1)
    expect(result.err).toBe('dsh: factory exploded\n')
    expect(existsSync(namedLockPath('doomed'))).toBe(false)
  })

  it('releases the lock when the run completes', async () => {
    useTempHome()
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'done', true) },
    })
    const result = await test.run({ sessionName: 'clean' })
    expect(result.code).toBe(0)
    expect(existsSync(namedLockPath('clean'))).toBe(false)
    await test.ctx.fiber.dispose()
  })

  it('fails loud while another live process holds the name', async () => {
    useTempHome()
    const holder = acquireNamedSessionLock('contested')
    const test = await bench({ afterPrompt() {} })
    const result = await test.run({ sessionName: 'contested' })
    expect(result.code).toBe(1)
    expect(result.err).toBe('dsh: session "contested" is active in another process\n')
    holder.release()
  })

  it('validates config: unknown formats fail loud at the schema, bad names in the resolver', () => {
    expect(() => new Config({ task: 't', format: 'yaml' as never })).toThrow()
    expect(() => resolveRunSpec({ task: 't', sessionName: '-bad' })).toThrow('invalid session name')
    expect(resolveRunSpec({ task: 't', format: 'json', sessionName: 'ok.Name-1' })).toEqual({
      kind: 'named',
      name: 'ok.Name-1',
      sessionId: deriveNamedSessionId('ok.Name-1'),
      json: true,
    })
    expect(resolveRunSpec({ task: 't' })).toEqual({ kind: 'one-shot', json: false })
  })

  it('fails loud in named mode without a persistence backend', async () => {
    useTempHome()
    const ctx = new Context()
    let err = ''
    internals.stdout = { write: () => true }
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    ctx.provide('appExit', () => {})
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', {} as never)
    apply(ctx, { task: 't', sessionName: 'needs-persistence' })
    await new Promise(resolve => setImmediate(resolve))
    expect(err).toContain('named sessions require a configured session-persistence backend')
    await ctx.fiber.dispose()
  })
})

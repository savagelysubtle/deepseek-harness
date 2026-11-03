/**
 * The plugin entry running a real turn end to end: the SDK `query` and
 * `getSessionInfo` are replaced by the fake query, the subprocess owner by a
 * fake that hands out fake children. Everything else is the shipped code.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FakeQuery, fakeChild, resultMessage, seatRow, tick, userMessage } from './fakes.ts'

const sdk = vi.hoisted(() => ({
  queries: [] as unknown[],
  make: undefined as undefined | ((prompt: never, options: never) => unknown),
  sessionInfo: undefined as unknown,
  sessionInfoError: undefined as Error | undefined,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...original,
    query: ({ prompt, options }: { prompt: never; options: never }) => {
      const fake = (sdk.make as NonNullable<typeof sdk.make>)(prompt, options)
      sdk.queries.push(fake)
      return fake
    },
    getSessionInfo: () => {
      if (sdk.sessionInfoError !== undefined) return Promise.reject(sdk.sessionInfoError)
      return Promise.resolve(sdk.sessionInfo)
    },
  }
})

sdk.make = (prompt, options) => new FakeQuery(prompt, options)

const Driver = await import('../src/index.ts')

class FakeSubprocess extends Service {
  readonly children: SubprocessHandle[] = []

  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  spawn(): SubprocessHandle {
    const child = fakeChild(4242)
    this.children.push(child)
    return child
  }
}

async function bootedContext(): Promise<Context> {
  const ctx = new Context()
  const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
  const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FakeSubprocess)
  return ctx
}

async function nthQuery(index: number): Promise<FakeQuery> {
  for (let attempt = 0; attempt < 200 && sdk.queries[index] === undefined; attempt++) await tick(5)
  return sdk.queries[index] as FakeQuery
}

describe('sdkTranscriptState', () => {
  it('maps the SDK lookup to ok, missing, and unreadable', async () => {
    sdk.sessionInfoError = undefined
    sdk.sessionInfo = { sessionId: 'x' }
    expect(await Driver.sdkTranscriptState('x', '/w')).toBe('ok')
    sdk.sessionInfo = undefined
    expect(await Driver.sdkTranscriptState('x', '/w')).toBe('missing')
    sdk.sessionInfoError = new Error('EACCES')
    expect(await Driver.sdkTranscriptState('x', '/w')).toBe('unreadable')
    sdk.sessionInfoError = undefined
  })
})

describe('the plugin running a turn', () => {
  it('reaps a recorded orphan and runs a turn through the real wiring', async () => {
    const ctx = await bootedContext()
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-driver-plugin-'))
    // A real, live process in its own group with a matching start time is a genuine orphan to reap.
    const orphan = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    const gone = new Promise<void>((resolve) => { orphan.once('exit', () => { resolve() }) })
    const { readProcessStartTime } = await import('../src/ledger.ts')
    await tick(50)
    const startTime = readProcessStartTime(orphan.pid as number)
    expect(startTime).toBeDefined()
    writeFileSync(join(stateDir, 'claude-code-seat-pids.json'), JSON.stringify([{ seat: 'orphan', pid: orphan.pid, startTime }]))
    const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir, seats: { s1: seatRow() } }))
    await gone

    const handle = await ctx.agents.create({ sessionId: SessionId('s1'), driver: 'claude-code', meta: { cwd: '/w' } })
    handle.agent.followup(userMessage('hello'))
    const query = await nthQuery(0)
    expect(query.options.cwd).toBe('/w')
    query.spawn()
    query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    await handle.agent.whenIdle()
    expect(handle.agent.session.events.some(event => event.type === 'claude-code/turn-completed')).toBe(true)
    await handle.dispose()
    await fiber.dispose()
  })

  it('reports a pid-ledger write failure through the logger and keeps the turn alive', async () => {
    const ctx = await bootedContext()
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-driver-plugin-'))
    const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir, seats: { s2: seatRow() } }))
    const warn = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => undefined)
    const handle = await ctx.agents.create({ sessionId: SessionId('s2'), driver: 'claude-code', meta: { cwd: '/w' } })
    const before = sdk.queries.length
    handle.agent.followup(userMessage('hello'))
    const query = await nthQuery(before)
    // Turn the ledger file into a directory so the child-pid write fails with a non-ENOENT error.
    rmSync(join(stateDir, 'claude-code-seat-pids.json'), { force: true })
    mkdirSync(join(stateDir, 'claude-code-seat-pids.json'), { recursive: true })
    query.spawn()
    query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    await handle.agent.whenIdle()
    expect(warn.mock.calls.flat().join('\n')).toContain('could not record child pid in the ledger')
    warn.mockRestore()
    await handle.dispose()
    await fiber.dispose()
  })

  it('refuses resume without persistence and names the configured seats when a seat is unknown', async () => {
    const ctx = await bootedContext()
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-driver-plugin-'))
    const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir, seats: {} }))
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('r'), driver: 'claude-code' })).rejects.toThrow(/persistence is not configured/)
    await expect(ctx.agents.create({ sessionId: SessionId('nobody'), driver: 'claude-code', meta: { cwd: '/w' } }))
      .rejects.toThrow(/\(configured seats: none\)/)
    await fiber.dispose()
  })

  it('applies the built-in timing defaults when the config object omits them', async () => {
    const ctx = await bootedContext()
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-driver-plugin-'))
    const fiber = await ctx.plugin(Object.assign((inner: Context) => { Driver.apply(inner, { stateDir, seats: {} }) }, { inject: ['agents', 'sessions', 'subprocess'] }))
    expect(ctx.agents.listDrivers()).toEqual(['claude-code'])
    await fiber.dispose()
  })
})

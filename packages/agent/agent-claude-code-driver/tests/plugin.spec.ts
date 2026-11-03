/**
 * The plugin entry running a real turn end to end: the SDK `query` and
 * `getSessionInfo` are replaced by the fake query, the subprocess owner by a
 * fake that hands out fake children. Everything else is the shipped code.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { SessionId } from '@deepseek-ai/dsh-session'
import { cleanTempDirs, FakeQuery, fakeChild, fakeClaudeBinary, resultMessage, seatRow, tempDir, tick, userMessage } from './fakes.ts'

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
const { ProcessLedger, readBootId } = await import('../src/ledger.ts')
const { ensurePrivateDir } = await import('../src/state.ts')
const { sha256File } = await import('../src/attest.ts')

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
  afterEach(() => {
    vi.restoreAllMocks()
    cleanTempDirs()
  })

  /** A harness home with a state directory, an attested fake binary, and a real working directory. */
  function setup() {
    const dshHome = tempDir('cc-home-')
    const stateDir = join(dshHome, 'claude-code')
    return { dshHome, stateDir, binary: fakeClaudeBinary(), cwd: tempDir('cc-work-') }
  }

  it('reaps a recorded orphan and runs a turn through the real wiring', async () => {
    const ctx = await bootedContext()
    const { dshHome, stateDir, binary, cwd } = setup()
    ensurePrivateDir(stateDir)
    // A real, live process in its own group with a matching start time is a genuine orphan to reap.
    const orphan = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    try {
      const gone = new Promise<void>((resolve) => { orphan.once('exit', () => { resolve() }) })
      const { readProcessStartTime } = await import('../src/ledger.ts')
      await tick(50)
      const startTime = readProcessStartTime(orphan.pid as number)
      expect(startTime).toBeDefined()
      writeFileSync(
        join(stateDir, 'claude-code-seat-pids.json'),
        JSON.stringify([{ seat: 'orphan', pid: orphan.pid, startTime, hostPid: 1, hostStartTime: '', bootId: readBootId() }]),
        { mode: 0o600 },
      )
      const warn = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => undefined)
      const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats: { s1: seatRow({ claude_path: binary }) } }))
      await gone
      expect(warn.mock.calls.flat().join('\n')).toContain('killed orphaned Claude Code children of seats: orphan')

      const handle = await ctx.agents.create({ sessionId: SessionId('s1'), driver: 'claude-code', meta: { cwd } })
      handle.agent.followup(userMessage('hello'))
      const query = await nthQuery(0)
      expect(query.options.cwd).toBe(cwd)
      query.spawn()
      query.emit(resultMessage({ user_message_uuids: query.uuids() }))
      await handle.agent.whenIdle()
      expect(handle.agent.session.events.some(event => event.type === 'claude-code/turn-completed')).toBe(true)
      await handle.dispose()
      await fiber.dispose()
    } finally {
      try {
        process.kill(-(orphan.pid as number), 'SIGKILL')
      } catch {
        // already reaped
      }
    }
  })

  it('reports a pid-ledger write failure through the logger and keeps the turn alive', async () => {
    const ctx = await bootedContext()
    const { dshHome, stateDir, binary, cwd } = setup()
    const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats: { s2: seatRow({ claude_path: binary }) } }))
    const warn = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => undefined)
    const handle = await ctx.agents.create({ sessionId: SessionId('s2'), driver: 'claude-code', meta: { cwd } })
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
    await handle.dispose()
    await fiber.dispose()
  })

  it('refuses resume without persistence and names the configured seats when a seat is unknown', async () => {
    const ctx = await bootedContext()
    const { dshHome, cwd } = setup()
    const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats: {} }))
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('r'), driver: 'claude-code' })).rejects.toThrow(/persistence is not configured/)
    await expect(ctx.agents.create({ sessionId: SessionId('nobody'), driver: 'claude-code', meta: { cwd } }))
      .rejects.toThrow(/\(configured seats: none\)/)
    await fiber.dispose()
  })

  it('applies the built-in timing defaults when the config object omits them', async () => {
    const ctx = await bootedContext()
    const { dshHome } = setup()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => { Driver.apply(inner, { stateDir: 'claude-code', dshHome, seats: {} }) }, { inject: ['agents', 'sessions', 'subprocess'] }))
    expect(ctx.agents.listDrivers()).toEqual(['claude-code'])
    await fiber.dispose()
  })

  it('refuses a coder row at start because no permission-policy extension exists yet', async () => {
    const ctx = await bootedContext()
    const { dshHome, binary } = setup()
    await expect(ctx.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats: { c: seatRow({ role: 'coder', claude_path: binary }) } })))
      .rejects.toThrow(/coder/)
  })

  it('refuses a state directory outside the harness home and an unattestable binary', async () => {
    const ctx = await bootedContext()
    const { dshHome, binary } = setup()
    await expect(ctx.plugin(Driver, Driver.Config({ stateDir: '/tmp/elsewhere', dshHome, seats: {} })))
      .rejects.toThrow(/must name a subdirectory of the harness home/)
    await expect(ctx.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats: { x: seatRow({ claude_path: `${binary}.sh` }) } })))
      .rejects.toThrow(/refused/)
  })

  it('attests a binary shared by several seats once and refuses it when it changes, until the new hash is pinned', async () => {
    const { dshHome, binary } = setup()
    const seats = { a: seatRow({ claude_path: binary }), b: seatRow({ claude_path: binary }) }
    const first = await bootedContext()
    const fiber = await first.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats }))
    await fiber.dispose()
    appendFileSync(binary, '# upgraded\n')
    const second = await bootedContext()
    await expect(second.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats })))
      .rejects.toThrow(/the claude binary changed .*claude_path_sha256/)
    const pin = sha256File(binary)
    const pinnedRow = seatRow({ claude_path: binary, claude_path_sha256: pin })
    const pinned = { a: pinnedRow, b: pinnedRow }
    const third = await bootedContext()
    const repinned = await third.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats: pinned }))
    await repinned.dispose()
    const fourth = await bootedContext()
    const accepted = await fourth.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats }))
    await accepted.dispose()
  })

  it('warns about survivors, failed kills and entries of another live host', async () => {
    const ctx = await bootedContext()
    const { dshHome } = setup()
    vi.spyOn(ProcessLedger.prototype, 'reapStale').mockReturnValue({ reaped: [], stale: [], skipped: ['theirs'], survivors: ['left'], failed: ['denied'] })
    const warn = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => undefined)
    const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats: {} }))
    const text = warn.mock.calls.flat().join('\n')
    expect(text).toContain('seats left left process-group members behind')
    expect(text).toContain('could not kill the orphaned children of seats denied')
    expect(text).toContain('seats theirs belong to another live host')
    await fiber.dispose()
  })

  it('refuses a turn when the attested binary changed on disk after start', async () => {
    const ctx = await bootedContext()
    const { dshHome, binary, cwd } = setup()
    const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir: 'claude-code', dshHome, seats: { sw: seatRow({ claude_path: binary }) } }))
    const handle = await ctx.agents.create({ sessionId: SessionId('sw'), driver: 'claude-code', meta: { cwd } })
    const before = sdk.queries.length
    appendFileSync(binary, '# swapped\n')
    handle.agent.followup(userMessage('hello'))
    await handle.agent.whenIdle()
    expect(sdk.queries.length).toBe(before)
    expect(JSON.stringify(handle.agent.session.events)).toContain('changed since this host attested it')
    await handle.dispose()
    await fiber.dispose()
  })
})

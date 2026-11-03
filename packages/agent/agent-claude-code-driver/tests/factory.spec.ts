import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { DEFAULT_AGENT_DRIVER } from '@deepseek-ai/dsh-agent'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import * as Driver from '../src/index.ts'
import { ClaudeCodeSeatFactory } from '../src/factory.ts'
import type { ResolvedSeat } from '../src/factory.ts'
import { cleanHostEnv, cleanTempDirs, fakeClaudeBinary, harness, resultMessage, seatConfig, seatRow, tempDir, tick, userMessage } from './fakes.ts'

class FakeSubprocess extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  spawn(): never {
    throw new Error('the factory tests never spawn')
  }
}

describe('ClaudeCodeSeatFactory through the keyed registry', () => {
  async function wired() {
    const h = await harness()
    const resolved: ResolvedSeat = { seat: 'seat-a', config: seatConfig() }
    const factory = new ClaudeCodeSeatFactory({
      ctx: h.ctx,
      resolveSeat: (_id, hint) => {
        if (hint !== undefined && hint !== 'seat-a') throw new Error(`no seat row for "${hint}"`)
        return resolved
      },
      deps: h.deps,
      persistence: () => undefined,
      gate: h.gate,
      realpath: path => path,
    })
    h.ctx.agents.setFactory(factory, 'claude-code')
    return { h, factory }
  }

  it('registers under the claude-code key and leaves the default driver untouched', async () => {
    const { h } = await wired()
    expect(h.ctx.agents.listDrivers()).toEqual(['claude-code'])
    await expect(h.ctx.agents.create({ sessionId: SessionId('d1'), meta: { cwd: '/work/seat' } })).rejects.toThrow(
      new RegExp(`no agent factory registered for driver '${DEFAULT_AGENT_DRIVER}'|no agent factory registered`),
    )
  })

  it('creates a published seat agent whose first mail starts a bound query', async () => {
    const { h } = await wired()
    const handle = await h.ctx.agents.create({
      sessionId: SessionId('seat-a-session'), driver: 'claude-code', meta: { cwd: '/work/seat', agentPreset: 'seat-a' },
    })
    expect(h.ctx.agents.get(SessionId('seat-a-session'))).toBe(handle.agent)
    expect(handle.agent.options).toEqual({ provider: 'claude-code', model: 'sonnet' })
    handle.agent.followup(userMessage('first mail'))
    const query = await h.query(0)
    expect(query.options.cwd).toBe('/work/seat')
    query.emit(resultMessage())
    await handle.agent.whenIdle()
    await handle.dispose()
    expect(h.ctx.agents.get(SessionId('seat-a-session'))).toBeUndefined()
    expect(h.ctx.sessions.get(SessionId('seat-a-session'))).toBeUndefined()
  })

  it('rejects a second create for a seat that has a live query, then allows it after the turn ends', async () => {
    const { h } = await wired()
    const first = await h.ctx.agents.create({ sessionId: SessionId('live-1'), driver: 'claude-code', meta: { cwd: '/work/seat' } })
    first.agent.followup(userMessage('busy'))
    const query = await h.query(0)
    await expect(h.ctx.agents.create({ sessionId: SessionId('live-2'), driver: 'claude-code', meta: { cwd: '/work/seat' } }))
      .rejects.toThrow(/seat "seat-a" already has a live Claude Code query/)
    expect(h.ctx.agents.get(SessionId('live-2'))).toBeUndefined()
    query.emit(resultMessage())
    await first.agent.whenIdle()
    const second = await h.ctx.agents.create({ sessionId: SessionId('live-2'), driver: 'claude-code', meta: { cwd: '/work/seat' } })
    await second.dispose()
    await first.dispose()
  })

  it('passes an explicit seed through and refuses meta without a cwd', async () => {
    const { h } = await wired()
    await expect(h.ctx.agents.create({ sessionId: SessionId('m1'), driver: 'claude-code', meta: { agentPreset: 'seat-a' } }))
      .rejects.toThrow(/absolute meta\.cwd/)
    const handle = await h.ctx.agents.create({ sessionId: SessionId('m2'), driver: 'claude-code', seed: [], meta: { cwd: '/w' } })
    expect(h.ctx.agents.get(SessionId('m2'))).toBe(handle.agent)
    await handle.dispose()
  })

  it('refuses to publish when setup aborts the signal and then returns normally', async () => {
    const { h } = await wired()
    const controller = new AbortController()
    await expect(h.ctx.agents.create({
      sessionId: SessionId('late-abort'), driver: 'claude-code', meta: { cwd: '/w' }, signal: controller.signal,
      setup: () => { controller.abort(new Error('aborted during setup')) },
    })).rejects.toThrow('aborted during setup')
    expect(h.ctx.agents.get(SessionId('late-abort'))).toBeUndefined()
  })

  it('requires an absolute cwd, a known seat, and an active factory', async () => {
    const { h, factory } = await wired()
    await expect(h.ctx.agents.create({ sessionId: SessionId('n1'), driver: 'claude-code' })).rejects.toThrow(/absolute meta\.cwd/)
    await expect(h.ctx.agents.create({ sessionId: SessionId('n2'), driver: 'claude-code', meta: { cwd: 'rel' } })).rejects.toThrow(/absolute meta\.cwd/)
    await expect(h.ctx.agents.create({ sessionId: SessionId('n3'), driver: 'claude-code', meta: { cwd: '/w', agentPreset: 'other' } }))
      .rejects.toThrow(/no seat row for "other"/)
    expect(factory.seatGate).toBe(h.gate)
    await factory.dispose()
    await expect(h.ctx.agents.create({ sessionId: SessionId('n4'), driver: 'claude-code', meta: { cwd: '/w' } })).rejects.toThrow(/not active/)
  })

  it('honours creation-time abort and rolls a failed setup back', async () => {
    const { h } = await wired()
    const aborted = new AbortController()
    aborted.abort(new Error('caller gave up'))
    await expect(h.ctx.agents.create({ sessionId: SessionId('a1'), driver: 'claude-code', meta: { cwd: '/w' }, signal: aborted.signal }))
      .rejects.toThrow('caller gave up')
    const midflight = new AbortController()
    const pending = h.ctx.agents.create({
      sessionId: SessionId('a2'), driver: 'claude-code', meta: { cwd: '/w' }, signal: midflight.signal,
      setup: () => new Promise(() => {}),
    })
    await tick(5)
    midflight.abort('plain reason')
    await expect(pending).rejects.toThrow(/creation aborted/)
    await expect(h.ctx.agents.create({
      sessionId: SessionId('a3'), driver: 'claude-code', meta: { cwd: '/w' },
      setup: () => { throw new Error('setup refused') },
    })).rejects.toThrow('setup refused')
    for (const id of ['a1', 'a2', 'a3']) {
      expect(h.ctx.agents.get(SessionId(id))).toBeUndefined()
      expect(h.ctx.sessions.get(SessionId(id))).toBeUndefined()
    }
  })

  it('tears the agent down when its owner unloads', async () => {
    const { h } = await wired()
    let handle: AgentHandle | undefined
    const owner = await h.ctx.plugin(Object.assign(async (inner: Context) => {
      handle = await inner.agents.create({ sessionId: SessionId('owned'), driver: 'claude-code', meta: { cwd: '/w' } })
    }, { inject: ['agents'] }))
    expect(h.ctx.agents.get(SessionId('owned'))).toBe(handle?.agent)
    await owner.dispose()
    await tick(5)
    expect(h.ctx.agents.get(SessionId('owned'))).toBeUndefined()
  })

  it('resumes through persistence and refuses without it or without an absolute cwd', async () => {
    const { h } = await wired()
    await expect(h.ctx.agents.resume({ resumeSessionId: SessionId('r1'), driver: 'claude-code' })).rejects.toThrow(/persistence is not configured/)
    const prepare = (header: { cwd?: string }) => () => ({
      persistence: () => ({
        prepare: (id: SessionId) => Promise.resolve(SessionPreparation.create(h.ctx.sessions.prepare(id, { meta: header }))),
      }) as never,
    })
    const make = (header: { cwd?: string }, seat = 'seat-r') => new ClaudeCodeSeatFactory({
      ctx: h.ctx,
      resolveSeat: () => ({ seat, config: seatConfig() }),
      deps: h.deps,
      ...prepare(header)(),
      gate: h.gate,
      realpath: path => path,
    })
    const resumed = await make({ cwd: '/work/seat' }).resume(h.ctx, { resumeSessionId: SessionId('r2') })
    expect(resumed.agent.session.header.cwd).toBe('/work/seat')
    expect(h.ctx.agents.get(SessionId('r2'))).toBe(resumed.agent)
    await resumed.dispose()
    await expect(make({}).resume(h.ctx, { resumeSessionId: SessionId('r3') })).rejects.toThrow(/no absolute cwd/)
    h.gate.acquire('busy-seat', 'someone')
    await expect(make({ cwd: '/w' }, 'busy-seat').resume(h.ctx, { resumeSessionId: SessionId('r4') }))
      .rejects.toThrow(/already has a live Claude Code query/)
  })
})

describe('plugin entry', () => {
  beforeEach(() => { cleanHostEnv() })
  afterEach(() => { vi.unstubAllEnvs() })

  it('declares a function plugin with the three injections', () => {
    expect(Driver.name).toBe('agent-claude-code-driver')
    expect(Driver.inject).toEqual(['agents', 'sessions', 'subprocess'])
    expect('default' in Driver).toBe(false)
  })

  it('registers the claude-code factory, validates seats, and unregisters on dispose', async () => {
    const ctx = new Context()
    const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
    const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FakeSubprocess)
    const dshHome = tempDir('cc-home-')
    const cwd = tempDir()
    const fiber = await ctx.plugin(Driver, Driver.Config({
      stateDir: 'claude-code', dshHome, seats: { 'seat-a': seatRow({ model: 'haiku', claude_path: fakeClaudeBinary() }) },
    }))
    expect(ctx.agents.listDrivers()).toEqual(['claude-code'])
    await expect(ctx.agents.create({ sessionId: SessionId('x'), driver: 'claude-code', meta: { cwd, agentPreset: 'nobody' } }))
      .rejects.toThrow(/no claude-code seat row for "nobody" \(configured seats: seat-a\)/)
    const handle = await ctx.agents.create({ sessionId: SessionId('y'), driver: 'claude-code', meta: { cwd, agentPreset: 'seat-a' } })
    expect(handle.agent.options.model).toBe('haiku')
    await fiber.dispose()
    expect(ctx.agents.listDrivers()).toEqual([])
    cleanTempDirs()
  })

  it('rejects an invalid or fable seat row at start, and reaps a stale recorded child', async () => {
    const ctx = new Context()
    const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
    const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FakeSubprocess)
    const dshHome = tempDir('cc-home-')
    const stateDir = join(dshHome, 'claude-code')
    await expect(ctx.plugin(Driver, Driver.Config({ stateDir, dshHome, seats: { f: seatRow({ model: 'claude-fable-1' }) } })))
      .rejects.toThrow(/fable model/)
    // A recorded child with a start time that cannot match this host's pid is stale, never killed.
    writeFileSync(
      join(stateDir, 'claude-code-seat-pids.json'),
      JSON.stringify([{ seat: 'old', pid: 2 ** 30, startTime: '1', hostPid: 1, hostStartTime: '', bootId: 'another-boot' }]),
      { mode: 0o600 },
    )
    const fiber = await ctx.plugin(Driver, Driver.Config({ stateDir, dshHome, seats: {} }))
    expect(readFileSync(join(stateDir, 'claude-code-seat-pids.json'), 'utf8').trim()).toBe('[]')
    await fiber.dispose()
    cleanTempDirs()
  })

  it('maps SDK transcript lookups to ok, missing, and unreadable', async () => {
    expect(await Driver.sdkTranscriptState('00000000-0000-4000-8000-000000000000', '/nonexistent/dir')).toBe('missing')
  })
})

describe('canonical working directory', () => {
  afterEach(() => { cleanTempDirs() })

  async function real(header: { cwd?: string } = {}) {
    const h = await harness()
    const factory = new ClaudeCodeSeatFactory({
      ctx: h.ctx,
      resolveSeat: () => ({ seat: 'seat-a', config: seatConfig() }),
      deps: h.deps,
      persistence: () => ({
        prepare: (id: SessionId) => Promise.resolve(SessionPreparation.create(h.ctx.sessions.prepare(id, { meta: header }))),
      }) as never,
      gate: h.gate,
    })
    h.ctx.agents.setFactory(factory, 'claude-code')
    return { h, factory }
  }

  it('accepts a real directory and refuses a symlinked one, naming the realpath', async () => {
    const dir = tempDir()
    const link = join(tempDir(), 'link')
    symlinkSync(dir, link)
    const { h } = await real()
    const ok = await h.ctx.agents.create({ sessionId: SessionId('c1'), driver: 'claude-code', meta: { cwd: dir } })
    await ok.dispose()
    await expect(h.ctx.agents.create({ sessionId: SessionId('c2'), driver: 'claude-code', meta: { cwd: link } }))
      .rejects.toThrow(new RegExp(`cwd ${link} is not canonical; pass its realpath ${dir}`))
    expect(h.ctx.agents.get(SessionId('c2'))).toBeUndefined()
  })

  it('refuses a directory that does not exist', async () => {
    const { h } = await real()
    await expect(h.ctx.agents.create({ sessionId: SessionId('c3'), driver: 'claude-code', meta: { cwd: join(tempDir(), 'gone') } }))
      .rejects.toThrow(/cannot be resolved \(ENOENT\)/)
  })

  it('applies the same check on resume', async () => {
    const dir = tempDir()
    const link = join(tempDir(), 'link')
    symlinkSync(dir, link)
    const { h, factory } = await real({ cwd: link })
    await expect(factory.resume(h.ctx, { resumeSessionId: SessionId('c4') })).rejects.toThrow(/is not canonical/)
  })
})

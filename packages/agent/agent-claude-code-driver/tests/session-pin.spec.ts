/**
 * Per-seat session pin (A1) and durable call windows (A5).
 *
 * A registry writer can change a row's `sessionId`, which would hand the seat a fresh log: the driver pins the
 * first-seen id per registry-routed seat and accepts a different one only when the founder put it in the host
 * entry (`session_id`). A reseed must not reset the seat's call window, so the window is kept in the state
 * directory and survives both a session-id change and a host restart.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ClaudeCodeSeatAgent, SeatGate } from '../src/seat-agent.ts'
import { CALL_WINDOW_FILE_NAME, CallWindowStore, SEAT_SESSIONS_FILE_NAME, SeatSessionPins } from '../src/seat-state.ts'
import { ensurePrivateDir } from '../src/state.ts'
import {
  cleanHostEnv, cleanTempDirs, FakeQuery, harness, resultMessage, seatConfig, tempDir, tick, userMessage,
} from './fakes.ts'
import { bindingFor, bootedContext, hostSeat, hostWorld, optionsWith, registryRow, trustingSource } from './host-fakes.ts'
import type { HostWorld } from './host-fakes.ts'

const sdk = vi.hoisted(() => ({
  queries: [] as unknown[],
  make: undefined as undefined | ((prompt: never, options: never) => unknown),
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
    getSessionInfo: () => Promise.resolve({ sessionId: 'x' }),
  }
})

sdk.make = (prompt, options) => new FakeQuery(prompt, options)

const Driver = await import('../src/index.ts')

async function nthQuery(index: number): Promise<FakeQuery> {
  for (let attempt = 0; attempt < 200 && sdk.queries[index] === undefined; attempt++) await tick(5)
  return sdk.queries[index] as FakeQuery
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  cleanTempDirs()
})

function privateStateDir(): string {
  const dir = join(tempDir('cc-state-'), 'claude-code')
  ensurePrivateDir(dir)
  return dir
}

describe('SeatSessionPins', () => {
  it('pins the first-seen id privately, lets the same id through, and survives a reload', () => {
    const dir = privateStateDir()
    const pins = new SeatSessionPins(dir)
    expect(pins.enforce('ops', 's1', undefined)).toBe('pinned')
    expect(pins.enforce('ops', 's1', undefined)).toBe('same')
    expect(pins.enforce('other', 's9', undefined)).toBe('pinned')
    const file = join(dir, SEAT_SESSIONS_FILE_NAME)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ops: 's1', other: 's9' })
    expect(new SeatSessionPins(dir).enforce('ops', 's1', 's2')).toBe('same')
  })

  it('refuses a changed id unless it is the one the host entry authorises, then re-pins', () => {
    const pins = new SeatSessionPins(privateStateDir())
    pins.enforce('ops', 's1', undefined)
    expect(() => pins.enforce('ops', 's2', undefined)).toThrow(
      'seat-session-changed: seat "ops" session id changed without a host-config session_id; ask the founder to reseed',
    )
    expect(() => pins.enforce('ops', 's2', 's3')).toThrow(/seat-session-changed/)
    expect(pins.enforce('ops', 's2', 's2')).toBe('reseeded')
    expect(pins.enforce('ops', 's2', undefined)).toBe('same')
    expect(() => pins.enforce('ops', 's1', 's2')).toThrow(/seat-session-changed/)
  })

  it('treats a first sight of the authorised id as a plain pin', () => {
    expect(new SeatSessionPins(privateStateDir()).enforce('ops', 's2', 's2')).toBe('pinned')
  })

  it('writes before it assigns: a failed write never leaves the pin ahead of the disk', () => {
    const dir = privateStateDir()
    writeFileSync(join(dir, SEAT_SESSIONS_FILE_NAME), JSON.stringify({ ops: 's1' }), { mode: 0o600 })
    const pins = new SeatSessionPins(dir)
    chmodSync(dir, 0o500)
    try {
      expect(() => pins.enforce('ops', 's2', 's2')).toThrow()
      expect(() => pins.enforce('ops', 's2', 's2')).toThrow()
      expect(() => pins.enforce('ops', 's2', undefined)).toThrow(/seat-session-changed/)
      expect(pins.enforce('ops', 's1', undefined)).toBe('same')
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(JSON.parse(readFileSync(join(dir, SEAT_SESSIONS_FILE_NAME), 'utf8'))).toEqual({ ops: 's1' })
  })

  it('refuses a pin file that is open to others, not a regular file, corrupt, or not an object', () => {
    const dir = privateStateDir()
    const file = join(dir, SEAT_SESSIONS_FILE_NAME)
    writeFileSync(file, '{}', { mode: 0o600 })
    chmodSync(file, 0o644)
    expect(() => new SeatSessionPins(dir)).toThrow(/accessible by group or others/)
    chmodSync(file, 0o600)
    writeFileSync(file, '{oops')
    expect(() => new SeatSessionPins(dir)).toThrow(/seat session pin file .* is unreadable/)
    writeFileSync(file, '[]')
    expect(() => new SeatSessionPins(dir)).toThrow(/seat session pin file .* is unreadable \(not an object\)/)
    writeFileSync(file, JSON.stringify({ good: 's1', bad: 7 }))
    expect(new SeatSessionPins(dir).enforce('bad', 's5', undefined)).toBe('pinned')
  })
})

describe('CallWindowStore and the persisted SeatGate', () => {
  it('keeps the call times of each seat privately on disk and reloads them', () => {
    const dir = privateStateDir()
    const warnings: string[] = []
    const store = new CallWindowStore(dir, (message) => { warnings.push(message) })
    expect(store.load('ops')).toBeUndefined()
    store.save('ops', [1, 2, 3])
    const file = join(dir, CALL_WINDOW_FILE_NAME)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(new CallWindowStore(dir, () => undefined).load('ops')).toEqual([1, 2, 3])
    expect(warnings).toEqual([])
  })

  it('refuses an untrustworthy or damaged file, and drops malformed entries', () => {
    const dir = privateStateDir()
    const file = join(dir, CALL_WINDOW_FILE_NAME)
    writeFileSync(file, '{}', { mode: 0o600 })
    chmodSync(file, 0o666)
    expect(() => new CallWindowStore(dir, () => undefined)).toThrow(/accessible by group or others/)
    chmodSync(file, 0o600)
    writeFileSync(file, 'nope')
    expect(() => new CallWindowStore(dir, () => undefined)).toThrow(/call-window file .* is unreadable/)
    writeFileSync(file, JSON.stringify({ good: [1, 2], text: 'x', mixed: [1, 'two'], nan: [null] }))
    const store = new CallWindowStore(dir, () => undefined)
    expect(store.load('good')).toEqual([1, 2])
    expect(store.load('text')).toBeUndefined()
    expect(store.load('mixed')).toBeUndefined()
    expect(store.load('nan')).toBeUndefined()
  })

  it('reports a failed write and keeps counting in memory', () => {
    const dir = privateStateDir()
    const warnings: string[] = []
    const store = new CallWindowStore(dir, (message) => { warnings.push(message) })
    mkdirSync(join(dir, CALL_WINDOW_FILE_NAME))
    store.save('ops', [5])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not persist the call window of seat "ops"')
    expect(store.load('ops')).toEqual([5])
  })

  it('seeds from the saved history, adds log queries older than all of it, and falls back to the log alone', () => {
    const saved = new Map<string, number[]>([['ops', [100, 200]], ['empty', []]])
    const written: Array<[string, readonly number[]]> = []
    const gate = new SeatGate({ load: seat => saved.get(seat), save: (seat, times) => { written.push([seat, times]) } })
    gate.seed('ops', [10, 150, 250])
    expect(gate.callsInWindow('ops', 300, 1000)).toBe(3)
    gate.seed('ops', [1, 2, 3])
    expect(gate.callsInWindow('ops', 300, 1000)).toBe(3)
    gate.seed('empty', [7, 8])
    expect(gate.callsInWindow('empty', 300, 1000)).toBe(2)
    gate.seed('fresh', [9])
    expect(gate.callsInWindow('fresh', 300, 1000)).toBe(1)
    gate.noteCall('ops', 290)
    expect(written).toEqual([['ops', [10, 100, 200, 290]]])
    expect(new SeatGate().callsInWindow('ops', 300, 1000)).toBe(0)
  })
})

/** Mount the driver for one host seat `ops` capped at two calls per window, with a trusting source. */
async function mount(world: HostWorld, sessionId: string | undefined) {
  const ctx = await bootedContext()
  ctx.provide('claudeCodeSeatSource', trustingSource())
  const fiber = await ctx.plugin(Driver, Driver.Config({
    seats: {}, stateDir: 'claude-code',
    dshHome: world.dshHome,
    claudePathPrefixes: [world.prefix],
    hostSeats: { ops: hostSeat(world, { max_calls_per_window: 2, ...sessionId === undefined ? {} : { session_id: sessionId } }) },
  }))
  const warn = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => undefined)
  const open = (id: string) => ctx.agents.create({
    sessionId: SessionId(id), driver: 'claude-code', meta: { cwd: world.cwd }, agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
  })
  return { ctx, fiber, open, warn }
}

/** Run one typed turn to completion on an open agent. */
async function turn(
  agent: { followup(message: ReturnType<typeof userMessage>): void; whenIdle(): Promise<void> },
  text: string,
): Promise<void> {
  const before = sdk.queries.length
  agent.followup(userMessage(text))
  const query = await nthQuery(before)
  query.spawn()
  query.emit(resultMessage({ user_message_uuids: query.uuids() }))
  await agent.whenIdle()
}

describe('the session pin through the plugin (A1)', () => {
  beforeEach(() => { cleanHostEnv() })

  it('pins the first session id, lets it reopen, and refuses another id the founder did not authorise', async () => {
    const world = hostWorld()
    const { fiber, open } = await mount(world, undefined)
    const first = await open('sess-1')
    await first.dispose()
    const file = join(world.stateDir, SEAT_SESSIONS_FILE_NAME)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ops: 'sess-1' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    await (await open('sess-1')).dispose()
    await expect(open('sess-evil')).rejects.toThrow(
      'seat-session-changed: seat "ops" session id changed without a host-config session_id; ask the founder to reseed',
    )
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ops: 'sess-1' })
    await fiber.dispose()
  })

  it('accepts the id the host entry authorises as a founder reseed, re-pins it, and says so loudly', async () => {
    const world = hostWorld()
    const { fiber, open, warn } = await mount(world, 'sess-2')
    await (await open('sess-1')).dispose()
    expect(warn).not.toHaveBeenCalled()
    await expect(open('sess-3')).rejects.toThrow(/seat-session-changed/)
    await (await open('sess-2')).dispose()
    expect(warn.mock.calls.flat().join('\n')).toContain('seat "ops" was reseeded by the founder\'s host-config session_id; its session pin moved to sess-2')
    expect(JSON.parse(readFileSync(join(world.stateDir, SEAT_SESSIONS_FILE_NAME), 'utf8'))).toEqual({ ops: 'sess-2' })
    // the old id is now a different id and the host entry no longer names it
    await expect(open('sess-1')).rejects.toThrow(/seat-session-changed/)
    await fiber.dispose()
  })

  it('refuses to mount over a pin file open to others', async () => {
    const world = hostWorld()
    ensurePrivateDir(world.stateDir)
    const file = join(world.stateDir, SEAT_SESSIONS_FILE_NAME)
    writeFileSync(file, '{}', { mode: 0o600 })
    chmodSync(file, 0o644)
    await expect(mount(world, undefined)).rejects.toThrow(/accessible by group or others/)
  })
})

describe('call-window counters after a founder reseed (A5)', () => {
  beforeEach(() => { cleanHostEnv() })

  const refusals = (events: ReadonlyArray<{ type: string; data?: unknown }>) =>
    events.filter(event => event.type === 'claude-code/refused' && (event.data as { reason?: string }).reason === 'call-window')

  it('keeps the window when the session id changes inside one host process', async () => {
    const world = hostWorld()
    const { fiber, open } = await mount(world, 'sess-2')
    const first = await open('sess-1')
    await turn(first.agent, 'one')
    await turn(first.agent, 'two')
    await first.dispose()
    const reseeded = await open('sess-2')
    const before = sdk.queries.length
    reseeded.agent.followup(userMessage('three'))
    await reseeded.agent.whenIdle()
    expect(sdk.queries.length).toBe(before)
    expect(refusals(reseeded.agent.session.events)).toHaveLength(1)
    await reseeded.dispose()
    await fiber.dispose()
  })

  it('keeps the window across a reseed plus a host restart, because the calls are saved in the state directory', async () => {
    const world = hostWorld()
    const firstHost = await mount(world, undefined)
    const first = await firstHost.open('sess-1')
    await turn(first.agent, 'one')
    await turn(first.agent, 'two')
    await first.dispose()
    await firstHost.fiber.dispose()
    expect((JSON.parse(readFileSync(join(world.stateDir, CALL_WINDOW_FILE_NAME), 'utf8')) as Record<string, unknown>).ops).toHaveLength(2)

    // the founder reseeds (new session id in the host entry) and the host restarts: a new, empty session log
    const secondHost = await mount(world, 'sess-2')
    const reseeded = await secondHost.open('sess-2')
    expect(reseeded.agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(0)
    const before = sdk.queries.length
    reseeded.agent.followup(userMessage('three'))
    await reseeded.agent.whenIdle()
    expect(sdk.queries.length).toBe(before)
    expect(refusals(reseeded.agent.session.events)).toHaveLength(1)
    await reseeded.dispose()
    await secondHost.fiber.dispose()
  })
})

describe('the gate seeds a restarted seat from its saved window (A5, agent level)', () => {
  it('counts saved calls for a new empty session, where a log-only gate would count none', async () => {
    const h = await harness()
    const now = h.state.now
    const dir = privateStateDir()
    const before = new SeatGate(new CallWindowStore(dir, () => undefined))
    for (const n of [1, 2, 3]) before.noteCall('tester', now - n * 1000)
    const restarted = new SeatGate(new CallWindowStore(dir, () => undefined))
    const empty = h.session('reseeded')
    new ClaudeCodeSeatAgent(h.ctx, empty.id, empty, 'tester', seatConfig(), '/work/seat', h.deps, restarted)
    expect(restarted.callsInWindow('tester', now, 18_000_000)).toBe(3)
    const logOnly = new SeatGate()
    const empty2 = h.session('reseeded-2')
    new ClaudeCodeSeatAgent(h.ctx, empty2.id, empty2, 'tester', seatConfig(), '/work/seat', h.deps, logOnly)
    expect(logOnly.callsInWindow('tester', now, 18_000_000)).toBe(0)
  })
})

describe('a call window that cannot be saved (A5)', () => {
  beforeEach(() => { cleanHostEnv() })

  it('warns through the host logger and keeps the turn and the in-memory count', async () => {
    const world = hostWorld()
    const { fiber, open, warn } = await mount(world, undefined)
    mkdirSync(join(world.stateDir, CALL_WINDOW_FILE_NAME))
    const handle = await open('sess-1')
    await turn(handle.agent, 'one')
    expect(warn.mock.calls.flat().join('\n')).toContain('could not persist the call window of seat "ops"')
    expect(handle.agent.session.events.some(event => event.type === 'claude-code/turn-completed')).toBe(true)
    await handle.dispose()
    await fiber.dispose()
  })
})

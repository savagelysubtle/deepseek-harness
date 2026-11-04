/**
 * Shared fixtures for the seat-driver bridge specs (`bridge-driver.spec.ts`,
 * `bridge-default-differential.spec.ts`): block-style throwaway registries
 * written under `os.tmpdir()` (no spec reads `~/.dsh`), and a harness that wires the
 * real mailbox registry and SQLite provider to a recording agent registry,
 * so each test can assert the exact arguments `agents.create` / `agents.resume`
 * received and every setup side effect they ran.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import MailboxRegistry, { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import MailboxLocal from '@deepseek-ai/dsh-mailbox-local'
import { deriveNamedSessionId } from '@deepseek-ai/dsh-named-sessions'
import * as bridge from '../src/index.ts'

/** Directories every harness created, removed by {@link cleanupHarnesses}. */
const dirs: string[] = []
/** Specs every harness resolved, whose residents {@link cleanupHarnesses} releases. */
const specs: bridge.BridgeSpec[] = []
/** The `DSH_HOME` the process had before the first harness, restored by {@link cleanupHarnesses}. */
let savedDshHome: string | undefined
let dshHomeSaved = false
/** Monotonic mtime seed so each registry rewrite changes the cache key. */
let mtimeSeconds = Math.floor(Date.now() / 1000) + 10

/** The one served address every driver spec mails. */
export const TARGET = formatMailboxAddress('target')

/** A stored-log event as the flip classifier reads it. */
export interface LogEvent { readonly type: string }

/** Block-style rows for one registry: seat name to the YAML lines under its mapping (cwd is added). */
export interface RegistryRows {
  readonly rows: Readonly<Record<string, readonly string[]>>
  readonly edges?: readonly (readonly [string, string])[]
  readonly callUp?: readonly string[]
}

/**
 * Render a registry document in block style, like the live registry.
 * @param base - the registry's base directory.
 * @param options - the rows, edges and call-up seats.
 * @returns the registry text.
 */
function renderRegistry(base: string, options: RegistryRows): string {
  const rows = Object.entries(options.rows).map(([seat, lines]) =>
    [`  ${seat}:`, `    cwd: ${seat}`, ...lines.map(line => `    ${line}`)].join('\n')).join('\n')
  const edges = options.edges ?? [['alice', 'target']]
  const edgeBlock = edges.length === 0 ? 'edges: []' : `edges:\n${edges.map(([a, b]) => `  - [${a}, ${b}]`).join('\n')}`
  const callUp = options.callUp === undefined ? '' : `\ncallUp:\n${options.callUp.map(seat => `  - ${seat}`).join('\n')}`
  return `baseDir: ${base}\nseats:\n${rows}\n${edgeBlock}${callUp}\n`
}

/**
 * Write a throwaway block-style registry under `os.tmpdir()` and return its path.
 * @param options - the rows, edges and call-up seats.
 * @returns the registry file path.
 */
export function writeRegistry(options: RegistryRows): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-driver-registry-'))
  dirs.push(dir)
  const path = join(dir, 'registry.yml')
  writeFileSync(path, renderRegistry(dir, options), 'utf8')
  for (const seat of Object.keys(options.rows)) mkdirSync(join(dir, seat), { recursive: true })
  expect(path.startsWith(tmpdir())).toBe(true)
  return path
}

/**
 * Rewrite a registry in place and move its mtime forward so the bridge's
 * mtime-keyed cache sees a new file.
 * @param path - the registry written by {@link writeRegistry}.
 * @param options - the new rows, edges and call-up seats.
 */
export function rewriteRegistry(path: string, options: RegistryRows): void {
  const base = path.slice(0, path.lastIndexOf('/'))
  writeFileSync(path, renderRegistry(base, options), 'utf8')
  for (const seat of Object.keys(options.rows)) mkdirSync(join(base, seat), { recursive: true })
  mtimeSeconds += 5
  utimesSync(path, mtimeSeconds, mtimeSeconds)
}

/** The rows of a Claude Code `target` seat admitting `alice` as a seat sender. */
export const CC_TARGET: readonly string[] = [
  'driver: claude-code',
  'admit_from:',
  '  - alice',
  'admit_sender_classes:',
  '  - seat',
]

/** One recorded `agents.create` / `agents.resume` call. */
export interface RecordedCall {
  readonly kind: 'create' | 'resume'
  /** The exact options object the registry was handed. */
  readonly args: Readonly<Record<string, unknown>>
}

/** Options for {@link makeDriverHarness}. */
export interface DriverHarnessOptions {
  readonly registryPath: string
  /** Drivers `agents.listDrivers()` reports; default both. */
  readonly drivers?: readonly string[]
  /** Make `listDrivers` throw, to exercise the fail-closed admission step. */
  readonly listDriversThrows?: boolean
  /** Seat names that already have a stored log (session id derived from the name unless `sessionIds` names one). */
  readonly persisted?: readonly string[]
  /** Explicit session ids per seat name, for rows that pin `sessionId`. */
  readonly sessionIds?: Readonly<Record<string, string>>
  /** Stored events `persistence.inspect` returns, per seat name. */
  readonly logs?: Readonly<Record<string, readonly LogEvent[]>>
  /** Make `persistence.inspect` throw. */
  readonly inspectThrows?: boolean
  /** Tool names the fake agent context reports. */
  readonly knownTools?: readonly string[]
  /** Provide no `tools` service in the fake agent context. */
  readonly noTools?: boolean
  /** Provide no default-model service at all. */
  readonly noDefaultModel?: boolean
  /** Make `agents.create` / `agents.resume` throw this (after setup ran). */
  readonly mintThrows?: Error
}

/** The live agent stub the harness registers (also what `agents.get` returns). */
export interface StubAgent {
  status: 'idle'
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  whenIdle: () => Promise<void>
  session: { id: string; events: LogEvent[]; append: ReturnType<typeof vi.fn> }
}

/**
 * A bare live agent stub for tests that need an agent the bridge did not compose.
 * @param id - the session id it answers to.
 * @param events - its live log.
 * @returns the stub.
 */
export function stubAgent(id: string, events: readonly LogEvent[] = []): StubAgent {
  return {
    status: 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    whenIdle: async () => {},
    session: { id, events: [...events], append: vi.fn() },
  }
}

/** Everything a driver spec needs from one wired harness. */
export interface DriverHarness {
  readonly ctx: ContextType
  readonly storePath: string
  readonly registryPath: string
  /** Every create/resume call, in order. */
  readonly calls: RecordedCall[]
  /** Side effects each `setup` callback ran, in order, as readable strings. */
  readonly setupLog: string[]
  /** Dispose count across every handle. */
  readonly disposes: () => number
  /** Live registry: session id to agent stub. */
  readonly registered: Map<string, StubAgent>
  /** Mutable stored logs keyed by session id; `persistence.inspect` reads this. */
  readonly logs: Map<string, LogEvent[]>
  /** Session ids `persistence.list()` reports. */
  readonly persistedIds: Set<string>
  readonly inspect: ReturnType<typeof vi.fn>
  readonly listDrivers: ReturnType<typeof vi.fn>
  /** Events `mailbox/refused` carried. */
  readonly refusals: bridge.MailboxRefusal[]
  /** Events `mailbox/seat-tools-restricted` carried. */
  readonly restrictions: bridge.SeatToolsRestricted[]
  /** Events `mailbox/seat-driver-row-changed` carried. */
  readonly rowChanges: bridge.SeatDriverRowChanged[]
  /** Resolve a bridge spec for the harness registry (residency on by default) and remember it for cleanup. */
  spec(overrides?: Partial<Parameters<typeof bridge.resolveBridgeSpec>[0]>): bridge.BridgeSpec
  /** Publish one message to `target`. */
  publish(from: string, subject?: string): Promise<string>
  /** Read one message's settled row. */
  row(messageId: string): { state: string; reason: string }
  /** The session id a seat's stored log lives under. */
  sessionIdOf(name: string): string
}

/**
 * Wire the real mailbox registry and SQLite provider to a recording agent
 * registry.
 * @param options - the harness knobs.
 * @returns the wired harness.
 */
export async function makeDriverHarness(options: DriverHarnessOptions): Promise<DriverHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-driver-unit-'))
  dirs.push(dir)
  if (!dshHomeSaved) {
    dshHomeSaved = true
    savedDshHome = process.env.DSH_HOME
  }
  process.env.DSH_HOME = dir
  expect(options.registryPath.startsWith(tmpdir())).toBe(true)
  const ctx = new Context()
  await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
  await ctx.plugin(MailboxLocal, { path: join(dir, 'mailbox.db') })

  const sessionIdOf = (name: string): string => options.sessionIds?.[name] ?? String(deriveNamedSessionId(name))
  const calls: RecordedCall[] = []
  const setupLog: string[] = []
  const registered = new Map<string, StubAgent>()
  const logs = new Map<string, LogEvent[]>()
  const persistedIds = new Set<string>((options.persisted ?? []).map(sessionIdOf))
  for (const [name, events] of Object.entries(options.logs ?? {})) logs.set(sessionIdOf(name), [...events])
  const state = { disposes: 0 }

  const makeAgent = (id: string): { agent: StubAgent; handle: { agent: StubAgent; dispose: () => Promise<void> } } => {
    const agent: StubAgent = {
      status: 'idle',
      followup: vi.fn(),
      steer: vi.fn(),
      whenIdle: async () => {},
      session: { id, events: [...logs.get(id) ?? []], append: vi.fn() },
    }
    agent.session.append.mockImplementation((type: string) => { setupLog.push(`append:${type}`) })
    return {
      agent,
      handle: {
        agent,
        dispose: async () => {
          state.disposes += 1
          if (registered.get(id) === agent) registered.delete(id)
        },
      },
    }
  }

  /** A fresh agent context per setup call, recording what `setup` did to it. */
  const runSetup = async (setup: ((agentCtx: ContextType) => unknown) | undefined): Promise<void> => {
    const agentCtx = new Context()
    if (options.noTools !== true) {
      agentCtx.provide('tools', {
        schemas: () => (options.knownTools ?? ['read', 'bash']).map(name => ({ name })),
        restrict: (rule: unknown) => { setupLog.push(`tools.restrict:${JSON.stringify(rule)}`) },
      } as never)
    }
    const on = vi.spyOn(agentCtx, 'on')
    await setup?.(agentCtx)
    for (const call of on.mock.calls) setupLog.push(`on:${call[0]}`)
  }

  const listDrivers = vi.fn(() => {
    if (options.listDriversThrows === true) throw new Error('listDrivers exploded')
    return options.drivers ?? ['default', 'claude-code']
  })
  const mint = (kind: 'create' | 'resume') => vi.fn(async (args: { sessionId?: string; resumeSessionId?: string; setup?: (agentCtx: ContextType) => unknown }) => {
    calls.push({ kind, args })
    await runSetup(args.setup)
    if (options.mintThrows !== undefined) throw options.mintThrows
    const id = String(kind === 'create' ? args.sessionId : args.resumeSessionId)
    const { agent, handle } = makeAgent(id)
    registered.set(id, agent)
    // A created session has a stored log from then on, so the next cold wake resumes it.
    persistedIds.add(id)
    return handle
  })
  ctx.provide('agents', {
    get: (id: string) => registered.get(id),
    listDrivers,
    create: mint('create'),
    resume: mint('resume'),
  } as never)
  if (options.noDefaultModel !== true) {
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  }
  const inspect = vi.fn(async (id: string) => {
    if (options.inspectThrows === true) throw new Error('inspect exploded')
    return { meta: {}, events: logs.get(id) ?? [] }
  })
  ctx.provide('sessionPersistence', {
    list: async () => [...persistedIds].map(id => ({ id })),
    inspect,
  } as never)
  ctx.provide('sessions', { flush: vi.fn(async () => {}) } as never)

  const refusals: bridge.MailboxRefusal[] = []
  const restrictions: bridge.SeatToolsRestricted[] = []
  const rowChanges: bridge.SeatDriverRowChanged[] = []
  ctx.on('mailbox/refused', (refusal) => { refusals.push(refusal) })
  ctx.on('mailbox/seat-tools-restricted', (restriction) => { restrictions.push(restriction) })
  ctx.on('mailbox/seat-driver-row-changed', (change) => { rowChanges.push(change) })

  const storePath = join(dir, 'mailbox.db')
  return {
    ctx,
    storePath,
    registryPath: options.registryPath,
    calls,
    setupLog,
    disposes: () => state.disposes,
    registered,
    logs,
    persistedIds,
    inspect,
    listDrivers,
    refusals,
    restrictions,
    rowChanges,
    spec(overrides = {}) {
      const resolved = bridge.resolveBridgeSpec({
        addresses: ['target'],
        pollIntervalMs: 5,
        maxClaimPerCycle: 10,
        staleClaimMs: 600_000,
        admitFrom: ['sender'],
        orgRegistryPath: options.registryPath,
        residencyIdleMs: 60_000,
        ...overrides,
      })
      specs.push(resolved)
      return resolved
    },
    publish: (from, subject = 'hello') => ctx.mailbox.publish({ to: TARGET, from, subject }),
    row(messageId) {
      const db = new DatabaseSync(storePath)
      try {
        const found = db.prepare('SELECT state, result FROM messages WHERE id = ?').get(messageId) as { state: string; result: string | null }
        const parsed = JSON.parse(found.result ?? '{}') as { reason?: string }
        return { state: found.state, reason: parsed.reason ?? '' }
      } finally {
        db.close()
      }
    },
    sessionIdOf,
  }
}

/** Release every resident any harness spec retained and remove every temp directory. Call from `afterEach`. */
export function cleanupHarnesses(): void {
  for (const spec of specs.splice(0)) {
    for (const resident of spec.residents.values()) resident.release()
    spec.residents.clear()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  if (dshHomeSaved) {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    dshHomeSaved = false
  }
}

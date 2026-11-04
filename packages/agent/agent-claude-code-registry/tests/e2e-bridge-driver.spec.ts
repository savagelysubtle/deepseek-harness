/**
 * End to end, OP #292 S3 (step 6, addendum A1/A7/A8): the real mailbox bridge, the real Claude Code driver and the
 * registry glue mounted together over a throwaway block-style registry. Only the edges are faked: the SDK `query`
 * (a hand-driven {@link FakeQuery}), the subprocess owner, and the `claude` binary (a generated, attested shell
 * stub under a temp prefix listed in `claudePathPrefixes`). A real Claude Code process is never started. Every
 * path lives under `os.tmpdir()` (registry, mailbox store, session store, driver state, `DSH_HOME`), and nothing
 * here reads `~/.dsh`.
 *
 * S8 closer (A8, the settlement the bridge cannot yet improve): the bridge settles a mail's lease as `done`
 * right after it hands the mail to the seat (`followup`), and the glue installs no lease sink, so the driver's
 * lease calls are no-ops until S8. The sender therefore sees `done` for mail that a PAUSED or OVER-CAP seat only
 * queued, and for mail the driver's own admission refused after the bridge admitted it. What the operator can
 * see is the seat's own log: `claude-code/refused` (with the call-window reason or the admission detail) or
 * `claude-code/paused`. The "queued, sender sees done" cases below pin that exact behaviour; when S8 gives the
 * glue a real lease sink those assertions are the ones that must change (the sender row should become `failed`
 * or stay `pending`, with the reason).
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import MailboxRegistry, { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import * as Bridge from '@deepseek-ai/dsh-mailbox-bridge'
import MailboxLocal from '@deepseek-ai/dsh-mailbox-local'
import { deriveNamedSessionId } from '@deepseek-ai/dsh-named-sessions'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ClaudeCodeHostSeat } from '../../agent-claude-code-driver/src/index.ts'
import { FakeQuery, resultMessage, tick } from '../../agent-claude-code-driver/tests/fakes.ts'
import * as Glue from '../src/index.ts'
import { cleanHostEnv, FakeSubprocess, mail } from './helpers.ts'

const sdk = vi.hoisted(() => {
  // This package does not depend on the SDK, so the specifier does not resolve from here; the driver's own copy does, and
  // the mock must be keyed on that file for the driver's import to hit it.
  const { createRequire } = process.getBuiltinModule('node:module')
  const driverDir = new URL('../../agent-claude-code-driver/package.json', import.meta.url)
  return {
    entry: createRequire(driverDir).resolve('@anthropic-ai/claude-agent-sdk'),
    queries: [] as unknown[],
    /** Resolvers woken each time the mocked `query` is called. */
    waiters: [] as Array<() => void>,
    make: undefined as undefined | ((prompt: never, options: never) => unknown),
  }
})

vi.mock(sdk.entry, async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    query: ({ prompt, options }: { prompt: never; options: never }) => {
      const fake = (sdk.make as NonNullable<typeof sdk.make>)(prompt, options)
      sdk.queries.push(fake)
      for (const wake of sdk.waiters.splice(0)) wake()
      return fake
    },
    getSessionInfo: (sessionId: string) => Promise.resolve({ sessionId }),
  }
})

sdk.make = (prompt, options) => new FakeQuery(prompt, options)

const Driver = await import('../../agent-claude-code-driver/src/index.ts')

// ---------------------------------------------------------------------------------------------------------
// Scene: every on-disk piece of one scenario, all under os.tmpdir()
// ---------------------------------------------------------------------------------------------------------

const SEATS = ['target', 'legacy', 'plain', 'alice', 'ghost'] as const
type SeatName = typeof SEATS[number]

const EDGES: ReadonlyArray<readonly [string, string]> = [
  ['alice', 'target'], ['ghost', 'target'], ['alice', 'legacy'], ['alice', 'plain'], ['ghost', 'plain'],
]

/** The registry lines of a Claude Code row admitting `alice` as a seat sender. */
const CC_ROW: readonly string[] = ['driver: claude-code', 'admit_from:', '  - alice', 'admit_sender_classes:', '  - seat']

interface Scene {
  readonly root: string
  readonly registryPath: string
  readonly dshHome: string
  readonly persistRoot: string
  readonly mailboxDb: string
  readonly binary: string
  readonly cwds: Record<SeatName, string>
  /** The registry rows (extra lines per seat) the file currently holds. */
  rows: Partial<Record<SeatName, readonly string[]>>
}

const roots: string[] = []
let mtimeSeconds = Math.floor(Date.now() / 1000) + 10

function renderRegistry(scene: Scene): string {
  const body = SEATS.map(seat => [`  ${seat}:`, `    cwd: ${scene.cwds[seat]}`, ...(scene.rows[seat] ?? []).map(line => `    ${line}`)].join('\n')).join('\n')
  const edges = EDGES.map(([from, to]) => `  - [${from}, ${to}]`).join('\n')
  return `baseDir: ${scene.root}\nseats:\n${body}\nedges:\n${edges}\n`
}

/** Write (or rewrite) the scene's registry, moving its mtime forward so the bridge's cache sees a new file. */
function writeRegistry(scene: Scene): void {
  writeFileSync(scene.registryPath, renderRegistry(scene), 'utf8')
  mtimeSeconds += 5
  utimesSync(scene.registryPath, mtimeSeconds, mtimeSeconds)
}

function scene(rows: Scene['rows'] = { target: CC_ROW }): Scene {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-e2e-bridge-driver-')))
  roots.push(root)
  const cwds = {} as Record<SeatName, string>
  for (const seat of SEATS) {
    cwds[seat] = join(root, seat)
    mkdirSync(cwds[seat], { recursive: true })
  }
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true, mode: 0o700 })
  chmodSync(binDir, 0o700)
  const binary = join(binDir, 'claude')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  chmodSync(binary, 0o700)
  const dshHome = join(root, 'dsh-home')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  const made: Scene = {
    root,
    registryPath: join(root, 'registry.yml'),
    dshHome,
    persistRoot: join(root, 'sessions'),
    mailboxDb: join(root, 'mailbox.db'),
    binary,
    cwds,
    rows,
  }
  // No path any part of the stack reads may be the real harness home.
  for (const path of [made.registryPath, made.dshHome, made.persistRoot, made.mailboxDb, made.binary]) {
    expect(path.startsWith(tmpdir())).toBe(true)
    expect(path.startsWith(join(homedir(), '.dsh'))).toBe(false)
  }
  writeRegistry(made)
  return made
}

/** A valid host entry for a seat of the scene. */
function host(s: Scene, seat: SeatName, overrides: Partial<ClaudeCodeHostSeat> = {}): ClaudeCodeHostSeat {
  return { model: 'haiku', role: 'mail-only', claude_path: s.binary, cwd: s.cwds[seat], admit_from_ceiling: ['alice'], ...overrides }
}

// ---------------------------------------------------------------------------------------------------------
// Mount: a fresh process (context) over the scene's stores
// ---------------------------------------------------------------------------------------------------------

interface Mounted {
  readonly ctx: Context
  readonly scene: Scene
  readonly spec: Bridge.BridgeSpec
  /** Session ids the stand-in default factory was asked to create / resume. */
  readonly defaultCreated: string[]
  readonly defaultResumed: string[]
  readonly refusals: Bridge.MailboxRefusal[]
}

const mounted: Mounted[] = []

interface MountOptions {
  readonly residencyIdleMs?: number
  readonly hosts?: Partial<Record<SeatName, Partial<ClaudeCodeHostSeat>>>
  /** Seats that get a host entry; default `target` and `legacy`. */
  readonly hostSeats?: readonly SeatName[]
}

async function mount(s: Scene, options: MountOptions = {}): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: s.persistRoot })
  await ctx.plugin(FakeSubprocess)
  await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
  await ctx.plugin(MailboxLocal, { path: s.mailboxDb })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)

  // The default driver is a recording stand-in: a seat that must stay on the dsh loop lands here, never on the SDK.
  const defaultCreated: string[] = []
  const defaultResumed: string[] = []
  const publish = (id: string, cwd: string): Promise<{ agent: Agent; dispose: () => Promise<void> }> => {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
    const agent = {
      id: session.id, session, status: 'idle', followup: () => undefined, steer: () => undefined, whenIdle: () => Promise.resolve(),
    } as unknown as Agent
    const unregister = ctx.agents.register(agent)
    return Promise.resolve({ agent, dispose: () => { unregister(); return Promise.resolve() } })
  }
  const defaultFactory: AgentFactory = {
    createAgent(_owner, create) {
      defaultCreated.push(create.sessionId)
      return publish(create.sessionId, create.meta?.cwd ?? s.root)
    },
    resume(_owner, resume) {
      defaultResumed.push(resume.resumeSessionId)
      return publish(resume.resumeSessionId, s.root)
    },
  }
  ctx.agents.setFactory(defaultFactory)

  const hostSeats: Record<string, ClaudeCodeHostSeat> = {}
  for (const seat of options.hostSeats ?? ['target', 'legacy']) hostSeats[seat] = host(s, seat, options.hosts?.[seat])
  await ctx.plugin(Glue)
  await ctx.plugin(Driver, Driver.Config({
    seats: {}, stateDir: 'claude-code', dshHome: s.dshHome, claudePathPrefixes: [dirname(s.binary)], hostSeats,
  }))
  const refusals: Bridge.MailboxRefusal[] = []
  // Refusals are logged on purpose; keep the run quiet (the assertions read the mailbox rows and the seat logs).
  for (const level of ['warn', 'info'] as const) {
    const proto = Object.getPrototypeOf(ctx.logger) as Record<string, (...args: unknown[]) => void>
    vi.spyOn(proto, level).mockImplementation(() => undefined)
  }
  ctx.on('mailbox/refused', (refusal) => { refusals.push(refusal) })
  await ctx.plugin(Bridge, Bridge.Config({
    addresses: ['target', 'legacy', 'plain'],
    pollIntervalMs: 3_600_000,
    admitFrom: ['alice', 'ghost'],
    orgRegistryPath: s.registryPath,
    residencyIdleMs: options.residencyIdleMs ?? 0,
  }))
  const spec = (ctx.get('mailboxBridgeSpecs') as Bridge.BridgeSpec[])[0] as Bridge.BridgeSpec
  const made: Mounted = { ctx, scene: s, spec, defaultCreated, defaultResumed, refusals }
  mounted.push(made)
  return made
}

/** Release every resident and dispose every mounted context (a simulated host restart); the scene's files stay. */
async function unmountAll(): Promise<void> {
  for (const m of mounted.splice(0)) {
    for (const resident of m.spec.residents.values()) resident.release()
    m.spec.residents.clear()
    await m.ctx.fiber.dispose()
  }
}

// ---------------------------------------------------------------------------------------------------------
// Driving mail
// ---------------------------------------------------------------------------------------------------------

let counter = 0

/** Wait (woken by the mocked `query`, bounded by a deadline so a missing query fails the case) for the Nth query. */
async function nthQuery(index: number): Promise<FakeQuery | undefined> {
  const deadline = Date.now() + 3000
  while (sdk.queries[index] === undefined && Date.now() < deadline) {
    await Promise.race([new Promise<void>((resolve) => { sdk.waiters.push(resolve) }), tick(250)])
  }
  return sdk.queries[index] as FakeQuery | undefined
}

/** A rejected five-hour window event, shaped as the SDK reports it (typed `never` so no SDK type is needed here). */
const rateLimited = (): never => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
  uuid: 'u', session_id: 's',
}) as never

type Answer = 'result' | 'rate-limit' | 'none'

/** The settled row of one mailbox message. */
function rowOf(m: Mounted, messageId: string): { state: string; reason: string } {
  const db = new DatabaseSync(m.scene.mailboxDb)
  try {
    const found = db.prepare('SELECT state, result FROM messages WHERE id = ?').get(messageId) as { state: string; result: string | null }
    const parsed = JSON.parse(found.result ?? '{}') as { reason?: string }
    return { state: found.state, reason: parsed.reason ?? '' }
  } finally {
    db.close()
  }
}

/**
 * Publish one message and run one drain cycle. When a query is expected the fake SDK answers it (a result, or a
 * rate-limit rejection) while the drain is still waiting on the seat.
 */
async function deliver(
  m: Mounted, from: string, options: { to?: string; answer?: Answer } = {},
): Promise<{ id: string; state: string; reason: string }> {
  const id = await m.ctx.mailbox.publish({ to: formatMailboxAddress(options.to ?? 'target'), from, subject: `mail-${String(++counter)}` })
  const before = sdk.queries.length
  const drained = Bridge.internals.drainOnce(m.ctx, m.spec)
  const answer = options.answer ?? 'result'
  if (answer !== 'none') {
    const query = await nthQuery(before)
    if (query === undefined) {
      await Promise.race([drained, tick(1000)])
      throw new Error(`the driver never started the query this delivery should have run: ${JSON.stringify(rowOf(m, id))}`)
    }
    query.emit(answer === 'result' ? resultMessage({ user_message_uuids: query.uuids() }) : rateLimited())
  }
  await drained
  return { id, ...rowOf(m, id) }
}

/** The stored event types of a seat's session log (through the real persistence backend). */
async function storedTypes(m: Mounted, sessionId: string): Promise<string[]> {
  const persistence = m.ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('no session persistence mounted')
  return (await persistence.inspect(SessionId(sessionId))).events.map(event => event.type)
}

async function storedEvents(m: Mounted, sessionId: string) {
  const persistence = m.ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('no session persistence mounted')
  return (await persistence.inspect(SessionId(sessionId))).events
}

const sid = (seat: string): string => String(deriveNamedSessionId(seat))

/** Stand a default-driver roster seat up as a live resident, so a refusal notice can be appended to its log. */
function liveDefaultSender(m: Mounted, seat: SeatName): Agent {
  const session = m.ctx.sessions.create(SessionId(sid(seat)), { meta: { cwd: m.scene.cwds[seat] } })
  const agent = { id: session.id, session, status: 'idle', followup: () => undefined, steer: () => undefined, whenIdle: () => Promise.resolve() } as unknown as Agent
  m.ctx.agents.register(agent)
  return agent
}

/** Leave a default-driver log holding only a `user/message` in the session store, as a retired seat would. */
async function seedUserOnlyLog(s: Scene, seat: SeatName): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: s.persistRoot })
  const session = ctx.sessions.create(SessionId(sid(seat)), { meta: { cwd: s.cwds[seat] } })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'earlier chat' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await ctx.sessions.flush(session)
  await ctx.fiber.dispose()
}

beforeEach(() => {
  cleanHostEnv()
  sdk.queries.length = 0
})

afterEach(async () => {
  await unmountAll()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/** Each case runs with the harness home pointed at its own throwaway directory. */
function home(s: Scene): void {
  vi.stubEnv('DSH_HOME', s.dshHome)
}

// ---------------------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------------------

describe('the scene never touches the real harness home', () => {
  it('keeps the registry, stores and DSH_HOME under os.tmpdir() and the mounted bridge reads the temp registry', async () => {
    const s = scene()
    home(s)
    const m = await mount(s)
    expect(s.registryPath.startsWith(tmpdir())).toBe(true)
    expect(m.spec.orgRegistryPath).toBe(s.registryPath)
    expect(process.env.DSH_HOME?.startsWith(tmpdir())).toBe(true)
    expect(m.ctx.mailboxSeatRows?.registryPath).toBe(s.registryPath)
  })
})

describe('mail from a listed roster seat runs on the claude-code factory', () => {
  it('invokes the SDK query (never the default factory) and binds the session in the stored log', async () => {
    const s = scene()
    home(s)
    const m = await mount(s)
    const result = await deliver(m, 'alice')
    expect(result).toMatchObject({ state: 'done', reason: '' })
    expect(sdk.queries).toHaveLength(1)
    const query = sdk.queries[0] as FakeQuery
    expect(query.options.cwd).toBe(s.cwds.target)
    expect(m.defaultCreated).toEqual([])
    expect(m.defaultResumed).toEqual([])
    const types = await storedTypes(m, sid('target'))
    expect(types).toContain('claude-code/session-bound')
    expect(types).toContain('claude-code/mail-claimed')
    expect(types).toContain('claude-code/turn-completed')
  })
})

describe('mail the row does not admit is refused at the bridge, visibly', () => {
  it('refuses guest mail and an unlisted roster sender, noticing the sender and emitting mailbox/refused', async () => {
    const s = scene()
    home(s)
    const m = await mount(s, { residencyIdleMs: 60_000 })
    const ghost = liveDefaultSender(m, 'ghost')

    const unlisted = await deliver(m, 'ghost', { answer: 'none' })
    expect(unlisted.state).toBe('failed')
    expect(unlisted.reason).toBe('seat-driver-admission-denied: seat "target" does not admit mail from "ghost": sender "ghost" is not in admit_from')
    expect(m.refusals).toContainEqual({ from: 'ghost', to: 'target', reason: unlisted.reason })
    // The default-driver sender sees it in its own log.
    const notice = ghost.session.events.filter(event => event.type === 'user/message')
    expect(notice).toHaveLength(1)
    expect(JSON.stringify(notice[0])).toContain('seat-driver-admission-denied')

    const guest = await deliver(m, 'guest:operator', { answer: 'none' })
    expect(guest.state).toBe('failed')
    expect(guest.reason).toContain('seat-driver-admission-denied')
    expect(m.refusals.map(refusal => refusal.from)).toEqual(['ghost', 'guest:operator'])

    // Nothing reached the driver or the default loop.
    expect(sdk.queries).toHaveLength(0)
    expect(m.defaultCreated).toEqual([])
  })
})

describe('a stale or tampered row is refused when the seat is opened', () => {
  it('bounces the sender with the stale-binding reason when the registry moves between the bridge binding and the open', async () => {
    const s = scene()
    home(s)
    const m = await mount(s)
    const open = m.ctx.agents.create.bind(m.ctx.agents)
    vi.spyOn(m.ctx.agents, 'create').mockImplementation(async (options) => {
      // The row is rewritten after the bridge froze its binding; an empty drain cycle makes the bridge's row service re-read the file.
      s.rows = { target: ['driver: claude-code', 'admit_from:', '  - alice', '  - ghost', 'admit_sender_classes:', '  - seat'] }
      writeRegistry(s)
      // An idle cycle starts the re-read without awaiting it, so wait (bounded) until the row service reports the new row.
      const frozen = m.ctx.mailboxSeatRows?.current('target')?.rowHash
      await Bridge.internals.drainOnce(m.ctx, m.spec)
      for (let attempt = 0; attempt < 200 && m.ctx.mailboxSeatRows?.current('target')?.rowHash === frozen; attempt++) await tick(5)
      return open(options)
    })
    const result = await deliver(m, 'alice', { answer: 'none' })
    expect(result.state).toBe('failed')
    expect(result.reason).toContain('stale binding')
    expect(sdk.queries).toHaveLength(0)
  })

  it('quarantines a row that smuggles a host-config key, and the bridge refuses mail to it', async () => {
    const s = scene({ target: [...CC_ROW, 'model: opus'] })
    home(s)
    const m = await mount(s)
    const result = await deliver(m, 'alice', { answer: 'none' })
    expect(result.state).toBe('failed')
    expect(result.reason).toContain('belongs in host config')
    expect(sdk.queries).toHaveLength(0)
    expect(m.defaultCreated).toEqual([])
  })
})

describe('a direct steer on the live agent is denied by the glue', () => {
  it('records claude-code/refused for an unlisted from, naming the admit_from rule', async () => {
    const s = scene()
    home(s)
    const m = await mount(s, { residencyIdleMs: 60_000 })
    const first = await deliver(m, 'alice')
    expect(first.state).toBe('done')
    const live = m.ctx.agents.get(SessionId(sid('target')))
    if (live === undefined) throw new Error('the resident Claude Code agent is gone')
    const before = sdk.queries.length
    live.steer(mail('intruder', 'direct-1'))
    await live.whenIdle()
    const refused = live.session.events.filter(event => event.type === 'claude-code/refused')
    expect(refused).toHaveLength(1)
    expect(JSON.stringify(refused[0])).toContain('sender \\"intruder\\" is not in admit_from')
    expect(sdk.queries.length).toBe(before)
  })
})

describe('a driver flip is refused, and only a founder reseed moves the seat (A1)', () => {
  it('refuses the flip back to default, refuses a registry-only session change, then runs a fresh session after a host reseed', async () => {
    const s = scene()
    home(s)
    const first = await mount(s)
    expect((await deliver(first, 'alice')).state).toBe('done')
    expect(await storedTypes(first, sid('target'))).toContain('claude-code/session-bound')

    // The row is flipped to default while the log holds claude-code history: refused, default factory untouched.
    s.rows = {}
    writeRegistry(s)
    const flipped = await deliver(first, 'alice', { answer: 'none' })
    expect(flipped.state).toBe('failed')
    expect(flipped.reason).toContain('seat-driver-flip')
    expect(first.defaultCreated).toEqual([])
    expect(first.defaultResumed).toEqual([])

    // A registry writer repoints the seat at a new session id: the driver's pin refuses without the founder's host entry.
    const reseedId = randomUUID()
    s.rows = { target: [...CC_ROW, `sessionId: ${reseedId}`] }
    writeRegistry(s)
    const unauthorised = await deliver(first, 'alice', { answer: 'none' })
    expect(unauthorised.state).toBe('failed')
    expect(unauthorised.reason).toContain('seat-session-changed')
    await unmountAll()

    // The founder writes the new session id into the host entry (the A1 reseed): a fresh process proceeds on a fresh session.
    const s2 = s
    const second = await mount(s2, { hosts: { target: { session_id: reseedId } } })
    const queriesBefore = sdk.queries.length
    const ok = await deliver(second, 'alice')
    expect(ok.state).toBe('done')
    expect(sdk.queries.length).toBe(queriesBefore + 1)
    expect(await storedTypes(second, reseedId)).toContain('claude-code/session-bound')
  })
})

describe('a default seat in the same registry still uses the default factory', () => {
  it('creates a plain seat on the stand-in default factory and never reaches the SDK', async () => {
    const s = scene()
    home(s)
    const m = await mount(s)
    const result = await deliver(m, 'alice', { to: 'plain', answer: 'none' })
    expect(result).toMatchObject({ state: 'done', reason: '' })
    expect(m.defaultCreated).toEqual([sid('plain')])
    expect(sdk.queries).toHaveLength(0)
  })
})

describe('a log holding only user/message may be flipped to claude-code once, then it is locked (A7)', () => {
  it('binds on the first Claude Code turn, after which a flip back to default is refused', async () => {
    const s = scene({ target: CC_ROW })
    home(s)
    await seedUserOnlyLog(s, 'legacy')
    s.rows = { target: CC_ROW, legacy: CC_ROW }
    writeRegistry(s)
    const m = await mount(s)
    expect(await storedTypes(m, sid('legacy'))).toEqual(['user/message'])

    const bound = await deliver(m, 'alice', { to: 'legacy' })
    expect(bound.state).toBe('done')
    expect(sdk.queries).toHaveLength(1)
    const types = await storedTypes(m, sid('legacy'))
    expect(types).toContain('user/message')
    expect(types).toContain('claude-code/session-bound')

    s.rows = { target: CC_ROW }
    writeRegistry(s)
    const back = await deliver(m, 'alice', { to: 'legacy', answer: 'none' })
    expect(back.state).toBe('failed')
    expect(back.reason).toContain('seat-driver-flip')
    expect(m.defaultCreated).toEqual([])
    expect(m.defaultResumed).toEqual([])
  })
})

describe('settlement the bridge cannot yet improve (A8, the S8 closer)', () => {
  it('shows a driver refusal after queueing as a log record only, until a lease sink exists', async () => {
    const s = scene()
    home(s)
    const m = await mount(s, { residencyIdleMs: 60_000 })
    expect((await deliver(m, 'alice')).state).toBe('done')
    const live = m.ctx.agents.get(SessionId(sid('target')))
    if (live === undefined) throw new Error('the resident Claude Code agent is gone')
    expect(Object.keys(m.ctx.claudeCodeMailHooks)).toEqual(['admit'])

    // As shipped: no lease sink, so a refusal after queueing is visible only as the seat's own log record.
    live.followup(mail('intruder', 'lease-1'))
    await live.whenIdle()
    expect(live.session.events.filter(event => event.type === 'claude-code/refused')).toHaveLength(1)

    // A simulated lease sink (S8 will install the real one): the driver's existing failure path fails the lease with the reason.
    const calls: string[] = []
    Object.assign(m.ctx.claudeCodeMailHooks, {
      lease: { settle: (id: string) => { calls.push(`settle:${id}`) }, fail: (id: string, reason: string) => { calls.push(`fail:${id}:${reason}`) } },
    })
    live.followup(mail('intruder', 'lease-2'))
    await live.whenIdle()
    await tick(10)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^fail:lease-2:refused: .*sender "intruder" is not in admit_from/)
  })

  it('queues mail for an over-cap seat: lease done, no query, a claude-code/refused record naming the call window', async () => {
    const s = scene()
    home(s)
    const m = await mount(s, { hosts: { target: { max_calls_per_window: 1 } } })
    expect((await deliver(m, 'alice')).state).toBe('done')
    const before = sdk.queries.length

    const second = await deliver(m, 'alice', { answer: 'none' })
    expect(second).toMatchObject({ state: 'done', reason: '' })
    expect(sdk.queries.length).toBe(before)
    const refused = (await storedEvents(m, sid('target'))).filter(event => event.type === 'claude-code/refused')
    expect(refused).toHaveLength(1)
    expect(JSON.stringify(refused[0])).toContain('"reason":"call-window"')
    expect(JSON.stringify(refused[0])).toContain('1 of 1 calls used')
  })

  it('queues mail for a paused seat: the pause is in the log, the next lease is done, no second query runs', async () => {
    const s = scene()
    home(s)
    const m = await mount(s)
    const paused = await deliver(m, 'alice', { answer: 'rate-limit' })
    expect(paused.state).toBe('done')
    const pausedRecords = (await storedEvents(m, sid('target'))).filter(event => event.type === 'claude-code/paused')
    expect(pausedRecords).toHaveLength(1)
    expect(JSON.stringify(pausedRecords[0])).toContain('rate-limit')

    const before = sdk.queries.length
    const queued = await deliver(m, 'alice', { answer: 'none' })
    expect(queued).toMatchObject({ state: 'done', reason: '' })
    expect(sdk.queries.length).toBe(before)
    // The driver's refusal of the second turn names the pause window in the seat's log.
    expect(JSON.stringify(await storedEvents(m, sid('target')))).toContain('is paused until')
  })
})

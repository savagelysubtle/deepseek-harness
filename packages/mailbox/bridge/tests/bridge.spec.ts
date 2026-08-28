/**
 * Bridge routing behavior over the real seam pieces — the actual `ctx.mailbox`
 * registry backed by the SQLite provider, stubbed residency services — without
 * the Loader: spec resolution, delivery rendering, and each of the three
 * routing outcomes a claimed lease can take.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import { acquireNamedSessionLock, deriveNamedSessionId, namedLockPath } from '@deepseek-ai/dsh-named-sessions'
import MailboxLocal from '@deepseek-ai/dsh-mailbox-local'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as mailCli from '../../local/src/cli.ts'
import * as bridge from '../src/index.ts'
import { admittedOutcome, relaySource, relayText } from '../src/delivery.ts'

let homes: string[] = []

afterEach(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
  homes = []
})

const TARGET = formatMailboxAddress('target')

/** The spec every routing test drains with: one address, permissive staleness, the fixture peer sender admitted. */
function targetSpec(addresses = ['target']): Parameters<typeof bridge.resolveBridgeSpec>[0] {
  return { addresses, pollIntervalMs: 5, maxClaimPerCycle: 10, staleClaimMs: 600_000, admitFrom: ['sender'] }
}

interface LiveAgentStub {
  status: 'idle' | 'running'
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
}

/**
 * One wired harness: real mailbox registry + real SQLite provider, stubbed
 * agent registry / persistence / sessions so routing decisions are observable.
 */
async function makeHarness(options: {
  /** Live agents by derived session id; the routing's `ctx.agents.get` proxy. */
  liveBySession?: Record<string, LiveAgentStub>
  /** Which session names persistence reports logs for (`true` = the shared 'target' fixture). */
  persisted?: boolean | readonly string[]
  /** Explicit queue file override (down-host tests mount the file the CLI wrote). */
  storePath?: string
  /** Explicit live-seat roster passed through to the spec (web-seat tests). */
  seatAliases?: readonly { readonly address: string; readonly sessionId: string }[]
} = {}): Promise<{
  ctx: ContextType
  storePath: string
  resumeCalls: () => number
  resumedFollowup: ReturnType<typeof vi.fn>
  disposeCalls: () => number
  flushes: () => number
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-bridge-unit-'))
  homes.push(dir)
  process.env.DSH_HOME = dir
  const ctx = new Context()
  await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
  await ctx.plugin(MailboxLocal, { path: options.storePath ?? join(dir, 'mailbox.db') })

  const state = { resumes: 0, disposes: 0, flushes: 0 }
  const resumedFollowup = vi.fn()
  const agents = {
    get: (id: string) => options.liveBySession?.[id],
    resume: vi.fn(async () => {
      state.resumes += 1
      return {
        agent: {
          status: 'idle',
          followup: resumedFollowup,
          steer: vi.fn(),
          whenIdle: async () => {},
          session: { events: [] },
        },
        dispose: async () => { state.disposes += 1 },
      }
    }),
  }
  ctx.provide('agents', agents as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  ctx.provide('sessionPersistence', {
    list: async () => {
      if (options.persisted === true) return [{ id: deriveNamedSessionId('target') }]
      return Array.isArray(options.persisted) ? options.persisted.map(name => ({ id: deriveNamedSessionId(name) })) : []
    },
  } as never)
  ctx.provide('sessions', { flush: vi.fn(async () => { state.flushes += 1 }) } as never)
  return {
    ctx,
    storePath: join(dir, 'mailbox.db'),
    resumeCalls: () => state.resumes,
    resumedFollowup,
    disposeCalls: () => state.disposes,
    flushes: () => state.flushes,
  }
}

async function publishHello(ctx: ContextType): Promise<string> {
  return ctx.mailbox.publish({ to: TARGET, from: 'sender', subject: 'hello' })
}

/** Read one message's stored lifecycle row straight out of the provider file. */
async function rowState(storePath: string, messageId: string): Promise<{
  state: string
  settle_state: string | null
  result: string | null
}> {
  const db = new DatabaseSync(storePath)
  try {
    const row = db.prepare('SELECT state, settle_state, result FROM messages WHERE id = ?').get(messageId) as
      | { state: string; settle_state: string | null; result: string | null }
    return row
  } finally {
    db.close()
  }
}

describe('spec resolution', () => {
  it('rejects empty rosters and malformed addresses loud', () => {
    expect(() => bridge.resolveBridgeSpec({ addresses: [] })).toThrow(/at least one served/)
    expect(() => bridge.resolveBridgeSpec({ addresses: ['no separator'] })).toThrow(/invalid mailbox address/)
  })

  it('brands served addresses and applies explicit values over defaults', () => {
    const spec = bridge.resolveBridgeSpec({
      addresses: ['target'],
      pollIntervalMs: 5,
      maxClaimPerCycle: 2,
      staleClaimMs: 3,
      lockStaleMs: 4,
    })
    expect(spec.addresses).toEqual([TARGET])
    expect(spec.pollIntervalMs).toBe(5)
    expect(spec.maxClaimPerCycle).toBe(2)
    expect(spec.staleClaimMs).toBe(3)
    expect(spec.lockStaleMs).toBe(4)
    const defaulted = bridge.resolveBridgeSpec({ addresses: ['target'] })
    expect(defaulted.pollIntervalMs).toBe(bridge.DEFAULT_POLL_INTERVAL_MS)
    expect(defaulted.maxClaimPerCycle).toBe(bridge.DEFAULT_MAX_CLAIM_PER_CYCLE)
    expect(defaulted.staleClaimMs).toBe(bridge.DEFAULT_STALE_CLAIM_MS)
    expect(defaulted.lockStaleMs).toBeUndefined()
  })
})

describe('seatAliases resolution validation', () => {
  it('rejects invalid addresses, empty session ids, and duplicate rows loud', () => {
    expect(() => bridge.resolveBridgeSpec({
      addresses: ['target'],
      seatAliases: [{ address: 'no separator', sessionId: 'session-x' }],
    })).toThrow(/invalid mailbox address/)
    expect(() => bridge.resolveBridgeSpec({
      addresses: ['target'],
      seatAliases: [{ address: 'target', sessionId: '   ' }],
    })).toThrow(/carries an empty session id/)
    expect(() => bridge.resolveBridgeSpec({
      addresses: ['target'],
      seatAliases: [
        { address: 'target', sessionId: 'session-one' },
        { address: 'target', sessionId: 'session-two' },
      ],
    })).toThrow(/declared more than once/)
  })
})

describe('delivery rendering', () => {
  it('joins subject and payload bodies and keeps provenance in the merged source', () => {
    const base = { id: 'm-1' as never, to: TARGET, from: 'sender' }
    expect(relayText({ message: base, leaseRef: 'r' as never, claimedAt: 1 })).toBe('')
    expect(relayText({ message: { ...base, subject: 'hello', payload: { op: 'ping' } }, leaseRef: 'r' as never, claimedAt: 1 }))
      .toBe('hello\n\n{\n  "op": "ping"\n}')
    expect(relayText({ message: { ...base, payload: 'plain body' }, leaseRef: 'r' as never, claimedAt: 1 })).toBe('plain body')
    const sourced = relaySource({ message: { ...base, traceId: 't-9' }, leaseRef: 'r' as never, claimedAt: 1 })
    expect(sourced).toMatchObject({
      kind: 'mailbox', form: 'relay', address: TARGET, from: 'sender', messageId: 'm-1', traceId: 't-9',
    })
    expect(relaySource({ message: base, leaseRef: 'r' as never, claimedAt: 1 })).not.toHaveProperty('traceId')
    expect(() => relaySource({ message: { to: TARGET, from: 'sender' }, leaseRef: 'r' as never, claimedAt: 1 })).toThrow(/no provider id/)
    expect(admittedOutcome({ message: base, leaseRef: 'r' as never, claimedAt: 1 }).state).toBe('done')
  })

  it('marks a blocking sender with the literal [BLOCKING] token ahead of the content', () => {
    const base = { id: 'm-1' as never, to: TARGET, from: 'sender' }
    expect(relayText({ message: { ...base, blocking: true, subject: 'wake now' }, leaseRef: 'r' as never, claimedAt: 1 }))
      .toBe('[BLOCKING]\n\nwake now')
  })

  it('renders non-blocking turns without the [BLOCKING] token anywhere', () => {
    const base = { id: 'm-1' as never, to: TARGET, from: 'sender' }
    expect(relayText({ message: { ...base, subject: 'routine note' }, leaseRef: 'r' as never, claimedAt: 1 })).toBe('routine note')
    expect(relayText({ message: { ...base, subject: 'routine note', blocking: false }, leaseRef: 'r' as never, claimedAt: 1 }))
      .toBe('routine note')
  })
})

describe('routing outcomes', () => {
  it('delivers to a live idle agent via STEER (founder model: all mail interrupts)', async () => {
    const live = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const h = await makeHarness({ liveBySession: { [String(deriveNamedSessionId('target'))]: live } })
    const id = await publishHello(h.ctx)
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec()))
    expect(live.steer).toHaveBeenCalledTimes(1)
    expect(live.followup).not.toHaveBeenCalled()
    const message = live.steer.mock.calls[0]?.[0] as {
      source: { kind: string; form: string; messageId: string }
      content: readonly [{ text: string }]
    }
    expect(message.source).toMatchObject({ kind: 'mailbox', form: 'relay', messageId: id })
    expect(message.content[0]?.text).toBe('hello')
    await expect(rowState(h.storePath, id)).resolves.toMatchObject({ state: 'done', settle_state: 'done' })
  })

  it('steers routine mail into a BUSY turn as well — no busyness inference, channel is uniform', async () => {
    const busy = { status: 'running' as const, followup: vi.fn(), steer: vi.fn() }
    const derived = String(deriveNamedSessionId('target'))
    const h = await makeHarness({ liveBySession: { [derived]: busy } })
    const id = await publishHello(h.ctx)
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec()))
    expect(busy.steer).toHaveBeenCalledTimes(1)
    expect(busy.followup).not.toHaveBeenCalled()
    await expect(rowState(h.storePath, id)).resolves.toMatchObject({ state: 'done' })
  })

  it('falls back to an ordinary queued turn when the boundary refuses the interruption', async () => {
    const refusing = { status: 'running' as const, followup: vi.fn(), steer: vi.fn(() => { throw new Error('turn boundary refused') }) }
    const derived = String(deriveNamedSessionId('target'))
    const h = await makeHarness({
      liveBySession: { [derived]: refusing },
      persisted: ['target'],
    })
    const id = await h.ctx.mailbox.publish({ to: TARGET, from: 'sender', subject: 'abort now' })
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec()))
    expect(refusing.steer).toHaveBeenCalledTimes(1)
    expect(refusing.followup).toHaveBeenCalledTimes(1)
    await expect(rowState(h.storePath, id)).resolves.toMatchObject({ state: 'done' })
  })

  it('cold-resumes a dormant persisted target: queued turn, done at admission, flush, dispose, lock released', async () => {
    const h = await makeHarness({ persisted: true })
    const id = await publishHello(h.ctx)
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec()))
    expect(h.resumeCalls()).toBe(1)
    expect(h.resumedFollowup).toHaveBeenCalledTimes(1)
    const message = h.resumedFollowup.mock.calls[0]?.[0] as { source: { kind: string }; content: readonly [{ text: string }] }
    expect(message.source.kind).toBe('mailbox')
    expect(message.content[0]?.text).toBe('hello')
    await expect(rowState(h.storePath, id)).resolves.toMatchObject({ state: 'done' })
    // Settled AT ADMISSION, not after quiescence — but idle/flush/dispose still ran.
    expect(h.flushes()).toBe(1)
    expect(h.disposeCalls()).toBe(1)
    expect(existsSync(namedLockPath('target'))).toBe(false)
  })

  it("settles failed with reason 'unknown-address' for an unpersisted name", async () => {
    const h = await makeHarness({ persisted: false })
    const id = await publishHello(h.ctx)
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec()))
    expect(h.resumeCalls()).toBe(0)
    const row = await rowState(h.storePath, id)
    expect(row.state).toBe('failed')
    expect(JSON.parse(row.result ?? '{}')).toEqual({ reason: 'unknown-address' })
    expect(existsSync(namedLockPath('target'))).toBe(false)
  })

  it('defers back to pending while residency is held elsewhere', async () => {
    const h = await makeHarness({ persisted: true })
    const lock = acquireNamedSessionLock('target')
    try {
      const id = await publishHello(h.ctx)
      await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec()))
      expect(h.resumeCalls()).toBe(0)
      await expect(rowState(h.storePath, id)).resolves.toMatchObject({ state: 'pending', settle_state: null })
    } finally {
      lock.release()
    }
    expect(existsSync(namedLockPath('target'))).toBe(false)
  })

  it('delivers CLI-published backlog on the next bridge mount — the down-host bootstrap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-bridge-down-'))
    homes.push(dir)
    process.env.DSH_HOME = dir
    const dbPath = join(dir, 'mailbox.db')
    // The harness is DOWN: the guest writes through the CLI bin alone.
    const silent = mailCli.internals.stdout
    mailCli.internals.stdout = { write: () => true }
    try {
      await mailCli.runMailboxCli([
        'send', '--to', 'down', '--from', 'claude-code',
        '--type', 'field-report', '--subject', 'outage report', '--db', dbPath,
      ])
    } finally {
      mailCli.internals.stdout = silent
    }

    // Next successful boot: the bridge mounts over the same file and its
    // inline drain delivers the dormant seat's backlog.
    const h = await makeHarness({ persisted: ['down'], storePath: dbPath })
    // The CLI already landed exactly one pending row while the host was down.
    const probe = new DatabaseSync(dbPath)
    const queued = probe.prepare('SELECT state FROM messages WHERE to_address = ?').all('down') as Array<{ state: string }>
    probe.close()
    expect(queued).toEqual([{ state: 'pending' }])
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec({
      addresses: ['down'], pollIntervalMs: 5, maxClaimPerCycle: 10,
      staleClaimMs: 600_000, admitFrom: ['claude-code'],
    }))
    expect(h.resumeCalls()).toBe(1)
    const message = h.resumedFollowup.mock.calls[0]?.[0] as {
      source?: { kind?: string; form?: string; from?: string }
      content?: readonly [{ type: string; text: string }]
    }
    expect(message?.source).toMatchObject({ kind: 'mailbox', form: 'relay', from: 'claude-code' })
    expect(message?.content?.[0]?.text).toContain('outage report')

    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT state FROM messages WHERE to_address = ?').all('down') as Array<{ state: string }>
    db.close()
    expect(rows.map(row => row.state)).toEqual(['done'])
  })

  it('isolates a poison delivery instead of wedging the batch behind it', async () => {
    // Both admission channels poisoned so nothing self-heals: a delivery that
    // cannot land ANYWHERE propagates into terminal-failure isolation.
    const poisoned = {
      status: 'idle' as const,
      followup: vi.fn(() => { throw new Error('boom') }),
      steer: vi.fn(() => { throw new Error('boom') }),
    }
    const healthy = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const h = await makeHarness({
      liveBySession: {
        [String(deriveNamedSessionId('target'))]: poisoned,
        [String(deriveNamedSessionId('other'))]: healthy,
      },
    })
    const bad = await publishHello(h.ctx)
    const good = await h.ctx.mailbox.publish({
      to: formatMailboxAddress('other'), from: 'sender', subject: 'fine',
    })
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec(['target', 'other'])))
    const badRow = await rowState(h.storePath, bad)
    expect(badRow.state).toBe('failed')
    expect(JSON.parse(badRow.result ?? '{}').reason).toContain('boom')
    await expect(rowState(h.storePath, good)).resolves.toMatchObject({ state: 'done' })
  })
})

describe('seat-alias routing (web-host live seats)', () => {
  /** A seat whose session id is NOT name-derived, as web-host seats are. */
  const SEAT_SESSION_ID = 'session-seat-arbitrary-id' as never

  it('publish→live-seat steer: the aliased live agent receives via steer, not derivation', async () => {
    const seatLive = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const derived = String(deriveNamedSessionId('batman'))
    const h = await makeHarness({
      // A decoy under the DERIVED id proves alias wins over derivation.
      liveBySession: {
        [derived]: { status: 'idle', followup: vi.fn(), steer: vi.fn() },
        ['session-seat-arbitrary-id']: seatLive,
      },
      seatAliases: [{ address: 'batman', sessionId: 'session-seat-arbitrary-id' }],
    })
    const id = await h.ctx.mailbox.publish({ to: formatMailboxAddress('batman'), from: 'alfred', subject: 'wake' })
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec({
      addresses: ['batman'], pollIntervalMs: 5, maxClaimPerCycle: 10,
      staleClaimMs: 600_000, admitFrom: ['alfred'],
      seatAliases: [{ address: 'batman', sessionId: 'session-seat-arbitrary-id' }],
    }))
    expect(seatLive.steer).toHaveBeenCalledTimes(1)
    expect((seatLive.steer.mock.calls[0]?.[0] as { source: { messageId: string } }).source.messageId).toBe(id)
    await expect(rowState(h.storePath, id)).resolves.toMatchObject({ state: 'done' })
    void SEAT_SESSION_ID
  })

  it('publish→idle-seat cold-resume resumes the EXACT aliased session id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-seat-'))
    homes.push(dir)
    process.env.DSH_HOME = dir
    const ctx = new Context()
    await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
    await ctx.plugin(MailboxLocal, { path: join(dir, 'mailbox.db') })

    const resumeCalls: SessionId[] = []
    ctx.provide('agents', {
      get: () => undefined,
      resume: vi.fn(async (options: { resumeSessionId: SessionId }) => {
        resumeCalls.push(options.resumeSessionId)
        return {
          agent: { status: 'idle', followup: vi.fn(), steer: vi.fn(), whenIdle: async () => {}, session: { events: [] } },
          dispose: async () => {},
        }
      }),
    } as never)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'session-seat-arbitrary-id' as never }],
    } as never)
    ctx.provide('sessions', { flush: vi.fn(async () => {}) } as never)

    await ctx.mailbox.publish({ to: formatMailboxAddress('robin'), from: 'council', subject: 'briefing' })
    await bridge.internals.drainOnce(ctx, bridge.resolveBridgeSpec({
      addresses: ['robin'], pollIntervalMs: 5, maxClaimPerCycle: 10,
      staleClaimMs: 600_000, admitFrom: ['council'],
      seatAliases: [{ address: 'robin', sessionId: 'session-seat-arbitrary-id' }],
    }))
    expect(resumeCalls).toEqual(['session-seat-arbitrary-id'])
  })

  it('an unserved address stays parked — nobody drains what no roster serves', async () => {
    const { ctx, storePath } = await makeHarness({})
    const unserved = formatMailboxAddress('off-roster')
    await ctx.mailbox.publish({ to: unserved, from: 'alfred', subject: 'nobody home' })
    // A drain over a DIFFERENT roster must leave the off-roster row untouched.
    await bridge.internals.drainOnce(ctx, bridge.resolveBridgeSpec(targetSpec(['target'])))
    const db = new DatabaseSync(storePath)
    const rows = db.prepare('SELECT state FROM messages WHERE to_address = ?').all(String(unserved)) as Array<{ state: string }>
    db.close()
    expect(rows).toEqual([{ state: 'pending' }])
    // And publishAndWake keeps refusing it loud (existing behavior preserved):
    // mount a real roster first so the check reaches the not-served branch.
    ctx.provide('mailboxBridgeSpecs', [bridge.resolveBridgeSpec(targetSpec())] as never)
    await expect(bridge.publishAndWake(ctx, { to: String(unserved), from: 'alfred' }))
      .rejects.toThrow(/not served by any mounted mailbox bridge/)
  })
})

describe('drain-time sender admission', () => {
  /** The spec variant under test, differing only in the guest opt-in. */
  function specWith(admitFrom: readonly string[]): Parameters<typeof bridge.resolveBridgeSpec>[0] {
    return { addresses: ['target'], pollIntervalMs: 5, maxClaimPerCycle: 10, staleClaimMs: 600_000, admitFrom }
  }

  it('settles a non-admitted sender failed at drain and never wakes the target', async () => {
    const live = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const h = await makeHarness({ liveBySession: { [String(deriveNamedSessionId('target'))]: live } })
    const id = await h.ctx.mailbox.publish({ to: TARGET, from: 'claude-code', subject: 'unsolicited' })
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(specWith([])))
    expect(live.followup).not.toHaveBeenCalled()
    const row = await rowState(h.storePath, id)
    expect(row.state).toBe('failed')
    expect(JSON.parse(row.result ?? '{}')).toEqual({ reason: 'sender-not-admitted' })
  })

  it('delivers an explicitly admitted guest sender like any colleague', async () => {
    const live = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const h = await makeHarness({ liveBySession: { [String(deriveNamedSessionId('target'))]: live } })
    const id = await h.ctx.mailbox.publish({ to: TARGET, from: 'claude-code', subject: 'council report' })
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(specWith(['claude-code'])))
    expect(live.steer).toHaveBeenCalledTimes(1)
    await expect(rowState(h.storePath, id)).resolves.toMatchObject({ state: 'done' })
  })

  it('fails a sender whose namespace half cannot even be parsed closed', async () => {
    const live = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const h = await makeHarness({ liveBySession: { [String(deriveNamedSessionId('target'))]: live } })
    const id = await h.ctx.mailbox.publish({ to: TARGET, from: 'opaque-sender-token', subject: '?' })
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(specWith([])))
    expect(live.followup).not.toHaveBeenCalled()
    const row = await rowState(h.storePath, id)
    expect(JSON.parse(row.result ?? '{}')).toEqual({ reason: 'sender-not-admitted' })
  })
})

describe('terminal-failure bounces (every drop visible)', () => {
  /** Read every store row addressed to one recipient address. */
  type StoredRow = {
    type: string | null
    trace_id: string | null
    result: string | null
    payload: string | null
    from_address: string
  }
  function rowsTo(storePath: string, address: string): Array<StoredRow> {
    const db = new DatabaseSync(storePath)
    try {
      return db.prepare('SELECT type, trace_id, result, payload, from_address FROM messages WHERE to_address = ?').all(address) as unknown as Array<StoredRow>
    } finally {
      db.close()
    }
  }

  it("bounce round-trip: rejected guest mail produces a 'bounce' row carrying the original traceId and reason", async () => {
    const h = await makeHarness({})
    const id = await h.ctx.mailbox.publish({
      to: TARGET, from: 'council', subject: 'request', traceId: 'tr-42',
    })
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec()))
    const bounces = rowsTo(h.storePath, 'council').filter(row => row.type === 'bounce')
    expect(bounces).toHaveLength(1)
    const bounceRow = bounces[0]
    expect(bounceRow?.trace_id).toBe('tr-42')
    expect(bounceRow?.from_address).toBe(String(TARGET))
    // An UNDRAINED bounce stays pending with an empty settlement slot — the
    // drop notice lives in its payload, readable by the guest's next inbox.
    expect(JSON.parse(bounceRow?.payload ?? '{}')).toEqual({
      bouncedMessageId: id,
      reason: 'sender-not-admitted',
    })
  })

  it("'unknown-address' bounces too — the fix is general, not guest-specific", async () => {
    const h = await makeHarness({ persisted: false })
    const ghost = formatMailboxAddress('ghost')
    await h.ctx.mailbox.publish({ to: ghost, from: 'alice', subject: 'typo send' })
    // The roster serves both names: the typo'd one fails route-time discovery
    // while remaining grammatically servable.
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec(['alice', 'ghost'])))
    const bounces = rowsTo(h.storePath, 'alice').filter(row => row.type === 'bounce')
    expect(bounces).toHaveLength(1)
    expect(bounces[0]?.trace_id).toBeNull()
    expect(JSON.parse(bounces[0]?.payload ?? '{}').reason).toBe('unknown-address')
  })

  it('never bounces a bounce and never fabricates addresses for unparseable senders', async () => {
    const h = await makeHarness({ persisted: false })
    const db = new DatabaseSync(h.storePath)
    db.prepare(
      "INSERT INTO messages (id, to_address, from_address, type, state, created_at) VALUES (?, ?, ?, 'bounce', 'pending', 500)",
    ).run('bb-1', String(formatMailboxAddress('ghost')), 'bouncer')
    db.prepare(
      "INSERT INTO messages (id, to_address, from_address, state, created_at) VALUES (?, ?, ?, 'pending', 501)",
    ).run('up-1', String(TARGET), 'opaque-sender-token')
    db.close()
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec(['bouncer'])))
    expect(rowsTo(h.storePath, 'bouncer')).toEqual([])
    expect(rowsTo(h.storePath, 'opaque-sender-token')).toEqual([])
  })
})

describe('publishAndWake', () => {
  /** Attach one bridge's resolved roster so the wake path sees it as served. */
  function serveSpecs(ctx: ContextType, addresses: readonly string[], admitFrom: readonly string[]): void {
    ctx.provide('mailboxBridgeSpecs', [bridge.resolveBridgeSpec({
      addresses: [...addresses], pollIntervalMs: 5, maxClaimPerCycle: 10,
      staleClaimMs: 600_000, admitFrom,
    })] as never)
  }

  it('delivers into a live target and reports the admission', async () => {
    const live = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const h = await makeHarness({ liveBySession: { [String(deriveNamedSessionId('target'))]: live } })
    serveSpecs(h.ctx, ['target'], ['ceo'])
    const result = await bridge.publishAndWake(h.ctx, { to: 'target', from: 'ceo', subject: 'wake' })
    expect(result.disposition).toBe('delivered')
    expect(live.steer).toHaveBeenCalledTimes(1)
    expect((live.steer.mock.calls[0]?.[0] as { source: { messageId: string } }).source.messageId).toBe(result.messageId)
    await expect(rowState(h.storePath, result.messageId)).resolves.toMatchObject({ state: 'done' })
  })

  it('reports queued while residency holds the target elsewhere', async () => {
    const h = await makeHarness({ persisted: true })
    serveSpecs(h.ctx, ['target'], ['ceo'])
    const lock = acquireNamedSessionLock('target')
    try {
      const result = await bridge.publishAndWake(h.ctx, { to: 'target', from: 'ceo', subject: 'hold' })
      expect(result.disposition).toBe('queued')
      await expect(rowState(h.storePath, result.messageId)).resolves.toMatchObject({ state: 'pending' })
    } finally {
      lock.release()
    }
  })

  it('rejects grammar violations before anything is stored', async () => {
    const h = await makeHarness({ persisted: true })
    serveSpecs(h.ctx, ['target'], [])
    await expect(bridge.publishAndWake(h.ctx, { to: 'no separator', from: 'ceo' }))
      .rejects.toThrow(/invalid mailbox address/)
  })

  it('rejects addresses outside every mounted roster loud', async () => {
    const h = await makeHarness({ persisted: true })
    serveSpecs(h.ctx, ['target'], [])
    await expect(bridge.publishAndWake(h.ctx, { to: 'stranger', from: 'ceo' }))
      .rejects.toThrow(/not served by any mounted mailbox bridge/)
  })

  it('surfaces a terminal routing failure with its recorded reason', async () => {
    const h = await makeHarness({ persisted: false })
    serveSpecs(h.ctx, ['target'], ['ceo'])
    await expect(bridge.publishAndWake(h.ctx, { to: 'target', from: 'ceo', subject: 'nobody home' }))
      .rejects.toThrow(/mailbox delivery failed: unknown-address/)
  })

  it('refuses to publish when no bridge is composed at all', async () => {
    const h = await makeHarness({ persisted: true })
    await expect(bridge.publishAndWake(h.ctx, { to: 'target', from: 'ceo' }))
      .rejects.toThrow(/no mailbox bridge is composed/)
  })
})

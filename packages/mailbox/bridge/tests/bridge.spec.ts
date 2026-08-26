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
import * as bridge from '../src/index.ts'
import { admittedOutcome, relaySource, relayText } from '../src/delivery.ts'

let homes: string[] = []

afterEach(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
  homes = []
})

const TARGET = formatMailboxAddress('sc', 'target')

/** The spec every routing test drains with: one address, permissive staleness. */
function targetSpec(addresses = ['sc:target']): Parameters<typeof bridge.resolveBridgeSpec>[0] {
  return { addresses, pollIntervalMs: 5, maxClaimPerCycle: 10, staleClaimMs: 600_000 }
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
  /** Whether persistence reports a log for the derived target session. */
  persisted?: boolean
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
  await ctx.plugin(MailboxLocal, { path: join(dir, 'mailbox.db') })

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
    list: async () => options.persisted === true ? [{ id: deriveNamedSessionId('target') }] : [],
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
  return ctx.mailbox.publish({ to: TARGET, from: 'sc:sender', subject: 'hello' })
}

/** Read one message's stored lifecycle row straight out of the provider file. */
async function rowState(storePath: string, messageId: string): Promise<{ state: string; settle_state: string | null; result: string | null }> {
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
      addresses: ['sc:target'],
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
    const defaulted = bridge.resolveBridgeSpec({ addresses: ['sc:target'] })
    expect(defaulted.pollIntervalMs).toBe(bridge.DEFAULT_POLL_INTERVAL_MS)
    expect(defaulted.maxClaimPerCycle).toBe(bridge.DEFAULT_MAX_CLAIM_PER_CYCLE)
    expect(defaulted.staleClaimMs).toBe(bridge.DEFAULT_STALE_CLAIM_MS)
    expect(defaulted.lockStaleMs).toBeUndefined()
  })
})

describe('delivery rendering', () => {
  it('joins subject and payload bodies and keeps provenance in the merged source', () => {
    const base = { id: 'm-1' as never, to: TARGET, from: 'sc:sender' }
    expect(relayText({ message: base, leaseRef: 'r' as never, claimedAt: 1 })).toBe('')
    expect(relayText({ message: { ...base, subject: 'hello', payload: { op: 'ping' } }, leaseRef: 'r' as never, claimedAt: 1 }))
      .toBe('hello\n\n{\n  "op": "ping"\n}')
    expect(relayText({ message: { ...base, payload: 'plain body' }, leaseRef: 'r' as never, claimedAt: 1 })).toBe('plain body')
    const sourced = relaySource({ message: { ...base, traceId: 't-9' }, leaseRef: 'r' as never, claimedAt: 1 })
    expect(sourced).toMatchObject({
      kind: 'mailbox', form: 'relay', address: TARGET, from: 'sc:sender', messageId: 'm-1', traceId: 't-9',
    })
    expect(relaySource({ message: base, leaseRef: 'r' as never, claimedAt: 1 })).not.toHaveProperty('traceId')
    expect(() => relaySource({ message: { ...base, id: undefined }, leaseRef: 'r' as never, claimedAt: 1 })).toThrow(/no provider id/)
    expect(admittedOutcome({ message: base, leaseRef: 'r' as never, claimedAt: 1 }).state).toBe('done')
  })
})

describe('routing outcomes', () => {
  it('delivers to a live idle agent via followup and settles done at admission', async () => {
    const live = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const h = await makeHarness({ liveBySession: { [String(deriveNamedSessionId('target'))]: live } })
    const id = await publishHello(h.ctx)
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec()))
    expect(live.steer).not.toHaveBeenCalled()
    expect(live.followup).toHaveBeenCalledTimes(1)
    const message = live.followup.mock.calls[0]?.[0] as { source: { kind: string; form: string; messageId: string }; content: readonly [{ text: string }] }
    expect(message.source).toMatchObject({ kind: 'mailbox', form: 'relay', messageId: id })
    expect(message.content[0]?.text).toBe('hello')
    await expect(rowState(h.storePath, id)).resolves.toMatchObject({ state: 'done', settle_state: 'done' })
  })

  it('steers into a running turn first, falling back to followup on rejection', async () => {
    const steering = { status: 'running' as const, followup: vi.fn(), steer: vi.fn() }
    const refusing = { status: 'running' as const, followup: vi.fn(), steer: vi.fn(() => { throw new Error('turn boundary refused') }) }
    const derived = String(deriveNamedSessionId('target'))
    const hA = await makeHarness({ liveBySession: { [derived]: steering } })
    const idA = await publishHello(hA.ctx)
    await bridge.internals.drainOnce(hA.ctx, bridge.resolveBridgeSpec(targetSpec()))
    expect(steering.steer).toHaveBeenCalledTimes(1)
    expect(steering.followup).not.toHaveBeenCalled()
    await expect(rowState(hA.storePath, idA)).resolves.toMatchObject({ state: 'done' })

    const hB = await makeHarness({ liveBySession: { [derived]: refusing } })
    const idB = await publishHello(hB.ctx)
    await bridge.internals.drainOnce(hB.ctx, bridge.resolveBridgeSpec(targetSpec()))
    expect(refusing.steer).toHaveBeenCalledTimes(1)
    expect(refusing.followup).toHaveBeenCalledTimes(1)
    await expect(rowState(hB.storePath, idB)).resolves.toMatchObject({ state: 'done' })
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

  it('isolates a poison delivery instead of wedging the batch behind it', async () => {
    const poisoned = { status: 'idle' as const, followup: vi.fn(() => { throw new Error('boom') }), steer: vi.fn() }
    const healthy = { status: 'idle' as const, followup: vi.fn(), steer: vi.fn() }
    const h = await makeHarness({
      liveBySession: {
        [String(deriveNamedSessionId('target'))]: poisoned,
        [String(deriveNamedSessionId('other'))]: healthy,
      },
    })
    const bad = await publishHello(h.ctx)
    const good = await h.ctx.mailbox.publish({
      to: formatMailboxAddress('sc', 'other'), from: 'sc:sender', subject: 'fine',
    })
    await bridge.internals.drainOnce(h.ctx, bridge.resolveBridgeSpec(targetSpec(['sc:target', 'sc:other'])))
    const badRow = await rowState(h.storePath, bad)
    expect(badRow.state).toBe('failed')
    expect(JSON.parse(badRow.result ?? '{}').reason).toContain('boom')
    await expect(rowState(h.storePath, good)).resolves.toMatchObject({ state: 'done' })
  })
})

/**
 * Store behavior of the SQLite mailbox provider: schema-version gating,
 * publish/claim/settle leasing semantics, and the service's registry mount
 * and disposal.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MailboxAddress, MailboxClaimFilter } from '@deepseek-ai/dsh-mailbox'
import { formatMailboxAddress, MailboxRegistry } from '@deepseek-ai/dsh-mailbox'
import MailboxLocal, { resolveMailboxPath, SCHEMA_VERSION } from '../src/index.ts'
import { openMailboxDatabase, SqliteMailboxStore } from '../src/sqlite.ts'
import type { MailboxClock } from '../src/types.ts'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

/** Create one private database path inside a fresh temp directory. */
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-local-'))
  dirs.push(dir)
  return join(dir, 'mailbox.db')
}

/** A controllable epoch-millisecond clock for staleness accounting. */
function fakeClock(): { clock: MailboxClock; advance: (ms: number) => void } {
  let now = 1_000_000
  return { clock: () => now, advance: (ms) => { now += ms } }
}

function storeWith(clock: MailboxClock, path = tempDbPath()): SqliteMailboxStore {
  return new SqliteMailboxStore(openMailboxDatabase(path), clock)
}

const OPS = formatMailboxAddress('gotham', 'operations')
const FIELD = formatMailboxAddress('gotham', 'field')

function filter(addresses: readonly MailboxAddress[], limit = 10, staleClaimMs = 30_000): MailboxClaimFilter {
  return { addresses, limit, staleClaimMs }
}

describe('schema ownership', () => {
  it('stamps a fresh database at SCHEMA_VERSION and accepts reopen', () => {
    const path = tempDbPath()
    openMailboxDatabase(path).close()
    const reopened = openMailboxDatabase(path)
    const row = reopened.prepare('SELECT value FROM mailbox_meta WHERE key = ?').get('schema_version') as { value: string }
    expect(row.value).toBe(String(SCHEMA_VERSION))
    reopened.close()
  })

  it('rejects a database stamped by a newer schema version loud', () => {
    const path = tempDbPath()
    const db = openMailboxDatabase(path)
    db.prepare('UPDATE mailbox_meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION + 1), 'schema_version')
    db.close()
    expect(() => openMailboxDatabase(path)).toThrow(`incompatible with this build (${SCHEMA_VERSION})`)
  })

  it('rejects a non-mailbox SQLite database loud', () => {
    const path = tempDbPath()
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE stray (x INTEGER)')
    foreign.close()
    expect(() => openMailboxDatabase(path)).toThrow('is not a mailbox store')
  })
})

describe('publish/claim/settle', () => {
  it('round-trips a fully populated message and admits its delivery envelope', async () => {
    const { clock } = fakeClock()
    const store = storeWith(clock)
    const payload = { op: 'ping', count: 2 }
    const id = await store.publish({
      to: OPS, from: 'gotham:batman', type: 'task', subject: 'check in',
      payload, traceId: 'trace-1',
    })
    const [lease] = await store.claim(filter([OPS]))
    expect(lease?.message).toEqual({ id, to: OPS, from: 'gotham:batman', type: 'task', subject: 'check in', payload, traceId: 'trace-1' })
    expect(lease?.claimedAt).toBe(1_000_000)
    await store.settle(lease!.leaseRef, { state: 'done', result: { deliveredAt: 1_000_500, messageId: id } })
    store.close()
  })

  it('omits absent optional fields instead of delivering undefined placeholders', async () => {
    const { clock } = fakeClock()
    const store = storeWith(clock)
    const id = await store.publish({ to: OPS, from: 'gotham:alfred' })
    expect(id).toBeTruthy()
    const [lease] = await store.claim(filter([OPS]))
    expect(lease?.message.id).toBe(id)
    for (const key of ['type', 'subject', 'payload', 'traceId'] as const) {
      expect(key in (lease?.message ?? {})).toBe(false)
    }
    store.close()
  })

  it('round-trips a blocking mark through publish and claim', async () => {
    const { clock } = fakeClock()
    const store = storeWith(clock)
    await store.publish({ to: OPS, from: 'gotham:batman', blocking: true })
    const [lease] = await store.claim(filter([OPS]))
    expect(lease?.message.blocking).toBe(true)
    store.close()
  })

  it('stores no blocking column value unless the sender marked itself blocked', async () => {
    const { clock } = fakeClock()
    const path = tempDbPath()
    const store = storeWith(clock, path)
    const explicitFalse = await store.publish({ to: OPS, from: 'gotham:alfred', blocking: false })
    const silent = await store.publish({ to: OPS, from: 'gotham:cane' })
    const leases = await store.claim(filter([OPS]))
    for (const lease of leases) {
      expect('blocking' in lease.message).toBe(false)
    }
    // Both unmarked encodings land as an exact NULL column value.
    const db = new DatabaseSync(path)
    try {
      for (const id of [explicitFalse, silent]) {
        const row = db.prepare('SELECT blocking FROM messages WHERE id = ?').get(id) as { blocking: number | null }
        expect(row.blocking).toBeNull()
      }
    } finally {
      db.close()
    }
    store.close()
  })

  it('scopes claims to the requested addresses only', async () => {
    const { clock } = fakeClock()
    const store = storeWith(clock)
    const fieldId = await store.publish({ to: FIELD, from: 'gotham:alfred' })
    const [lease] = await store.claim(filter([OPS]))
    expect(lease).toBeUndefined()
    const [fieldLease] = await store.claim(filter([FIELD]))
    expect(fieldLease?.message.id).toBe(fieldId)
    store.close()
  })

  it('never returns more leases than the filter limit', async () => {
    const { clock } = fakeClock()
    const store = storeWith(clock)
    for (let i = 0; i < 3; i++) await store.publish({ to: OPS, from: 'gotham:alfred', subject: `m${i}` })
    const first = await store.claim(filter([OPS], 2))
    expect(first).toHaveLength(2)
    expect(new Set(first.map(lease => lease.message.id)).size).toBe(2)
    const second = await store.claim(filter([OPS], 5))
    expect(second).toHaveLength(1)
    expect(await store.claim(filter([OPS]))).toHaveLength(0)
    // A non-positive limit claims nothing rather than flipping SQLite's
    // negative-LIMIT-means-unbounded reading into an unbounded batch.
    await store.publish({ to: OPS, from: 'gotham:alfred', subject: 'held' })
    expect(await store.claim(filter([OPS], 0))).toHaveLength(0)
    store.close()
  })

  it('reclaims a stale lease with a fresh ref and orphans the dead one', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    const id = await store.publish({ to: OPS, from: 'gotham:alfred' })
    const [first] = await store.claim(filter([OPS]))
    expect(first?.message.id).toBe(id)
    // Held leases are invisible until their age provably passes the bound…
    advance(29_999)
    expect(await store.claim(filter([OPS]))).toHaveLength(0)
    // …then the same message comes back under a NEW claim token.
    advance(1)
    const [second] = await store.claim(filter([OPS]))
    expect(second?.message.id).toBe(id)
    expect(second?.leaseRef).not.toBe(first?.leaseRef)
    await expect(store.settle(first!.leaseRef, { state: 'done', result: { deliveredAt: 9, messageId: id } }))
      .rejects.toThrow(/reclaimed/)
    await store.settle(second!.leaseRef, { state: 'done', result: { deliveredAt: 9, messageId: id } })
    store.close()
  })

  it('defers a pending outcome back to the claimable queue', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    const id = await store.publish({ to: OPS, from: 'gotham:alfred' })
    const [lease] = await store.claim(filter([OPS]))
    advance(5)
    await store.settle(lease!.leaseRef, { state: 'pending', result: undefined })
    // Deferred without waiting out any staleness window: the row left
    // `claimed` entirely, so the next cycle sees it as fresh pending again.
    const [again] = await store.claim(filter([OPS]))
    expect(again?.message.id).toBe(id)
    await store.settle(again!.leaseRef, { state: 'done', result: { deliveredAt: 20, messageId: id } })
    expect(await store.claim(filter([OPS]))).toHaveLength(0)
    store.close()
  })

  it('isolates a foreign malformed-payload row and keeps its batch siblings deliverable', async () => {
    const { clock } = fakeClock()
    const path = tempDbPath()
    const store = storeWith(clock, path)
    const goodA = await store.publish({ to: OPS, from: 'guest:x', subject: 'a' })
    // Hand-write a poisoned row exactly like an external writer could.
    const raw = new DatabaseSync(path)
    raw.prepare(
      "INSERT INTO messages (id, to_address, from_address, payload, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    ).run('poison-1', OPS, 'guest:x', '{"broken"', clock())
    raw.close()
    const goodB = await store.publish({ to: OPS, from: 'guest:x', subject: 'b' })

    const leases = await store.claim(filter([OPS]))
    expect(leases).toHaveLength(2)
    expect(new Set(leases.map(lease => lease.message.id))).toEqual(new Set([goodA, goodB]))

    const after = new DatabaseSync(path)
    const poison = after.prepare('SELECT state, result FROM messages WHERE id = ?').get('poison-1') as { state: string; result: string }
    after.close()
    expect(poison.state).toBe('failed')
    expect(JSON.parse(poison.result)).toEqual({ reason: 'malformed-payload' })
    // The batch is not wedged: a follow-up cycle finds nothing stuck behind it.
    expect(await store.claim(filter([OPS]))).toHaveLength(0)
    store.close()
  })

  it('keeps a failed settlement terminal and unclaimable', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    const id = await store.publish({ to: OPS, from: 'gotham:alfred' })
    const [lease] = await store.claim(filter([OPS]))
    await store.settle(lease!.leaseRef, { state: 'failed', result: { reason: 'unknown-address' } })
    advance(1_000_000)
    expect(await store.claim(filter([OPS]))).toHaveLength(0)
    expect(id).toBeTruthy()
    store.close()
  })
})

describe('settlement rejection', () => {
  it('throws on unknown, malformed, double, and mismatched settlements', async () => {
    const { clock } = fakeClock()
    const store = storeWith(clock)
    const id = await store.publish({ to: OPS, from: 'gotham:alfred' })
    await expect(store.settle('not-a-ref' as never, { state: 'pending', result: undefined })).rejects.toThrow(/lease ref/)
    await expect(store.settle(`${id}:` as never, { state: 'pending', result: undefined })).rejects.toThrow(/lease ref/)
    await expect(store.settle(`stranger:${id}` as never, { state: 'pending', result: undefined })).rejects.toThrow(/rejected/)
    const [lease] = await store.claim(filter([OPS]))
    await expect(store.settle(lease!.leaseRef, { state: 'done', result: { deliveredAt: 1, messageId: 'other-id' as never } }))
      .rejects.toThrow(/names message other-id/)
    await store.settle(lease!.leaseRef, { state: 'done', result: { deliveredAt: 1, messageId: id } })
    await expect(store.settle(lease!.leaseRef, { state: 'pending', result: undefined })).rejects.toThrow(/already settled/)
    store.close()
  })
})

describe('service mounting', () => {
  it('registers provider "local" on ctx.mailbox and proves disposal removes it', async () => {
    const ctx = new Context()
    await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
    const fiber = await ctx.plugin(MailboxLocal, { path: ':memory:' })
    expect(ctx.mailbox.getProvider('local')).toBeInstanceOf(SqliteMailboxStore)
    // The default-provider convenience rides the full seam path — grammar
    // validation plus resolution onto this store — not just direct calls.
    const id = await ctx.mailbox.publish({ to: OPS, from: 'gotham:alfred' })
    expect(id).toBeTruthy()
    await fiber.dispose()
    expect(ctx.mailbox.getProvider('local')).toBeUndefined()
  })
})

describe('claimableAddresses', () => {
  it('lists addresses with pending work, sorted, and drops them once claimed', async () => {
    const store = storeWith(fakeClock().clock)
    await store.publish({ to: FIELD, from: 'gotham:alfred' })
    await store.publish({ to: OPS, from: 'gotham:alfred' })
    await expect(store.claimableAddresses({ staleClaimMs: 30_000 })).resolves.toEqual([FIELD, OPS])
    await store.claim(filter([OPS]))
    await expect(store.claimableAddresses({ staleClaimMs: 30_000 })).resolves.toEqual([FIELD])
    store.close()
  })

  it('counts a stale-claimed row as claimable but not a fresh claim', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    await store.publish({ to: OPS, from: 'gotham:alfred' })
    await store.claim(filter([OPS]))
    await expect(store.claimableAddresses({ staleClaimMs: 30_000 })).resolves.toEqual([])
    advance(31_000)
    await expect(store.claimableAddresses({ staleClaimMs: 30_000 })).resolves.toEqual([OPS])
    store.close()
  })

  it('returns nothing for an empty store', async () => {
    const store = storeWith(fakeClock().clock)
    await expect(store.claimableAddresses({ staleClaimMs: 30_000 })).resolves.toEqual([])
    store.close()
  })
})

describe('config resolution', () => {
  it('defaults to the harness home, resolves configured paths absolutely, keeps the memory sentinel, rejects blanks', () => {
    expect(resolveMailboxPath()).toMatch(/mailbox[/\\]mailbox\.db$/)
    expect(resolveMailboxPath('data/mail.db')).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/)
    expect(resolveMailboxPath(':memory:')).toBe(':memory:')
    expect(() => resolveMailboxPath('   ')).toThrow('non-empty')
  })
})

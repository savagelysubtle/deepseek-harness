/**
 * Store behavior of the SQLite mailbox provider: schema-version gating,
 * publish/claim/settle leasing semantics, and the service's registry mount
 * and disposal.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MailboxAddress, MailboxClaimFilter } from '@deepseek-ai/dsh-mailbox'
import { formatMailboxAddress, MailboxRegistry } from '@deepseek-ai/dsh-mailbox'
import MailboxLocal, { openLocalMailbox, resolveMailboxPath, SCHEMA_VERSION } from '../src/index.ts'
import { openMailboxDatabase, SqliteMailboxStore } from '../src/sqlite.ts'
import type { MailboxClock } from '../src/types.ts'

// Lets one test inject a deterministic non-EEXIST failure from `openSync`
// (e.g. EACCES) without depending on real OS permission checks, which a
// root-running test process can bypass entirely — same `...actual`
// passthrough + hoisted toggle-flag pattern as subprocess-local's
// spawn.spec.ts and memory-local's fault-injection suite.
const { failNextOpenCode } = vi.hoisted(() => ({ failNextOpenCode: { value: undefined as string | undefined } }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync(
      path: Parameters<typeof actual.openSync>[0],
      flags: Parameters<typeof actual.openSync>[1],
      mode?: Parameters<typeof actual.openSync>[2],
    ) {
      const code = failNextOpenCode.value
      if (code !== undefined) {
        failNextOpenCode.value = undefined
        throw Object.assign(new Error(`simulated ${code} on open`), { code })
      }
      return actual.openSync(path, flags, mode)
    },
  }
})

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

const OPS = formatMailboxAddress('operations')
const FIELD = formatMailboxAddress('field')

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

  it('rejects a mailbox_meta table with no readable schema version stamp', () => {
    const path = tempDbPath()
    openMailboxDatabase(path).close()
    const db = new DatabaseSync(path)
    // The table itself is a real mailbox_meta table (distinct from the
    // no-table case above), just missing the one row this check reads.
    db.prepare('DELETE FROM mailbox_meta WHERE key = ?').run('schema_version')
    db.close()
    expect(() => openMailboxDatabase(path)).toThrow('has no readable schema version stamp')
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
    expect(lease?.message).toEqual({ id, to: OPS, from: 'gotham:batman', sentAt: 1_000_000, type: 'task', subject: 'check in', payload, traceId: 'trace-1' })
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

  it('dates a claimed message by its publish-time sentAt, not the claim moment', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    await store.publish({ to: OPS, from: 'gotham:batman', subject: 'sat queued' })
    // The message sits queued well past its admission, so a claim-time stamp
    // would misdate it to the reader.
    advance(5_000)
    const [lease] = await store.claim(filter([OPS]))
    expect(lease?.message.sentAt).toBe(1_000_000)
    expect(lease?.claimedAt).toBe(1_005_000)
    store.close()
  })

  it('keeps the original sentAt across a stale-lease reclaim', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    await store.publish({ to: OPS, from: 'gotham:alfred' })
    await store.claim(filter([OPS]))
    advance(31_000)
    const [reclaimed] = await store.claim(filter([OPS]))
    expect(reclaimed?.message.sentAt).toBe(1_000_000)
    expect(reclaimed?.claimedAt).toBe(1_031_000)
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

  it('rejects publish with the real Error a circular payload throws, instead of wrapping it', async () => {
    const store = storeWith(fakeClock().clock)
    // JSON.stringify throws a genuine TypeError on a circular structure,
    // synchronously, before any write happens — the `error instanceof Error`
    // TRUE side of publish's catch, distinct from the abort tests below
    // (which reject with a non-Error reason and take the wrapping branch).
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    await expect(store.publish({ to: OPS, from: 'gotham:alfred', payload: circular }))
      .rejects.toThrow(/circular/i)
    store.close()
  })

  it('skips both a malformed and a well-formed row when their claim UPDATE matches nothing, as if raced away', async () => {
    // SQLite's own locking (BEGIN IMMEDIATE) makes a real lost race between
    // this transaction's SELECT and its claim UPDATE unreachable in a
    // single-process test, so the "changes !== 1" defensive branches are
    // exercised here against a stub connection instead of a timing-based
    // race — per the house rule against flaky race-shaped tests.
    const rows = [
      { id: 'poison-1', to_address: OPS, from_address: 'guest:x', type: null, subject: null, payload: '{"broken"', trace_id: null, blocking: null, created_at: 1_000_000 },
      { id: 'good-1', to_address: OPS, from_address: 'guest:x', type: null, subject: null, payload: null, trace_id: null, blocking: null, created_at: 1_000_000 },
    ]
    const raceStub = {
      exec: () => {},
      prepare: (sql: string) => {
        if (sql.includes('SELECT id, to_address')) return { all: () => rows }
        if (sql.includes('SET state = \'claimed\'')) return { run: () => ({ changes: 0 }) }
        throw new Error(`unexpected prepare in race stub: ${sql}`)
      },
    }
    const store = new SqliteMailboxStore(raceStub as unknown as DatabaseSync, fakeClock().clock)
    await expect(store.claim(filter([OPS]))).resolves.toEqual([])
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
  it('rejects a settle outcome state outside the known union as unreachable', async () => {
    // TypeScript's own exhaustiveness check (`const unreachable: never =
    // outcome`) guards this at compile time; a caller that bypasses the type
    // (an external, non-TypeScript caller, or a bug upstream) reaches it at
    // runtime instead, which this proves rejects loud rather than silently
    // falling through.
    const { clock } = fakeClock()
    const store = storeWith(clock)
    const id = await store.publish({ to: OPS, from: 'gotham:alfred' })
    const [lease] = await store.claim(filter([OPS]))
    expect(id).toBeTruthy()
    await expect(store.settle(lease!.leaseRef, { state: 'bogus', result: undefined } as never))
      .rejects.toThrow(/unreachable mailbox outcome/)
    store.close()
  })

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

describe('openLocalMailbox / createDatabaseFile', () => {
  it('propagates a non-EEXIST failure reserving the database file, instead of swallowing it as a first-writer race', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-local-'))
    dirs.push(dir)
    const path = join(dir, 'mailbox.db')
    // EACCES (permission denied) is a real, distinct failure the EEXIST
    // swallow must never absorb — injected directly so the assertion holds
    // regardless of whether this process happens to run as root.
    failNextOpenCode.value = 'EACCES'
    expect(() => openLocalMailbox(path)).toThrow(/EACCES/)
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

describe('lookupByTraceId', () => {
  it('returns one entry per stored message carrying the traceId, earliest send first', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    const question = await store.publish({ to: OPS, from: 'gotham:batman', traceId: 'trace-1', subject: 'question' })
    advance(10)
    const answer = await store.publish({ to: FIELD, from: 'gotham:operations', traceId: 'trace-1', subject: 'answer' })
    await store.publish({ to: OPS, from: 'gotham:cane', traceId: 'trace-2' })
    await expect(store.lookupByTraceId('trace-1')).resolves.toEqual([
      { id: question, from: 'gotham:batman', to: OPS, sentAt: 1_000_000, state: 'pending', subject: 'question' },
      { id: answer, from: 'gotham:operations', to: FIELD, sentAt: 1_000_010, state: 'pending', subject: 'answer' },
    ])
    await expect(store.lookupByTraceId('unknown-trace')).resolves.toEqual([])
    store.close()
  })

  it('projects the content fields a reader acts on without a second claim', async () => {
    const { clock } = fakeClock()
    const store = storeWith(clock)
    const id = await store.publish({
      to: OPS, from: 'gotham:batman', traceId: 'trace-1', subject: 'status', payload: { ok: true }, blocking: true,
    })
    const [lease] = await store.claim(filter([OPS]))
    // Mid-flight, the row reports its claim time — the moment another
    // consumer took it — alongside the content a waiter returns as the reply.
    await expect(store.lookupByTraceId('trace-1')).resolves.toEqual([
      {
        id, from: 'gotham:batman', to: OPS, sentAt: 1_000_000, state: 'claimed',
        subject: 'status', payload: { ok: true }, blocking: true, claimedAt: 1_000_000,
      },
    ])
    await store.settle(lease!.leaseRef, { state: 'done', result: { deliveredAt: 1_000_005, messageId: id } })
    // Settled, the claim is released (its lease is spent) and the delivery
    // admission is what dates the row for a reader.
    await expect(store.lookupByTraceId('trace-1')).resolves.toEqual([
      {
        id, from: 'gotham:batman', to: OPS, sentAt: 1_000_000, state: 'done',
        subject: 'status', payload: { ok: true }, blocking: true, deliveredAt: 1_000_005,
      },
    ])
    store.close()
  })

  it('degrades an unreadable stored payload to no payload instead of failing the read', async () => {
    const { clock } = fakeClock()
    const path = tempDbPath()
    const store = storeWith(clock, path)
    const id = await store.publish({ to: OPS, from: 'gotham:batman', traceId: 'trace-1', subject: 'status', payload: 'fine' })
    const db = new DatabaseSync(path)
    try {
      db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run('not-json{', id)
    } finally {
      db.close()
    }
    await expect(store.lookupByTraceId('trace-1')).resolves.toEqual([
      { id, from: 'gotham:batman', to: OPS, sentAt: 1_000_000, state: 'pending', subject: 'status' },
    ])
    store.close()
  })

  it('projects a refused row\'s reason, so a waiting sender need not wait out its deadline', async () => {
    const { clock } = fakeClock()
    const store = storeWith(clock)
    const id = await store.publish({ to: OPS, from: 'gotham:alfred', traceId: 'trace-refused' })
    const [lease] = await store.claim(filter([OPS]))
    await store.settle(lease!.leaseRef, { state: 'failed', result: { reason: 'org-registry-denied: no edge' } })
    // The reason is the whole point: a sender awaiting a reply to a message
    // that was REFUSED must learn that immediately rather than blocking until
    // its deadline expires on an answer that can never come.
    await expect(store.lookupByTraceId('trace-refused')).resolves.toEqual([
      { id, from: 'gotham:alfred', to: OPS, sentAt: 1_000_000, state: 'failed', failureReason: 'org-registry-denied: no edge' },
    ])
    store.close()
  })

  it('degrades a settlement envelope that is unreadable, non-object, or missing its expected field, instead of failing the read', async () => {
    const { clock } = fakeClock()
    const path = tempDbPath()
    const store = storeWith(clock, path)
    const invalidJson = await store.publish({ to: OPS, from: 'gotham:alfred', traceId: 'trace-bad-json' })
    const nonObject = await store.publish({ to: OPS, from: 'gotham:alfred', traceId: 'trace-non-object' })
    const doneNoDeliveredAt = await store.publish({ to: OPS, from: 'gotham:alfred', traceId: 'trace-done-no-deliveredat' })
    const failedNoReason = await store.publish({ to: OPS, from: 'gotham:alfred', traceId: 'trace-failed-no-reason' })
    const pendingWithLeftoverResult = await store.publish({ to: OPS, from: 'gotham:alfred', traceId: 'trace-pending-leftover' })

    const db = new DatabaseSync(path)
    try {
      db.prepare('UPDATE messages SET state = \'done\', result = ? WHERE id = ?').run('not-json{', invalidJson)
      db.prepare('UPDATE messages SET state = \'done\', result = ? WHERE id = ?').run('42', nonObject)
      db.prepare('UPDATE messages SET state = \'done\', result = ? WHERE id = ?')
        .run(JSON.stringify({ messageId: doneNoDeliveredAt }), doneNoDeliveredAt)
      db.prepare('UPDATE messages SET state = \'failed\', result = ? WHERE id = ?').run('{}', failedNoReason)
      // Back to 'pending' but still carrying a leftover result value —
      // unreachable through settle() itself (its own 'pending' case always
      // clears result to NULL) — simulating a hand-edited or
      // pre-migration row instead.
      db.prepare('UPDATE messages SET state = \'pending\', result = ? WHERE id = ?')
        .run(JSON.stringify({ deliveredAt: 1 }), pendingWithLeftoverResult)
    } finally {
      db.close()
    }

    await expect(store.lookupByTraceId('trace-bad-json')).resolves.toEqual([
      { id: invalidJson, from: 'gotham:alfred', to: OPS, sentAt: 1_000_000, state: 'done' },
    ])
    await expect(store.lookupByTraceId('trace-non-object')).resolves.toEqual([
      { id: nonObject, from: 'gotham:alfred', to: OPS, sentAt: 1_000_000, state: 'done' },
    ])
    await expect(store.lookupByTraceId('trace-done-no-deliveredat')).resolves.toEqual([
      { id: doneNoDeliveredAt, from: 'gotham:alfred', to: OPS, sentAt: 1_000_000, state: 'done' },
    ])
    await expect(store.lookupByTraceId('trace-failed-no-reason')).resolves.toEqual([
      { id: failedNoReason, from: 'gotham:alfred', to: OPS, sentAt: 1_000_000, state: 'failed' },
    ])
    await expect(store.lookupByTraceId('trace-pending-leftover')).resolves.toEqual([
      { id: pendingWithLeftoverResult, from: 'gotham:alfred', to: OPS, sentAt: 1_000_000, state: 'pending' },
    ])
    store.close()
  })

  it('reads terminal rows and leaves both pending and settled rows untouched', async () => {
    const { clock } = fakeClock()
    const path = tempDbPath()
    const store = storeWith(clock, path)
    const id = await store.publish({ to: OPS, from: 'gotham:alfred', traceId: 'trace-1' })
    // The lookup is a pure read: the pending row survives for the next claim,
    // and reports the lifecycle state it is actually in.
    await expect(store.lookupByTraceId('trace-1')).resolves.toEqual([
      { id, from: 'gotham:alfred', to: OPS, sentAt: 1_000_000, state: 'pending' },
    ])
    const [lease] = await store.claim(filter([OPS]))
    expect(lease?.message.id).toBe(id)
    await store.settle(lease!.leaseRef, { state: 'done', result: { deliveredAt: 5, messageId: id } })
    // Settled messages stay readable — the reply-direction evidence outlives
    // the delivery — and the settlement is undisturbed. The terminal envelope
    // is projected too: `deliveredAt` is what lets a waiting sender tell
    // "never picked up" from "delivered, still no answer".
    await expect(store.lookupByTraceId('trace-1')).resolves.toEqual([
      { id, from: 'gotham:alfred', to: OPS, sentAt: 1_000_000, state: 'done', deliveredAt: 5 },
    ])
    const db = new DatabaseSync(path)
    try {
      const row = db.prepare('SELECT state, claim_token FROM messages WHERE id = ?').get(id) as { state: string; claim_token: string | null }
      expect(row.state).toBe('done')
      expect(row.claim_token).toBeNull()
    } finally {
      db.close()
    }
    store.close()
  })
})

describe('lookupInboundSince', () => {
  it('returns every state addressed to the scan target admitted at or after the floor, earliest first', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    const before = await store.publish({ to: OPS, from: 'gotham:robin', subject: 'older' })
    advance(10)
    const atFloor = await store.publish({ to: OPS, from: 'gotham:batman', subject: 'at the floor' })
    advance(10)
    const after = await store.publish({ to: OPS, from: 'gotham:batman', subject: 'after' })
    advance(10)
    const elsewhere = await store.publish({ to: FIELD, from: 'gotham:batman', subject: 'not mine' })
    expect(elsewhere).toBeDefined()
    // The floor is inclusive: mail admitted exactly at `sinceMs` counts, so a
    // waiter anchored on its awaited send's admission time cannot skip a reply
    // admitted in the same millisecond. Clock times: `before` at 1_000_000,
    // `atFloor` at 1_000_010, `after` at 1_000_020, `elsewhere` at 1_000_030.
    const [leaseBefore] = await store.claim(filter([OPS], 1))
    await store.settle(leaseBefore!.leaseRef, { state: 'done', result: { deliveredAt: clock(), messageId: leaseBefore!.message.id! } })
    await expect(store.lookupInboundSince(OPS, 1_000_010)).resolves.toEqual([
      { id: atFloor, from: 'gotham:batman', to: OPS, sentAt: 1_000_010, state: 'pending', subject: 'at the floor' },
      { id: after, from: 'gotham:batman', to: OPS, sentAt: 1_000_020, state: 'pending', subject: 'after' },
    ])
    // A floor at the first row's admission still includes it, and the
    // delivered row reads in whatever state it is in — the scan is the read
    // half of reply detection, not a second queue.
    await expect(store.lookupInboundSince(OPS, 1_000_000)).resolves.toEqual([
      { id: before, from: 'gotham:robin', to: OPS, sentAt: 1_000_000, state: 'done', subject: 'older', deliveredAt: expect.any(Number) as unknown },
      { id: atFloor, from: 'gotham:batman', to: OPS, sentAt: 1_000_010, state: 'pending', subject: 'at the floor' },
      { id: after, from: 'gotham:batman', to: OPS, sentAt: 1_000_020, state: 'pending', subject: 'after' },
    ])
    store.close()
  })

  it('returns nothing when no row for the address reaches the floor', async () => {
    const { clock, advance } = fakeClock()
    const store = storeWith(clock)
    await store.publish({ to: OPS, from: 'gotham:robin' })
    advance(10)
    await expect(store.lookupInboundSince(OPS, 1_000_050)).resolves.toEqual([])
    store.close()
  })
})

describe('abort handling and rejection normalization', () => {
  // publish, settle, claimableAddresses, lookupByTraceId, and lookupInboundSince
  // are plain (non-`async`) methods that read `signal?.throwIfAborted()` before
  // any work, then fold whatever the synchronous body throws into a rejection
  // via `error instanceof Error ? error : new Error(String(error))`. An
  // already-aborted signal's reason is exactly such a synchronous throw, and
  // `throwIfAborted()` throws the reason value itself (not an Error) when the
  // caller aborted with a non-Error reason.
  it('rejects publish with the aborted reason instead of throwing synchronously', async () => {
    const store = storeWith(fakeClock().clock)
    const controller = new AbortController()
    controller.abort('plain reason')
    await expect(store.publish({ to: OPS, from: 'gotham:alfred' }, controller.signal))
      .rejects.toThrow('plain reason')
    store.close()
  })

  it('rejects settle with the aborted reason instead of throwing synchronously', async () => {
    const store = storeWith(fakeClock().clock)
    const controller = new AbortController()
    controller.abort('plain reason')
    await expect(store.settle('irrelevant:token' as never, { state: 'pending', result: undefined }, controller.signal))
      .rejects.toThrow('plain reason')
    store.close()
  })

  it('rejects claimableAddresses with the aborted reason instead of throwing synchronously', async () => {
    const store = storeWith(fakeClock().clock)
    const controller = new AbortController()
    controller.abort('plain reason')
    await expect(store.claimableAddresses({ staleClaimMs: 30_000 }, controller.signal))
      .rejects.toThrow('plain reason')
    store.close()
  })

  it('rejects lookupByTraceId with the aborted reason instead of throwing synchronously', async () => {
    const store = storeWith(fakeClock().clock)
    const controller = new AbortController()
    controller.abort('plain reason')
    await expect(store.lookupByTraceId('trace-1', controller.signal))
      .rejects.toThrow('plain reason')
    store.close()
  })

  it('rejects lookupInboundSince with the aborted reason instead of throwing synchronously', async () => {
    const store = storeWith(fakeClock().clock)
    const controller = new AbortController()
    controller.abort('plain reason')
    await expect(store.lookupInboundSince(OPS, 0, controller.signal))
      .rejects.toThrow('plain reason')
    store.close()
  })

  // `claim` is the fifth method the SQL surface exposes, but it stayed
  // `async claim(...)` in the lint cleanup (see sqlite.ts) rather than moving
  // to the plain-method-plus-explicit-Promise shape the other five took, so
  // its rejection path is not this normalization branch and is out of scope
  // here.

  it('rejects claimableAddresses, lookupByTraceId, and lookupInboundSince with the real Error a closed handle throws', async () => {
    // A closed DatabaseSync's own prepare() throws a genuine Error
    // ("database is not open"), synchronously — the `error instanceof Error`
    // TRUE side of each method's catch, distinct from the plain-reason abort
    // tests above (which take the wrapping branch instead).
    const store = storeWith(fakeClock().clock)
    store.close()
    await expect(store.claimableAddresses({ staleClaimMs: 30_000 })).rejects.toThrow('database is not open')
    await expect(store.lookupByTraceId('trace-1')).rejects.toThrow('database is not open')
    await expect(store.lookupInboundSince(OPS, 0)).rejects.toThrow('database is not open')
  })

  it('returns a rejected promise rather than throwing synchronously on a validation failure', async () => {
    // Distinct from the abort cases above: this proves the general
    // try/catch-to-rejection shape holds for ANY synchronous throw in the
    // body, not only ones sourced from an aborted signal. `store.settle(...)`
    // itself must not throw before returning its promise — the `expect(() =>
    // ...).not.toThrow()` below is what proves that, separately from the
    // rejection assertion that follows.
    const store = storeWith(fakeClock().clock)
    let pending: Promise<void> | undefined
    expect(() => {
      pending = store.settle('not-a-ref' as never, { state: 'pending', result: undefined })
    }).not.toThrow()
    await expect(pending).rejects.toThrow(/lease ref/)
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

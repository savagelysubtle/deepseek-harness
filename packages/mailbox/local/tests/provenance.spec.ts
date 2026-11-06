/**
 * Provenance storage of the SQLite mailbox provider: the nullable `tainted`
 * and `chain` columns round-trip with absent meaning "not asserted", the
 * forward-only v3 to v4 migration, malformed stored chains, and the CLI view.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import * as cli from '../src/cli.ts'
import { openMailboxDatabase, SCHEMA_VERSION, SqliteMailboxStore } from '../src/sqlite.ts'

const TARGET = formatMailboxAddress('target')
const FILTER = { addresses: [TARGET], limit: 10, staleClaimMs: 30_000 }

let dirs: string[] = []
const originalStdout = cli.internals.stdout

afterEach(() => {
  cli.internals.stdout = originalStdout
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-prov-'))
  dirs.push(dir)
  return dir
}

describe('provenance columns', () => {
  it('round-trips tainted true, tainted false and a chain; absent stays absent', async () => {
    const store = new SqliteMailboxStore(openMailboxDatabase(join(tempDir(), 'm.db')))
    await store.publish({ to: TARGET, from: 'a', subject: 'set', tainted: true, chain: ['x', 'seat'] })
    await store.publish({ to: TARGET, from: 'a', subject: 'clean', tainted: false, chain: [] })
    await store.publish({ to: TARGET, from: 'a', subject: 'bare' })
    const bySubject = new Map((await store.claim(FILTER)).map(lease => [lease.message.subject, lease.message]))
    expect(bySubject.get('set')).toMatchObject({ tainted: true, chain: ['x', 'seat'] })
    expect(bySubject.get('clean')).toMatchObject({ tainted: false, chain: [] })
    const bare = bySubject.get('bare')!
    expect('tainted' in bare).toBe(false)
    expect('chain' in bare).toBe(false)
    store.close()
  })

  it('isolates a row whose stored chain is not a string array, without failing its siblings', async () => {
    const path = join(tempDir(), 'm.db')
    const db = openMailboxDatabase(path)
    const store = new SqliteMailboxStore(db)
    await store.publish({ to: TARGET, from: 'a', subject: 'good' })
    await store.publish({ to: TARGET, from: 'a', subject: 'bad' })
    db.prepare("UPDATE messages SET chain = '[1]' WHERE subject = 'bad'").run()
    const leases = await store.claim(FILTER)
    expect(leases.map(lease => lease.message.subject)).toEqual(['good'])
    store.close()
  })

  it('migrates a v3 database forward in place and reads its old rows as absent', async () => {
    const path = join(tempDir(), 'old.db')
    const fresh = openMailboxDatabase(path)
    // Rebuild the exact v3 shape: no provenance columns, version stamp 3.
    fresh.exec('ALTER TABLE messages DROP COLUMN tainted')
    fresh.exec('ALTER TABLE messages DROP COLUMN chain')
    fresh.prepare('UPDATE mailbox_meta SET value = ? WHERE key = ?').run('3', 'schema_version')
    fresh.prepare(
      "INSERT INTO messages (id, to_address, from_address, subject, state, created_at) VALUES ('old-1', ?, 'a', 'legacy', 'pending', 1)",
    ).run(TARGET)
    fresh.close()

    const migrated = openMailboxDatabase(path)
    const stamp = migrated.prepare('SELECT value FROM mailbox_meta WHERE key = ?').get('schema_version') as { value: string }
    expect(stamp.value).toBe(String(SCHEMA_VERSION))
    const store = new SqliteMailboxStore(migrated)
    await store.publish({ to: TARGET, from: 'a', subject: 'new', tainted: true })
    const bySubject = new Map((await store.claim(FILTER)).map(lease => [lease.message.subject, lease.message]))
    expect('tainted' in bySubject.get('legacy')!).toBe(false)
    expect('chain' in bySubject.get('legacy')!).toBe(false)
    expect(bySubject.get('new')?.tainted).toBe(true)
    store.close()
  })

  it('reopening an already-migrated v4 file is a no-op and stays v4', async () => {
    const path = join(tempDir(), 'v4.db')
    const first = openMailboxDatabase(path)
    await new SqliteMailboxStore(first).publish({ to: TARGET, from: 'a', tainted: true })
    first.close()
    const second = openMailboxDatabase(path)
    const stamp = second.prepare('SELECT value FROM mailbox_meta WHERE key = ?').get('schema_version') as { value: string }
    expect(stamp.value).toBe('4')
    expect((await new SqliteMailboxStore(second).claim(FILTER))[0]?.message.tainted).toBe(true)
    second.close()
  })

  it('rejects a non-boolean tainted or a non-string-array chain at publish', async () => {
    const store = new SqliteMailboxStore(openMailboxDatabase(join(tempDir(), 'm.db')))
    await expect(store.publish({ to: TARGET, from: 'a', tainted: 'yes' as never })).rejects.toThrow('tainted must be a boolean')
    await expect(store.publish({ to: TARGET, from: 'a', chain: 'x' as never })).rejects.toThrow('chain must be an array of strings')
    await expect(store.publish({ to: TARGET, from: 'a', chain: [1] as never })).rejects.toThrow('chain must be an array of strings')
    expect(await store.claim(FILTER)).toEqual([])
    store.close()
  })

  it('still rejects an older-than-v3 database loud', () => {
    const path = join(tempDir(), 'v2.db')
    openMailboxDatabase(path).close()
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE mailbox_meta SET value = ? WHERE key = ?').run('2', 'schema_version')
    raw.close()
    expect(() => openMailboxDatabase(path)).toThrow(`incompatible with this build (${SCHEMA_VERSION})`)
  })
})

describe('CLI provenance view', () => {
  async function inboxJson(db: string): Promise<Record<string, unknown>[]> {
    let captured = ''
    cli.internals.stdout = { write: (chunk: string) => { captured += chunk; return true } }
    expect(await cli.runMailboxCli(['inbox', '--address', TARGET, '--db', db, '--json'])).toBe(0)
    return JSON.parse(captured) as Record<string, unknown>[]
  }

  it('carries tainted and chain through toEntry, and a guest send never sets them', async () => {
    const dir = tempDir()
    const db = join(dir, 'm.db')
    const store = new SqliteMailboxStore(openMailboxDatabase(db))
    await store.publish({ to: TARGET, from: 'seat', subject: 'flagged', tainted: true, chain: ['seat'] })
    await store.publish({ to: TARGET, from: 'seat', subject: 'explicit-clean', tainted: false, chain: [] })
    store.close()
    cli.internals.stdout = { write: () => true }
    expect(await cli.runMailboxCli(['send', '--to', TARGET, '--from', 'me', '--subject', 'guest', '--db', db])).toBe(0)
    const entries = await inboxJson(db)
    const bySubject = new Map(entries.map(entry => [entry['subject'], entry]))
    expect(bySubject.get('flagged')).toMatchObject({ tainted: true, chain: ['seat'] })
    expect(bySubject.get('explicit-clean')).toMatchObject({ tainted: false, chain: [] })
    const guest = bySubject.get('guest')!
    expect('tainted' in guest).toBe(false)
    expect('chain' in guest).toBe(false)
  })
})

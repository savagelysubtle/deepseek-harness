/**
 * The SQLite mailbox store: schema ownership (a version-stamped `mailbox_meta`
 * table), the open step that rejects foreign and newer files loud, and the
 * {@link SqliteMailboxStore} implementing the `MailboxProvider` contract over
 * `node:sqlite`.
 *
 * A claim runs as one `BEGIN IMMEDIATE` transaction whose guarded UPDATE
 * admits exactly one winner per message (`changes === 1`); settlement matches
 * the lease's claim token, so a stale-reclaimed lease can never settle a
 * successor's delivery, and a settled terminal row is immutable to its dead ref.
 *
 * @module @deepseek-ai/dsh-mailbox-local/sqlite
 */

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  MailboxClaimFilter, MailboxLease, MailboxLeaseRef, MailboxMessage,
  MailboxMessageId, MailboxOutcome, MailboxProvider,
} from '@deepseek-ai/dsh-mailbox'
import type { MailboxClock, MessageRow } from './types.ts'

/**
 * On-disk schema version of the mailbox database. Monotonic: an open against
 * a file stamped with any other version — newer or older — rejects loud
 * instead of migrating in place.
 */
export const SCHEMA_VERSION = 1

/** Meta-table key stamping {@link SCHEMA_VERSION}. */
const SCHEMA_VERSION_KEY = 'schema_version'

/** Registry-unique provider name this store registers under on `ctx.mailbox`. */
export const PROVIDER_NAME = 'local'

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mailbox_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    to_address   TEXT NOT NULL,
    from_address TEXT NOT NULL,
    type         TEXT,
    subject      TEXT,
    payload      TEXT,
    trace_id     TEXT,
    state        TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'done', 'failed')),
    created_at   INTEGER NOT NULL,
    claimed_at   INTEGER,
    claim_token  TEXT,
    settle_state TEXT CHECK (settle_state IN ('done', 'failed')),
    result       TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS messages_claim_scan ON messages (state, to_address, created_at)
`

/**
 * Open a mailbox database and ensure its schema. An empty file (or absent
 * path, which SQLite creates) initializes at {@link SCHEMA_VERSION}; a
 * non-empty file must already be a mailbox store stamped at exactly this
 * build's version, else the open fails naming the mismatch.
 * @param path - the SQLite database file to open (`:memory:` for tests).
 * @returns the open handle with all tables and indexes ensured.
 */
export function openMailboxDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec('BEGIN IMMEDIATE')
    let began = true
    try {
      const { count } = db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
      ).get() as { count: number }
      if (count === 0) {
        db.exec(CREATE_SCHEMA)
        db.prepare('INSERT INTO mailbox_meta (key, value) VALUES (?, ?)').run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION))
      } else {
        assertCompatibleSchema(db, path)
      }
      db.exec('COMMIT')
      began = false
    } finally {
      /* v8 ignore start -- rollback only runs when a schema rejection races a
         second SQLite failure, unreachable against real files in tests. */
      if (began) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // The original schema failure remains the actionable cause.
        }
      }
      /* v8 ignore stop */
    }
  } catch (error: unknown) {
    db.close()
    throw error
  }
  // Fixed WAL: the store's contract is concurrent multi-process claimers on a
  // local disk. Rollback-journal fallbacks for network mounts stay deferred
  // until a deployment needs them (see README Known Limitations).
  db.exec('PRAGMA journal_mode = WAL')
  return db
}

/**
 * Verify an existing database is a mailbox store stamped at this build's
 * schema version. Runs inside the open transaction, so no other connection
 * can change ownership between inspection and commit.
 * @param db - the handle opened on the suspect file.
 * @param path - the file path, for error messages.
 */
function assertCompatibleSchema(db: DatabaseSync, path: string): void {
  const table = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'mailbox_meta'",
  ).get()
  if (table === undefined) {
    throw new Error(`mailbox database at "${path}" is not a mailbox store: no mailbox_meta table`)
  }
  const row = db.prepare('SELECT value FROM mailbox_meta WHERE key = ?').get(SCHEMA_VERSION_KEY) as
    | { value: string }
    | undefined
  if (row === undefined || !/^\d+$/.test(row.value)) {
    throw new Error(`mailbox database at "${path}" has no readable schema version stamp`)
  }
  if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(`mailbox database at "${path}" has schema version ${row.value}, incompatible with this build (${SCHEMA_VERSION})`)
  }
}

/** Columns a claim needs to rebuild the message; kept narrow on purpose. */
type ClaimRow = Pick<MessageRow, 'id' | 'to_address' | 'from_address' | 'type' | 'subject' | 'payload' | 'trace_id'>

/**
 * Reconstruct a {@link MailboxMessage} from a claim-selected row. `NULL`
 * optional columns map back to omitted fields rather than present-`undefined`
 * ones.
 * @param row - the row selected by {@link SqliteMailboxStore.claim}.
 * @returns the delivered message with its durable id.
 */
function rowToMessage(row: ClaimRow): MailboxMessage {
  return {
    id: row.id as MailboxMessageId,
    to: row.to_address as MailboxMessage['to'],
    from: row.from_address,
    ...row.type !== null ? { type: row.type } : {},
    ...row.subject !== null ? { subject: row.subject } : {},
    ...row.payload !== null ? { payload: JSON.parse(row.payload) as unknown } : {},
    ...row.trace_id !== null ? { traceId: row.trace_id } : {},
  }
}

/**
 * Compose one lease ref: `<message id>:<claim token>`. Both halves are UUIDs
 * without colons, so the split is unambiguous; the token makes refs issued
 * before a stale reclaim fail their later settlement predicate.
 * @param id - the leased message's durable id.
 * @param token - this claim's fresh random token.
 * @returns the branded settlement handle.
 */
function formatLeaseRef(id: string, token: string): MailboxLeaseRef {
  return `${id}:${token}` as MailboxLeaseRef
}

/**
 * Split a lease ref into its verification halves.
 * @param leaseRef - the ref received from a claiming call.
 * @returns the message id and claim token it names.
 * @throws when the ref carries no `<id>:<token>` structure at all.
 */
function parseLeaseRef(leaseRef: MailboxLeaseRef): { id: string; token: string } {
  const separatorAt = leaseRef.indexOf(':')
  if (separatorAt <= 0 || separatorAt === leaseRef.length - 1) {
    throw new Error(`unknown mailbox lease ref ${JSON.stringify(leaseRef)}: expected "<message id>:<claim token>"`)
  }
  return { id: leaseRef.slice(0, separatorAt), token: leaseRef.slice(separatorAt + 1) }
}

/**
 * The SQLite {@link MailboxProvider}: every durability and exclusivity
 * guarantee lives in the SQL operations below. One instance owns exactly one
 * `DatabaseSync`; instances are cheap enough that each plugin mount opens its
 * own.
 */
export class SqliteMailboxStore implements MailboxProvider {
  readonly name = PROVIDER_NAME

  /**
   * @param db - an open handle from {@link openMailboxDatabase}; closed by {@link close}.
   * @param clock - epoch-millisecond source for timestamps and staleness cutoffs; defaults to `Date.now`.
   */
  constructor(private readonly db: DatabaseSync, private readonly clock: MailboxClock = Date.now) {}

  async publish(message: Omit<MailboxMessage, 'id'>, signal?: AbortSignal): Promise<MailboxMessageId> {
    signal?.throwIfAborted()
    const id = randomUUID() as MailboxMessageId
    // JSON.stringify throws on circular payloads before any write happens, so
    // a non-serializable body never lands half-stored.
    const payload = message.payload === undefined ? null : JSON.stringify(message.payload)
    this.db.prepare(`
      INSERT INTO messages (id, to_address, from_address, type, subject, payload, trace_id, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      message.to,
      message.from,
      message.type ?? null,
      message.subject ?? null,
      payload,
      message.traceId ?? null,
      this.clock(),
    )
    return id
  }

  async claim(filter: MailboxClaimFilter, signal?: AbortSignal): Promise<readonly MailboxLease[]> {
    signal?.throwIfAborted()
    // A non-positive limit claims nothing: SQLite reads a negative LIMIT as
    // unbounded, which would silently invert the batch bound.
    if (!(filter.limit > 0) || filter.addresses.length === 0) return []
    const now = this.clock()
    const cutoff = now - filter.staleClaimMs
    const placeholders = filter.addresses.map(() => '?').join(', ')
    this.db.exec('BEGIN IMMEDIATE')
    let began = true
    try {
      const rows = this.db.prepare(`
        SELECT id, to_address, from_address, type, subject, payload, trace_id
        FROM messages
        WHERE to_address IN (${placeholders})
          AND (state = 'pending' OR (state = 'claimed' AND claimed_at <= ?))
        ORDER BY created_at
        LIMIT ?
      `).all(...filter.addresses, cutoff, filter.limit) as unknown as ClaimRow[]
      const claim = this.db.prepare(`
        UPDATE messages
        SET state = 'claimed', claimed_at = ?, claim_token = ?
        WHERE id = ? AND (state = 'pending' OR (state = 'claimed' AND claimed_at <= ?))
      `)
      const leases: MailboxLease[] = []
      for (const row of rows) {
        const token = randomUUID()
        if (claim.run(now, token, row.id, cutoff).changes !== 1) continue
        leases.push({ message: rowToMessage(row), leaseRef: formatLeaseRef(row.id, token), claimedAt: now })
      }
      this.db.exec('COMMIT')
      began = false
      return leases
    } finally {
      /* v8 ignore start -- reached only when a claim SQL statement fails
         mid-transaction; SQLite offers no deterministic in-test failure. */
      if (began) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // COMMIT already ended the transaction, or its failure is the one propagated above.
        }
      }
      /* v8 ignore stop */
    }
  }

  async settle(leaseRef: MailboxLease['leaseRef'], outcome: MailboxOutcome, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const { id, token } = parseLeaseRef(leaseRef)
    let updateSql: string
    let updateParams: readonly (string | null)[]
    switch (outcome.state) {
      case 'done': {
        if (outcome.result.messageId !== id) {
          throw new Error(`mailbox settlement names message ${outcome.result.messageId}, but the lease belongs to "${id}"`)
        }
        updateSql = 'UPDATE messages SET state = \'done\', settle_state = \'done\', result = ?, claimed_at = NULL, claim_token = NULL'
        updateParams = [JSON.stringify({ deliveredAt: outcome.result.deliveredAt, messageId: outcome.result.messageId })]
        break
      }
      case 'failed': {
        updateSql = 'UPDATE messages SET state = \'failed\', settle_state = \'failed\', result = ?, claimed_at = NULL, claim_token = NULL'
        updateParams = [JSON.stringify({ reason: outcome.result.reason })]
        break
      }
      case 'pending': {
        updateSql = 'UPDATE messages SET state = \'pending\', settle_state = NULL, result = NULL, claimed_at = NULL, claim_token = NULL'
        updateParams = []
        break
      }
      default: {
        const unreachable: never = outcome
        throw new Error(`unreachable mailbox outcome ${JSON.stringify(unreachable)}`)
      }
    }
    const changes = this.db.prepare(`${updateSql} WHERE id = ? AND claim_token = ? AND state = 'claimed'`)
      .run(...updateParams, id, token).changes
    if (changes !== 1) {
      throw new Error(`mailbox settlement rejected: the lease for message "${id}" is unknown, already settled, or was reclaimed after going stale`)
    }
  }

  /** Release the database handle; the store is unusable afterwards. */
  close(): void {
    this.db.close()
  }
}

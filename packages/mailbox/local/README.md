# @deepseek-ai/dsh-mailbox-local

English | [中文](README.zh.md)

The local mailbox provider: one SQLite database file (over `node:sqlite`'s `DatabaseSync`) hosts every address's queue behind the [`@deepseek-ai/dsh-mailbox`](../mailbox/README.md) seam. It registers as provider `local` on `ctx.mailbox`, enforces single-winner claims inside SQLite transactions, reclaims abandoned leases after `staleClaimMs`, and rejects foreign or newer-versioned database files at open instead of migrating in place.

## Provider API

| Operation | Semantics |
|---|---|
| `publish(message)` | Assigns a fresh durable id and stores the message as `pending`; non-serializable payloads throw before any write. |
| `claim(filter)` | One `BEGIN IMMEDIATE` transaction selects up to `filter.limit` pending-or-stale rows across `filter.addresses` and flips each winner with a guarded UPDATE (`changes === 1`); every lease ref embeds a fresh claim token. |
| `settle(leaseRef, outcome)` | Writes the terminal outcome or defers back to `pending`, guarded by the claim token; unknown, already-settled, stale-reclaimed, and mismatched-message settlements throw. |
| `close()` | Releases the database handle; the mounted disposer calls it after unregistering. |

## Contracts

- **Single winner per claim** — the immediate transaction plus the conditional update means concurrent claimers of one message observe exactly one winner; losers see it gone from their candidate set.
- **At-least-once delivery** — a lease held longer than `filter.staleClaimMs` becomes claimable again under a NEW claim token, so the old ref can never settle a successor's delivery. Consumers tolerate duplicate claims.
- **`done` stores the admission envelope verbatim** — `{ deliveredAt, messageId }` where `messageId` must equal the leased row's id; settlement records inbox admission only, never business results.
- **Schema ownership is loud** — `mailbox_meta.schema_version` must equal this build's monotonic version; an empty file initializes at v1, any other non-mailbox file or version rejects the open (and therefore the plugin mount).

## Config

| Field | Type | Default | Semantics |
|---|---|---|---|
| `path` | string? | `<dsh home>/mailbox/mailbox.db` | Database file location. Missing directories and files are created owner-only; existing file modes are preserved. The value `:memory:` opens an in-process database (tests). |

## Model Experience

### Delivered mailbox messages

#### What the model sees

The store contributes no live prompt, schema, or request mutation. Message content reaches a model only when a consumer delivers it — typically the mailbox bridge rendering a claimed message as a user turn carrying its own provenance kind (`{ kind: 'mailbox' }`). Payload bodies pass through this store as opaque JSON bytes behind the seam's optional `payload` field; their meaning is owned entirely by sender and receiver.

#### Token effect

Zero direct token effect: storage adds nothing to any model request.

#### KV Cache effect

Independent: reading or writing the queue never touches a request prefix. Any cache behavior belongs to the surface that renders delivered messages.

## Known Limitations and Deferred Work

- **No busy-handling or retry** — contended multi-process claims surface SQLite `SQLITE_BUSY` errors immediately rather than blocking; drain-loop pacing and retries belong to consumers (the planned mailbox bridge).
- **Journal mode fixed to WAL** — network-mounted filesystems where WAL's shared-memory files do not work have no rollback-journal fallback here; the session and storage backends expose `journalMode` config if a deployment proves the need.
- **Composition coverage deferred to the bridge slice** — real-composition tests booting this provider through the Loader arrive with the mailbox bridge (plan PR-E), per the testing policy for product-visible plugins.

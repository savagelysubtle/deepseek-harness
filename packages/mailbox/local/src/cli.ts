/**
 * The `dsh-mailbox` CLI: guest access to the mailbox store when no harness is
 * running — the bootstrap case outside council exists for. It writes and
 * drains through the SAME SQLite store and owner-only open sequence as the
 * plugin mount, version-locked to `SCHEMA_VERSION` by living inside this
 * package.
 *
 * Two commands: `send` publishes one message; `inbox` claims a batch against
 * one address and settles each receipt (`--peek` defers back to `pending`
 * instead, reading without consuming). Machine-readable output rides
 * `--json`; errors go to stderr with a non-zero exit.
 *
 * The CLI is the outside-operator GUEST channel, so `send` stamps its sender
 * `guest:<original>` unconditionally — the caller cannot suppress the prefix,
 * and a stamped sender never matches a roster seat. In-process seats send
 * through the mailbox tools instead, whose sender is the trusted session
 * name; this path exists for the operator standing outside the harness.
 *
 * Built as its own bundle and declared in `package.json` `bin`; runs under
 * plain Node with no host up (precedent: `dsh-mcp-client-auth`).
 *
 * @module @deepseek-ai/dsh-mailbox-local/cli
 */

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import type { MailboxMessageId } from '@deepseek-ai/dsh-mailbox'
import { openLocalMailbox, resolveMailboxPath } from './index.ts'
import type { MailboxMessage } from '@deepseek-ai/dsh-mailbox'
import { SqliteMailboxStore } from './sqlite.ts'

/** Batch bound of one `inbox` drain when `--limit` is absent. */
export const INBOX_DEFAULT_LIMIT = 20

/** Prefix stamped onto every `send` sender; see {@link guestSender}. */
export const GUEST_SENDER_PREFIX = 'guest:'

/**
 * Stamp the outside-operator sender. The CLI is the guest bootstrap path, so
 * whatever the caller passes under `--from` is stored as
 * `guest:<original>` — the prefix cannot be suppressed and cannot be
 * pre-satisfied by already-prefixed input. A stamped sender never matches a
 * roster seat, so the receiving end renders it `unverified`.
 * @param original - the `--from` value the caller supplied.
 * @returns the stored sender text.
 */
export function guestSender(original: string): string {
  return `${GUEST_SENDER_PREFIX}${original}`
}

/**
 * Staleness bound applied while claiming, aligned in value with the bridge's
 * `DEFAULT_STALE_CLAIM_MS` so a guest crash between claim and settle reclaims
 * on the same clock a bridge crash would.
 */
export const INBOX_STALE_CLAIM_MS = 60_000

/** Process-facing effects of one invocation: the two output streams the runner writes to. */
interface MailboxCliIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/** Output sinks the runner writes to; tests substitute captures. */
export const internals: MailboxCliIo = { stdout: process.stdout, stderr: process.stderr }

/** Parsed arguments of one `send` invocation. */
interface SendArgs {
  readonly command: 'send'
  readonly to: string
  /** The original `--from` value; stored stamped as `guest:<from>` ({@link guestSender}). */
  readonly from: string
  readonly type?: string
  readonly subject?: string
  /** Parsed payload body when one was supplied. */
  readonly payload?: unknown
  readonly traceId?: string
  readonly db?: string
  readonly json: boolean
}

/** Parsed arguments of one `inbox` invocation. */
interface InboxArgs {
  readonly command: 'inbox'
  readonly address: string
  readonly limit: number
  readonly peek: boolean
  readonly db?: string
  readonly json: boolean
}

/** Either subcommand's arguments. */
type CliArgs = SendArgs | InboxArgs

/**
 * Parse `--flag value` argv entries after the subcommand. Unknown flags,
 * missing values, and both payload sources at once fail loud.
 * @param argv - raw argv entries after the script path.
 * @returns the parsed arguments.
 */
function parseArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv
  if (command !== 'send' && command !== 'inbox') {
    throw new Error(
      'usage: dsh-mailbox <send|inbox> [flags] — send always stores its sender as "guest:<--from>";'
      + ' see the @deepseek-ai/dsh-mailbox-local README',
    )
  }
  const values = new Map<string, string>()
  const valueFlags = new Set(['--to', '--from', '--type', '--subject', '--payload-file', '--trace-id', '--address', '--limit', '--db'])
  const bareFlags = new Set(['--payload-stdin', '--peek', '--json'])
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === undefined) break
    if (bareFlags.has(arg)) {
      values.set(arg, 'true')
      continue
    }
    if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}`)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    values.set(arg, value)
    i += 1
  }
  const db = values.get('--db')
  const dbField = db !== undefined ? { db } : {}
  const json = values.has('--json')
  if (command === 'send') {
    const to = requireFlag(values, '--to')
    const from = requireFlag(values, '--from')
    // Loud before any write: an unroutable address would otherwise sit in the
    // store forever invisible — the bridge only polices its own roster. The
    // `--from` value is the original provenance; the stored sender gains the
    // guest prefix at publish ({@link guestSender}).
    parseMailboxAddress(to)
    parseMailboxAddress(from)
    return {
      command,
      to,
      from,
      ...spreadOpt(values, '--type'),
      ...spreadOpt(values, '--subject'),
      ...spreadPayload(values),
      ...spreadOpt(values, '--trace-id'),
      ...dbField,
      json,
    }
  }
  const address = requireFlag(values, '--address')
  parseMailboxAddress(address)
  const rawLimit = values.get('--limit')
  const limit = rawLimit === undefined ? INBOX_DEFAULT_LIMIT : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer, received ${JSON.stringify(rawLimit)}`)
  }
  return { command, address, limit, peek: values.has('--peek'), ...dbField, json }
}

/** Read one required flag or throw naming it. */
function requireFlag(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)
  if (value === undefined) throw new Error(`missing required flag ${flag}`)
  return value
}

/** Build the conditional single-field object for one optional string flag. */
function spreadOpt(values: Map<string, string>, flag: string): Record<string, string> {
  const value = values.get(flag)
  return value !== undefined ? { [keyOf(flag)]: value } : {}
}

/** Map an argv flag onto its argument name (`--trace-id` → `traceId`). */
function keyOf(flag: string): string {
  const names: Record<string, string> = {
    '--type': 'type',
    '--subject': 'subject',
    '--payload-file': 'payloadFile',
    '--trace-id': 'traceId',
  }
  const name = names[flag]
  if (name === undefined) throw new Error(`internal error: unmapped flag ${flag}`)
  return name
}

/**
 * Load the message payload from `--payload-file` or stdin, exactly once.
 * JSON parses here so an unserializable body fails before anything is written.
 * @param values - parsed flag map.
 * @returns `{ payload }` when a source was given, else an empty object.
 */
function spreadPayload(values: Map<string, string>): { payload: unknown } | Record<string, never> {
  const file = values.get('--payload-file')
  const stdin = values.has('--payload-stdin')
  if (!file && !stdin) return {}
  if (file !== undefined && stdin) throw new Error('pass either --payload-file or --payload-stdin, not both')
  // Node exposes piped stdin as fd 0 regardless of TTY state.
  const text = file !== undefined ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
  return { payload: JSON.parse(text) as unknown }
}

/** One machine-readable inbox entry. */
interface InboxEntryView {
  readonly messageId: string
  readonly from: string
  /** Present only when the sender marked itself blocked waiting for an answer. */
  readonly blocking?: true
  readonly type?: string
  readonly subject?: string
  readonly payload?: unknown
  readonly traceId?: string
  readonly claimedAt: number
}

/** Project one lease's message onto its wire view; absent fields stay omitted. */
function toEntry(lease: MailboxLeaseView): InboxEntryView {
  const { id, from, type, subject, payload, traceId } = lease.message
  if (id === undefined) throw new Error(`claimed message from "${from}" has no provider id`)
  return {
    messageId: id,
    from,
    ...lease.message.blocking === true ? { blocking: true as const } : {},
    ...type !== undefined ? { type } : {},
    ...subject !== undefined ? { subject } : {},
    ...payload !== undefined ? { payload } : {},
    ...traceId !== undefined ? { traceId } : {},
    claimedAt: lease.claimedAt,
  }
}

/** Structural slice of {@link MailboxLease} the renderer needs. */
interface MailboxLeaseView {
  readonly message: MailboxMessage
  readonly claimedAt: number
}

/** Emit human-readable blocks, one per entry. */
function printHuman(entries: readonly InboxEntryView[], io: typeof internals): void {
  if (entries.length === 0) {
    io.stdout.write('(empty)\n')
    return
  }
  for (const entry of entries) {
    io.stdout.write(
      [
        `id ${entry.messageId}`,
        `from ${entry.from}${entry.type !== undefined ? ` type ${entry.type}` : ''}${entry.subject !== undefined ? ` subject ${entry.subject}` : ''}`,
        entry.payload === undefined ? '' : typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload, null, 2),
      ].filter(line => line !== '').join('\n') + '\n\n',
    )
  }
}

/**
 * Run the CLI: parse, execute the subcommand against its store, close the
 * handle on every path. Exported so tests drive it in-process; executing this
 * module as a bin calls it with `process.argv`.
 * @param argv - flag entries in argv form (no script path).
 * @returns the process exit code (0 on success).
 */
export async function runMailboxCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  const path = resolveMailboxPath(args.db)
  const store = new SqliteMailboxStore(openLocalMailbox(path))
  try {
    if (args.command === 'send') {
      await store.publish({
        to: args.to as never,
        // Unconditional guest stamp: the CLI caller is outside the harness and
        // cannot claim a seat's identity, including by pre-prefixing.
        from: guestSender(args.from),
        ...args.type !== undefined ? { type: args.type } : {},
        ...args.subject !== undefined ? { subject: args.subject } : {},
        ...args.payload !== undefined ? { payload: args.payload } : {},
        ...args.traceId !== undefined ? { traceId: args.traceId } : {},
      })
      const body = args.json ? { stored: true, to: args.to } : `stored for ${args.to}`
      internals.stdout.write(`${args.json ? JSON.stringify(body) : String(body)}\n`)
      return 0
    }
    const leases = await store.claim({ addresses: [args.address as never], limit: args.limit, staleClaimMs: INBOX_STALE_CLAIM_MS })
    const pairs = leases.map(lease => ({ lease, entry: toEntry(lease) }))
    // Receipts first — exactly what the seam calls inbox admission; a crash
    // before this loop finishes reclaims through the staleness bound.
    for (const { lease, entry } of pairs) {
      const settle = args.peek
        ? store.settle(lease.leaseRef, { state: 'pending', result: undefined })
        : store.settle(lease.leaseRef, { state: 'done', result: { deliveredAt: Date.now(), messageId: entry.messageId as MailboxMessageId } })
      await settle
    }
    internals.stdout.write(args.json ? `${JSON.stringify(pairs.map(({ entry }) => entry))}\n` : '')
    if (!args.json) printHuman(pairs.map(({ entry }) => entry), internals)
    return 0
  } finally {
    store.close()
  }
}

/**
 * Whether one argv script path names THIS module, compared after resolving
 * both sides through the filesystem. `import.meta.url` is always fully
 * resolved, while `process.argv[1]` can carry a symlinked path — a bin shim,
 * a PATH entry into a linked install, or any indirection an operator's shell
 * puts in the way — and an unresolved comparison never matches, so the guard
 * would be false and the CLI would exit 0 having run nothing. A resolution
 * failure (the invoked path does not exist, or cannot be read) answers
 * `false`: a missing file cannot be this module's entry.
 * @param invokedPath - the `process.argv[1]` script path, unresolved.
 * @param entryUrl - this module's `import.meta.url`.
 * @returns whether the invoked path and this module are the same file.
 */
export function isEntryInvocation(invokedPath: string, entryUrl: string): boolean {
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(entryUrl))
  } catch {
    // ENOENT or an unreadable path: the invocation cannot be this module's
    // entry, and there is no fallback comparison that could still match.
    return false
  }
}

// Bin execution guard: run only when this file is the entry module, so an
// in-process import (tests) never starts a store session.
const invoked = process.argv[1] !== undefined
  && isEntryInvocation(process.argv[1], import.meta.url)
if (invoked) {
  runMailboxCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    internals.stderr.write(String(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  })
}

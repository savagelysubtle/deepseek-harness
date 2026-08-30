/**
 * The three model-facing mailbox tools. All carry the deployment-supplied
 * trusted session name and resolve their identity through
 * {@link resolveMailboxIdentity} inside `execute`: `mailbox_send` fills the
 * envelope's sender from it — the schema has no `from` to fill — and
 * `mailbox_check_inbox` and `mailbox_await` act on the calling seat's own
 * address, taking no address argument at all. A seat can address mail
 * anywhere but can only ever be itself.
 *
 * @module @deepseek-ai/dsh-tool-mailbox/tools
 */

import { randomUUID } from 'node:crypto'
import { parseMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import type { MailboxAddress, MailboxLease, MailboxMessageId, MailboxRegistry, MailboxTraceEntry } from '@deepseek-ai/dsh-mailbox'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveMailboxIdentity } from './identity.ts'
import type { IdentitySources } from './identity.ts'

/**
 * Batch bound of one `mailbox_check_inbox` drain. Aligned in value with the
 * `dsh-mailbox` CLI's `INBOX_DEFAULT_LIMIT` so a seat and the outside
 * operator drain the same amount per admission pass.
 */
export const CHECK_INBOX_DRAIN_LIMIT = 20

/**
 * Staleness bound applied while claiming, aligned in value with the CLI's
 * `INBOX_STALE_CLAIM_MS` and the bridge's `DEFAULT_STALE_CLAIM_MS`: a crashed
 * drainer's abandoned lease is reclaimable on one shared clock everywhere.
 */
export const CHECK_INBOX_STALE_CLAIM_MS = 60_000

/**
 * Deadline `mailbox_await` applies when the caller supplies none. Five
 * minutes covers the observed stall class — a peer seat stopped mid-reply —
 * with margin, while keeping one held turn short enough that a stopped seat
 * reclaims control quickly and a live seat keeps deciding between waits.
 */
export const AWAIT_DEFAULT_DEADLINE_MS = 300_000

/**
 * Shortest deadline `mailbox_await` accepts. Below one poll interval a wait
 * cannot observe a mid-wait arrival at all, so anything shorter is a
 * `mailbox_check_inbox` drain rather than a wait; the floor makes that
 * distinction real instead of accepting a deadline that can only return what
 * the first instant check already sees.
 */
export const AWAIT_MIN_DEADLINE_MS = 1_000

/**
 * Longest deadline `mailbox_await` accepts. One call is bounded so a seat
 * stays stoppable and every expiry returns control to the model; a longer
 * horizon is a re-await after each return, which keeps the decision with the
 * model instead of pinning the turn for an hour.
 */
export const AWAIT_MAX_DEADLINE_MS = 600_000

/**
 * How often `mailbox_await` re-reads the store while waiting. The reads are
 * two cheap local SQLite statements, and the interval — below the bridge's
 * own `DEFAULT_POLL_INTERVAL_MS` — bounds how late the wait can notice a
 * reply that landed just after a poll.
 */
export const AWAIT_POLL_INTERVAL_MS = 2_000

/** Canonical outcome of one sent message. */
export interface SendResult {
  /** Provider-assigned durable id of the stored message. */
  readonly messageId: string
  /** Destination address as published. */
  readonly to: string
  /** Sender address the runtime filled from the trusted session name. */
  readonly from: string
  /**
   * The correlation id stored on this send's row: a fresh id minted for an
   * ordinary send, or the awaited send's id when this send IS a threaded
   * reply (`replyToTraceId`). It is the handle `mailbox_await` correlates
   * on: the same id retrieves the row's later fate — delivered, or refused
   * with the recorded reason — so a wait can end on a refusal instead of
   * the full deadline, and a reply published under it is matched to the
   * wait that started it.
   */
  readonly traceId: string
}

/** One drained message in the tool's canonical output. */
export interface InboxEntry {
  /** Provider-assigned durable id of the delivered message. */
  readonly messageId: string
  /** Sender address as published; free-form provenance, never resolved. */
  readonly from: string
  /** Present only when the sender marked itself blocked waiting for an answer. */
  readonly blocking?: true
  /** The sender's subject line, when it supplied one. */
  readonly subject?: string
  /** The sender's body; non-string payloads render as their JSON text. */
  readonly body: string
  /** Epoch milliseconds at which this drain claimed the message. */
  readonly claimedAt: number
}

/** Canonical outcome of one inbox drain. */
export interface CheckInboxResult {
  /**
   * The drained messages, in claim order. Declared mutable to match the
   * output schema's inferred value type; the registry snapshots and freezes
   * the canonical value after the body returns.
   */
  readonly messages: InboxEntry[]
  /** Convenience count of {@link CheckInboxResult.messages}. */
  readonly count: number
}

/** How one `mailbox_await` call ended. */
export type MailboxAwaitOutcome = 'reply' | 'refused' | 'timeout'

/**
 * What the store could establish about the awaited send when the wait ended:
 * `delivered` (the recipient's row settled `done`), `claimed` (a drainer
 * holds it, delivery not yet settled), `pending` (never picked up), or
 * `unknown` (no correlation id supplied, or no row this seat sent carries
 * it).
 */
export type MailboxAwaitSentState = 'delivered' | 'claimed' | 'pending' | 'unknown'

/** Canonical outcome of one `mailbox_await` call. */
export interface MailboxAwaitResult {
  /** What ended the wait; the model branches on this, not on absence. */
  readonly outcome: MailboxAwaitOutcome
  /**
   * The drained messages when the wait ended on arrival, in claim order;
   * always present, empty on the other outcomes.
   */
  readonly messages: InboxEntry[]
  /** Convenience count of {@link MailboxAwaitResult.messages}. */
  readonly count: number
  /**
   * The terminal reason recorded on the refused send's row, verbatim;
   * present only on a `refused` outcome.
   */
  readonly refusalReason?: string
  /**
   * The awaited send's store-lifecycle state at wait end; present only on a
   * `timeout` outcome, whenever the store could be consulted about it.
   */
  readonly sentState?: MailboxAwaitSentState
  /**
   * Epoch milliseconds at which the awaited send reached its recipient's
   * queue; present only with a `delivered` {@link MailboxAwaitResult.sentState}.
   */
  readonly deliveredAt?: number
  /** Wall-clock milliseconds the wait actually held this turn. */
  readonly waitedMs: number
}

/**
 * Output schema of one drained message — the shape `mailbox_check_inbox` and
 * `mailbox_await` both return, declared once so the two tools cannot drift
 * on what a drained message looks like.
 */
const INBOX_ENTRY_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    from: { type: 'string', required: true },
    // The mark only ever travels as `true`, and the enum pins that so the
    // schema's inferred value type stays assignable to `InboxEntry` under
    // exactOptionalPropertyTypes.
    blocking: { type: 'boolean', enum: [true] },
    subject: { type: 'string' },
    body: { type: 'string', required: true },
    claimedAt: { type: 'integer', required: true },
  },
} as const

/** Project one claimed lease's payload onto its string body form. */
function bodyOf(lease: MailboxLease): string {
  const { payload } = lease.message
  if (payload === undefined) return ''
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
}

/** Project one claimed lease onto its canonical inbox entry. */
function toEntry(lease: MailboxLease): InboxEntry {
  const { id, from, subject, blocking } = lease.message
  if (id === undefined) {
    throw new Error(`mailbox_check_inbox: claimed message from "${from}" has no provider id and cannot be delivered`)
  }
  return {
    messageId: id,
    from,
    ...blocking === true ? { blocking: true as const } : {},
    ...subject !== undefined ? { subject } : {},
    body: bodyOf(lease),
    claimedAt: lease.claimedAt,
  }
}

/**
 * Project one read-detected row onto its canonical inbox entry — the shape
 * `mailbox_await` returns for a reply another consumer already claimed or
 * settled, where no lease exists to claim. The claim time falls back through
 * the row's delivery admission to its send time, so the field always carries
 * a real moment in the row's life rather than the read's own clock.
 * @param entry - the store row read by a trace lookup or inbound scan.
 * @returns the canonical inbox entry for that row.
 */
function toReadEntry(entry: MailboxTraceEntry): InboxEntry {
  const { payload } = entry
  return {
    messageId: entry.id,
    from: entry.from,
    ...entry.blocking === true ? { blocking: true as const } : {},
    ...entry.subject !== undefined ? { subject: entry.subject } : {},
    body: payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
    claimedAt: entry.claimedAt ?? entry.deliveredAt ?? entry.sentAt,
  }
}

/**
 * Fold the calling agent's session id into the mount-time identity inputs.
 * Kept as a function rather than a spread at each call site so the two tools
 * cannot drift on which sources they consider.
 * @param mounted - the deployment-supplied identity inputs.
 * @param agentSessionId - the calling agent's durable session id, when the
 *   call runs inside an agent loop.
 * @returns the complete input to {@link resolveMailboxIdentity}.
 */
function callerIdentity(mounted: IdentitySources, agentSessionId: string | undefined): IdentitySources {
  return { ...mounted, ...agentSessionId !== undefined ? { agentSessionId } : {} }
}

/**
 * Render drained entries the way `mailbox_check_inbox` numbers and joins
 * them, shared with `mailbox_await` so a reply reads identically no matter
 * which of the two tools drained it.
 * @param messages - the drained entries, in claim order.
 * @returns the joined model-facing text.
 */
function formatInboxEntries(messages: readonly InboxEntry[]): string {
  return messages.map((entry, index) => {
    const head = `${index + 1}. from ${entry.from}${entry.blocking === true ? ' [BLOCKING]' : ''}`
      + `${entry.subject !== undefined ? `: ${entry.subject}` : ''}`
    return entry.body === '' ? head : `${head}\n${entry.body}`
  }).join('\n\n')
}

/**
 * Build the `mailbox_send` tool: publish one message whose sender is the
 * trusted session name. The registry's `publish` validates the destination
 * address grammar; the stamped `from` needs no validation because it never
 * passes through the model.
 * @param mailbox - the mailbox registry whose default provider admits the message.
 * @param identity - the deployment's mount-time identity inputs; the calling
 *   agent's own session id is added per call.
 * @returns the registry-ready tool definition.
 */
export function mailboxSendTool(mailbox: MailboxRegistry, identity: IdentitySources) {
  return defineTool({
    name: 'mailbox_send',
    description: 'Send a mailbox message to another seat by its bare name. '
      + 'The sender is filled in by the runtime from this session\'s trusted name and cannot be chosen or changed — '
      + 'the recipient sees the message as coming from this seat. '
      + 'Replies travel as their own mailbox_send calls, not inside this one. '
      + 'When this message IS the reply the other seat is waiting for, pass the traceId its sender quoted as replyToTraceId: '
      + 'the reply then carries that correlation id, and the waiting seat\'s mailbox_await matches it instead of timing out. '
      + 'The result names a traceId: pass it to mailbox_await to hold this turn until the reply arrives or the deadline expires.',
    parameters: {
      to: {
        type: 'string',
        required: true,
        description: 'The recipient seat\'s bare name (for example "batman"). One name names one seat across the whole deployment.',
      },
      subject: {
        type: 'string',
        required: true,
        description: 'Short human-readable subject line.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The message text. Keep it self-contained: the recipient may read it without this conversation\'s context.',
      },
      blocking: {
        type: 'boolean',
        description: 'True when you are blocked waiting on an answer to this message and the recipient should handle it now; '
          + 'omit for ordinary mail the recipient can absorb at a natural gap.',
      },
      replyToTraceId: {
        type: 'string',
        description: 'The traceId of the message this reply answers — only when the sender asked you to reply while it waits '
          + '(its mail said so, or you know it is awaiting). Threads the reply onto that message\'s correlation chain so the '
          + 'waiting seat\'s mailbox_await recognizes your reply. Omit for ordinary replies and new threads.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
          to: { type: 'string', required: true },
          from: { type: 'string', required: true },
          traceId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Stored for ${value.to} as message ${value.messageId} (sender ${value.from}). `
          + `Reply may be awaited with mailbox_await traceId ${value.traceId}.`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Send mail to ${args.to}`,
      kind: 'other',
      rawInput: { to: args.to, subject: args.subject },
    }),
    async execute(args, exec) {
      const from = resolveMailboxIdentity(callerIdentity(identity, exec.agent?.id))
      // The branded boundary: the destination crosses into the seam here, so
      // the grammar check that admits it runs at this exact edge. The
      // registry re-validates by contract; this call gives the model the
      // grammar error with no intervening framing.
      const to = parseMailboxAddress(args.to)
      // A fresh correlation id per send — unless this send IS a threaded
      // reply: publishing it under the awaited send's id is what lets the
      // waiting seat's read-based detection match the reply to its wait, the
      // same threading the bounce path uses. Only the sender ever learns the
      // id, and it is what makes the send's later fate — delivered, or
      // refused with the recorded reason — retrievable for an await.
      const traceId = args.replyToTraceId ?? randomUUID()
      const messageId = await mailbox.publish({
        to,
        from,
        subject: args.subject,
        payload: args.body,
        traceId,
        ...args.blocking !== undefined ? { blocking: args.blocking } : {},
      }, exec.signal)
      const result: SendResult = { messageId, to, from, traceId }
      return result
    },
  })
}

/**
 * Build the `mailbox_check_inbox` tool: drain this seat's own address and
 * nothing else. The tool takes no address argument — the drained address IS
 * the trusted identity — so a seat cannot read another seat's mail by naming
 * it. Each claimed message settles as delivered (inbox admission); a crash
 * between claim and settle is reclaimed by the staleness bound.
 * @param mailbox - the mailbox registry whose default provider holds the queue.
 * @param identity - the deployment's mount-time identity inputs; the calling
 *   agent's own session id is added per call.
 * @returns the registry-ready tool definition.
 */
export function mailboxCheckInboxTool(mailbox: MailboxRegistry, identity: IdentitySources) {
  return defineTool({
    name: 'mailbox_check_inbox',
    description: 'Drain this seat\'s own mailbox: claim and deliver every pending message addressed to this seat. '
      + 'Takes no address argument — the runtime drains this session\'s own address, and only that one. '
      + 'Each returned message is removed from the pending queue (delivered); call it whenever you expect mail, '
      + 'for example after learning a coworker sent you something.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: INBOX_ENTRY_ITEM_SCHEMA,
          },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? 'Inbox empty — no pending mail for this seat.'
          : formatInboxEntries(value.messages),
      }],
    },
    presentCall: () => ({ card: 'generic', title: 'Check inbox', kind: 'other' }),
    async execute(_args, exec) {
      const own = resolveMailboxIdentity(callerIdentity(identity, exec.agent?.id))
      const leases = await mailbox.claim({
        addresses: [own],
        limit: CHECK_INBOX_DRAIN_LIMIT,
        staleClaimMs: CHECK_INBOX_STALE_CLAIM_MS,
      }, exec.signal)
      const pairs = leases.map(lease => ({ lease, entry: toEntry(lease) }))
      // Receipts first — exactly what the seam calls inbox admission; a crash
      // before this loop finishes reclaims through the staleness bound.
      for (const { lease, entry } of pairs) {
        await mailbox.settle(lease.leaseRef, {
          state: 'done',
          // `toEntry` already failed loud on a missing id, so the settlement
          // envelope always carries the provider-assigned id it names.
          result: { deliveredAt: Date.now(), messageId: entry.messageId as MailboxMessageId },
        }, exec.signal)
      }
      const messages = pairs.map(({ entry }) => entry)
      const result: CheckInboxResult = { messages, count: messages.length }
      return result
    },
  })
}

/**
 * Resolve a caller-supplied await deadline onto the documented range. An
 * absent value takes the default; anything outside the floor/ceiling is
 * clamped, not refused — a model that asks for a 1 ms or a 1-hour wait still
 * gets a working wait, and every result reports the wait it actually ran.
 * @param deadlineMs - the caller's requested deadline, when supplied.
 * @returns the effective deadline in milliseconds.
 */
export function clampAwaitDeadlineMs(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined) return AWAIT_DEFAULT_DEADLINE_MS
  return Math.min(Math.max(deadlineMs, AWAIT_MIN_DEADLINE_MS), AWAIT_MAX_DEADLINE_MS)
}

/**
 * Sleep one poll interval, ending early when the caller aborts. The rejection
 * carries the abort reason: the registry's cancellation contract, not the
 * wait, decides how a stopped seat's call is reported. The timer is cleared
 * on either exit, so an aborted wait leaves nothing scheduled behind.
 * @param ms - how long to sleep; never longer than the remaining deadline.
 * @param signal - the calling agent's cancellation signal.
 * @returns a promise that settles at the interval's end or on abort.
 */
function waitPollInterval(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    // Read here, not at function entry: a signal aborted LATER carries the
    // reason only once abort() ran, so an early read would reject `undefined`.
    const reason: unknown = signal.reason
    return Promise.reject(reason)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      const reason: unknown = signal.reason
      reject(reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read the one stored row this seat SENT under a correlation id. The lookup
 * returns every row carrying the id — this seat's send, a peer's reply that
 * shares it, a bounce — so the selection narrows by recorded sender, which
 * only a send from this address carries. Earliest-first matches the lookup's
 * own order; an id reused across sends is ambiguous by construction and
 * resolves to the first.
 * @param mailbox - the mailbox registry whose default provider holds the store.
 * @param traceId - the correlation id the caller is waiting on.
 * @param own - the calling seat's resolved address.
 * @param signal - caller cancellation owning the scan.
 * @returns the sent row, or undefined when no row this seat sent carries the id.
 */
async function pickSentRow(
  mailbox: MailboxRegistry,
  traceId: string,
  own: MailboxAddress,
  signal: AbortSignal,
): Promise<MailboxTraceEntry | undefined> {
  const entries = await mailbox.lookupByTraceId(traceId, signal)
  return entries.find(entry => entry.from === own)
}

/**
 * Project a sent row's store state onto the timeout result's diagnosis.
 * @param sent - the observed sent row, when a correlation id resolved to one.
 * @returns the state name a timeout result reports.
 */
function sentStateOf(sent: MailboxTraceEntry | undefined): MailboxAwaitSentState {
  if (sent === undefined) return 'unknown'
  switch (sent.state) {
    case 'done': return 'delivered'
    case 'claimed': return 'claimed'
    case 'pending': return 'pending'
    case 'failed':
      // A failed row ends the wait as a refusal in the same iteration that
      // observed it; a timeout never carries one.
      throw new Error('mailbox_await: a failed sent row is a refusal, never a timeout diagnosis')
  }
}

/**
 * Read-detect the rows that end a wait: mail addressed to this seat that
 * another consumer has already taken past the claimable states. The claim
 * fallback sees only `pending` (and stale-`claimed`) rows, while the bridge —
 * the normal delivery path — claims first, steers the reply into the waiting
 * seat's live turn, and settles `done`, so detection that only claimed would
 * deterministically lose every reply that lands faster than the awaiting
 * seat's own model round trip (measured 1.9 s reply against a 3.4 s await
 * start). The reads claim and settle nothing: a `done` row is already
 * delivered, and a fresh `claimed` row belongs to the consumer holding its
 * lease — returning its content here is the at-least-once seam property, the
 * same reply the bridge is steering as a turn.
 *
 * Correlation stays directional-first: a traced wait prefers rows carrying
 * its own trace id (a threaded reply, or a bounce), and falls back to any
 * inbound mail admitted since the awaited send — a reply the peer sent
 * without threading still ends the wait, at the documented cost that
 * unrelated mail does too. An untraced wait reads inbound mail since the
 * wait began, its documented "ends on any inbound mail" semantics.
 * @param mailbox - the mailbox registry whose default provider holds the store.
 * @param own - the calling seat's resolved address.
 * @param traceId - the correlation id the caller passed, when any.
 * @param sent - the awaited send's row, when the correlation id resolved to one.
 * @param startedAt - epoch milliseconds at which the wait began.
 * @param signal - caller cancellation owning the reads.
 * @returns the arrived rows ending the wait, earliest admission first; empty when nothing has arrived.
 */
async function detectArrivals(
  mailbox: MailboxRegistry,
  own: MailboxAddress,
  traceId: string | undefined,
  sent: MailboxTraceEntry | undefined,
  startedAt: number,
  signal: AbortSignal,
): Promise<readonly MailboxTraceEntry[]> {
  // Only rows past the claimable states end a wait here: a `pending` row is
  // the claim fallback's to deliver in this same iteration, and a `failed`
  // row addressed to this seat is the peer's refused send, not this wait's
  // answer. A fresh `claimed` row belongs to the consumer holding its lease;
  // reading its content is the at-least-once property, not a second claim.
  const arrived = (entry: MailboxTraceEntry): boolean => entry.state === 'done' || entry.state === 'claimed'
  if (traceId === undefined) {
    // No correlation id: the wait's own start is the only anchor, and only
    // mail admitted during the wait counts — older mail was delivered to
    // the seat before the wait and is the model's to reason about, not
    // this tool's to re-report.
    const inbound = await mailbox.lookupInboundSince(own, startedAt, signal)
    return inbound.filter(arrived)
  }
  const traced = await mailbox.lookupByTraceId(traceId, signal)
  // Threaded arrivals: rows carrying this trace id, addressed to this seat,
  // other than the awaited send itself — the sent row shares the id, and a
  // self-addressed send shares both directions, so it is excluded by id.
  const threaded = traced.filter(entry =>
    entry.to === own
    && (sent === undefined || entry.id !== sent.id)
    && arrived(entry))
  if (threaded.length > 0) return threaded
  // Unthreaded fallback: the peer replied without carrying the thread (or a
  // bounce was suppressed), so the trace lookup alone would time out on a
  // reply that exists. Any inbound mail admitted at or after the awaited
  // send ends the wait — read, never claimed, whatever consumer won the row.
  if (sent !== undefined) {
    const inbound = await mailbox.lookupInboundSince(own, sent.sentAt, signal)
    return inbound.filter(entry => entry.id !== sent.id && arrived(entry))
  }
  return []
}

/**
 * Build the `refused` outcome: the send's row is terminally failed, so no
 * reply can ever come and the known reason ends the wait immediately.
 * @param sent - the refused row.
 * @param waitedMs - wall-clock the wait held before the refusal was read.
 * @returns the canonical refused result.
 */
function refusedResult(sent: MailboxTraceEntry, waitedMs: number): MailboxAwaitResult {
  return {
    outcome: 'refused',
    messages: [],
    count: 0,
    refusalReason: sent.failureReason ?? 'refused: the recipient\'s row is terminally failed but recorded no reason',
    waitedMs,
  }
}

/**
 * Build the `timeout` outcome: an ordinary result the model reasons about,
 * carrying what the store could establish about the awaited send — delivered
 * (with the time), picked up but unsettled, never picked up, or untraceable.
 * @param sent - the last-observed sent row, when a correlation id resolved.
 * @param waitedMs - wall-clock the wait held before expiring.
 * @returns the canonical timeout result.
 */
function timeoutResult(sent: MailboxTraceEntry | undefined, waitedMs: number): MailboxAwaitResult {
  return {
    outcome: 'timeout',
    messages: [],
    count: 0,
    sentState: sentStateOf(sent),
    ...sent?.state === 'done' && sent.deliveredAt !== undefined ? { deliveredAt: sent.deliveredAt } : {},
    waitedMs,
  }
}

/**
 * Model-facing text of one await outcome. The reply form matches
 * `mailbox_check_inbox`'s rendering; the timeout form states what is known
 * about the awaited send, because "never delivered" and "delivered minutes
 * ago" demand different responses.
 * @param traceId - the correlation id the caller passed, when any.
 * @param value - the validated canonical result.
 * @returns the single text block's content.
 */
function renderAwaitOutcome(traceId: string | undefined, value: MailboxAwaitResult): string {
  switch (value.outcome) {
    case 'reply':
      return `Reply arrived after ${value.waitedMs} ms:\n\n${formatInboxEntries(value.messages)}`
    case 'refused':
      return `The awaited message was REFUSED — no reply is coming. Reason: ${value.refusalReason}. `
        + 'Handle the refused send instead of waiting.'
    case 'timeout': {
      // The trailing fallback covers an absent sentState — possible only on a
      // logged row from an older version — and never throws, because render
      // also runs on replay.
      switch (value.sentState) {
        case 'delivered':
          return `No reply within ${value.waitedMs} ms. The message WAS delivered to its recipient`
            + `${value.deliveredAt !== undefined ? ` at ${value.deliveredAt}` : ''} — it has your mail but has not answered. `
            + 'A timeout is a normal outcome: report the stall, re-await, or move on — do not retry blindly.'
        case 'claimed':
          return `No reply within ${value.waitedMs} ms. The message was picked up for delivery but is not yet confirmed `
            + 'delivered. A timeout is a normal outcome: report the stall, re-await, or move on — do not retry blindly.'
        case 'pending':
          return `No reply within ${value.waitedMs} ms. The message was NEVER picked up — it is still queued undelivered `
            + 'in the store. A timeout is a normal outcome: report the stall, re-await, or move on — do not retry blindly.'
        case 'unknown':
          return `No reply within ${value.waitedMs} ms. The sent message could not be traced`
            + `${traceId !== undefined ? ' — no row this seat sent carries the id' : ' — no traceId was supplied'}. `
            + 'A timeout is a normal outcome: report the stall, re-await, or move on — do not retry blindly.'
        default:
          return `No reply within ${value.waitedMs} ms, and the result carries no delivery diagnosis for the sent message. `
            + 'Check it with mailbox_check_inbox or re-await with the traceId.'
      }
    }
  }
}

/**
 * Build the `mailbox_await` tool: hold the calling turn until a matching
 * reply arrives, the awaited send is refused, or the deadline expires. The
 * wait polls the same store the other two tools use — never busy-looping —
 * and every deadline decision runs on this process's clock, never on a
 * caller-computed remaining budget. A refused send short-circuits the wait
 * with its recorded reason; a timeout is an ordinary result carrying whether
 * the send was ever delivered. The wait forwards `exec.signal` into every
 * store read and its sleeps, so a stopped seat reclaims control immediately.
 * @param mailbox - the mailbox registry whose default provider holds the queue.
 * @param identity - the deployment's mount-time identity inputs; the calling
 *   agent's own session id is added per call.
 * @returns the registry-ready tool definition.
 */
export function mailboxAwaitTool(mailbox: MailboxRegistry, identity: IdentitySources) {
  return defineTool({
    name: 'mailbox_await',
    description: 'Hold this turn until a reply arrives or the deadline expires — the wait primitive to call right after '
      + 'mailbox_send when you are blocked on an answer, instead of improvising a Bash sleep-poll loop that burns one turn '
      + 'per poll. Pass the traceId from that send\'s result to correlate the wait with that exact message: a refusal in '
      + 'transit ends the wait immediately with its reason (never wait out the deadline for a refused message), and a '
      + 'timeout states whether the message was delivered or never picked up. The wait recognizes a reply whether it was '
      + 'still queued or already delivered to this seat — but the reply only carries your traceId if the sender passed it '
      + 'as replyToTraceId on their mailbox_send, so say so when you ask for a reply. A timeout is a normal outcome — on '
      + 'one, report the stall, re-await, or move on rather than retrying blindly. Without a traceId the wait ends on any '
      + 'inbound mail for this seat. The deadline is clamped to 1000–600000 ms; default 300000 (5 minutes).',
    parameters: {
      deadlineMs: {
        type: 'integer',
        description: 'How long to hold this turn, in milliseconds; clamped to 1000–600000. Default 300000 (5 minutes).',
      },
      traceId: {
        type: 'string',
        description: 'The traceId mailbox_send returned for the message you are waiting on. Correlates the wait to that '
          + 'send: a refusal ends the wait immediately, a timeout reports the message\'s delivery state, and a reply '
          + 'threaded onto the id ends the wait with its content. '
          + 'Omit to end the wait on any inbound mail.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string', enum: ['reply', 'refused', 'timeout'], required: true },
          messages: { type: 'array', required: true, items: INBOX_ENTRY_ITEM_SCHEMA },
          count: { type: 'integer', required: true },
          refusalReason: { type: 'string' },
          sentState: { type: 'string', enum: ['delivered', 'claimed', 'pending', 'unknown'] },
          deliveredAt: { type: 'integer' },
          waitedMs: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderAwaitOutcome(args.traceId, value) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Await mailbox reply', kind: 'other' }),
    async execute(args, exec) {
      const own = resolveMailboxIdentity(callerIdentity(identity, exec.agent?.id))
      const startedAt = Date.now()
      const deadline = startedAt + clampAwaitDeadlineMs(args.deadlineMs)
      for (;;) {
        // Refusal first: a terminally failed send means no reply can ever
        // come, so the known outcome ends the wait immediately — even when
        // unrelated mail is queued behind it, which stays pending for the
        // next drain.
        const sent = args.traceId !== undefined
          ? await pickSentRow(mailbox, args.traceId, own, exec.signal)
          : undefined
        if (sent?.state === 'failed') return refusedResult(sent, Date.now() - startedAt)
        // Then read-detection: a reply the bridge already claimed, steered
        // as a turn, and settled done is invisible to the claim below, and
        // any reply faster than this seat's model round trip loses that race
        // deterministically. The reads see the row whatever consumer won it.
        const arrivals = await detectArrivals(mailbox, own, args.traceId, sent, startedAt, exec.signal)
        if (arrivals.length > 0) {
          const messages = arrivals.map(toReadEntry)
          const result: MailboxAwaitResult = {
            outcome: 'reply',
            messages,
            count: messages.length,
            waitedMs: Date.now() - startedAt,
          }
          return result
        }
        // Then the own-address queue, drained and settled exactly as
        // mailbox_check_inbox does — one claim, no duplicate delivery. The
        // reads above have already released anything the bridge took, so
        // what reaches this claim is mail still queued for a claimer.
        const leases = await mailbox.claim({
          addresses: [own],
          limit: CHECK_INBOX_DRAIN_LIMIT,
          staleClaimMs: CHECK_INBOX_STALE_CLAIM_MS,
        }, exec.signal)
        if (leases.length > 0) {
          const pairs = leases.map(lease => ({ lease, entry: toEntry(lease) }))
          for (const { lease, entry } of pairs) {
            await mailbox.settle(lease.leaseRef, {
              state: 'done',
              result: { deliveredAt: Date.now(), messageId: entry.messageId as MailboxMessageId },
            }, exec.signal)
          }
          const messages = pairs.map(({ entry }) => entry)
          const result: MailboxAwaitResult = {
            outcome: 'reply',
            messages,
            count: messages.length,
            waitedMs: Date.now() - startedAt,
          }
          return result
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) return timeoutResult(sent, Date.now() - startedAt)
        await waitPollInterval(Math.min(remaining, AWAIT_POLL_INTERVAL_MS), exec.signal)
      }
    },
  })
}

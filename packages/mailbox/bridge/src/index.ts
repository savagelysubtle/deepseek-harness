/**
 * The mailbox consumer: a polling bridge that turns claimed messages into
 * delivered user-role turns on the addressed named-session agents. Routing is
 * pure derivation — the address IS the session name, so no
 * directory lives here. One drain cycle claims up to `maxClaimPerCycle`
 * messages, admits each through the drain-time pipeline below, and routes
 * each admitted lease:
 *
 * Admission runs in order, and every refusal is terminal — the recipient's
 * row settles `failed` AND the sender gets a `bounce` naming the reason, so
 * a dropped message is never silent and never mysterious:
 *
 * 1. **Registry health** — a registry file that exists but will not load
 *    refuses the lease loud (`org-registry-unavailable`): a broken roster
 *    cannot prove any exchange boundary-safe, and silently permitting is the
 *    failure the `test: true` boundary exists to prevent. A MISSING registry
 *    file is a deployment without an org graph (the down-host CLI bootstrap
 *    world); the registry-dependent rules have nothing to judge and no-op.
 * 2. **The `test: true` boundary** — a seat marked `test: true` may only
 *    exchange mail with seats also marked, in either direction. The boundary
 *    outranks everything below it: the admission list, the edge list, and
 *    `callUp` (which would otherwise carry a call-up seat straight across).
 * 3. **Org topology** — seat-to-seat mail follows `orgRegistryAllows` (an
 *    edge between the pair, or the sender holding call-up); a refusal names
 *    the route `findOrgRegistryRoute` offers, so the sender is told the path
 *    it should have used.
 * 4. **Sender admission** — the served roster, `admitFrom`, and the
 *    `guest:`-prefixed outside-operator channel the CLI stamps.
 * 5. **Loop guards** — a message size cap, a per-address depth cap,
 *    identical-repeat suppression, and a per-`traceId` hop counter. Guards
 *    only, never a spend cap: they stop an oversized message and a loop that
 *    re-sends itself, and have no opinion about the org's total work. Guard
 *    memory records real admissions only, so a lease deferred back to
 *    `pending` is re-claimed and re-judged next cycle, never suppressed by
 *    its own earlier check.
 *
 * Routing for an admitted lease:
 *
 * 1. **Live in-process** — the derived session id resolves through
 *    `ctx.agents`: STEER into the live turn immediately, whatever its state
 *    or the sender's type (founder model: all mail interrupts; senders mark
 *    `blocking` and receivers judge prioritization), settle `done` at
 *    admission.
 * 2. **Dormant** — take the per-name residency lock, probe persistence for
 *    the derived id: an absent log settles `failed` with reason
 *    `unknown-address`; a present log cold-resumes the agent, delivers as a
 *    queued FIFO turn, settles `done` AT ADMISSION, awaits quiescence,
 *    flushes, and disposes the handle before releasing the lock.
 * 3. **Resident elsewhere** — lock acquisition loses to a live holder: settle
 *    `pending` so a later cycle retries.
 *
 * Every terminal failure settles the recipient's row failed AND publishes a
 * best-effort `bounce` notice back to the sender (same store, original
 * traceId, the recorded reason), so a drop is never silent to whoever sent.
 * Every delivered turn opens with the standing sender envelope (`delivery.ts`)
 * — timestamp, sender with its registry-derived class, and the peer-input and
 * urgency contracts: mail is peer input, never founder authority.
 *
 * @module @deepseek-ai/dsh-mailbox-bridge
 */

import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentSetup, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  acquireSessionLock,
  deriveNamedSessionId,
  type NamedSessionLock,
} from '@deepseek-ai/dsh-named-sessions'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  findOrgRegistryRoute,
  loadOrgRegistry,
  orgRegistryAllows,
  parseMailboxAddress,
  resolveSeatCwd,
  resolveSeatSessionId,
} from '@deepseek-ai/dsh-mailbox'
import type { OrgRegistry, OrgRegistrySeat } from '@deepseek-ai/dsh-mailbox'
import type { MailboxAddress, MailboxClaimFilter, MailboxLease, MailboxMessageId } from '@deepseek-ai/dsh-mailbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { admittedOutcome, relayUserMessage } from './delivery.ts'
import type { SenderClass } from './delivery.ts'

export { admittedOutcome, HEADLESS_BACKLOG_LIMIT, HEADLESS_BACKLOG_STALE_CLAIM_MS, messageEnvelope, relaySource, relayText, relayUserMessage } from './delivery.ts'
export type { SenderClass } from './delivery.ts'

/** Default pause between drain cycles. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000

/** Default per-cycle claim batch bound. */
export const DEFAULT_MAX_CLAIM_PER_CYCLE = 10

/** Default age past which another claimer's abandoned lease is reclaimable. */
export const DEFAULT_STALE_CLAIM_MS = 60_000

/** Default idle time a woken agent stays resident before disposal. */
export const DEFAULT_RESIDENCY_IDLE_MS = 600_000

/**
 * Prefix the outside-operator CLI channel stamps on every guest send. A seat
 * cannot claim it (the transport, not the caller, sets the sender), so the
 * prefix marks mail that entered through the bootstrap path — the CLI used
 * while no host is up.
 */
export const GUEST_SENDER_PREFIX = 'guest:'

/** Default cap on one message's rendered sender content, in characters. */
export const DEFAULT_MAX_MESSAGE_CHARS = 262_144

/** Default maximum messages admitted to ONE recipient address within a depth window. */
export const DEFAULT_MAX_DEPTH_PER_ADDRESS = 50

/** Default sliding window the per-address depth cap counts within. */
export const DEFAULT_DEPTH_WINDOW_MS = 60_000

/** Default window within which a substantially identical repeat is suppressed. */
export const DEFAULT_REPEAT_WINDOW_MS = 300_000

/** Default maximum admitted deliveries one `traceId` chain may carry. */
export const DEFAULT_MAX_HOPS_PER_TRACE = 8

/**
 * Recent admission fingerprints remembered per sender→recipient pair for
 * repeat suppression. More than one, so an ALTERNATING loop (x, y, x, …)
 * is caught, not just an immediate resend; beyond this many distinct
 * messages in one window the depth cap is the backstop.
 */
const RECENT_FINGERPRINTS_PER_PAIR = 8
/** One resident seat: its agent handle plus the residency's release path. */
export interface ResidentSeat {
  /** Dispose the agent and release the per-name lock (idle expiry or replacement). */
  release(): void
  /** Reset the idle timer after a delivery keeps the seat in use. */
  keepAlive(): void
}


/** Plugin configuration. */
export interface Config {
  /**
   * The bare seat addresses the bridge serves. Every grammar violation fails
   * schema-adjacent resolution at mount; routing derives each target's
   * session id from the address with no second encoding.
   */
  readonly addresses?: readonly string[]
  /** Pause between drain cycles in milliseconds. */
  readonly pollIntervalMs?: number
  /** Upper bound on leases claimed per cycle; providers may return fewer. */
  readonly maxClaimPerCycle?: number
  /** Age past which an abandoned `claimed` message becomes claimable again. */
  readonly staleClaimMs?: number
  /**
   * Cold-resume takeover bound passed to the named-session lock: a holder
   * older than this many milliseconds loses the artifact even while alive.
   * Absent (the default): pid liveness is the only takeover path.
   */
  readonly lockStaleMs?: number
  /**
   * Idle milliseconds a woken seat's agent stays resident in this host after
   * its last delivery, so the operator's composer and later mail steer it in
   * place instead of cold-starting. Zero disposes immediately (delivery-time
   * semantics). Absent: the default bound.
   */
  readonly residencyIdleMs?: number
  /**
   * Sender addresses whose mail this bridge's addresses will accept beyond
   * the served roster. Empty (the default) admits no external-origin mail
   * except the `guest:` channel ({@link Config.admitGuests}): an outside
   * writer bypasses every write-side check by construction, so admission is
   * decided here at drain, where the store can actually enforce it. A
   * `guest:`-prefixed sender whose stripped name appears here is also
   * admitted, so a list written for bare sender names keeps matching the
   * mail the CLI stamps.
   */
  readonly admitFrom?: readonly string[]
  /**
   * Whether the `guest:`-prefixed outside-operator channel is admitted. The
   * CLI stamps every guest send with the prefix (a seat cannot claim it —
   * the transport sets the sender), so true (the default) keeps the
   * bootstrap path — mail written while no host is up — reaching its seat.
   * False closes the channel: only the served roster and exact `admitFrom`
   * matches (including a `guest:`-prefixed sender whose stripped name is
   * listed) are admitted. Guests still pass the full pipeline — boundary,
   * topology, and every loop guard.
   */
  readonly admitGuests?: boolean
  /**
   * Maximum rendered sender content one message may bring — subject plus
   * payload, the text the delivered turn carries — in characters. A larger
   * message bounces naming both sizes. This is a message-shape guard, not a
   * volume cap: it stops an unbounded payload entering the shared store, and
   * has no opinion about how many messages flow.
   */
  readonly maxMessageChars?: number
  /**
   * Maximum messages admitted to ONE recipient address within
   * `depthWindowMs`. Beyond it the bridge refuses and bounces instead of
   * waking the seat again: a seat's queue must not grow without bound, and a
   * conversation loop shows up exactly as one address being fed faster than
   * anyone reads it. Windowed, so ordinary volume resumes when the window
   * slides; it bounds one address's intake rate, never the org's total work.
   */
  readonly maxDepthPerAddress?: number
  /** Sliding window `maxDepthPerAddress` counts within, in milliseconds. */
  readonly depthWindowMs?: number
  /**
   * Window within which a substantially identical repeat — same sender, same
   * recipient, same subject and payload — is suppressed with a bounce that
   * names the original message and says not to resend. A loop is two seats
   * re-sending the same thing to each other: a correctness bug, not
   * expensive work, and suppressing the repeat never stops legitimate
   * activity. Content is fingerprinted exactly (sha256 over sender,
   * recipient, and rendered body), and the most recent
   * `RECENT_FINGERPRINTS_PER_PAIR` admissions per pair are remembered, so
   * alternating repeats are caught too.
   */
  readonly repeatWindowMs?: number
  /**
   * Maximum admitted deliveries one `traceId` chain may carry before further
   * mail on that trace is refused. The trace id is the correlation field
   * that rides the message producer → delivery → bounce (this bridge's own
   * bounce path preserves it), so a relayed chain terminates instead of
   * hopping forever. The counter is per mounted bridge and counts hops as
   * they are ADMITTED — a queued burst on one trace is judged per hop, not
   * by the backlog ahead of it — and resets on host restart. Conversation
   * mail that does not thread a trace id is bounded by the depth and repeat
   * guards instead.
   */
  readonly maxHopsPerTrace?: number
  /**
   * Path to the org registry that resolves a seat name to its project
   * directory. A provisioned seat is created in ITS OWN cwd, never the host's:
   * the panel groups sessions by directory, so a seat created under the host's
   * cwd is filed where nobody looks. Absent: the harness-home default.
   */
  readonly orgRegistryPath?: string
  /**
   * Explicit live-seat roster: full served addresses routed to an EXISTING
   * session id instead of the name-derivation default. This is how web-host
   * seat sessions (whose ids are not named-derived) become reachable. Absent
   * (the default): pure derivation — fail-closed, no discovery magic.
   */
  readonly seatAliases?: readonly { readonly address: string; readonly sessionId: string }[]
}

/** Schemastery validator for {@link Config}. */
export const Config = z.object({
  addresses: z.array(z.string()),
  pollIntervalMs: z.number().step(1).min(1).default(DEFAULT_POLL_INTERVAL_MS),
  maxClaimPerCycle: z.number().step(1).min(1).default(DEFAULT_MAX_CLAIM_PER_CYCLE),
  staleClaimMs: z.number().step(1).min(1).default(DEFAULT_STALE_CLAIM_MS),
  lockStaleMs: z.number().step(1).min(1),
  residencyIdleMs: z.number().step(1).min(0),
  admitFrom: z.array(z.string()),
  admitGuests: z.boolean().default(true),
  maxMessageChars: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_CHARS),
  maxDepthPerAddress: z.number().step(1).min(1).default(DEFAULT_MAX_DEPTH_PER_ADDRESS),
  depthWindowMs: z.number().step(1).min(1).default(DEFAULT_DEPTH_WINDOW_MS),
  repeatWindowMs: z.number().step(1).min(1).default(DEFAULT_REPEAT_WINDOW_MS),
  maxHopsPerTrace: z.number().step(1).min(1).default(DEFAULT_MAX_HOPS_PER_TRACE),
  orgRegistryPath: z.string().min(1),
  seatAliases: z.array(
    z.object({ address: z.string().min(1), sessionId: z.string().min(1) }),
  ),
})

/** Resolved serving parameters; every fallback decision happens here once. */
export interface BridgeSpec {
  /** Branded, grammar-validated served addresses. */
  readonly addresses: readonly MailboxAddress[]
  readonly pollIntervalMs: number
  readonly maxClaimPerCycle: number
  readonly staleClaimMs: number
  readonly lockStaleMs: number | undefined
  /** Idle bound for resident seats; zero disposes each agent after delivery. */
  readonly residencyIdleMs: number
  /** Sender addresses admitted beyond the served roster. */
  readonly admitFrom: readonly string[]
  /** Whether the `guest:`-prefixed outside-operator channel is admitted. */
  readonly admitGuests: boolean
  /** Rendered sender-content character cap; a larger message bounces. */
  readonly maxMessageChars: number
  /** Messages admitted to one recipient address within `depthWindowMs`. */
  readonly maxDepthPerAddress: number
  /** Sliding window the per-address depth cap counts within. */
  readonly depthWindowMs: number
  /** Window within which a substantially identical repeat is suppressed. */
  readonly repeatWindowMs: number
  /** Admitted deliveries one `traceId` chain may carry before refusal. */
  readonly maxHopsPerTrace: number
  /** The drain-time loop guards; one state instance per mounted bridge. */
  readonly guards: LoopGuards
  /** Registry file resolving a seat name to the project directory it runs in. */
  readonly orgRegistryPath: string
  /** Grammar-checked alias rows for non-derived (web-host seat) targets. */
  readonly seatAliases: ReadonlyMap<MailboxAddress, SessionId>
  /** Live resident seats keyed by address; the host's one-writer pen. */
  readonly residents: Map<string, ResidentSeat>
}

/**
 * Validate and brand the configured roster. Runs at mount, so a malformed
 * address or an empty roster fails the load instead of idling forever.
 * @param config - schema-normalized plugin configuration.
 * @returns the resolved serving parameters.
 */
export function resolveBridgeSpec(config: Config): BridgeSpec {
  const rawAddresses = config.addresses ?? []
  if (rawAddresses.length === 0) {
    throw new Error('mailbox-bridge: addresses must name at least one served seat endpoint')
  }
  const seatAliases = new Map<MailboxAddress, SessionId>()
  for (const alias of config.seatAliases ?? []) {
    // Brand both halves at the resolution boundary (compile-time casts —
    // this contract's opaque ids carry no runtime structure). Address grammar
    // is enforced here, so an invalid row fails the mount.
    const address = parseMailboxAddress(alias.address)
    if (alias.sessionId.trim().length === 0) {
      throw new Error(`mailbox-bridge: seat alias "${alias.address}" carries an empty session id`)
    }
    if (seatAliases.has(address)) {
      throw new Error(`mailbox-bridge: seat alias for "${alias.address}" declared more than once`)
    }
    seatAliases.set(address, String(alias.sessionId) as SessionId)
  }
  return {
    addresses: rawAddresses.map(address => parseMailboxAddress(address)),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxClaimPerCycle: config.maxClaimPerCycle ?? DEFAULT_MAX_CLAIM_PER_CYCLE,
    staleClaimMs: config.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS,
    lockStaleMs: config.lockStaleMs,
    residencyIdleMs: config.residencyIdleMs ?? DEFAULT_RESIDENCY_IDLE_MS,
    admitFrom: config.admitFrom ?? [],
    admitGuests: config.admitGuests ?? true,
    maxMessageChars: config.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS,
    maxDepthPerAddress: config.maxDepthPerAddress ?? DEFAULT_MAX_DEPTH_PER_ADDRESS,
    depthWindowMs: config.depthWindowMs ?? DEFAULT_DEPTH_WINDOW_MS,
    repeatWindowMs: config.repeatWindowMs ?? DEFAULT_REPEAT_WINDOW_MS,
    maxHopsPerTrace: config.maxHopsPerTrace ?? DEFAULT_MAX_HOPS_PER_TRACE,
    guards: new LoopGuards({
      maxMessageChars: config.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS,
      maxDepthPerAddress: config.maxDepthPerAddress ?? DEFAULT_MAX_DEPTH_PER_ADDRESS,
      depthWindowMs: config.depthWindowMs ?? DEFAULT_DEPTH_WINDOW_MS,
      repeatWindowMs: config.repeatWindowMs ?? DEFAULT_REPEAT_WINDOW_MS,
      maxHopsPerTrace: config.maxHopsPerTrace ?? DEFAULT_MAX_HOPS_PER_TRACE,
      maxTracedChains: MAX_TRACED_CHAINS,
    }),
    orgRegistryPath: config.orgRegistryPath ?? dshHomePath('org', 'registry.yml'),
    seatAliases,
    residents: new Map(),
  }
}

/** Resolved loop-guard limits; every value is a Config default or override. */
export interface LoopGuardLimits {
  /** Rendered sender-content characters (subject plus payload) one message may carry. */
  readonly maxMessageChars: number
  /** Messages admitted to one recipient address within `depthWindowMs`. */
  readonly maxDepthPerAddress: number
  /** Sliding window the per-address depth cap counts within. */
  readonly depthWindowMs: number
  /** Window within which a substantially identical repeat is suppressed. */
  readonly repeatWindowMs: number
  /** Admitted deliveries one `traceId` chain may carry before refusal. */
  readonly maxHopsPerTrace: number
  /** Distinct `traceId` chains tracked at once (memory hygiene, not a tunable). */
  readonly maxTracedChains: number
}

/** One remembered admission fingerprint: content hash, when, and which message. */
interface StoredFingerprint {
  readonly fingerprint: string
  /** Epoch milliseconds of the admission that stored it. */
  readonly at: number
  /** The store id of the admitted message, named by a later duplicate's bounce. */
  readonly messageId: string
}

/**
 * Memory bound on distinct `traceId` chains the hop guard tracks at once.
 * Internal hygiene, not a deployment tunable: a refreshed-on-touch LRU keeps
 * the live chains and forgets the least recently used when this is exceeded.
 */
const MAX_TRACED_CHAINS = 1024

/**
 * The loop guards judged at drain-time admission. Guards ONLY — never a
 * spend cap: none of them has an opinion about how much work the org does.
 * They stop the two failure shapes a conversational org otherwise runs into:
 * a message too big for the shared store, and a loop that re-sends itself
 * until someone notices the bill.
 *
 * Judgment (`refusalFor`) and memory (`recordAdmission`) are separate on
 * purpose. A lease the bridge defers back to `pending` (residency held
 * elsewhere) is re-claimed and re-judged next cycle, so nothing may be
 * recorded until the message actually admits — recording only real
 * admissions is what keeps a deferred message from being suppressed by its
 * own earlier check, and keeps a same-trace burst judged per hop as it is
 * delivered rather than by the size of the queue ahead of it.
 *
 * All state is in-memory for one mounted bridge (one spec): it bounds what
 * THIS drain admits and resets on host restart. The store's trace rows are
 * deliberately NOT the hop memory: a trace's queued backlog would count
 * before any of it was delivered, refusing a whole batch for messages that
 * never hopped.
 */
export class LoopGuards {
  private readonly depth = new Map<string, number[]>()
  private readonly repeats = new Map<string, StoredFingerprint[]>()
  private readonly hops = new Map<string, number>()

  /**
   * @param limits - the resolved guard limits this instance enforces.
   * @param now - the clock the windowed guards read; defaults to the host
   *   clock. Injection exists for deterministic tests of window expiry.
   */
  constructor(
    private readonly limits: LoopGuardLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Judge one claimed lease against every guard, in order: size, per-address
   * depth, repeat, hops. Refusal reasons name the numbers the sender needs —
   * exact sizes, counts, the suppressed original's id — because a dropped
   * message must be traceable, never mysterious.
   * @param lease - the claimed lease under judgment.
   * @returns the refusal reason, or undefined when every guard passes.
   */
  refusalFor(lease: MailboxLease): string | undefined {
    const at = this.now()
    const rendered = renderedBody(lease)
    if (rendered.length > this.limits.maxMessageChars) {
      return `message-too-large: rendered ${rendered.length} chars exceeds the ${this.limits.maxMessageChars} char cap`
    }
    const depth = this.depthRefusal(lease, at)
    if (depth !== undefined) return depth
    const repeat = this.repeatRefusal(lease, at, fingerprintOf(lease, rendered))
    if (repeat !== undefined) return repeat
    return this.hopRefusal(lease)
  }

  /**
   * Record one ACTUAL admission into the guard memory: depth, repeat, and
   * hop counters. Call only after the delivery settled `done` — never for a
   * lease deferred back to `pending`.
   * @param lease - the lease that admitted.
   */
  recordAdmission(lease: MailboxLease): void {
    const at = this.now()
    const address = String(lease.message.to)
    const windowStart = at - this.limits.depthWindowMs
    const recent = (this.depth.get(address) ?? []).filter(stamp => stamp > windowStart)
    recent.push(at)
    this.depth.set(address, recent)

    const pair = pairKey(lease)
    const pairWindowStart = at - this.limits.repeatWindowMs
    const fingerprints = (this.repeats.get(pair) ?? []).filter(stored => stored.at > pairWindowStart)
    fingerprints.push({ fingerprint: fingerprintOf(lease, renderedBody(lease)), at, messageId: String(lease.message.id ?? '') })
    while (fingerprints.length > RECENT_FINGERPRINTS_PER_PAIR) fingerprints.shift()
    this.repeats.set(pair, fingerprints)

    const { traceId } = lease.message
    if (traceId === undefined) return
    // Refresh-on-touch LRU: re-recording a chain moves it to the newest
    // slot, so eviction takes the least recently used chain.
    const carried = this.hops.get(traceId) ?? 0
    this.hops.delete(traceId)
    this.hops.set(traceId, carried + 1)
    while (this.hops.size > this.limits.maxTracedChains) {
      // The loop condition guarantees at least one entry; Map iteration
      // order is insertion order, so the first key is the oldest touch.
      this.hops.delete(this.hops.keys().next().value as string)
    }
  }

  /**
   * Per-address depth: how many messages this bridge admitted to the
   * recipient within the sliding window. The store's actual backlog is not
   * enumerable through the seam, so the drain bounds the intake rate it
   * controls — the rate at which a seat's queue can grow through here.
   * @param lease - the claimed lease under judgment.
   * @param at - judgment time, epoch milliseconds.
   * @returns the refusal reason, or undefined when under the cap.
   */
  private depthRefusal(lease: MailboxLease, at: number): string | undefined {
    const address = String(lease.message.to)
    const windowStart = at - this.limits.depthWindowMs
    const recent = (this.depth.get(address) ?? []).filter(stamp => stamp > windowStart)
    if (recent.length < this.limits.maxDepthPerAddress) return undefined
    return `address-depth-exceeded: "${address}" already admitted ${recent.length} messages within ${this.limits.depthWindowMs}ms`
  }

  /**
   * Repeat suppression: the same sender resending substantially the same
   * message to the same recipient within the window is refused, naming the
   * original message and telling the sender not to resend.
   * @param lease - the claimed lease under judgment.
   * @param at - judgment time, epoch milliseconds.
   * @param fingerprint - the lease's content fingerprint.
   * @returns the refusal reason, or undefined when not a suppressed repeat.
   */
  private repeatRefusal(lease: MailboxLease, at: number, fingerprint: string): string | undefined {
    const windowStart = at - this.limits.repeatWindowMs
    const original = (this.repeats.get(pairKey(lease)) ?? [])
      .find(stored => stored.fingerprint === fingerprint && stored.at > windowStart)
    if (original === undefined) return undefined
    return `duplicate-suppressed: repeats message ${original.messageId} to "${lease.message.to}" within ${this.limits.repeatWindowMs}ms; do not resend`
  }

  /**
   * The hop counter: how many deliveries this bridge has already admitted
   * on the lease's trace chain. A message without a trace id starts no
   * chain and is not hop-counted; the depth and repeat guards bound it
   * instead.
   * @param lease - the claimed lease under judgment.
   * @returns the refusal reason, or undefined when under the cap.
   */
  private hopRefusal(lease: MailboxLease): string | undefined {
    const { traceId } = lease.message
    if (traceId === undefined) return undefined
    const carried = this.hops.get(traceId) ?? 0
    if (carried < this.limits.maxHopsPerTrace) return undefined
    return `hop-limit-exceeded: trace "${traceId}" already carried ${carried} admitted hops (cap ${this.limits.maxHopsPerTrace})`
  }
}

/**
 * The sender-owned content one message renders: subject and payload body,
 * joined exactly as the delivered turn renders them. The envelope is the
 * bridge's, not the sender's, so it counts toward neither the size cap nor
 * the repeat fingerprint. Mirrors `relayText`'s body construction in
 * delivery.ts — the rendering owner; keep the two in step.
 * @param lease - the claimed lease under judgment.
 * @returns the rendered sender content.
 */
function renderedBody(lease: MailboxLease): string {
  const parts: string[] = []
  if (lease.message.subject !== undefined) parts.push(lease.message.subject)
  if (lease.message.payload !== undefined) {
    parts.push(typeof lease.message.payload === 'string' ? lease.message.payload : JSON.stringify(lease.message.payload, null, 2))
  }
  return parts.join('\n\n')
}

/**
 * Fingerprint one message's content for repeat suppression: sha256 over
 * sender, recipient, and rendered body — exact, so a resend must match byte
 * for byte, and pair-scoped, so identical mail between different parties
 * never collides.
 * @param lease - the claimed lease under judgment.
 * @param rendered - the lease's rendered sender content.
 * @returns the hex digest.
 */
function fingerprintOf(lease: MailboxLease, rendered: string): string {
  return createHash('sha256')
    .update(`${lease.message.from}\u0000${String(lease.message.to)}\u0000${rendered}`)
    .digest('hex')
}

/** The sender→recipient pair a repeat is suppressed within. */
function pairKey(lease: MailboxLease): string {
  return `${lease.message.from}\u0000${String(lease.message.to)}`
}

/**
 * Deliver one claimed lease to its live agent under the FOUNDER MODEL (chair
 * revision on Doc 1 §2): ALL mail steers into a live turn immediately — no
 * busyness inference, no type-based interrupt requests. Whether the delivered
 * content preempts mental focus or waits behind the current task is the
 * RECEIVER's judging call, driven by the sender's `blocking` mark rendered
 * visibly in the turn. A boundary refusal between admission and steer falls
 * back to an ordinary queued turn so nothing is ever lost. Either way
 * admission is immediate; the caller settles.
 * @param agent - the live agent addressed by the lease.
 * @param message - the rendered delivery turn.
 */
function deliverToLive(agent: Agent, message: UserMessage): void {
  try {
    agent.steer(message)
  } catch {
    // A boundary refused the interruption between admission and steer;
    // an ordinary queued turn still admits the message this cycle.
    agent.followup(message)
  }
}

/**
 * Route one claimed lease to the agent its address names, settling the exact
 * outcome the routing observed. See the module contract for the three paths.
 * @param ctx - plugin context carrying the mailbox registry and core services.
 * @param spec - resolved serving parameters.
 * @param lease - the lease claimed this cycle.
 * @returns what the settlement recorded, observed by {@link internals.drainOnce}.
 */
/**
 * Record one terminal routing failure and make it visible: settle the
 * recipient's row `failed`, then publish a best-effort `bounce` notice back
 * to the original sender — same-store reply path, carrying the original
 * traceId and the recorded reason. Skips bounce-of-bounce (no ping-pong) and
 * senders whose address would not parse; an undrainable bounce is an unread
 * row, never a hang, and never masks the primary failure.
 * @param ctx - plugin context carrying the mailbox registry.
 * @param lease - the failed lease.
 * @param reason - the terminal reason recorded on both rows.
 */
async function failTerminal(ctx: Context, lease: MailboxLease, reason: string): Promise<void> {
  await ctx.mailbox.settle(lease.leaseRef, { state: 'failed', result: { reason } }).catch(() => {
    // The settlement surface itself is down; re-raising would mask its cause.
  })
  const { type, id, traceId } = lease.message
  if (type === 'bounce' || id === undefined) return
  try {
    parseMailboxAddress(lease.message.from)
    await ctx.mailbox.publish({
      to: lease.message.from as never,
      from: lease.message.to,
      type: 'bounce',
      subject: `undeliverable: ${reason}`,
      payload: { bouncedMessageId: String(id), reason },
      ...traceId !== undefined ? { traceId } : {},
    })
  } catch {
    // The primary failure is already durably recorded above.
  }
}

/**
 * Refuse one claimed lease terminally at admission: warn the host log, settle
 * the recipient's row `failed`, and bounce to the sender with the reason. A
 * refusal that only a store row would show is a silent fence — the operator
 * sees the reason in the moment it happens, the sender gets the bounce.
 * @param ctx - plugin context carrying the mailbox registry.
 * @param lease - the refused lease.
 * @param reason - the terminal reason recorded on both rows and the bounce.
 * @returns the failed route result the caller returns.
 */
async function refuse(ctx: Context, lease: MailboxLease, reason: string): Promise<RouteResult> {
  ctx.logger.warn(`mailbox-bridge: refused mail to "${lease.message.to}" from "${lease.message.from}": ${reason}`)
  await failTerminal(ctx, lease, reason)
  return { kind: 'failed', reason }
}

async function deliverLease(ctx: Context, spec: BridgeSpec, lease: MailboxLease): Promise<RouteResult> {
  const mailbox = ctx.mailbox
  const from = lease.message.from
  const name = String(lease.message.to)
  // Drain-time admission pipeline, in the module contract's order. The store
  // cannot police an external writer, so every rule is decided here at drain,
  // where the store can actually enforce it. Each refusal is terminal: warn,
  // settle the recipient's row failed, and bounce to the sender with the
  // reason — a drop is never silent, and never mysterious.
  let registry: OrgRegistry | undefined
  try {
    registry = await judgmentRegistry(spec)
  } catch (error) {
    // A PRESENT registry that will not load refuses everything loud: no
    // check below could prove an exchange boundary-safe, and silently
    // permitting is exactly the failure the test boundary exists to prevent.
    // The next cycle re-reads the file, so fixing it self-heals the bridge.
    return refuse(ctx, lease, `org-registry-unavailable: ${(error as Error).message}`)
  }
  // The test boundary outranks everything below it — the admission list, the
  // edge list, and callUp (which would otherwise carry a call-up seat
  // straight across it).
  const boundary = testBoundaryRefusal(registry, from, name)
  if (boundary !== undefined) return refuse(ctx, lease, boundary)
  const topology = orgTopologyRefusal(registry, from, name)
  if (topology !== undefined) return refuse(ctx, lease, topology)
  if (!isAdmittedSender(spec, spec.addresses.map(String), from)) {
    return refuse(ctx, lease, 'sender-not-admitted')
  }
  const guardRefusal = spec.guards.refusalFor(lease)
  if (guardRefusal !== undefined) return refuse(ctx, lease, guardRefusal)
  // Derived once per lease here, where the registry is already reachable, and
  // passed into the rendered turn so delivery.ts stays pure and testable.
  const senderClass = await senderClassFor(spec, from)
  // Every served address was grammar-checked at mount, and the address IS
  // the session name. An explicit seat-alias row routes to that EXISTING
  // session id (web-host seats are not name-derived); anything else falls
  // back to pure derivation — routing adds no second encoding.
  // Recorded identity beats derived. A seat whose id is pinned in the org
  // registry keeps that id through a rename; derivation is only the bootstrap
  // for a seat that has never run. Resolving by name alone is what made the
  // name the identity, so a rename orphaned the log.
  const sessionId = spec.seatAliases.get(lease.message.to as MailboxAddress)
    ?? await seatSessionId(spec, name)

  // Host-resident delivery: an agent this process already owns takes the
  // message directly. The operator's composer rides the same residency, so
  // human input and mail converge on one agent with no fence in between.
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) {
    deliverToLive(live, relayUserMessage(lease, senderClass))
    await mailbox.settle(lease.leaseRef, admittedOutcome(lease))
    // Guard memory records the admission only now that it actually happened:
    // a lease settled `pending` below is re-claimed and re-judged, and must
    // never be suppressed by its own earlier check.
    spec.guards.recordAdmission(lease)
    // A delivery keeps the seat's residency warm — idle expiry measures time
    // since the seat was last used, not since it was woken.
    spec.residents.get(name)?.keepAlive()
    return { kind: 'done' }
  }

  const residency = spec.residencyIdleMs
  let lock: NamedSessionLock | undefined
  try {
    // Losing the acquire means a live process holds residency elsewhere: defer
    // without waiting out any staleness window.
    // Locked by SESSION ID, not by name: the lock must guard the identity that
    // is actually written, or a rename leaves two live writers holding two
    // different locks over one log.
    lock = acquireSessionLock(String(sessionId), spec.lockStaleMs === undefined ? {} : { maxAgeMs: spec.lockStaleMs }, name)
  } catch {
    await mailbox.settle(lease.leaseRef, { state: 'pending', result: undefined })
    return { kind: 'pending' }
  }
  try {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('mailbox-bridge: wake requires a configured session-persistence backend')
    }
    const persisted = (await persistence.list()).some(header => header.id === sessionId)
    const handle = persisted
      ? await resumeTarget(ctx, sessionId)
      : await createTarget(ctx, sessionId, await seatCwd(spec, name))
    // A freshly resident agent takes the delivery as an ordinary FIFO turn;
    // steering a cold resume would skip reconstructing prior context.
    handle.agent.followup(relayUserMessage(lease, senderClass))
    await mailbox.settle(lease.leaseRef, admittedOutcome(lease))
    // Guard memory records the admission only after the settlement, for the
    // same reason as the live path above.
    spec.guards.recordAdmission(lease)
    // The agent STAYS resident — the operator's composer and later mail all
    // reach it without any cold start — until the idle bound releases the
    // lock and disposes it (the one-writer pen stays with the host).
    if (residency <= 0) {
      const sessions = ctx.get('sessions')
      if (sessions === undefined) throw new Error('mailbox-bridge: wake requires the session store service')
      await handle.agent.whenIdle()
      await sessions.flush(handle.agent.session)
      await handle.dispose()
      lock.release()
      return { kind: 'done' }
    }
    retainResident(ctx, spec, name, handle, lock, residency)
    return { kind: 'done' }
  } catch (error) {
    lock.release()
    throw error
  }
}

/**
 * Keep one woken agent resident under this bridge's pen: the per-name lock
 * stays held (stray headless runs refuse cleanly), the agent stays registered
 * so the operator's composer and later mail steer it in place, and an idle
 * timer flushes, disposes the agent, and releases the lock after `idleMs`.
 * @param ctx - plugin context carrying the session store service.
 * @param spec - resolved serving parameters carrying the residency map.
 * @param name - the seat's address (its session name).
 * @param handle - the resident agent handle.
 * @param lock - the per-name lock acquired for this residency.
 * @param idleMs - idle milliseconds before the resident disposes.
 */
function retainResident(
  ctx: Context,
  spec: BridgeSpec,
  name: string,
  handle: AgentHandle,
  lock: NamedSessionLock,
  idleMs: number,
): void {
  const previous = spec.residents.get(name)
  previous?.release()
  let timer: ReturnType<typeof setTimeout> | undefined
  const retire = (): void => {
    spec.residents.delete(name)
    const sessions = ctx.get('sessions')
    // The timer/release caller cannot await this drain, so its failure is
    // logged rather than swallowed; disposal still runs so the lock never
    // waits on a dead resident.
    void (sessions === undefined
      ? handle.dispose()
      : sessions.flush(handle.agent.session).catch((error: unknown) => {
        ctx.logger.warn(`mailbox-bridge: final flush for retiring resident "${name}" (${handle.agent.session.id}) failed: ${String(error)}`)
      }).then(() => handle.dispose()))
    lock.release()
  }
  const resident: ResidentSeat = {
    keepAlive(): void {
      if (timer !== undefined) clearTimeout(timer)
      arm()
    },
    release(): void {
      if (timer !== undefined) clearTimeout(timer)
      retire()
    },
  }
  const arm = (): void => {
    timer = setTimeout(retire, idleMs)
    timer.unref()
  }
  spec.residents.set(name, resident)
  arm()
}

/**
 * Registry cache, keyed by path and invalidated on mtime.
 *
 * Delivery resolves a seat's identity and project from the registry, and a busy
 * bridge drains on a short interval — so an uncached read here is a file read
 * plus a YAML parse **per message**. Caching on mtime keeps a hand-edit picked
 * up on the next cycle (the registry is edited by hand, and by the UI) while
 * costing one `stat` on the hot path instead of a parse.
 */
const registryCache = new Map<string, { mtimeMs: number; registry: OrgRegistry }>()

/**
 * Load the org registry, reusing the parsed copy while the file is unchanged.
 * @param path - the registry file.
 * @returns the parsed registry.
 * @throws when the file cannot be read or parsed.
 */
async function cachedRegistry(path: string): Promise<OrgRegistry> {
  const { mtimeMs } = await stat(path)
  const hit = registryCache.get(path)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.registry
  const registry = await loadOrgRegistry(path)
  registryCache.set(path, { mtimeMs, registry })
  return registry
}

/**
 * Load the org registry for drain-time judgment: the parsed registry, or
 * `undefined` when NO registry file exists — a deployment without an org
 * graph (the down-host CLI bootstrap world), where nothing is knowable as a
 * seat and the registry-dependent rules have nothing to judge. A registry
 * that EXISTS but will not load throws: the caller must refuse rather than
 * permit, because a broken roster cannot prove any exchange boundary-safe.
 * @param spec - resolved serving parameters carrying the registry path.
 * @returns the parsed registry, or undefined when no registry file exists.
 * @throws when a present registry cannot be read or parsed.
 */
async function judgmentRegistry(spec: BridgeSpec): Promise<OrgRegistry | undefined> {
  try {
    return await cachedRegistry(spec.orgRegistryPath)
  } catch (error) {
    // The file is simply absent: no org graph was ever provisioned here.
    // Anything else — a parse error, an unreadable file — is a broken roster
    // and must fail the caller's judgment loud.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Resolve the durable session id a seat's conversation lives under.
 *
 * The registry answers when it has a recorded `sessionId`; otherwise the name is
 * derived as a bootstrap for a seat that has never run. Recorded beats derived
 * so that a rename carries the conversation — the id stays put while the label
 * moves.
 * @param spec - resolved serving parameters carrying the registry path.
 * @param name - the seat name (which is also its address).
 * @returns the seat's durable session id.
 * @throws when the registry cannot be read or does not list the seat.
 */
async function seatSessionId(spec: BridgeSpec, name: string): Promise<SessionId> {
  let registry
  try {
    registry = await cachedRegistry(spec.orgRegistryPath)
  } catch {
    // A registry that will not load cannot pin identity; derivation is the only
    // answer left, and it is the same one every prior build used.
    return deriveNamedSessionId(name)
  }
  try {
    return resolveSeatSessionId(registry, name, n => String(deriveNamedSessionId(n))) as SessionId
  } catch {
    // Unknown to the roster: fall back to derivation so routing still resolves.
    // Provisioning still refuses (see seatCwd) — this only keeps an existing
    // conversation reachable when the roster and the served list disagree.
    return deriveNamedSessionId(name)
  }
}

/**
 * Resolve the project directory a seat runs in, from the org registry.
 *
 * Fails loud on an unknown seat rather than falling back to the host's cwd.
 * A silent fallback is what produced ghost sessions: the seat was provisioned
 * correctly, ran correctly, and was filed under a workspace the operator never
 * opens. An address the registry does not know is a configuration error and
 * should bounce to its sender, not become an invisible conversation.
 * @param spec - resolved serving parameters carrying the registry path.
 * @param name - the seat name (which is also its address).
 * @returns the seat's absolute project directory.
 * @throws when the registry cannot be read or does not list the seat.
 */
async function seatCwd(spec: BridgeSpec, name: string): Promise<string> {
  let registry
  try {
    registry = await cachedRegistry(spec.orgRegistryPath)
  } catch (error) {
    throw new Error(
      `mailbox-bridge: cannot provision "${name}" — org registry at `
      + `"${spec.orgRegistryPath}" did not load: ${(error as Error).message}`,
    )
  }
  return resolveSeatCwd(registry, name)
}

/**
 * One roster seat looked up defensively (own properties only, per the same
 * rule `senderClassFor` applies), or undefined when the name is not a seat.
 * @param registry - the parsed registry.
 * @param name - the address under lookup.
 * @returns the seat entry, or undefined.
 */
function seatEntry(registry: OrgRegistry, name: string): OrgRegistrySeat | undefined {
  return Object.hasOwn(registry.seats, name) ? registry.seats[name] : undefined
}

/**
 * The `test: true` boundary: a seat marked `test: true` may exchange mail
 * only with seats that are also marked, in either direction. The registry
 * file's own comment promises that boundary-crossing edges can never exist;
 * the promise is enforced HERE, at drain-time admission, where it outranks
 * the admission list, the edge list, and `callUp` (which would otherwise
 * carry a call-up seat straight across it).
 *
 * Fail-closed readings, on doubt:
 * - A test seat mailing a recipient that is NOT a confirmed test seat — a
 *   live seat, or an address unknown to the roster — is refused: test mail
 *   must stay inside the sandbox it was provisioned for.
 * - A roster seat WITHOUT the mark mailing a test seat is refused in turn,
 *   so a live seat cannot reach into the test bed either.
 * - Everyone else — the operator, a `guest:` sender, any non-seat address —
 *   may still mail a test seat: that is the bootstrap path a test bed exists
 *   for, and no seat is crossing anything.
 *
 * A refusal still bounces, and that bounce is itself boundary-judged mail
 * (live sender, test recipient here), so a boundary refusal between seats
 * leaves its bounce an unread row rather than re-deliver across the
 * boundary. The refusal is loud either way: the failed row and the bounce
 * row both carry the reason.
 * @param registry - the loaded registry; `undefined` (no registry file)
 *   judges nothing — no seat is knowable without it.
 * @param from - the message's sender address.
 * @param to - the recipient address.
 * @returns the refusal reason, or undefined when the boundary does not refuse.
 */
function testBoundaryRefusal(registry: OrgRegistry | undefined, from: string, to: string): string | undefined {
  if (registry === undefined) return undefined
  const sender = seatEntry(registry, from)
  const recipient = seatEntry(registry, to)
  if (sender?.test === true && recipient?.test !== true) {
    return `test-boundary-violation: test seat "${from}" may not mail "${to}" (not marked test: true)`
  }
  if (recipient?.test === true && sender !== undefined && sender.test !== true) {
    return `test-boundary-violation: seat "${from}" without the test mark may not mail test seat "${to}"`
  }
  return undefined
}

/**
 * Org topology for seat-to-seat mail: both parties roster seats, and
 * `orgRegistryAllows` — an edge between the pair, or the sender holding
 * call-up — must say yes. A refusal names the route `findOrgRegistryRoute`
 * finds, so the sender is told the path the org graph offers instead of a
 * bare no. A non-seat participant (the operator, a guest, an address unknown
 * to the roster) is not part of the graph and is judged by admission alone.
 * @param registry - the loaded registry; `undefined` judges nothing.
 * @param from - the message's sender address.
 * @param to - the recipient address.
 * @returns the refusal reason, or undefined when topology permits or does not apply.
 */
function orgTopologyRefusal(registry: OrgRegistry | undefined, from: string, to: string): string | undefined {
  if (registry === undefined) return undefined
  if (seatEntry(registry, from) === undefined || seatEntry(registry, to) === undefined) return undefined
  if (orgRegistryAllows(registry, from, to)) return undefined
  const route = findOrgRegistryRoute(registry, from, to)
  const offered = route === undefined
    ? 'no route connects them'
    : `the org graph routes it ${route.join(' -> ')}`
  return `org-registry-denied: "${from}" may not mail "${to}" — no edge connects them and the sender holds no call-up (${offered})`
}

/**
 * Drain-time sender admission: a sender must be one of the served addresses,
 * explicitly admitted, or riding the `guest:` outside-operator channel. The
 * prefix is what the CLI stamps on every outside send (a seat cannot claim
 * it — the transport sets the sender); `admitFrom` may name the stripped
 * form, so an operator list written for bare sender names keeps matching
 * stamped mail. An unparseable `from` matches none of these and fails
 * closed like any foreign sender.
 * @param spec - resolved serving parameters.
 * @param served - the served addresses as strings.
 * @param from - the message's sender address.
 * @returns whether the sender is admitted.
 */
function isAdmittedSender(spec: BridgeSpec, served: readonly string[], from: string): boolean {
  if (served.includes(from) || spec.admitFrom.includes(from)) return true
  if (!from.startsWith(GUEST_SENDER_PREFIX)) return false
  if (spec.admitGuests) return true
  return spec.admitFrom.includes(from.slice(GUEST_SENDER_PREFIX.length))
}

/**
 * Derive the sender class of one incoming message from the org registry:
 * `seat` only when the sender address exactly matches a roster seat,
 * `unverified` for everything else.
 *
 * The relay MUST NEVER emit a `founder` class. Steve does not reach seats
 * through the mailbox — he types into a session directly, and a direct user
 * turn never runs this code — so a forged `send --from steve` names no seat,
 * renders `unverified`, and receives the full peer-input contract: the
 * forgery gains no authority. And because his real path never touches this
 * code, nothing here can teach a seat to discount him either. Do not add a
 * founder branch.
 * @param spec - resolved serving parameters carrying the registry path.
 * @param from - the message's sender address.
 * @returns the derived class; a registry that will not load fails closed to
 *   `unverified`, never `seat`.
 */
async function senderClassFor(spec: BridgeSpec, from: string): Promise<SenderClass> {
  try {
    const registry = await cachedRegistry(spec.orgRegistryPath)
    // Object.hasOwn, not `in`: `in` walks the prototype chain, so a sender
    // naming an inherited Object property would classify as a seat.
    return Object.hasOwn(registry.seats, from) ? 'seat' : 'unverified'
  } catch {
    // The roster is the only seat authority; without it nothing may look
    // like one, so the message ships as unverified peer input.
    return 'unverified'
  }
}

/**
 * Create the first session for a seat that has never run — the basic
 * wake-up: mail alone provisions the seat, no hire script required.
 * @param ctx - plugin context carrying the agent registry and default model.
 * @param sessionId - the derived durable session id to create.
 * @param cwd - the seat's own project directory, from the org registry.
 */
async function createTarget(
  ctx: Context,
  sessionId: ReturnType<typeof deriveNamedSessionId>,
  cwd: string,
): Promise<AgentHandle> {
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel === undefined) {
    throw new Error('mailbox-bridge: wake requires the default model-selection service')
  }
  const selection = defaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup: AgentSetup = (agentCtx): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  // The SEAT's directory, never `process.cwd()`. The host's cwd is wherever it
  // was launched from — systemd sets none, so it resolves to the home directory
  // — and the UI groups sessions by cwd. A seat provisioned with the host's cwd
  // is filed under a workspace nobody opens: the session is live and correct and
  // simply cannot be found. That is the "ghost session" class.
  return ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
}

/**
 * Cold-resume the dormant agent owning `sessionId`, composing the same model
 * selection path the host's direct runner uses. Missing model wiring fails
 * loud here rather than delivering a silently de-tuned turn.
 * @param ctx - plugin context carrying the agent registry and default model.
 * @param sessionId - the derived durable session id to resume.
 */
async function resumeTarget(ctx: Context, sessionId: ReturnType<typeof deriveNamedSessionId>): Promise<AgentHandle> {
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel === undefined) {
    throw new Error('mailbox-bridge: cold-resume requires the default model-selection service')
  }
  const selection = defaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup: AgentSetup = (agentCtx): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  return ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
}

/** Stable Cordis plugin name. */
export const name = 'mailbox-bridge'

/** Core services required before any cycle can route deliveries. */
export const inject = ['mailbox', 'agents']

/**
 * Context key every mounted bridge contributes its resolved spec under, so
 * wire consumers (the host API) can validate that an address is actually
 * served before admitting mail for it.
 */
export type MailboxBridgeSpecs = readonly BridgeSpec[]

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Union of every mounted bridge's serving roster in mount order. */
    mailboxBridgeSpecs?: MailboxBridgeSpecs
  }
}

/**
 * Lifecycle result of routing one claimed lease, observed at its settlement
 * write. `failed` carries the reason the settlement recorded.
 */
export type RouteResult = { kind: 'done' } | { kind: 'pending' } | { kind: 'failed'; reason: string }

/**
 * One drain pass without the interval wrapper — the unit-test surface. The
 * optional observer fires once per routed lease at its settlement write, so a
 * consumer can learn what became of a specific message it just published.
 * @param ctx - plugin context carrying the mailbox registry and core services.
 * @param spec - resolved serving parameters.
 * @param onSettled - observer keyed by the provider-assigned message id.
 */
export const internals = {
  async drainOnce(ctx: Context, spec: BridgeSpec, onSettled?: (messageId: string, result: RouteResult) => void): Promise<void> {
    const filter: MailboxClaimFilter = {
      addresses: spec.addresses,
      limit: spec.maxClaimPerCycle,
      staleClaimMs: spec.staleClaimMs,
    }
    const leases = await ctx.mailbox.claim(filter)
    for (const lease of leases) {
      try {
        const result = await deliverLease(ctx, spec, lease)
        onSettled?.(String(lease.message.id), result)
      } catch (error) {
        const reason = error instanceof Error ? `${error.message}` : String(error)
        await failTerminal(ctx, lease, reason)
        onSettled?.(String(lease.message.id), { kind: 'failed', reason })
      }
    }
  },
}

/**
 * Mount the drain loop. The first cycle runs inline so structural faults — an
 * unregistered default provider, a malformed roster — fail the mount itself;
 * later cycles stay periodic, single-flight, and loud on structural failure.
 * The resolved spec joins the process-wide serving roster, so wire consumers
 * can validate addresses against it ({@link publishAndWake}).
 * @param ctx - plugin context carrying the mailbox registry and core services.
 * @param config - validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const spec = resolveBridgeSpec(config)
  ctx.provide('mailboxBridgeSpecs', [...ctx.get('mailboxBridgeSpecs') ?? [], spec])
  let draining = false
  const cycle = (): void => {
    if (draining) return
    draining = true
    void internals.drainOnce(ctx, spec)
      .catch((error: unknown) => {
        // A second structural failure after mount cannot self-heal by ticking;
        // clearing the interval makes the broken deployment fail visibly
        // instead of consuming its queue one silent retry at a time.
        clearInterval(timer)
        throw error
      })
      .finally(() => {
        draining = false
      })
  }
  await internals.drainOnce(ctx, spec)
  const timer = setInterval(cycle, spec.pollIntervalMs)
  // Unref'd: the drain loop must not pin its host's event loop. Deployments
  // that exist only to serve mail hold themselves up through other handles.
  timer.unref()
  ctx.effect(() => () => {
    clearInterval(timer)
    // Host teardown retires every resident seat: agents dispose and the
    // per-name locks release, so nothing fences a post-restart wake.
    for (const resident of spec.residents.values()) resident.release()
    spec.residents.clear()
  }, 'mailbox-bridge.poll')
}

/** What the wire reports about one woken message. */
export type MailboxWakeDisposition = 'delivered' | 'queued'

/** Addressed publish input shared by every wire caller. */
export interface PublishAndWakeRequest {
  /** Destination address: the recipient seat's bare name. */
  readonly to: string
  /** Sender address; free-form provenance, never validated against live endpoints. */
  readonly from: string
  readonly type?: string
  readonly subject?: string
  /** JSON-serializable body owned by the sender. */
  readonly payload?: unknown
  readonly traceId?: string
}

/**
 * The wire admission path for non-dsh callers: validate the address against
 * the mounted bridges' rosters, store the message through the registry's
 * default provider, then run one immediate drain of that bridge's roster so
 * the fresh mail wakes its target in the same call.
 *
 * `delivered` means the routing admitted the message into a session inbox
 * this wake (live or cold-resumed); `queued` means it remains stored for a
 * later cycle — residency held elsewhere, or a full claim batch ahead of it.
 * A terminal routing failure (`unknown-address`, missing backends) rejects
 * loud with the recorded reason.
 * @param ctx - context carrying the mailbox registry and the bridge specs.
 * @param request - addressed publish content without an id.
 * @returns the provider-assigned id plus the observed disposition.
 */
export async function publishAndWake(
  ctx: Context,
  request: PublishAndWakeRequest,
): Promise<{ messageId: MailboxMessageId; disposition: MailboxWakeDisposition }> {
  const mailbox = ctx.get('mailbox')
  if (mailbox === undefined) {
    throw new Error('mailbox publish: no mailbox registry is composed in this deployment')
  }
  const to = parseMailboxAddress(request.to)
  const specs = ctx.get('mailboxBridgeSpecs') ?? []
  if (specs.length === 0) {
    throw new Error(`mailbox publish: no mailbox bridge is composed, so "${to}" cannot be served or woken`)
  }
  const spec = specs.find(candidate => candidate.addresses.includes(to))
  if (spec === undefined) {
    throw new Error(`mailbox publish: address "${to}" is not served by any mounted mailbox bridge`)
  }
  const messageId = await mailbox.publish({ ...request, to })
  let observed: RouteResult | undefined
  await internals.drainOnce(ctx, spec, (settledId, result) => {
    if (settledId === messageId && observed === undefined) observed = result
  })
  if (observed === undefined || observed.kind === 'pending') {
    return { messageId, disposition: 'queued' }
  }
  if (observed.kind === 'failed') {
    throw new Error(`mailbox delivery failed: ${observed.reason}`)
  }
  return { messageId, disposition: 'delivered' }
}

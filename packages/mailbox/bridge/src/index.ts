/**
 * The mailbox consumer: a polling bridge that turns claimed messages into
 * delivered user-role turns on the addressed named-session agents. Routing is
 * pure derivation — the address IS the session name, so no
 * directory lives here. One drain cycle claims up to `maxClaimPerCycle`
 * messages, admits each through the drain-time pipeline below, and routes
 * each admitted lease:
 *
 * Admission runs in order, and every refusal is terminal — the recipient's
 * row settles `failed` AND the refusal is reported to its SENDER on the
 * context bus (`mailbox/refused`, below) plus as a durable notice node in the
 * sender's own session, so a dropped message is never silent and never
 * mysterious:
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
 * Every admission refusal reports itself THREE ways, all from the one `refuse`
 * call: the recipient's row settles `failed`, the `mailbox/refused` context
 * event carries the sender and recipient addresses plus the reason to the
 * host's consumers (which render it as a live `host/agent-error` frame at the
 * SENDER's session), and a durable notice node is logged INTO the sender's
 * session (`injectRefusalNotice`) so the refusal survives a reload and sits in
 * the conversation the sender reads. The refusal deliberately travels none of
 * those ways as mail — a bounce back to the sender is itself subject to the
 * rule that refused the original, so it gets refused in turn and the sender
 * sees silence. Every terminal failure AFTER admission (a wake or provisioning
 * crash) settles the recipient's row failed AND publishes a best-effort
 * `bounce` notice back to the sender (same store, original traceId, the
 * recorded reason): those are failures of the recipient's side, and the bounce
 * is neither circular nor admission-judged. Every delivered turn opens with
 * the standing sender envelope (`delivery.ts`) — timestamp, sender with its
 * registry-derived class, and the peer-input and urgency contracts: mail is
 * peer input, never founder authority.
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
// Type-only: the bridge does not depend on the tools package at runtime, but
// this augments `Context` with `.tools` so `agentCtx.tools` type-checks
// inside the setup callbacks below — the same bare type-only import idiom
// used by the API proxy, agent-loop, agent-tool-presentation, and mcp-client.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only, same idiom: augments `Context` with `.subagents` so the
// idle-retire check below (`ctx.get('subagents')?.hasLiveDescendants(...)`)
// type-checks. A composition without the subagent runtime mounted resolves
// this to `undefined` at runtime, which the `?? false` fallback treats as
// "no descendants" — never a missing-service crash.
import type {} from '@deepseek-ai/dsh-subagent'
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
import { admittedOutcome, refusalUserMessage, relayUserMessage, seatToolRestrictionUserMessage } from './delivery.ts'
import type { SenderClass } from './delivery.ts'
import { applySeatToolRestriction } from './seat-tool-restriction.ts'
import type { SeatToolRestrictionOutcome, SeatToolRestrictionRule } from './seat-tool-restriction.ts'

export { admittedOutcome, HEADLESS_BACKLOG_LIMIT, HEADLESS_BACKLOG_STALE_CLAIM_MS, messageEnvelope, refusalSource, refusalText, refusalUserMessage, relaySource, relayText, relayUserMessage, seatToolRestrictionSource, seatToolRestrictionText, seatToolRestrictionUserMessage } from './delivery.ts'
export type { SenderClass, SeatToolRestrictionNoticeSource } from './delivery.ts'

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

/** Default maximum admitted deliveries one `traceId` chain may carry per UTC day. */
export const DEFAULT_MAX_HOPS_PER_TRACE = 50

/**
 * Recent admission fingerprints remembered per sender→recipient pair for
 * repeat suppression. More than one, so an ALTERNATING loop (x, y, x, …)
 * is caught, not just an immediate resend; beyond this many distinct
 * messages in one window the depth cap is the backstop.
 */
const RECENT_FINGERPRINTS_PER_PAIR = 8
/** Admitted-delivery count for one trace chain, stamped with its UTC day. */
interface HopCount {
  /** Admissions recorded on the chain so far today. */
  count: number
  /** UTC calendar day (`YYYY-MM-DD`) the count was last recorded on. */
  utcDay: string
}

/** One resident seat: its agent handle plus the residency's release paths. */
export interface ResidentSeat {
  /**
   * Dispose the agent and release its per-session lock immediately, with no
   * deferral for live background work. This is host teardown's own path (see
   * `apply`'s effect disposer): a process that is exiting cannot hang on a
   * runaway subagent, so it bypasses {@link ResidentSeat.supersede}'s drain
   * entirely — the one deliberate exception to the founder's "nothing here
   * kills background work" ruling.
   */
  release(): void
  /** Reset the idle timer after a delivery keeps the seat in use. */
  keepAlive(): void
  /**
   * This resident's name has just been claimed by a fresh resident (a seat
   * rename: the same name now routes to a different session). Per the
   * founder's ruling, nothing here stops, cancels, or drains this resident's
   * background work: it stays alive — unreachable under `name` from this
   * point on, since the caller has already overwritten (or is about to
   * overwrite) the map entry — until it has no live continuable descendant
   * left, then disposes itself and releases its OWN per-session lock (never
   * the new resident's; locks are keyed by session id, not by name, so the
   * two never contend). A resident with no live descendant at the moment its
   * name is claimed disposes immediately — the common case is unchanged.
   */
  supersede(): void
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
   *
   * A guest sender bypasses the `test: true` boundary and the org topology
   * BY DESIGN. Both rules key off roster seats and judge seat-to-seat pairs;
   * a guest is never a roster seat, so neither rule applies to it — a
   * `guest:`-prefixed CLI can mail a live seat, a test seat, or a seat with
   * no edge to anything. That is the break-glass property the channel exists
   * for: an outside operator must always be able to reach a working seat,
   * including for repair, without provisioning an edge first. It costs the
   * sender no authority: the delivered envelope renders the guest
   * `unverified`, and the recipient is told so. The loop guards DO still
   * apply to guest mail in full — size, depth, repeat, and hops.
   *
   * False closes the channel, and is the only switch that does: no edge, no
   * roster mark, and no other rule closes it while it is admitted. Only the
   * served roster and exact `admitFrom` matches (including a
   * `guest:`-prefixed sender whose stripped name is listed) are admitted.
   */
  readonly admitGuests?: boolean
  /**
   * Maximum rendered sender content one message may bring — subject plus
   * payload, the text the delivered turn carries — in characters. A larger
   * message is refused naming both sizes. This is a message-shape guard, not a
   * volume cap: it stops an unbounded payload entering the shared store, and
   * has no opinion about how many messages flow.
   */
  readonly maxMessageChars?: number
  /**
   * Maximum messages admitted to ONE recipient address within
   * `depthWindowMs`. Beyond it the bridge refuses instead of waking the seat
   * again: a seat's queue must not grow without bound, and a
   * conversation loop shows up exactly as one address being fed faster than
   * anyone reads it. Windowed, so ordinary volume resumes when the window
   * slides; it bounds one address's intake rate, never the org's total work.
   */
  readonly maxDepthPerAddress?: number
  /** Sliding window `maxDepthPerAddress` counts within, in milliseconds. */
  readonly depthWindowMs?: number
  /**
   * Window within which a substantially identical repeat — same sender, same
   * recipient, same subject and payload — is suppressed with a refusal that
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
   * Maximum admitted deliveries one `traceId` chain may carry per UTC day
   * before further mail on that trace is refused. The trace id is the
   * correlation field that rides the message producer → delivery → bounce
   * (the routing-failure bounce path preserves it), so a relayed chain
   * terminates instead of hopping forever. The counter is per mounted
   * bridge and counts hops as they are ADMITTED — a queued burst on one
   * trace is judged per hop, not by the backlog ahead of it — and resets
   * at 00:00 UTC and on host restart, so a chronic but legitimate relay
   * thread never locks permanently. Conversation mail that does not thread
   * a trace id is bounded by the depth and repeat guards instead.
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
  readonly seatAliases?: readonly {
    /** The full served mailbox address the alias routes; grammar-checked at mount with every served address. */
    readonly address: string
    /** The existing session id mail to that address is delivered into, bypassing name derivation. */
    readonly sessionId: string
  }[]
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
  /** Rendered sender-content character cap; a larger message is refused. */
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
  private readonly hops = new Map<string, HopCount>()

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
    return this.hopRefusal(lease, at)
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
    // slot, so eviction takes the least recently used chain. The count
    // restarts when the stored UTC day is not today.
    const today = utcDayOf(at)
    const stored = this.hops.get(traceId)
    const count = stored !== undefined && stored.utcDay === today ? stored.count + 1 : 1
    this.hops.delete(traceId)
    this.hops.set(traceId, { count, utcDay: today })
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
   * on the lease's trace chain TODAY (UTC). A message without a trace id
   * starts no chain and is not hop-counted; the depth and repeat guards
   * bound it instead. The count carries a UTC date stamp and reads as zero
   * once the day has turned, so a chronic but legitimate relay thread is
   * bounded per day, never permanently.
   * @param lease - the claimed lease under judgment.
   * @param at - judgment time, epoch milliseconds.
   * @returns the refusal reason, or undefined when under the cap.
   */
  private hopRefusal(lease: MailboxLease, at: number): string | undefined {
    const { traceId } = lease.message
    if (traceId === undefined) return undefined
    const stored = this.hops.get(traceId)
    const carried = stored !== undefined && stored.utcDay === utcDayOf(at) ? stored.count : 0
    if (carried < this.limits.maxHopsPerTrace) return undefined
    return `hop-limit-exceeded: trace "${traceId}" already carried ${carried} admitted hops today (cap ${this.limits.maxHopsPerTrace}, resets daily at 00:00 UTC)`
  }
}

/**
 * The UTC calendar day an epoch-millisecond instant falls on, the granularity
 * the hop counter resets at.
 * @param at - instant, epoch milliseconds.
 * @returns `YYYY-MM-DD` in UTC.
 */
function utcDayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
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
 * @returns `{delivered: true}` once either channel admits the message.
 *   `{delivered: false, reason}` only when BOTH refuse — most notably when
 *   the agent has been torn down in the exact window between the caller's
 *   registry lookup and this call (host-owned disposal racing admission:
 *   the registry can still hand back an entry for a session mid-disposal),
 *   but the shape covers any cause the fallback itself reports, carrying
 *   its actual message rather than assuming why. Either way there is
 *   nothing left to queue into. The caller settles this as a terminal
 *   routing failure via {@link failTerminal}, exactly like any other
 *   post-admission delivery failure — never a silent drop.
 */
function deliverToLive(
  agent: Agent,
  message: UserMessage,
): { delivered: true } | { delivered: false; reason: string } {
  try {
    agent.steer(message)
  } catch {
    // A boundary refused the interruption between admission and steer; an
    // ordinary queued turn still admits the message this cycle -- unless
    // the fallback itself now refuses (most notably: the agent has since
    // been disposed in this same window), in which case delivery has
    // genuinely failed and there is nothing left to queue into.
    try {
      agent.followup(message)
    } catch (error) {
      return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  return { delivered: true }
}

/**
 * Settle one lease's recipient row `failed` with the recorded reason — the
 * terminal marker every drop shares. Best-effort: the settlement surface
 * being down must not mask the primary failure this records.
 * @param ctx - plugin context carrying the mailbox registry.
 * @param lease - the lease being settled.
 * @param reason - the terminal reason recorded on the row.
 */
async function settleFailed(ctx: Context, lease: MailboxLease, reason: string): Promise<void> {
  await ctx.mailbox.settle(lease.leaseRef, { state: 'failed', result: { reason } }).catch(() => {
    // The settlement surface itself is down; re-raising would mask its cause.
  })
}

/**
 * Record one terminal ROUTING failure and make it visible: settle the
 * recipient's row `failed`, then publish a best-effort `bounce` notice back
 * to the original sender — same-store reply path, carrying the original
 * traceId and the recorded reason. Skips bounce-of-bounce (no ping-pong) and
 * senders whose address would not parse; an undrainable bounce is an unread
 * row, never a hang, and never masks the primary failure. Admission refusals
 * do NOT travel through here: a refusal is the harness reporting on the
 * sender's own action, and a bounce would be mail subject to the very rule
 * that refused the original — see {@link refuse}.
 * @param ctx - plugin context carrying the mailbox registry.
 * @param lease - the failed lease.
 * @param reason - the terminal reason recorded on both rows.
 */
async function failTerminal(ctx: Context, lease: MailboxLease, reason: string): Promise<void> {
  await settleFailed(ctx, lease, reason)
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
 * Log one refusal notice into the SENDER's session as a durable context node:
 * a `user/message` whose source is the mailbox `notice` form
 * ({@link refusalSource} in `delivery.ts`), so the refusal survives reloads,
 * sits in the conversation the sender reads, and reaches the sender's model —
 * none of which a transient `host/agent-error` frame guarantees.
 *
 * The notice is NOT mail and never touches the mail store: it is appended to
 * the session log directly, so no admission rule can ever judge it and a
 * refusal notice can never itself be refused. It also wakes nothing — no
 * `steer`, no `followup`, no inbox write of any kind — because the sender is
 * usually mid-turn (it just called the send tool) and a waking delivery from
 * a refusal would let a seat interrupt itself.
 *
 * Best-effort by construction: the refusal is already terminal on the
 * recipient's row and on the context bus before this runs, so a failed notice
 * is logged, never raised, and never turned into a second refusal — raising
 * out of `refuse` would hand the lease to the drain's generic failure path,
 * which bounces, and a bounce is the circular route the refusal forbids.
 * @param ctx - plugin context carrying the agent registry and core services.
 * @param spec - resolved serving parameters carrying the seat aliases.
 * @param lease - the refused lease.
 * @param reason - the terminal reason recorded on the recipient's failed row.
 */
async function injectRefusalNotice(ctx: Context, spec: BridgeSpec, lease: MailboxLease, reason: string): Promise<void> {
  const from = lease.message.from
  // A `guest:` sender has no session to log into — the outside-operator CLI
  // channel reports its failures with its own non-zero exit.
  if (from.startsWith(GUEST_SENDER_PREFIX)) return
  // An address that fails mailbox grammar names no seat and no derivable
  // session — the same guard the host's refusal frame applies.
  try {
    parseMailboxAddress(from)
  } catch {
    // Nowhere to log the notice; the failed row and the context event remain.
    return
  }
  // The same identity resolution delivery uses, retargeted at the sender:
  // recorded identity beats derivation, and an explicit web-seat alias wins
  // over both.
  const sessionId = spec.seatAliases.get(from as MailboxAddress) ?? await seatSessionId(spec, from)
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) {
    // The sender's agent is resident here — normally true, since it sent the
    // mail from a live turn. A direct log append bypasses the inbox entirely:
    // the running driver is not interrupted, and the notice joins the history
    // the model already reads on its next request.
    try {
      live.session.append('user/message', refusalUserMessage(lease, reason), { surfaceOp: 'append' })
    } catch (error) {
      ctx.logger.warn(`mailbox-bridge: refusal notice for sender "${from}" could not be logged: ${String(error)}`)
    }
    return
  }
  let lock: NamedSessionLock
  try {
    lock = acquireSessionLock(String(sessionId), spec.lockStaleMs === undefined ? {} : { maxAgeMs: spec.lockStaleMs }, from)
  } catch (error) {
    // Residency is held by a live process elsewhere, so THAT writer owns the
    // sender's log; appending here too would break the one-writer contract.
    ctx.logger.warn(`mailbox-bridge: refusal notice for sender "${from}" skipped, its session is active elsewhere: ${String(error)}`)
    return
  }
  let handle: AgentHandle | undefined
  try {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('mailbox-bridge: refusal notice requires a configured session-persistence backend')
    }
    const persisted = (await persistence.list()).some(header => header.id === sessionId)
    if (!persisted) {
      // The sender has never run: there is no session to notify, and
      // provisioning one for a notice is the ghost-session class. The CLI or
      // wire caller that sent the mail already learned the outcome from its
      // own path.
      return
    }
    handle = await resumeTarget(ctx, spec, sessionId, from)
    // Resume only — no followup, no steer: the dormant sender is rebuilt,
    // receives the durable node, and is released without ever driving a turn.
    handle.agent.session.append('user/message', refusalUserMessage(lease, reason), { surfaceOp: 'append' })
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new Error('mailbox-bridge: refusal notice requires the session store service')
    await sessions.flush(handle.agent.session)
  } catch (error) {
    ctx.logger.warn(`mailbox-bridge: refusal notice for sender "${from}" could not be logged: ${String(error)}`)
  } finally {
    // Dispose before releasing, mirroring delivery's zero-residency retire:
    // the notice must not keep the sender's residency warm.
    await handle?.dispose()
    lock.release()
  }
}

/**
 * Refuse one claimed lease terminally at admission: warn the host log, settle
 * the recipient's row `failed`, report the refusal on the context bus
 * (`mailbox/refused`), and log a durable notice into the SENDER's session
 * ({@link injectRefusalNotice}) — never as mail back to the sender. A bounce
 * would be itself subject to the rule that refused the original, refused in
 * turn, and the sender would have seen silence. The refusal is the harness
 * reporting on the sender's OWN action, so it travels as a system notice on
 * the context bus, which the host's api-proxy turns into a `host/agent-error`
 * frame at the sender's session — the live toast for a user who happens to be
 * watching — while the durable notice is the outlet that survives a reload.
 * A `guest:` sender has no session and reaches nobody that way; the CLI's own
 * send path reports its failures with a non-zero exit. A refusal that only a
 * store row would show is a silent fence — the operator sees the reason in
 * the moment it happens.
 * @param ctx - plugin context carrying the mailbox registry.
 * @param spec - resolved serving parameters, for the sender's session id.
 * @param lease - the refused lease.
 * @param reason - the terminal reason recorded on the row and the event.
 * @returns the failed route result the caller returns.
 */
async function refuse(ctx: Context, spec: BridgeSpec, lease: MailboxLease, reason: string): Promise<RouteResult> {
  ctx.logger.warn(`mailbox-bridge: refused mail to "${lease.message.to}" from "${lease.message.from}": ${reason}`)
  await settleFailed(ctx, lease, reason)
  ctx.emit('mailbox/refused', {
    from: lease.message.from,
    to: String(lease.message.to),
    reason,
  })
  await injectRefusalNotice(ctx, spec, lease, reason)
  return { kind: 'failed', reason }
}

/**
 * Route one claimed lease to the agent its address names, settling the exact
 * outcome the routing observed. See the module contract for the three paths.
 * @param ctx - plugin context carrying the mailbox registry and core services.
 * @param spec - resolved serving parameters.
 * @param lease - the lease claimed this cycle.
 * @returns what the settlement recorded, observed by {@link internals.drainOnce}.
 */
async function deliverLease(ctx: Context, spec: BridgeSpec, lease: MailboxLease): Promise<RouteResult> {
  const mailbox = ctx.mailbox
  const from = lease.message.from
  const name = String(lease.message.to)
  // Drain-time admission pipeline, in the module contract's order. The store
  // cannot police an external writer, so every rule is decided here at drain,
  // where the store can actually enforce it. Each refusal is terminal: warn,
  // settle the recipient's row failed, and report the refusal on the context
  // bus for the sender's session — never a bounce, which the rule that caused
  // the refusal would refuse in turn. A drop is never silent, and never
  // mysterious.
  let registry: OrgRegistry | undefined
  try {
    registry = await judgmentRegistry(spec)
  } catch (error) {
    // A PRESENT registry that will not load refuses everything loud: no
    // check below could prove an exchange boundary-safe, and silently
    // permitting is exactly the failure the test boundary exists to prevent.
    // The next cycle re-reads the file, so fixing it self-heals the bridge.
    return refuse(ctx, spec, lease, `org-registry-unavailable: ${(error as Error).message}`)
  }
  // The test boundary outranks everything below it — the admission list, the
  // edge list, and callUp (which would otherwise carry a call-up seat
  // straight across it).
  const boundary = testBoundaryRefusal(registry, from, name)
  if (boundary !== undefined) return refuse(ctx, spec, lease, boundary)
  const topology = orgTopologyRefusal(registry, from, name)
  if (topology !== undefined) return refuse(ctx, spec, lease, topology)
  if (!isAdmittedSender(spec, spec.addresses.map(String), from)) {
    return refuse(ctx, spec, lease, 'sender-not-admitted')
  }
  const guardRefusal = spec.guards.refusalFor(lease)
  if (guardRefusal !== undefined) return refuse(ctx, spec, lease, guardRefusal)
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
    const outcome = deliverToLive(live, relayUserMessage(lease, senderClass))
    if (!outcome.delivered) {
      // The registry still held this session, but delivery itself refused on
      // both channels -- most commonly because the agent had already been
      // torn down by the time delivery reached it (host-owned disposal racing
      // this lookup). A real, terminal delivery failure, not a silent drop.
      // This is post-admission, so it is recorded the same way any other
      // routing failure is, not as an admission refusal (see `refuse` above):
      // settle failed and bounce, exactly per the module's own "a drop is
      // never silent, and never mysterious."
      await failTerminal(ctx, lease, outcome.reason)
      return { kind: 'failed', reason: outcome.reason }
    }
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
      ? await resumeTarget(ctx, spec, sessionId, name)
      : await createTarget(ctx, spec, sessionId, await seatCwd(spec, name), name)
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
    // A muted recipient never got composed at all (see `SeatMutedToolsError`
    // and `composeSeatAgent`) — this is the ONE place both `resumeTarget` and
    // `createTarget` funnel through, and the only place with the claimed
    // lease in scope to route the failure through the real refusal path
    // instead of the drain loop's generic bounce. The warn and the bus event
    // fire here, describing WHY the refusal happened, before `refuse` itself
    // settles the row, warns again with the generic admission-refusal
    // framing, reports `mailbox/refused`, and notices the SENDER.
    if (error instanceof SeatMutedToolsError) {
      ctx.logger.warn(`mailbox-bridge: seat "${error.seatName}" tool restriction leaves it with NO tools at all — it cannot report this itself; refusing mail to it instead of composing it`)
      emitSeatToolsRestricted(ctx, error.seatName, error.outcome)
      return refuse(ctx, spec, lease, `seat-tools-muted: seat "${name}"'s configured tool restriction leaves it with no tools at all and cannot receive mail`)
    }
    throw error
  }
}

/**
 * Upper bound on how often the idle-retire timer rechecks a blocked seat for
 * live continuable descendants, once it has any. Recheck is a synchronous
 * in-memory scan (see `SubagentRuntime.hasLiveDescendants`), so it costs
 * nothing to run far more often than `idleMs` itself: bounding it below
 * `idleMs` (`Math.min`) is what keeps a real deployment's 10-minute default
 * from leaving a finished seat pinned open for up to 10 more minutes before
 * anyone notices its last descendant actually settled.
 */
const DESCENDANT_RECHECK_MS = 30_000

/**
 * Recheck ticks between repeated "still held open" log lines once a seat is
 * blocked on live descendants. The first tick always logs (a fence must
 * never be silent at the moment it starts); after that, logging every tick
 * would turn one long-running background task into one log line per recheck
 * interval. Expressed in ticks rather than wall-clock time so the same
 * constant means "N rechecks of being blocked" whether `idleMs` is a real
 * deployment's 10 minutes or a test's few milliseconds.
 */
const DESCENDANT_REANNOUNCE_TICKS = 20

/**
 * Blocked ticks past which a still-held seat's log escalates from `warn` to
 * `error` and its wording changes from routine to unusual. A seat held open
 * by legitimate background work is expected and must not read as an
 * incident; a seat still held after this many rechecks (roughly an hour, at
 * the recheck cap above) is unusual enough that a founder watching the log
 * should be able to tell the difference without reading source — this is the
 * legibility the module owes for choosing never to time out or kill the
 * underlying work itself.
 */
const DESCENDANT_ESCALATE_TICKS = 120

/**
 * Decide whether one blocked recheck should log, and how — shared by the
 * idle-retire path and the rename-supersede path (see {@link retainResident}
 * and {@link ResidentSeat.supersede}) so a founder reading the log sees one
 * consistent cadence for "why is this still running" regardless of which
 * path produced it. Pulled out as a pure function so the reannounce and
 * escalate thresholds are unit-testable without waiting on real timers.
 * @param name - the seat's address (its session name). For `reason:
 *   'superseded'` this is the name the resident USED TO answer to, not one it
 *   can still be reached under.
 * @param sessionId - the resident agent's durable session id.
 * @param blockedTicks - consecutive recheck ticks this resident has spent
 *   blocked on a live continuable descendant, counting the current one.
 * @param reason - `'idle'` (the resident's own idle timer elapsed) or
 *   `'superseded'` (its name was just claimed by a different session while it
 *   still had live descendants) — the two wordings a founder needs to tell
 *   apart "this seat is unusually busy" from "this is an old conversation
 *   finishing up after a rename." Defaults to `'idle'` for existing callers.
 * @returns the log level and message for this tick, or `undefined` when this
 *   tick reannounces nothing.
 */
function describeBlockedResident(
  name: string,
  sessionId: SessionId,
  blockedTicks: number,
  reason: 'idle' | 'superseded' = 'idle',
): { readonly escalate: boolean; readonly message: string } | undefined {
  if (blockedTicks !== 1 && blockedTicks % DESCENDANT_REANNOUNCE_TICKS !== 0) return undefined
  const escalate = blockedTicks >= DESCENDANT_ESCALATE_TICKS
  const message = reason === 'superseded'
    ? `mailbox-bridge: seat "${name}"'s previous conversation (${sessionId}) is being kept alive after the name moved to a new session — `
      + 'live background subagents are still running on it, so it has not been disposed yet'
      + (escalate
        ? '; this has now run far longer than one idle window is meant to mean — '
          + 'check its background work if this conversation should not still be running'
        : '')
    : `mailbox-bridge: seat "${name}" (${sessionId}) is staying resident past its idle window — `
      + 'live background subagents are still running, so it is being kept open rather than retired'
      + (escalate
        ? '; this has now run far longer than one idle window is meant to mean — '
          + 'check its background work if this seat should not still be running'
        : '')
  return { escalate, message }
}

/**
 * Flush the resident's session, dispose its agent, and release its own
 * per-session lock — the disposal tail shared by every teardown path
 * (idle retirement, `release()`'s immediate bypass, and supersession).
 * Neither caller can await this (a fired timer and a synchronous `release()`
 * call are both void contexts), so a flush failure is logged rather than
 * swallowed; disposal still runs regardless, so the lock never waits on a
 * dead resident.
 * @param ctx - plugin context carrying the session store service.
 * @param name - the seat name this resident was retained under, for the log.
 * @param handle - the resident agent handle being torn down.
 * @param lock - the resident's own per-session lock.
 */
function flushAndDispose(ctx: Context, name: string, handle: AgentHandle, lock: NamedSessionLock): void {
  const sessions = ctx.get('sessions')
  void (sessions === undefined
    ? handle.dispose()
    : sessions.flush(handle.agent.session).catch((error: unknown) => {
      ctx.logger.warn(`mailbox-bridge: final flush for retiring resident "${name}" (${handle.agent.session.id}) failed: ${String(error)}`)
    }).then(() => handle.dispose()))
  lock.release()
}

/**
 * Log one blocked-recheck announcement at the right level, or do nothing —
 * shared by the idle-retire and supersede recheck loops below so the
 * warn/error dispatch lives in exactly one place.
 * @param ctx - plugin context carrying the logger.
 * @param announcement - {@link describeBlockedResident}'s verdict for this
 *   tick, or `undefined` when this tick reannounces nothing.
 */
function logBlockedAnnouncement(
  ctx: Context,
  announcement: { readonly escalate: boolean; readonly message: string } | undefined,
): void {
  if (announcement === undefined) return
  if (announcement.escalate) ctx.logger.error(announcement.message)
  else ctx.logger.warn(announcement.message)
}

/**
 * Keep one woken agent resident under this bridge's pen: the per-name lock
 * stays held (stray headless runs refuse cleanly), the agent stays registered
 * so the operator's composer and later mail steer it in place, and an idle
 * timer flushes, disposes the agent, and releases the lock after `idleMs` —
 * unless the seat still has a live continuable descendant, in which case the
 * founder's ruling applies: nothing here stops, cancels, or drains that
 * descendant (that would silently orphan or kill work the seat's own
 * conversation may still depend on), so the timer defers instead of retiring.
 *
 * A prior resident already registered under `name` (this same seat, renamed
 * to a fresh session id) is superseded, not released: see
 * {@link ResidentSeat.supersede}'s own doc for the founder's ruling this
 * carries out. The old resident is never reachable under `name` again — this
 * function always takes over the map slot regardless of what the previous
 * resident is still doing — so its own disposal proceeds independently.
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
  // The name belongs to THIS resident from here on; whatever the previous
  // occupant is still finishing runs its own independent course (see
  // `supersede()` below) and never touches this map entry again.
  const previous = spec.residents.get(name)
  previous?.supersede()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Consecutive recheck ticks spent blocked on a live descendant; reset
  // whenever a real delivery proves the seat is in ordinary use again (idle
  // path), or when this resident is itself superseded and starts a fresh
  // count for the new reason (see `supersede()`).
  let blockedTicks = 0
  // The unconditional teardown for THIS resident's own current occupancy of
  // `spec.residents`: flush, dispose, release the lock, and only then drop
  // the map entry — guarded by identity so a resident that has since been
  // superseded (its map slot handed to a fresh generation) can never delete
  // whatever a later resident put there. `release()` calls this directly and
  // unconditionally: host teardown must not hang a process exit on a runaway
  // subagent. `retire()` below falls through to it once no live descendant
  // remains. This is NOT the rename case any more — a name reassigned to a
  // fresh session goes through `supersede()`, which shares the flush/dispose/
  // release tail (`flushAndDispose`) but deliberately never touches the map.
  const hardRetire = (): void => {
    if (spec.residents.get(name) === resident) spec.residents.delete(name)
    flushAndDispose(ctx, name, handle, lock)
  }
  // The idle-driven retire: a seat with a live continuable descendant does
  // not retire — the idle clock only starts once every descendant is gone.
  // A manager-less composition (`ctx.get('subagents')` absent) has never
  // materialized a descendant, so it falls straight through to `hardRetire`,
  // exactly reproducing the pre-existing behavior for every deployment that
  // does not mount the subagent runtime at all.
  const retire = (): void => {
    if (ctx.get('subagents')?.hasLiveDescendants(handle.agent) ?? false) {
      blockedTicks += 1
      // Never a silent fence: a founder watching the log must be able to
      // learn why this seat has not gone away without reading source.
      logBlockedAnnouncement(ctx, describeBlockedResident(name, handle.agent.session.id, blockedTicks, 'idle'))
      timer = setTimeout(retire, Math.min(idleMs, DESCENDANT_RECHECK_MS))
      timer.unref()
      return
    }
    hardRetire()
  }
  // The supersede-driven drain: reruns the exact same live-descendant check
  // and recheck cadence as `retire()` above (same constants, same
  // `describeBlockedResident` cadence, same `logBlockedAnnouncement`), but
  // its terminal action is `flushAndDispose` directly rather than
  // `hardRetire` — this resident is no longer `spec.residents.get(name)` by
  // the time anyone could look, so it must never touch that entry. Reuses
  // this same closure's `timer`/`blockedTicks` rather than allocating fresh
  // ones: once `supersede()` runs, nothing else in this closure (`arm`,
  // `retire`, `keepAlive`) is ever invoked again, so there is no shared-state
  // hazard in taking them over.
  const retireSuperseded = (): void => {
    if (ctx.get('subagents')?.hasLiveDescendants(handle.agent) ?? false) {
      blockedTicks += 1
      logBlockedAnnouncement(ctx, describeBlockedResident(name, handle.agent.session.id, blockedTicks, 'superseded'))
      timer = setTimeout(retireSuperseded, Math.min(idleMs, DESCENDANT_RECHECK_MS))
      timer.unref()
      return
    }
    flushAndDispose(ctx, name, handle, lock)
  }
  const resident: ResidentSeat = {
    keepAlive(): void {
      if (timer !== undefined) clearTimeout(timer)
      blockedTicks = 0
      arm()
    },
    release(): void {
      if (timer !== undefined) clearTimeout(timer)
      hardRetire()
    },
    supersede(): void {
      // Cancel whatever this resident's own machinery still has pending —
      // its idle-arm wait, or an in-progress idle-retire recheck — before
      // starting the independent supersede drain below. Without this, a
      // stale `retire()` tick could still fire later and call `hardRetire`,
      // which would delete the NEW resident's entry out from under it (by
      // name, not by identity) even though `hardRetire`'s own identity guard
      // exists precisely to stop that.
      if (timer !== undefined) clearTimeout(timer)
      blockedTicks = 0
      retireSuperseded()
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
 * Resolve one seat's configured tool restriction from the org registry.
 *
 * A registry that will not load, or a name unknown to the roster, carries no
 * restriction: unlike {@link seatCwd} this never throws and never provisions
 * anything, it only widens or narrows a set of tools, so the safe default on
 * either doubt is unrestricted — the same "applies to nobody by default"
 * contract an absent `tools` field on a known seat already carries. Mirrors
 * {@link seatSessionId}'s shape: same two parameters, same registry read.
 * @param spec - resolved serving parameters carrying the registry path.
 * @param name - the seat name (which is also its address).
 * @returns the seat's configured rule, or undefined for no restriction.
 */
async function seatToolsRule(spec: BridgeSpec, name: string): Promise<SeatToolRestrictionRule | undefined> {
  let registry: OrgRegistry
  try {
    registry = await cachedRegistry(spec.orgRegistryPath)
  } catch {
    // A registry that will not load cannot know any seat's restriction, and
    // this is never the caller that should refuse for it — the registry
    // health check upstream (`judgmentRegistry` in `deliverLease`) already
    // owns that decision.
    return undefined
  }
  return seatEntry(registry, name)?.tools
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
 * A refusal generates no mail: it settles the recipient's row `failed` and
 * reports on the context bus (`mailbox/refused`), and the sender's session
 * receives the reason as a system notice. A bounce between seats would be
 * itself boundary-judged mail — refused in turn, leaving the sender silence —
 * so none is published. The refusal is loud either way: the failed row and
 * the context event both carry the reason.
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
 *
 * Also installs the seat's configured tool restriction, when it has one: the
 * rule is resolved from the registry before `setup` is defined (mirroring how
 * the model selection above it is resolved), then applied inside `setup`
 * against the real tool registry `setup` exposes — the same out-parameter
 * idiom the model-selection install two lines above already uses, since
 * `applySeatToolRestriction`'s outcome is only known once `setup` runs. A
 * seat with no configured rule leaves the box empty and nothing changes for
 * it: this wiring applies to nobody by default.
 * @param ctx - plugin context carrying the agent registry and default model.
 * @param spec - resolved serving parameters carrying the registry path.
 * @param sessionId - the derived durable session id to create.
 * @param cwd - the seat's own project directory, from the org registry.
 * @param name - the seat name (which is also its address), for its tool rule and attribution.
 * @throws {@link SeatMutedToolsError} when the resolved tool rule leaves the
 *   seat with no tools at all — caught in `deliverLease`, never here.
 */
async function createTarget(
  ctx: Context,
  spec: BridgeSpec,
  sessionId: ReturnType<typeof deriveNamedSessionId>,
  cwd: string,
  name: string,
): Promise<AgentHandle> {
  // The SEAT's directory, never `process.cwd()`. The host's cwd is wherever it
  // was launched from — systemd sets none, so it resolves to the home directory
  // — and the UI groups sessions by cwd. A seat provisioned with the host's cwd
  // is filed under a workspace nobody opens: the session is live and correct and
  // simply cannot be found. That is the "ghost session" class.
  return composeSeatAgent(ctx, spec, name, 'wake', (agentOptions, setup) =>
    ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup }))
}

/**
 * Cold-resume the dormant agent owning `sessionId`, composing the same model
 * selection path the host's direct runner uses. Missing model wiring fails
 * loud here rather than delivering a silently de-tuned turn.
 *
 * Also installs the seat's configured tool restriction on every resume, same
 * as {@link createTarget} — a seat's tools must stay restricted across a cold
 * resume, not only at its first creation, and this is the one path every
 * resume goes through regardless of which caller resumed it (the drain's own
 * wake, or a refusal notice resuming a dormant sender).
 * @param ctx - plugin context carrying the agent registry and default model.
 * @param spec - resolved serving parameters carrying the registry path.
 * @param sessionId - the derived durable session id to resume.
 * @param name - the seat name (which is also its address), for its tool rule and attribution.
 * @throws {@link SeatMutedToolsError} when the resolved tool rule leaves the
 *   seat with no tools at all. `deliverLease` catches it for the drain's own
 *   wake path; `injectRefusalNotice`'s call (resuming a dormant SENDER to
 *   notice it) already wraps this in a best-effort catch-all, so a sender
 *   that happens to be muted itself degrades to "notice not logged" rather
 *   than a second refusal.
 */
async function resumeTarget(
  ctx: Context,
  spec: BridgeSpec,
  sessionId: ReturnType<typeof deriveNamedSessionId>,
  name: string,
): Promise<AgentHandle> {
  return composeSeatAgent(ctx, spec, name, 'cold-resume', (agentOptions, setup) =>
    ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup }))
}

/**
 * Thrown from inside a seat's `setup` callback ({@link composeSeatAgent})
 * when its configured tool restriction would leave it with NO tools at all —
 * `applySeatToolRestriction`'s `remaining` comes back empty. Deliberately a
 * THROW rather than a silently-returned muted outcome: `AgentSetup`'s own
 * contract (see `@deepseek-ai/dsh-agent`) rolls the whole creation/resume
 * back without ever publishing the session or agent id when setup throws, so
 * this is what makes "the agent is never created or resumed" true at the
 * actual registry-publish boundary, not just true by convention. A seat this
 * narrow cannot call `mailbox_send` to report its own condition, so it must
 * never exist in composed form at all — the mail addressed to it is refused
 * at its source instead (see the `catch` in {@link deliverLease}, the only
 * place this is caught, where the claimed lease is in scope to route through
 * `refuse()`).
 */
class SeatMutedToolsError extends Error {
  constructor(
    readonly seatName: string,
    readonly outcome: SeatToolRestrictionOutcome,
  ) {
    super(`seat "${seatName}": configured tool restriction leaves it with no tools at all`)
    this.name = 'SeatMutedToolsError'
  }
}

/**
 * Emit the live signal for one seat tool-restriction outcome: the durable
 * append (or, for a muted outcome, the refusal `deliverLease` performs
 * instead) is the outlet that survives a reload, and this is the one a
 * listener watching right now can observe. Kept as its own function because
 * both the ordinary post-composition path and the muted/aborted path in
 * `deliverLease` need to raise the identical event shape, and this is the
 * one place that decides what "identical" means.
 * @param ctx - plugin context carrying the mailbox registry.
 * @param seatName - the seat the restriction was computed for.
 * @param outcome - the effective rule, missing names, and surviving tool set.
 */
function emitSeatToolsRestricted(ctx: Context, seatName: string, outcome: SeatToolRestrictionOutcome): void {
  ctx.emit('mailbox/seat-tools-restricted', {
    seatName,
    muted: outcome.remaining.length === 0,
    degraded: outcome.missing.length > 0,
    missing: outcome.missing,
    remaining: outcome.remaining,
  })
}

/**
 * The one composition path both {@link createTarget} and {@link resumeTarget}
 * run through, so a seat is composed identically however it came to be awake.
 * Only the minting call differs between them, which is what `mint` carries.
 *
 * Kept as one function deliberately: the two callers previously held byte-identical
 * bodies, and a seat that was restricted on first creation but not on cold resume
 * — or noticed on one path and silently not the other — is exactly the kind of
 * half-applied fence this whole feature exists to avoid.
 *
 * A muted outcome aborts composition entirely: `setup` throws
 * {@link SeatMutedToolsError} instead of recording the outcome for the
 * post-mint notice, so `mint()` rejects and no agent or session is ever
 * published for this seat. That rejection is deliberately NOT caught here —
 * only `deliverLease` (the caller with the claimed lease in scope) can turn
 * it into a refusal, so it propagates through {@link createTarget} and
 * {@link resumeTarget} unmodified.
 * @param ctx - plugin context carrying the agent registry and default model.
 * @param spec - resolved serving parameters carrying the registry path.
 * @param name - the seat name (which is also its address), for its tool rule and attribution.
 * @param requirement - names the caller in the missing-model error, so a failure says which path needed it.
 * @param mint - creates or resumes the agent with the composed options.
 * @throws {@link SeatMutedToolsError} when the seat's configured tool
 *   restriction leaves it with no tools at all.
 */
async function composeSeatAgent(
  ctx: Context,
  spec: BridgeSpec,
  name: string,
  requirement: string,
  mint: (agentOptions: { provider: string; model: string }, setup: AgentSetup) => Promise<AgentHandle>,
): Promise<AgentHandle> {
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel === undefined) {
    throw new Error(`mailbox-bridge: ${requirement} requires the default model-selection service`)
  }
  const selection = defaultModel.currentSelection()
  const rule = await seatToolsRule(spec, name)
  let restriction: SeatToolRestrictionOutcome | undefined
  const setup: AgentSetup = (agentCtx): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
    const outcome = applySeatToolRestriction(agentCtx, name, rule)
    if (outcome !== undefined && outcome.remaining.length === 0) {
      // Thrown, not recorded: see the class doc for why this has to abort
      // the mint rather than let a muted seat finish composing.
      throw new SeatMutedToolsError(name, outcome)
    }
    restriction = outcome
  }
  const handle = await mint({ provider: selection.provider, model: selection.model }, setup)
  // Setup composes, it never drives (see its own contract) — the durable
  // notice of what setup did is appended here, after creation resolves,
  // mirroring the refusal notice's append through the returned handle.
  // `restriction` is NEVER a muted outcome here: that branch above threw and
  // this line was never reached for it.
  if (restriction !== undefined) {
    handle.agent.session.append('user/message', seatToolRestrictionUserMessage(name, restriction), { surfaceOp: 'append' })
    emitSeatToolsRestricted(ctx, name, restriction)
  }
  return handle
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

/**
 * One drain-time admission refusal, carried on the context bus. The refusal
 * is the harness reporting on the SENDER's own action — not correspondence
 * from the recipient — so it rides the bus instead of the mail store.
 */
export interface MailboxRefusal {
  /** Sender address as published; a `guest:` sender rides the outside-operator channel. */
  readonly from: string
  /** Recipient address the refused lease was addressed to. */
  readonly to: string
  /** The terminal refusal reason recorded on the recipient's failed row. */
  readonly reason: string
}

/**
 * One drain-time (or cold-resume) seat tool-restriction outcome, carried on
 * the context bus. Mirrors the durable notice's structured fields — see
 * {@link SeatToolRestrictionNoticeSource} for why `degraded` and `muted` are
 * kept as two separate booleans rather than blended into one.
 */
export interface SeatToolsRestricted {
  /** The seat the restriction was applied to. */
  readonly seatName: string
  /** Whether the seat's effective tool set is empty — it has no tools at all. */
  readonly muted: boolean
  /** Whether at least one configured tool name was not currently known and was dropped. */
  readonly degraded: boolean
  /** Configured names that were not currently known, in configured order; empty when not degraded. */
  readonly missing: readonly string[]
  /** The tool names the seat is actually left with, sorted; empty when muted. */
  readonly remaining: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Union of every mounted bridge's serving roster in mount order. */
    mailboxBridgeSpecs?: MailboxBridgeSpecs
  }

  interface Events {
    /**
     * The bridge refused a claimed lease terminally at admission — registry
     * health, the `test: true` boundary, org topology, sender admission, or a
     * loop guard — and settled the recipient's row `failed` with the same
     * reason. This event is the refusal's LIVE sender-facing outlet, in place
     * of a bounce message: a bounce would itself be subject to the rule that
     * refused the original and would be refused in turn. Listeners render it
     * where its sender will see it now (the host's api-proxy addresses a
     * `host/agent-error` frame to the sender's session); the DURABLE outlet is
     * the notice node `injectRefusalNotice` logs into the sender's session
     * from the same `refuse` call, which does not depend on anyone watching a
     * live stream. A `guest:` sender has no session and reaches nobody through
     * either outlet. Listener failures are logged and contained by Cordis
     * dispatch.
     * @param refusal - the sender and recipient addresses and the terminal reason.
     * @mode emit
     */
    'mailbox/refused'(refusal: MailboxRefusal): void

    /**
     * A seat's configured tool restriction was resolved at create or
     * cold-resume, in one of two shapes:
     *
     * - `muted: false` — `composeSeatAgent` applied it and the seat composed
     *   normally. This event is the restriction's LIVE outlet, emitted
     *   alongside (never instead of) the durable notice node
     *   `seatToolRestrictionUserMessage` appends into the seat's OWN
     *   session — that durable append is the outlet that does not depend on
     *   anyone watching a live stream, and this event is the one that
     *   reaches a listener right now.
     * - `muted: true` — the rule left the seat with NO tools at all, so
     *   `composeSeatAgent`'s `setup` threw {@link SeatMutedToolsError}
     *   before anything was ever published; the seat was never composed, so
     *   it has no session to notice. `deliverLease` catches that error,
     *   warns the host log, emits this event, and routes the mail through
     *   `refuse()` instead — whose own `mailbox/refused` event and durable
     *   SENDER-side notice report the refusal itself. This event exists
     *   alongside that one because `mailbox/refused` carries only
     *   `{ from, to, reason }`: this is the richer, domain-specific record
     *   of WHY — the missing/remaining tool names a listener would otherwise
     *   have to parse back out of the reason string.
     *
     * Listener failures are logged and contained by Cordis dispatch.
     * @param restriction - the seat, the effective outcome, and the muted/degraded conditions.
     * @mode emit
     */
    'mailbox/seat-tools-restricted'(restriction: SeatToolsRestricted): void
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
 * Also carries the idle-retire logging thresholds and their pure decision
 * function, so a test can exercise the reannounce/escalate cadence directly
 * instead of waiting on real recheck timers.
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
  describeBlockedResident,
  DESCENDANT_REANNOUNCE_TICKS,
  DESCENDANT_ESCALATE_TICKS,
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

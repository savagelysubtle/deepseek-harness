/**
 * The mailbox consumer: a polling bridge that turns claimed messages into
 * delivered user-role turns on the addressed named-session agents. Routing is
 * pure derivation — the address's name half IS the session name, so no
 * directory lives here. One drain cycle claims up to `maxClaimPerCycle`
 * messages and routes each:
 *
 * 1. **Live in-process** — the derived session id resolves through
 *    `ctx.agents`: deliver steering into the running turn (queue fallback),
 *    settle `done` at admission.
 * 2. **Dormant** — take the per-name residency lock, probe persistence for
 *    the derived id: an absent log settles `failed` with reason
 *    `unknown-address`; a present log cold-resumes the agent, delivers as a
 *    queued FIFO turn, settles `done` AT ADMISSION, awaits quiescence,
 *    flushes, and disposes the handle before releasing the lock.
 * 3. **Resident elsewhere** — lock acquisition loses to a live holder: settle
 *    `pending` so a later cycle retries.
 *
 * @module @deepseek-ai/dsh-mailbox-bridge
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentSetup, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  acquireNamedSessionLock,
  deriveNamedSessionId,
  type NamedSessionLock,
} from '@deepseek-ai/dsh-named-sessions'
import { parseMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import type { MailboxAddress, MailboxClaimFilter, MailboxLease, MailboxMessageId } from '@deepseek-ai/dsh-mailbox'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { admittedOutcome, relayUserMessage } from './delivery.ts'

export { admittedOutcome, HEADLESS_BACKLOG_LIMIT, HEADLESS_BACKLOG_STALE_CLAIM_MS, relaySource, relayText, relayUserMessage } from './delivery.ts'

/** Default pause between drain cycles. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000

/** Default per-cycle claim batch bound. */
export const DEFAULT_MAX_CLAIM_PER_CYCLE = 10

/** Default age past which another claimer's abandoned lease is reclaimable. */
export const DEFAULT_STALE_CLAIM_MS = 60_000

/** Plugin configuration. */
export interface Config {
  /**
   * The full `<namespace>:<name>` addresses the bridge serves. Every grammar
   * violation fails schema-adjacent resolution at mount; routing derives each
   * target's session id from the name half with no second encoding.
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
   * Sender namespaces whose mail this bridge's addresses will accept. Empty
   * (the default) admits no external-origin mail at all: an outside writer
   * bypasses every write-side check by construction, so admission is decided
   * here at drain, where the store can actually enforce it.
   */
  readonly admitFromNamespaces?: readonly string[]
}

/** Schemastery validator for {@link Config}. */
export const Config = z.object({
  addresses: z.array(z.string()),
  pollIntervalMs: z.number().step(1).min(1).default(DEFAULT_POLL_INTERVAL_MS),
  maxClaimPerCycle: z.number().step(1).min(1).default(DEFAULT_MAX_CLAIM_PER_CYCLE),
  staleClaimMs: z.number().step(1).min(1).default(DEFAULT_STALE_CLAIM_MS),
  lockStaleMs: z.number().step(1).min(1),
  admitFromNamespaces: z.array(z.string()),
})

/** Resolved serving parameters; every fallback decision happens here once. */
export interface BridgeSpec {
  /** Branded, grammar-validated served addresses. */
  readonly addresses: readonly MailboxAddress[]
  readonly pollIntervalMs: number
  readonly maxClaimPerCycle: number
  readonly staleClaimMs: number
  readonly lockStaleMs: number | undefined
  /** Sender namespaces admitted beyond each address's own namespace. */
  readonly admitFromNamespaces: readonly string[]
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
    throw new Error('mailbox-bridge: addresses must name at least one served "<namespace>:<name>" endpoint')
  }
  return {
    addresses: rawAddresses.map(address => parseMailboxAddress(address)),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxClaimPerCycle: config.maxClaimPerCycle ?? DEFAULT_MAX_CLAIM_PER_CYCLE,
    staleClaimMs: config.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS,
    lockStaleMs: config.lockStaleMs,
    admitFromNamespaces: config.admitFromNamespaces ?? [],
  }
}

/**
 * Deliver one claimed lease to its live agent: steering interrupts a running
 * turn first (Steve directive — publish-side wake must land promptly), and any
 * rejection falls back to an ordinary queued turn. Either way admission is
 * immediate; the caller settles.
 * @param agent - the live agent addressed by the lease.
 * @param message - the rendered delivery turn.
 */
function deliverToLive(agent: Agent, message: UserMessage): void {
  if (agent.status === 'idle') {
    agent.followup(message)
    return
  }
  try {
    agent.steer(message)
  } catch {
    // A turn boundary refused the interruption between status read and steer;
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
async function deliverLease(ctx: Context, spec: BridgeSpec, lease: MailboxLease): Promise<RouteResult> {
  const mailbox = ctx.mailbox
  // Drain-time admission (the store cannot police an external writer): a
  // sender namespace must be one this roster serves or explicitly admitted.
  // An unparseable `from` fails closed like any foreign namespace.
  const fromSeparator = lease.message.from.indexOf(':')
  const senderNamespace = fromSeparator <= 0 ? lease.message.from : lease.message.from.slice(0, fromSeparator)
  const servedNamespaces = spec.addresses.map(address => String(address).slice(0, String(address).indexOf(':')))
  if (!servedNamespaces.includes(senderNamespace) && !spec.admitFromNamespaces.includes(senderNamespace)) {
    await mailbox.settle(lease.leaseRef, { state: 'failed', result: { reason: 'sender-not-admitted' } })
    return { kind: 'failed', reason: 'sender-not-admitted' }
  }
  // Both halves of every served address were grammar-checked at mount, so the
  // name half slices out directly — routing adds no second encoding.
  const separatorAt = lease.message.to.indexOf(':')
  const name = lease.message.to.slice(separatorAt + 1)
  const sessionId = deriveNamedSessionId(name)

  const live = ctx.agents.get(sessionId)
  if (live !== undefined) {
    deliverToLive(live, relayUserMessage(lease))
    await mailbox.settle(lease.leaseRef, admittedOutcome(lease))
    return { kind: 'done' }
  }

  let lock: NamedSessionLock | undefined
  try {
    // Losing the acquire means a live process holds residency elsewhere: defer
    // without waiting out any staleness window.
    lock = acquireNamedSessionLock(name, spec.lockStaleMs === undefined ? {} : { maxAgeMs: spec.lockStaleMs })
  } catch {
    await mailbox.settle(lease.leaseRef, { state: 'pending', result: undefined })
    return { kind: 'pending' }
  }
  try {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('mailbox-bridge: cold-resume requires a configured session-persistence backend')
    }
    const persisted = (await persistence.list()).some(header => header.id === sessionId)
    if (!persisted) {
      await mailbox.settle(lease.leaseRef, { state: 'failed', result: { reason: 'unknown-address' } })
      return { kind: 'failed', reason: 'unknown-address' }
    }
    const { agent, dispose } = await resumeTarget(ctx, sessionId)
    try {
      // A freshly resumed agent takes the delivery as an ordinary FIFO turn;
      // steering a cold resume would skip reconstructing prior context.
      agent.followup(relayUserMessage(lease))
      await mailbox.settle(lease.leaseRef, admittedOutcome(lease))
      await agent.whenIdle()
      const sessions = ctx.get('sessions')
      if (sessions === undefined) throw new Error('mailbox-bridge: cold-resume requires the session store service')
      await sessions.flush(agent.session)
    } finally {
      await dispose()
    }
    return { kind: 'done' }
  } finally {
    lock.release()
  }
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
        await ctx.mailbox.settle(lease.leaseRef, {
          state: 'failed',
          result: { reason },
        }).catch(() => {
          // The settlement surface itself is down; re-raising would mask its cause.
        })
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
  }, 'mailbox-bridge.poll')
}

/** What the wire reports about one woken message. */
export type MailboxWakeDisposition = 'delivered' | 'queued'

/** Addressed publish input shared by every wire caller. */
export interface PublishAndWakeRequest {
  /** Destination address in the `<namespace>:<name>` grammar. */
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

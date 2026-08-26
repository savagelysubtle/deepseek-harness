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
import type { MailboxAddress, MailboxClaimFilter, MailboxLease } from '@deepseek-ai/dsh-mailbox'
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
}

/** Schemastery validator for {@link Config}. */
export const Config = z.object({
  addresses: z.array(z.string()),
  pollIntervalMs: z.number().step(1).min(1).default(DEFAULT_POLL_INTERVAL_MS),
  maxClaimPerCycle: z.number().step(1).min(1).default(DEFAULT_MAX_CLAIM_PER_CYCLE),
  staleClaimMs: z.number().step(1).min(1).default(DEFAULT_STALE_CLAIM_MS),
  lockStaleMs: z.number().step(1).min(1),
})

/** Resolved serving parameters; every fallback decision happens here once. */
export interface BridgeSpec {
  /** Branded, grammar-validated served addresses. */
  readonly addresses: readonly MailboxAddress[]
  readonly pollIntervalMs: number
  readonly maxClaimPerCycle: number
  readonly staleClaimMs: number
  readonly lockStaleMs: number | undefined
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
 */
async function deliverLease(ctx: Context, spec: BridgeSpec, lease: MailboxLease): Promise<void> {
  const mailbox = ctx.mailbox
  // Both halves of every served address were grammar-checked at mount, so the
  // name half slices out directly — routing adds no second encoding.
  const separatorAt = lease.message.to.indexOf(':')
  const name = lease.message.to.slice(separatorAt + 1)
  const sessionId = deriveNamedSessionId(name)

  const live = ctx.agents.get(sessionId)
  if (live !== undefined) {
    deliverToLive(live, relayUserMessage(lease))
    await mailbox.settle(lease.leaseRef, admittedOutcome(lease))
    return
  }

  let lock: NamedSessionLock | undefined
  try {
    // Losing the acquire means a live process holds residency elsewhere: defer
    // without waiting out any staleness window.
    lock = acquireNamedSessionLock(name, spec.lockStaleMs === undefined ? {} : { maxAgeMs: spec.lockStaleMs })
  } catch {
    await mailbox.settle(lease.leaseRef, { state: 'pending', result: undefined })
    return
  }
  try {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('mailbox-bridge: cold-resume requires a configured session-persistence backend')
    }
    const persisted = (await persistence.list()).some(header => header.id === sessionId)
    if (!persisted) {
      await mailbox.settle(lease.leaseRef, { state: 'failed', result: { reason: 'unknown-address' } })
      return
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

/**
 * Run one drain pass: claim a bounded batch across the roster and route every
 * lease. A per-lease failure settles `failed` with the reason instead of
 * wedging the roster behind one poison message.
 * @param ctx - plugin context carrying the mailbox registry and core services.
 * @param spec - resolved serving parameters.
 */
async function drainOnce(ctx: Context, spec: BridgeSpec): Promise<void> {
  const filter: MailboxClaimFilter = {
    addresses: spec.addresses,
    limit: spec.maxClaimPerCycle,
    staleClaimMs: spec.staleClaimMs,
  }
  const leases = await ctx.mailbox.claim(filter)
  for (const lease of leases) {
    try {
      await deliverLease(ctx, spec, lease)
    } catch (error) {
      await ctx.mailbox.settle(lease.leaseRef, {
        state: 'failed',
        result: { reason: error instanceof Error ? `${error.message}` : String(error) },
      }).catch(() => {
        // The settlement surface itself is down; re-raising would mask its cause.
      })
    }
  }
}

/** Stable Cordis plugin name. */
export const name = 'mailbox-bridge'

/** Core services required before any cycle can route deliveries. */
export const inject = ['mailbox', 'agents']

/** One drain pass without the interval wrapper — the unit-test surface. */
export const internals = { drainOnce }

/**
 * Mount the drain loop. The first cycle runs inline so structural faults — an
 * unregistered default provider, a malformed roster — fail the mount itself;
 * later cycles stay periodic, single-flight, and loud on structural failure.
 * @param ctx - plugin context carrying the mailbox registry and core services.
 * @param config - validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const spec = resolveBridgeSpec(config)
  let draining = false
  const cycle = (): void => {
    if (draining) return
    draining = true
    void drainOnce(ctx, spec)
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
  await drainOnce(ctx, spec)
  const timer = setInterval(cycle, spec.pollIntervalMs)
  // Unref'd: the drain loop must not pin its host's event loop. Deployments
  // that exist only to serve mail hold themselves up through other handles.
  timer.unref()
  ctx.effect(() => () => {
    clearInterval(timer)
  }, 'mailbox-bridge.poll')
}

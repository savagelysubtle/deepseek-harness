/**
 * Service Definition for the subagent capability seam (`ctx.subagents`): a named-provider registry plus a
 * capability-validating asynchronous start API. Providers establish a
 * child before returning its run, so fulfillment is the single publication and
 * ownership-transfer boundary.
 *
 * Unlike the bash seam (one executor per context, second load throws), MULTIPLE
 * providers coexist here: each registers under a unique name and a caller picks
 * one by name. The shape mirrors the LLM adapter registry
 * (`LlmRuntime.registerAdapter`), not the single-service bash executor.
 *
 * This package owns the Service Definition role of the capability seam. Service Providers
 * (`@deepseek-ai/dsh-subagent-spawn-in-process`, `-fork`, `-acp`) and the model-facing
 * consumer (`@deepseek-ai/dsh-tool-subagent`) are separate packages.
 *
 * Public operations express caller intent: `start` returns one published owned
 * one-shot run, `startContinuable` establishes a durable continuable child, and
 * `followup` delivers later content without exposing whether the child is
 * resident. Continuable children never become a {@link SubagentRun}: the
 * continuation manager holds their `AgentHandle` directly and orders every turn
 * through the child's own inbox, so providers contribute only the detached
 * creation spec and see no handle, turn, or teardown. Child and descendant
 * discovery read the live session store and optional session persistence
 * directly and do not require that continuation runtime.
 *
 * Same-process providers are trusted typed collaborators. Requests, provider
 * descriptors, results, and lifecycle payloads are borrowed immutable values;
 * serialization and hostile-input validation belong at real process, worker,
 * persistence, and model boundaries.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentStartRequest,
} from './types.ts'
import { SubagentError } from './error.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { createActivationObserver, createLifecycleEmitter, observeRun } from './lifecycle.ts'
import type { ActivationObserver, LifecycleEmitter } from './lifecycle.ts'
import SubagentContinuationManager from './continuation.ts'
import type {
  ContinuableStart,
  ContinuableStartSpec,
  SubagentAwaitSettlementResult,
  SubagentFollowupOptions,
  SubagentInterruptAuthority,
  SubagentReportOptions,
} from './continuation.ts'
import SubagentActivationSetupRegistry from './activation-setup-registry.ts'
import type { ContinuableSetupContribution } from './activation-setup-registry.ts'
import { listChildren as listSubagentChildren, listDescendants as listSubagentDescendants } from './list-children.ts'
import type { SubagentDescendantListEntry, SubagentListEntry } from './list-children.ts'
import { snapshotSubagentDescriptor } from './descriptor.ts'
import {
  subagentIdentityProjectionDefinition,
  subagentSettlementProjectionDefinition,
  subagentTimingProjectionDefinition,
} from './projection.ts'

export * from './out-of-process.ts'
export { AssistantOutputFold, finalAssistantOutput } from './assistant-output.ts'
export { SubagentRunId } from './types.ts'
export type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
  SubagentStopReasonMap,
} from './types.ts'
export {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  SUBAGENT_DESCRIPTOR_VERSION,
} from './descriptor.ts'
export type {
  ContinuableSubagentDescriptorData,
  ContinuableSubagentDescriptorInput,
  OneShotSubagentDescriptorData,
  OneShotSubagentDescriptorInput,
  SubagentDescriptorData,
  SubagentDescriptorInput,
} from './descriptor.ts'
export { seedDescriptorTurn } from './descriptor-seed.ts'
export { SubagentError } from './error.ts'
export { settleRun } from './run-settlement.ts'
export { assertSubagentMaxDepth, delegationDepthOf } from './depth.ts'
export {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  resolveChildAgentOptions,
  resolveChildDepth,
  SubagentDepthError,
} from './child-agent.ts'
export type { ChildComposition, DelegatedPolicyOverrides } from './child-agent.ts'
export type {
  ContinuableStart,
  ContinuableStartSpec,
  CoordinatorMessageSource,
  SubagentAwaitSettlementResult,
  SubagentFollowupOptions,
  SubagentInterruptAuthority,
  SubagentReportDelivery,
  SubagentReportMessageSource,
  SubagentReportOptions,
  SubagentSettledMessageSource,
} from './continuation.ts'
export { MAX_AWAIT_SETTLEMENT_DEADLINE_MS } from './continuation.ts'
export type { ContinuableSetupContribution } from './activation-setup-registry.ts'
export type { SubagentDescendantListEntry, SubagentListEntry } from './list-children.ts'
export type { SubagentRunEndInfo, SubagentRunInfo } from './types.ts'
export type { SubagentIdentityProjection, SubagentTimingProjection } from './projection-types.ts'
export type { SubagentSettlementProjection } from './projection-types.ts'
export {
  foldSubagentSettlement,
  snapshotSubagentSettlement,
  SUBAGENT_SETTLEMENT_VERSION,
} from './settlement.ts'
export type { SubagentSettlementData } from './settlement.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }

  interface Events {
    /**
     * A provider became resolvable in the registry.
     * @param provider - the registered provider.
     * @mode emit
     */
    'subagent/provider-added'(provider: SubagentProvider): void
    /**
     * A provider left the registry. Accepted runs remain holder-owned.
     * @param name - the provider name that no longer resolves.
     * @mode emit
     */
    'subagent/provider-removed'(name: string): void
    /**
     * A provider established a published child. For in-process providers,
     * `ctx.agents.get(info.id)` resolves during this notification.
     * Scope-filtered dispatch keys the carrier by the delegating parent, so a
     * parent-scoped listener observes only its own delegations. Paired with
     * `subagent/end`.
     * @param info - the provider and published child identity.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
    /**
     * A published child settled. Scope-filtered dispatch uses the same delegating
     * parent carrier as `subagent/start`, so the lifecycle pair reaches the
     * same scoped audience.
     * @param info - the run identity and terminal outcome.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
  }
}

/** Whether one `UserMessage` is a settlement notice/report sourced from `childId`. */
function isSettlementMessageFrom(message: UserMessage, childId: SessionId): boolean {
  return (message.source.kind === 'subagent-settled' || message.source.kind === 'subagent-report')
    && message.source.senderSessionId === childId
}

/**
 * Whether `error` is {@link listChildren} reporting that this deployment
 * never mounted the `sessionProjections` registry its listing read requires
 * — a permanent, deployment-wide condition, never a transient per-read
 * failure. Distinguishes that case for
 * {@link SubagentRuntime.discoverOutstandingSettlements}, which treats it as
 * "nothing discoverable, ever" rather than something to warn about and retry
 * on every agent's every step for the rest of the process. The session
 * store's own equivalent absence ({@link listChildren}'s other permanent
 * failure mode) is not special-cased here: every deployment that reaches
 * this seam at all mounts a session store, so that branch would be untested
 * dead weight rather than a real, observed condition.
 */
function isMissingListingCapability(error: unknown): boolean {
  return error instanceof SubagentError && error.code === 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE'
}

/**
 * Whether `agent` already carries a settlement notice from `childId` — a
 * `user/message` sourced `subagent-settled` or `subagent-report` naming it as
 * sender, committed to the session log, still queued in the inbox awaiting a
 * later claim, OR already claimed as part of the very step now proposing to
 * redeliver one. The idempotence check the `agent/pre-step` recheck performs
 * before ever synthesizing a redelivered notice: if the original push landed
 * (by either message source — a child that reported for itself before
 * settling also counts, exactly as `notifySettlement`'s own unconditional
 * contract treats it), nothing is synthesized.
 *
 * `claimedThisStep` matters for a reason the other two sources cannot cover:
 * `Inbox.claim()` runs before `agent/pre-step` dispatches, so the message a
 * waking notice is itself delivered through is no longer in `agent.inbox` by
 * the time this recheck runs on that very step — and it is not yet in
 * `agent.session.events` either, since the turn loop only appends a step's
 * claimed messages after every `agent/pre-step` listener (this one included)
 * has returned. Omitting it would make the recheck redeliver a second,
 * duplicate notice for the exact child the current step is already
 * delivering one for.
 * @param agent - the parent whose own log and pending inbox are scanned.
 * @param childId - the settled child to look for.
 * @param claimedThisStep - the current step's own claimed batch, from the
 *   same `agent/pre-step` dispatch this recheck runs inside of.
 */
function hasExistingSettlementNotice(
  agent: Agent,
  childId: SessionId,
  claimedThisStep: readonly UserMessage[],
): boolean {
  const logged = agent.session.events.some(event => (
    event.type === 'user/message' && isSettlementMessageFrom(event.data, childId)
  ))
  if (logged) return true
  const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn, ...claimedThisStep]
  return pending.some(message => isSettlementMessageFrom(message, childId))
}

/**
 * One child a parent's process-local bookkeeping still owes an account of:
 * durably settled, but not yet confirmed delivered to the parent's own log.
 */
interface OutstandingSettlement {
  /** The durable settlement's outcome, ready to redeliver without a re-read. */
  readonly outcome: SubagentResult['stopReason']
  /**
   * Set while the manager's own live push for this exact settlement is in
   * flight — between its durable append and `notifySettlement()` finishing —
   * so {@link SubagentRuntime.recheckSubagentSettlement} does not race it
   * into a duplicate. Cleared once that attempt finishes, successful or
   * not; the entry itself stays outstanding until a notice is confirmed in
   * the parent's own log.
   */
  pushInFlight: boolean
}

/** Named provider registry with one-shot runs, durable discovery, and continuable-child operations. */
export class SubagentRuntime extends Service {
  private providers = new Map<string, SubagentProvider>()
  private continuations: SubagentContinuationManager | undefined
  /** Deployment contributions composed into unpublished continuable children. */
  private readonly setupRegistry = new SubagentActivationSetupRegistry()
  /**
   * The contained lifecycle-edge publisher. Built here because scoped dispatch
   * keys its carrier by this exact service instance, whose own context filter
   * composes into the carrier.
   */
  private readonly emitLifecycle: LifecycleEmitter
  /**
   * Per-parent, process-local settlement bookkeeping: for each parent
   * {@link discoveredParents} or {@link trackOutstandingSettlement} has ever
   * touched, which of its direct children are durably settled but not yet
   * confirmed delivered to that parent's own log. Populated two ways: once,
   * lazily, by {@link discoverOutstandingSettlements} scanning the durable
   * `listChildren` ladder on that parent's very first pre-step this process
   * — so a cold-resumed parent that never spawned a child in THIS process
   * is still covered after a real restart — and live, by
   * {@link trackOutstandingSettlement}, as this process settles a child
   * itself, which may bootstrap this parent's entry before discovery has
   * ever run for it. An entry with no outstanding children is still present
   * with an empty inner `Map` once discovery has run: see
   * {@link discoveredParents} for why that scan's completion, not this
   * map's mere presence, is what {@link recheckSubagentSettlement} tests to
   * decide whether to skip the durable read.
   */
  private readonly outstandingByParent = new Map<SessionId, Map<SessionId, OutstandingSettlement>>()
  /**
   * Parents for which {@link discoverOutstandingSettlements} has completed
   * at least once this process (successfully, including an empty result;
   * never on a failed read). Kept independent of {@link outstandingByParent}
   * because {@link trackOutstandingSettlement} may bootstrap a parent's
   * entry in that map, live, before this parent has ever taken a pre-step —
   * e.g. a second child started and settled directly through the service
   * API without an intervening parent turn. Testing the map's mere presence
   * for "discovery already ran" would then skip discovery forever for that
   * parent, silently losing any OTHER child that settled durably before
   * this process started. This set is the one true "already discovered"
   * signal; {@link recheckSubagentSettlement} runs discovery once per parent
   * exactly when this set does not yet name it, regardless of what
   * {@link outstandingByParent} already holds for that parent.
   */
  private readonly discoveredParents = new Set<SessionId>()
  /**
   * Child ids whose settlement notice this process has already synthesized,
   * ever. Process-local and append-only, same shape as
   * {@link outstandingByParent}. Needed because `inject()` only queues onto
   * `next-step` — it does not become visible in `agent.session.events` or
   * `agent.inbox` until a *later* step claims it, and claiming happens before
   * the `agent/pre-step` dispatch that follows. A redelivered notice makes
   * `inbox.nextStep` non-empty, which keeps the current turn open for one
   * more step, whose own pre-step dispatch runs before the prior notice's
   * claim is committed anywhere observable — exactly the window in which
   * {@link hasExistingSettlementNotice} cannot yet see it. This memo closes
   * that window; the session-log scan remains the durable gate a fresh
   * process (after a restart) falls back to, since this set starts empty.
   */
  private readonly redeliveredSettlements = new Set<SessionId>()

  constructor(ctx: Context) {
    super(ctx, 'subagents')
    this.emitLifecycle = createLifecycleEmitter(this.ctx, parent => scopeTarget(this, parent))
    ctx.inject(['agents'], (childCtx: Context) => {
      const manager = new SubagentContinuationManager(childCtx, {
        prepareContinuable: (name, request) => this.prepareContinuable(name, request),
        observeActivation: (provider, childId, parent) => this.observeActivation(provider, childId, parent),
        trackOutstandingSettlement: (parentId, childId, outcome) => {
          this.trackOutstandingSettlement(parentId, childId, outcome)
        },
        clearPendingPush: (parentId, childId) => {
          this.clearPendingPush(parentId, childId)
        },
      }, this.setupRegistry)
      this.continuations = manager
      childCtx.effect(() => () => {
        /* v8 ignore else -- one injected binding owns the slot until its fiber disposes. */
        if (this.continuations === manager) this.continuations = undefined
      }, 'subagents.continuationBinding()')
    })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(subagentTimingProjectionDefinition)
      projectionCtx.sessionProjections.register(subagentIdentityProjectionDefinition)
      projectionCtx.sessionProjections.register(subagentSettlementProjectionDefinition)
    })
    // Redeliver a lost settlement notice on the parent's own next step. Cheap
    // by construction once a parent's first step has cached its (possibly
    // empty) outstanding set (see `outstandingByParent`) and idempotent (see
    // `hasExistingSettlementNotice`): a parent with nothing outstanding
    // returns before any further read, and a parent whose push already
    // landed synthesizes nothing.
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      await this.recheckSubagentSettlement(agent, messages)
      return next()
    })
  }

  /**
   * Establish one durable continuable child and deliver its initial prompt.
   * Resolves when the child's inbox accepts that prompt, without waiting for the
   * turn to start or for the message to reach the Session log; any earlier
   * failure rejects with no ids and rolls back the child entirely.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and the accepted prompt's message id.
   * @throws when continuation services are unavailable or materialization fails.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    return this.requireContinuations().startContinuable(spec)
  }

  /**
   * Deliver one later message to a continuable child as its next FIFO turn. A
   * resident child's Agent inbox accepts it directly (waking a `waiting`
   * Activation), while an absent one is cold-resumed from its persisted
   * Session. The Agent inbox is the only queue, so every accepted message has
   * one observable order.
   * @param parent - the exact live direct parent authorizing this delivery.
   * @param childId - durable child session id.
   * @param content - user-role content to deliver.
   * @param options - the message source fields and caller cancellation, which stops the
   *   operation only before inbox acceptance.
   * @returns the accepted message's inbox id.
   * @throws when continuation services are unavailable, parent authority is
   *   rejected, or the message was not admitted.
   */
  async followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<MessageId> {
    return this.requireContinuations().followup(parent, childId, content, options)
  }

  /**
   * Interrupt one live continuable child's current turn under a human parent
   * address or an exact live ancestor Agent. Fire-and-return: the cancel
   * signal is issued before this returns, but the target may keep running
   * until it observes the signal. Unclaimed pending inbox work, the Activation,
   * and published descendants are preserved; claimed work is not requeued.
   * Once the interrupted driver is idle, a waking send resumes the parked FIFO
   * queue. An absent target — including a one-shot or unknown id —
   * is an accepted no-op, as is a manager-less composition, which cannot own a
   * live Activation.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
   *   live target.
   * @returns whether the target actually had active work aborted by this
   *   call. A manager-less composition, which cannot own a live Activation,
   *   always reports `false`.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): boolean {
    return this.continuations?.interrupt(targetSessionId, authority) ?? false
  }

  /**
   * Wait for one continuable child's durable settlement: the fast
   * `subagent/end` lifecycle race against a capped deadline, falling back to
   * exactly one authoritative persistence read on that deadline. See
   * {@link SubagentContinuationManager.awaitSettlement} for the full
   * contract — this is a direct pass-through.
   * @param childId - the durable child session id to await.
   * @param parent - the exact live direct parent authorizing this wait.
   * @param deadlineMs - how long to wait before the one authoritative read;
   *   clamped to {@link MAX_AWAIT_SETTLEMENT_DEADLINE_MS}.
   * @param signal - caller cancellation, honored for the whole wait.
   * @returns the settlement, or `pending` when the deadline's read found none.
   * @throws when continuation services are unavailable, or `parent` is not
   *   this child's exact live durable direct parent.
   */
  async awaitSettlement(
    childId: SessionId,
    parent: Agent,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<SubagentAwaitSettlementResult> {
    return this.requireContinuations().awaitSettlement(childId, parent, deadlineMs, signal)
  }

  /**
   * Whether `root` currently has any live continuable descendant Activation.
   * Synchronous and process-local — backed only by the resident Activation
   * map, never a persistence read or a durable-history projection — so a
   * caller like an idle-retire timer can afford to call it on every tick.
   * {@link listDescendants} answers a different, more expensive question (the
   * durable tree, including already-settled children); this one exists
   * because that question is the wrong one, and the wrong cost, for a timer
   * callback. A manager-less composition (the `agents` service never
   * mounted) has never materialized an Activation, so it truthfully reports
   * no descendants rather than throwing — the same `?? false` honesty
   * {@link interrupt} uses for the same absence.
   * @param root - the exact live Agent to test for live descendants.
   * @returns whether `root` has at least one live continuable descendant.
   */
  hasLiveDescendants(root: Agent): boolean {
    return this.continuations?.hasLiveDescendants(root) ?? false
  }

  /**
   * Deliver selected content from one live continuable child to its durable
   * direct parent. The child is the authority credential; callers cannot name a
   * recipient. Reporting does not conclude the child's turn or Activation.
   * @param child - exact live reporting child.
   * @param content - selected model-facing content.
   * @param options - parent scheduling and pre-acceptance cancellation.
   * @returns the stable identity of the parent-accepted message.
   * @throws when continuation services are unavailable, sender authorization
   *   fails, or the direct parent is not live.
   */
  async reportFrom(
    child: Agent,
    content: ContentBlock[],
    options: SubagentReportOptions,
  ): Promise<MessageId> {
    return this.requireContinuations().reportFrom(child, content, options)
  }

  /**
   * Compose one deployment capability into every continuable child's
   * unpublished creation context on fresh creation and cold resume. Grants wait
   * for the next Activation; removing the contribution revokes every resident
   * installation immediately.
   * @param contribution - synchronous child-scope installer.
   * @returns the exact Cordis effect disposer.
   */
  registerContinuableSetup(contribution: ContinuableSetupContribution): () => void {
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(
      () => this.setupRegistry.register(contribution),
      'subagents.registerContinuableSetup()',
    )
  }

  /**
   * Close continuable admission below exact live parent Agents, stop only their
   * visible descendant Activations synchronously, then await admitted scoped
   * materializations and release those forests child-first. The scoped cutoff
   * lasts until each exact parent leaves the registry; unrelated parent trees
   * remain live.
   * @param parents - exact host-owned parent Agents entering teardown.
   * @returns once every retained descendant Activation released its `AgentHandle`.
   * @throws an aggregate error after all branches settle when any failed.
   */
  async drainContinuableDescendants(parents: readonly Agent[]): Promise<void> {
    const manager = this.continuations
    // Absent continuation services means nothing was ever materialized.
    if (manager === undefined) return
    await manager.drainDescendants(parents)
  }

  /**
   * Enumerate the parent's direct session-backed subagents without loading or
   * resuming an Agent and without any query service: the listing merges the live
   * session store with optional session persistence (live-preferred) and
   * serves each child's durable mode/label from the registered `subagent`
   * projection unit down a three-rung ladder — the registry's watermark
   * snapshot for a live child; for a cold one, a durable projection-cache
   * row when the optional cache serves an own-suffix identity (its `seq`
   * gate proves the value postdates the fork seed, where a child's own
   * descriptor is immutable once appended), else one persistence inspection
   * folded through the registry. The
   * projection fold is the single classification authority; per-child
   * diagnostics relay a fold that served no identity or a failed inspection,
   * never a list-time descriptor parse. Absent persistence, enumeration is
   * live-only (a cold child cannot be resumed then either, so its absence is
   * capability absence, not an error). This service consults no Agent
   * registrations, Activations, or providers.
   *
   * Every persistence read receives `signal`, and the listing rechecks
   * cancellation around each of those awaits. Read rejections that settle
   * after an abort become a stable `SubagentError` with code `CANCELLED`.
   * @param parentSessionId - parent session whose direct children are listed.
   * @param signal - caller-owned cancellation forwarded to persistence reads
   *   and observed around every read await.
   * @returns children and per-child diagnostics ordered by `createdAt`, then id.
   * @throws {@link SubagentError} when the projection registry or the session
   *   store is not mounted, or the caller cancels the listing.
   */
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]> {
    return listSubagentChildren(this.ctx, parentSessionId, signal)
  }

  /**
   * Enumerate the root's complete session-backed subagent tree in stable
   * pre-order from one live-preferred corpus, without loading or resuming an
   * Agent. Ordinary sessions and one-shot children remain traversal nodes so
   * continuable descendants below them are discovered; each returned entry
   * adds its durable `parentId` and root-relative `depth`. Identity resolution,
   * diagnostics, optional persistence, and cancellation follow the same
   * projection-backed contract as {@link listChildren}.
   * @param rootSessionId - session whose complete descendant tree is listed.
   * @param signal - caller-owned cancellation forwarded to persistence reads
   *   and observed around every read await.
   * @returns children and per-candidate diagnostics with tree position, in
   *   stable pre-order.
   * @throws {@link SubagentError} under the same conditions as {@link listChildren}.
   */
  listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> {
    return listSubagentDescendants(this.ctx, rootSessionId, signal)
  }

  /**
   * Register a provider under its name. Registration is effect-scoped and HMR
   * safe; removing a provider blocks new starts but does not revoke runs that
   * were already returned to their holders.
   * @param provider - the trusted provider implementation.
   * @returns the exact Cordis effect disposer.
   */
  registerProvider(provider: SubagentProvider): () => void {
    const name = provider.name
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: SubagentRuntime) {
      if (this.providers.has(name)) {
        throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.emitLifecycle('subagent/provider-removed', name)
      }
      // A throwing added-listener unwinds the yielded rollback, matching the
      // repository's fail-loud registration semantics.
      this.ctx.emit('subagent/provider-added', provider)
    }.bind(this), 'subagents.registerProvider()')
  }

  /**
   * Look up a provider by name.
   * @param name - the provider name.
   * @returns the provider, or undefined when absent.
   */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * List registered provider names in insertion order.
   * @returns the registered names.
   */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Establish a published child on the named provider. Capability and semantic
   * checks run before delegation. Provider ownership lasts until its promise
   * fulfills; a rejection therefore has no run for the caller to dispose and
   * emits no run lifecycle events. Post-publication turn and infrastructure
   * failures settle through the returned run.
   * @param name - the provider to use.
   * @param request - child label, prompt, parent, signal, and optional capabilities.
   * @returns the published holder-owned run.
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.expectProvider(name)
    this.assertCapabilities(provider, request)
    assertSubagentMaxDepth(request.maxDepth)
    if (request.outputSchema !== undefined) assertObjectJsonSchema(request.outputSchema)
    // Same resolved-route convention as the continuable snapshot in
    // continuation.ts: the declared override, else the parent's own route.
    // Direct service callers may supply minimal agents without options — a
    // deliberate mismatch with Agent's declared (non-optional) `options`
    // field, so the read is retyped honestly here instead of trusting it.
    const parentOptions = (request.parent as { options?: Agent['options'] }).options
    const agentProvider = request.agentOptions?.provider ?? parentOptions?.provider
    const agentModel = request.agentOptions?.model ?? parentOptions?.model
    const descriptor = snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: name,
      ...request.label !== undefined ? { label: request.label } : {},
      ...agentProvider !== undefined ? { agentProvider } : {},
      ...agentModel !== undefined ? { agentModel } : {},
    })
    const resolved: ResolvedSubagentStartRequest = { ...request, descriptor }
    return observeRun(this.emitLifecycle, name, request.parent, await provider.start(resolved))
  }

  /**
   * Resolve one provider's detached continuable-creation contribution. Method
   * presence on the provider IS the capability, so a provider without it is
   * rejected before the manager reserves any child resources.
   */
  private async prepareContinuable(
    name: string,
    request: ContinuableCreateRequest,
  ): Promise<ContinuableCreateSpec> {
    const provider = this.expectProvider(name)
    if (provider.prepareContinuable === undefined) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support continuable children `
        + '(no prepareContinuable capability)',
        'UNSUPPORTED_CAPABILITY',
      )
    }
    return provider.prepareContinuable(request)
  }

  /** Look up a provider for dispatch or fail loud. */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider
  }

  /** Resolve the optional continuable-subagent manager or fail loud. */
  private requireContinuations(): SubagentContinuationManager {
    if (this.continuations === undefined) {
      throw new SubagentError(
        'continuable subagents require the agents service',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return this.continuations
  }

  /**
   * Build the lifecycle observer for one continuable Activation's residency
   * epoch, so the manager publishes its edges without owning event dispatch.
   */
  private observeActivation(
    provider: string,
    childId: SessionId,
    parent: Agent,
  ): ActivationObserver {
    return createActivationObserver(this.emitLifecycle, provider, childId, parent)
  }

  /**
   * Redeliver one continuable parent's missed settlement notices on its own
   * next step. Discovery ({@link discoverOutstandingSettlements}) runs once
   * per parent, exactly when {@link discoveredParents} does not yet name
   * it — never merely when {@link outstandingByParent} already has an entry,
   * since {@link trackOutstandingSettlement} may have bootstrapped that
   * entry live, for one child, before this parent ever took a pre-step; a
   * presence check there would then skip discovery forever and silently
   * lose any OTHER child that settled durably before this process started.
   * Once discovered, a cold-resumed parent is covered even after a real
   * process restart, with no durable read at all on any later step. A child
   * whose live push is still in flight ({@link trackOutstandingSettlement})
   * is skipped this step rather than raced into a duplicate; one whose
   * notice is already present (checked by {@link hasExistingSettlementNotice})
   * is dropped from the outstanding set with nothing sent. A read failure
   * during discovery is logged and swallowed — this is a best-effort
   * recheck on a hot path, never a reason to fail the agent's step.
   * @param agent - the live agent about to take a step.
   * @param claimedThisStep - the current step's own claimed batch, forwarded
   *   to {@link hasExistingSettlementNotice} so a notice this very step is
   *   already delivering is never mistaken for one still missing.
   */
  private async recheckSubagentSettlement(
    agent: Agent,
    claimedThisStep: readonly UserMessage[],
  ): Promise<void> {
    if (!this.discoveredParents.has(agent.id)) {
      const discovered = await this.discoverOutstandingSettlements(agent, claimedThisStep)
      if (discovered === undefined) return
    }
    const outstanding = this.outstandingByParent.get(agent.id)
    if (outstanding === undefined || outstanding.size === 0) return
    const manager = this.continuations
    if (manager === undefined) return
    for (const [childId, entry] of outstanding) {
      if (entry.pushInFlight) continue
      if (hasExistingSettlementNotice(agent, childId, claimedThisStep)) {
        outstanding.delete(childId)
        continue
      }
      try {
        manager.synthesizeSettlementNotice(agent, childId, entry.outcome)
        this.redeliveredSettlements.add(childId)
        outstanding.delete(childId)
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `subagent: settlement notice redelivery for child "${childId}" failed: ${errorChain(error)}`,
        )
      }
    }
  }

  /**
   * One-time-per-process durable discovery of one parent's outstanding
   * settlements, run only the first time {@link recheckSubagentSettlement}
   * ever sees this parent id absent from {@link discoveredParents}: every
   * direct child already durably settled (via the same ladder `list_agents`
   * uses, {@link listChildren}) whose notice is not yet in this parent's own
   * log. On success — even an empty result — this parent is added to
   * {@link discoveredParents} so every later step for it skips this read
   * entirely; the (possibly pre-existing) outstanding map stays in
   * {@link outstandingByParent} either way. A permanently-missing capability
   * (no session store or no `sessionProjections` registry mounted — this
   * deployment can never answer the read, for any agent, ever) counts as
   * success with an empty scan, so it is marked discovered too, instead of
   * warning on literally every agent's first step forever; any other,
   * presumably transient, read failure is logged and leaves this parent
   * undiscovered, so a later step retries.
   *
   * A concurrent live settlement ({@link trackOutstandingSettlement}) may
   * install this parent's entry while the read above is in flight — or, for
   * a parent whose first child was only ever tracked live and never took a
   * pre-step, well before this scan starts at all. Either way this merges
   * into that same map rather than replacing it; never overwriting an entry
   * it names, since that entry's `pushInFlight` status is authoritative and
   * this scan's view of it is necessarily stale.
   * @param agent - the live parent whose direct children are scanned.
   * @param claimedThisStep - forwarded to {@link hasExistingSettlementNotice}
   *   so a notice this very step is already delivering is never counted as
   *   still missing.
   * @returns the (possibly empty) outstanding map now cached for this
   *   parent, or `undefined` when the durable read itself failed.
   */
  private async discoverOutstandingSettlements(
    agent: Agent,
    claimedThisStep: readonly UserMessage[],
  ): Promise<Map<SessionId, OutstandingSettlement> | undefined> {
    let rows: SubagentListEntry[]
    try {
      rows = await this.listChildren(agent.id)
    } catch (error: unknown) {
      if (!isMissingListingCapability(error)) {
        this.ctx.logger.warn(
          `subagent: settlement discovery for parent "${agent.id}" failed: ${errorChain(error)}`,
        )
        return undefined
      }
      // This deployment never mounted the session store or the
      // `sessionProjections` registry, so no agent's discovery read can ever
      // succeed; treat as a successful empty scan rather than warning and
      // retrying on every step of every agent for the rest of the process.
      rows = []
    }
    let outstanding = this.outstandingByParent.get(agent.id)
    if (outstanding === undefined) {
      outstanding = new Map()
      this.outstandingByParent.set(agent.id, outstanding)
    }
    for (const row of rows) {
      if (row.kind !== 'child' || row.activity !== 'inactive' || row.settlement === undefined) continue
      if (outstanding.has(row.id)) continue
      if (this.redeliveredSettlements.has(row.id)) continue
      if (hasExistingSettlementNotice(agent, row.id, claimedThisStep)) continue
      outstanding.set(row.id, { outcome: row.settlement.outcome, pushInFlight: false })
    }
    this.discoveredParents.add(agent.id)
    return outstanding
  }

  /**
   * Host callback the continuation manager calls right after durably
   * appending one child's settlement, before the teardown steps that make
   * it look drained to {@link listChildren}: records it outstanding and
   * marks its live push in flight, bootstrapping this parent's entry in
   * {@link outstandingByParent} when this is the first settlement either
   * path has ever seen for it.
   */
  private trackOutstandingSettlement(
    parentId: SessionId,
    childId: SessionId,
    outcome: SubagentResult['stopReason'],
  ): void {
    let outstanding = this.outstandingByParent.get(parentId)
    if (outstanding === undefined) {
      outstanding = new Map()
      this.outstandingByParent.set(parentId, outstanding)
    }
    outstanding.set(childId, { outcome, pushInFlight: true })
  }

  /**
   * Host callback the continuation manager calls once its push attempt for
   * one child finishes (successfully or not), releasing the guard
   * {@link trackOutstandingSettlement} set. The entry itself stays
   * outstanding — eligible for {@link recheckSubagentSettlement} to
   * redeliver — until a notice is actually confirmed in the parent's log.
   */
  private clearPendingPush(parentId: SessionId, childId: SessionId): void {
    const entry = this.outstandingByParent.get(parentId)?.get(childId)
    if (entry !== undefined) entry.pushInFlight = false
  }

  /** Reject the first requested capability that the provider lacks. */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
      { when: request.toolFilter !== undefined, cap: 'toolFilter' },
      { when: request.persona !== undefined, cap: 'persona' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }
}

export default SubagentRuntime

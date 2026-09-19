/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  createUserMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import { TOOL_SNAPSHOT_SETTLE_MS } from './constants.ts'
import { RuntimeContextProjection } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'
import { ReasoningDriftDetector, ToolRepeatDetector, toolCallSignature } from './loop-guard.ts'
import { boundFragment, FragmentTail, LoopAbortedError } from './loop-abort.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

/** Render tool-call arguments for the loop-aborted fragment; never throws on a hostile value. */
function argsPreview(args: unknown): string {
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** Package id stamped on the synthesized tool-roster recovery message's plugin source. */
const TOOL_SNAPSHOT_RECOVERY_SOURCE = '@deepseek-ai/dsh-agent-loop'

/**
 * Internal notice driven through the normal wake path when a wake's own tool
 * snapshot went stale (see {@link ReactLoopAgent.recheckToolSnapshot}). The
 * `{kind:'plugin'}` source is load-bearing: it is what keeps this out of the
 * human-facing transcript as a user prompt, the same pattern every other
 * synthesized system message in this codebase relies on (compare
 * `runtime-context.ts`, `repeat-tool-reminder`, `time-context`).
 */
const TOOL_SNAPSHOT_RECOVERY_TEXT =
  'Tool roster updated: additional tools finished registering after this session woke and are now '
  + 'available. No user input occurred; continue normally using the full current tool list.'

/** Order-sensitive tool-schema-set equality, matching how a logged header's own tools compare. */
function sameToolSet(a: readonly ToolSchema[], b: readonly ToolSchema[]): boolean {
  return a.length === b.length && a.every((tool, i) => JSON.stringify(tool) === JSON.stringify(b[i]))
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /**
   * Set exactly once, synchronously, the instant {@link cancel} is invoked
   * with `{kind: 'disposed'}` (see the disposal sequence in the plugin's
   * `dispose()`) and never cleared again. This is deliberately independent
   * of `phase` and of any {@link AbortController}: a phase transition always
   * mints a fresh, unaborted controller (see {@link wakeDriver}), so an async
   * chain that closed over this agent before disposal -- a fire-and-forget
   * tool-snapshot recheck latched behind {@link runMaintenance}, for
   * instance -- can still observe a live idle phase and a signal that was
   * never told to abort, well after disposal resolved. `disposed` cannot be
   * fooled by that: it is read synchronously at two choke points, both
   * required. {@link send} reads it first, for a *waking* send only, before
   * the message ever touches the inbox -- a disposed agent must never
   * durably queue `next-turn` work for a driver that will never claim it,
   * since a later resume of the same session would otherwise replay that
   * insert as live pending work and hand it a phantom extra turn ahead of
   * whatever the resumed caller actually sends. A non-waking send (`inject()`)
   * is deliberately exempt: it only ever lands in `next-step`, which nothing
   * claims except an already-running turn, so it cannot produce that phantom
   * turn, and a documented cross-package contract relies on exactly this
   * still succeeding into a disposing-but-still-registered agent (see
   * `packages/subagent/tool-subagent-report`'s README). {@link wakeDriver}
   * reads `disposed` again at the single choke point every new driver
   * activity passes through, for the two call sites ({@link runMaintenance}
   * and {@link kick}'s own `finally` blocks) that wake on already-queued
   * inbox content without going through `send()`. No teardown ordering,
   * timer, or promise race can let either a queued waking insert or a
   * dispatch slip past these.
   */
  private disposed = false

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  private readonly runtimeContext: RuntimeContextProjection

  /**
   * Debounce handle for {@link scheduleToolSnapshotRecheck}, cleared on the
   * next mutation (coalescing a burst) and on scope disposal.
   */
  private toolsSettleTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Set the instant a corrective wake is dispatched for a lost tool-registration
   * race (see {@link recheckToolSnapshot}), cleared the instant any real turn
   * next starts (see {@link setPhase}). Guards the window where a wake is
   * latched behind {@link runMaintenance} rather than started immediately —
   * outside maintenance, `send`'s own synchronous transition to phase
   * `'running'` already makes the idle check in {@link recheckToolSnapshot}
   * the sole guard needed; during maintenance `status` stays `'idle'` while
   * a wake sits latched, which would otherwise let a second burst queue a
   * second corrective message.
   *
   * A latched wake can also be dropped out from under this flag — a
   * {@link cancel} without `keepInbox` before maintenance finishes clears
   * the inbox and the latch together, so the transition to `'running'` this
   * flag is waiting for never comes. `cancel` detects exactly that and
   * re-arms {@link toolSnapshotRecheckDeferred} instead of leaving this
   * stuck `true`, which would otherwise silently disable every later
   * recheck for the rest of the agent's life.
   */
  private toolSnapshotCorrectionPending = false

  /**
   * Set when {@link recheckToolSnapshot} finds real drift but the agent is
   * mid-turn, so it deliberately did nothing (rule: a running turn's own
   * next `preStep`/`buildRequest` self-corrects for free). That only holds
   * when another step is actually coming — a turn whose in-flight step is
   * its LAST one has no next `preStep`, so a drift found there would
   * otherwise be dropped forever the instant the turn ends. {@link setPhase}
   * re-verifies on the very next transition to true `'idle'` and clears this
   * flag; also set by {@link cancel} when it discovers a latched correction
   * was just dropped, for the same reason.
   */
  private toolSnapshotRecheckDeferred = false

  /**
   * Tool-channel loop guard: lives for the whole agent, not one step or turn
   * — the real incident this catches (the same call repeated 5-6 times with
   * no state change) plays out across successive steps, not within one.
   * Its own streak logic resets on any differing signature, so no explicit
   * reset is needed here.
   */
  private readonly toolRepeatGuard: ToolRepeatDetector

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    // Insurance against the built-in/MCP tool-registration race: a wake's
    // first snapshot (in `preStep`, via `buildRequest`) can be taken before
    // every registration has landed, and most turns take exactly one step,
    // so there is otherwise no later step to notice the registry caught up.
    // `tools/change` is the registry's own unfiltered "something registered
    // or unregistered" signal (see `dsh-tools`); react to it here instead of
    // delaying the first turn on it.
    this.ctx.effect(() => {
      const stopToolsChange = this.ctx.on('tools/change', () => { this.scheduleToolSnapshotRecheck() })
      return () => {
        stopToolsChange()
        if (this.toolsSettleTimer !== undefined) clearTimeout(this.toolsSettleTimer)
      }
    }, 'agent.toolSnapshotRecheck()')
    this.toolRepeatGuard = new ToolRepeatDetector(loopCtx.agentLoop.config.loopGuard.toolRepeatThreshold)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    // Any real turn starting resolves whatever race the pending flag was
    // latched for: the driver about to run reads the registry live.
    if (next.kind === 'running') this.toolSnapshotCorrectionPending = false
    // The one place a deferred mid-turn (or cancel-dropped) recheck gets
    // caught up: genuinely going idle, not merely between turns of the same
    // kick() loop (which never passes through here — see `turn()`).
    if (next.kind === 'idle' && this.toolSnapshotRecheckDeferred) {
      this.toolSnapshotRecheckDeferred = false
      this.runToolSnapshotRecheck()
    }
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Refuse before anything is touched, but only for a waking send: a
    // disposed agent must never durably queue work for a driver that will
    // never claim it, because a later resume of this same session would
    // replay the insert as live pending work and hand it to the very next
    // real turn (see the `disposed` field doc) -- exactly this ticket's
    // measured harm. This is deliberately ahead of the `wakeDriver` disposal
    // check below, which only guards the dispatch side and runs too late
    // for this purpose: by the time it would see `disposed`, the insert
    // this guard exists to prevent has already committed.
    //
    // A non-waking send (`inject()`, `wakeup: false`) is deliberately left
    // out of this guard: it only ever targets `next-step`, which nothing
    // ever claims on its own -- `Inbox.claim()` only runs from inside an
    // already-running turn, so a lone `next-step` entry cannot produce the
    // phantom extra dispatch this ticket is about; at worst it is folded
    // as extra context into whatever real turn eventually claims it. A
    // documented cross-package contract (packages/subagent/tool-subagent-report's
    // README: "a registered parent already in host-owned disposal still
    // accepts while its log admits appends") deliberately relies on exactly
    // this succeeding, so refusing it here would fix a harm this path
    // cannot cause while breaking a real, tested product contract.
    if (wakeup && this.disposed) {
      this.throwError(new Error(`agent "${this.id}": send refused, agent is disposed`))
    }
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): boolean {
    // Captured before any of the below runs: whether there is active work to
    // abort is fixed at entry, and this call is the only thing that could
    // still change it before the read below.
    const activeWorkAborted = this.phase.kind !== 'idle'
    // Durable and permanent, set before anything else below so it is visible
    // to every later synchronous check regardless of how this cancel races
    // with concurrent phase transitions -- see the field doc on `disposed`.
    if (cause.kind === 'disposed') this.disposed = true
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
      if (this.toolSnapshotCorrectionPending) {
        // The corrective wake this flag is guarding was just dropped: its
        // message left the inbox, and (if it was still latched behind
        // maintenance) its wakeRequested latch was just cleared above too —
        // so the transition to 'running' that would normally clear this
        // flag is never coming for it. Re-arm via the deferred path instead
        // of leaving it stuck true, which would silently disable every
        // later recheck for the rest of this agent's life.
        this.toolSnapshotCorrectionPending = false
        this.toolSnapshotRecheckDeferred = true
        this.ctx.logger.info(
          `agent "${this.id}": tool-snapshot correction dropped by cancel(); will re-verify on the next idle transition`,
        )
      }
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
    return activeWorkAborted
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    if (this.disposed) {
      // Refuse loudly, at the sole gateway into a new driver: about to mint a
      // fresh, never-aborted AbortController and start `kick()`, so nothing
      // downstream of this point can be trusted to notice disposal on its
      // own. See the `disposed` field doc for why this cannot be a
      // teardown-ordering or abort-signal check instead. A wake landing
      // while some other phase is still converging (handled above) is not
      // this: it never reaches a dispatch, so it stays a silent no-op.
      this.throwError(new Error(`agent "${this.id}": dispatch blocked, agent is disposed`))
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /**
   * Coalesce a burst of `tools/change` notifications into one settle point,
   * then re-verify the live tool assembly against the set actually used by
   * the session's last dispatched request.
   *
   * Skipped before this instance's own first header is logged: that first
   * request always reads the registry live (see {@link preStep}), so there is
   * nothing yet to correct, and no baseline exists to compare against.
   */
  private scheduleToolSnapshotRecheck(): void {
    if (!this.requestHeaderLogged) return
    if (this.toolsSettleTimer !== undefined) clearTimeout(this.toolsSettleTimer)
    this.toolsSettleTimer = setTimeout(() => {
      this.toolsSettleTimer = undefined
      this.runToolSnapshotRecheck()
    }, TOOL_SNAPSHOT_SETTLE_MS)
    this.toolsSettleTimer.unref()
  }

  /** Fire-and-forget {@link recheckToolSnapshot}, logging rather than throwing on failure. */
  private runToolSnapshotRecheck(): void {
    this.recheckToolSnapshot().catch((error: unknown) => {
      this.ctx.logger.warn(`agent "${this.id}": tool-snapshot recheck failed: ${errorChain(error)}`)
    })
  }

  /**
   * Re-assemble the live prompt/tool registry and compare it against the
   * tools the session's most recent `request/header` actually carried —
   * i.e. what the last real dispatch to the model actually sent, not any
   * cached snapshot (there is none to invalidate: {@link preStep} already
   * reads the registry live on every step).
   *
   * A drift only matters while this agent is idle. A running turn's own next
   * `preStep`/`buildRequest` cycle re-assembles live and self-corrects for
   * free — `buildRequest` already diffs and logs a `request/header` change
   * on every step — so acting here too would just race a dispatch already
   * on its way. THAT ONLY HOLDS IF ANOTHER STEP IS ACTUALLY COMING: a turn
   * whose in-flight step is its last one (a plain-text answer, no tool call)
   * has no next `preStep` to self-correct on, so doing nothing here would
   * silently drop the drift forever — the exact failure class this ticket
   * exists to fix. `setPhase` re-verifies via {@link toolSnapshotRecheckDeferred}
   * on the next genuine transition to idle instead.
   *
   * An idle agent has no such cycle coming at all: the wake that lost the
   * race already produced its one step and went idle. The fix for that case
   * is to synthesize one internal message and drive it through the ordinary
   * wake path (`send(..., 'next-turn', true)`), which forces exactly one
   * real `step()`/`buildRequest()` and therefore one corrected outbound
   * request — a bare empty self-wake would not do this, since a wake with an
   * empty inbox short-circuits before `step()` ever runs.
   */
  private async recheckToolSnapshot(): Promise<void> {
    const lastUsed = this.session.requestHeader()?.tools ?? []
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this))
    if (sameToolSet(lastUsed, assembly.tools)) return
    if (this.status !== 'idle') {
      // Mid-turn: normally self-corrects for free on the next step (see the
      // doc above) — but only when there IS a next step. Never silently drop
      // this: re-verify on the next real idle transition instead.
      this.toolSnapshotRecheckDeferred = true
      this.ctx.logger.info(
        `agent "${this.id}": tool-snapshot recheck deferred (turn in flight, drift found on what may be its last step); `
        + 'will re-verify on the next idle transition',
      )
      return
    }
    if (this.toolSnapshotCorrectionPending) {
      // A correction is already in flight (latched behind maintenance, most
      // likely) — do not queue a second one on top of it.
      this.ctx.logger.info(
        `agent "${this.id}": tool-snapshot recheck short-circuited (a correction is already pending)`,
      )
      return
    }
    this.toolSnapshotCorrectionPending = true
    this.send(
      createUserMessage({
        content: [{ type: 'text', text: TOOL_SNAPSHOT_RECOVERY_TEXT }],
        source: { kind: 'plugin', plugin: TOOL_SNAPSHOT_RECOVERY_SOURCE },
      }),
      'next-turn',
      true,
    )
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          const stepEnd = await this.step(decision.assembly)
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    const system = renderPrompt(assembly)
    const loopGuardConfig = this.loopCtx.agentLoop.config.loopGuard

    while (true) {
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      // Reasoning-channel loop guard: scoped to this one request attempt (not
      // the whole agent, like the tool guard below) because the incident it
      // catches is one degenerate reasoning block within a single response;
      // a fresh retry after `agent/request-error` starts a clean stream and
      // must not inherit a near-trip count from the attempt it is replacing.
      const reasoningDrift = new ReasoningDriftDetector(
        loopGuardConfig.reasoningShingleSize,
        loopGuardConfig.reasoningWindowSize,
        loopGuardConfig.reasoningDriftThreshold,
      )
      const reasoningFragment = new FragmentTail()
      const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
      signal.throwIfAborted()
      for await (const chunk of stream) {
        signal.throwIfAborted()
        chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
        assembler.push(chunk)
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          reasoningFragment.push(chunk.text)
          if (reasoningDrift.push(chunk.text)) {
            const reason = 'reasoning/output text repeated the same structural pattern '
              + `${loopGuardConfig.reasoningDriftThreshold}+ times within a trailing `
              + `${loopGuardConfig.reasoningWindowSize}-shingle window`
            const fragment = boundFragment(reasoningFragment.snapshot())
            this.dispatch.emit('agent/loop-aborted', { turn, step, channel: 'reasoning', reason, fragment })
            throw new LoopAbortedError('reasoning', reason, fragment)
          }
        }
      }
      signal.throwIfAborted()
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await this.dispatch.waterfall(
          'agent/request-error', {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal,
          },
          () => Promise.resolve<RequestErrorAction>(undefined),
        )
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
      }

      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
      })
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
        (name, args, resultContent) => {
          if (!this.toolRepeatGuard.record(toolCallSignature(name, args, resultContent))) return
          const reason = `tool call "${name}" repeated with identical arguments and result `
            + `${loopGuardConfig.toolRepeatThreshold}+ times in a row with no state change`
          const fragment = boundFragment(`${name}(${argsPreview(args)})`)
          this.dispatch.emit('agent/loop-aborted', { turn, step, channel: 'tool-call', reason, fragment })
          throw new LoopAbortedError('tool-call', reason, fragment)
        },
      )
      return concluded ? { kind: 'completed' } : null
    }
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const reasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }

    const contextWindow = preparedCall?.context?.contextWindow
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}

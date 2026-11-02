/**
 * Host side of one workflow run. The first worker result, unexpected death, or
 * cancellation-grace expiry owns settlement and closes message admission.
 * Pending starts share one abort signal; published children share idempotent
 * cleanup, and quiescence waits for both while synthesizing any missing end events.
 * @module @deepseek-ai/dsh-workflow-worker-thread/host
 */

import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import {
  approvalIdsEqual,
  composeContinuationPrompt,
  createLocalBashExecutor,
  evidenceTail,
  newApprovalId,
  sanitizeEvidenceText,
  EVIDENCE_COMMAND_MAX_CHARS,
  validateBashCall,
  validateDoneWhen,
  WORKFLOW_APPROVAL_MESSAGE_MAX_CHARS,
  WORKFLOW_BASH_OUTPUT_CAP_BYTES,
  WORKFLOW_CONTINUATION_CEILING,
  WORKFLOW_NODE_ID_PATTERN,
} from '@deepseek-ai/dsh-workflow'
import type {
  ValidatedBashCall,
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowApprovalDecision,
  WorkflowApprovalOutcome,
  WorkflowApprover,
  WorkflowBashExecutor,
  WorkflowBashResult,
  WorkflowChildHandle,
  WorkflowChildSupervisor,
  WorkflowContinuationEvidence,
  WorkflowDoneWhen,
  WorkflowGateInfo,
  WorkflowMeta,
  WorkflowNodeEndInfo,
  WorkflowNodeInfo,
  WorkflowPendingApproval,
  WorkflowResult,
  WorkflowRun,
  WorkflowRunId,
  WorkflowSupervisedChild,
} from '@deepseek-ai/dsh-workflow'
import { namesDeniedModel } from './model-guard.ts'
import { renderThrown } from './realm.ts'
import { createWorkflowChildSupervisor } from './supervisor.ts'
import type { ExecutionObserver } from './runtime.ts'
import { HostToWorkerType, WorkerToHostType } from './protocol.ts'
import type { HostToWorkerPayloads, WorkerToHostMessage } from './protocol.ts'
import type { ChildResult, ChildStartRequest, WorkerInit } from './types.ts'

/** One published child and its shared quiescent-disposal transaction. */
interface ChildRecord {
  /** The live run; replaced by each continuation iteration (the previous run is disposed first). */
  run: SubagentRun
  readonly supervised: { -readonly [K in keyof WorkflowSupervisedChild]: WorkflowSupervisedChild[K] }
  /** Supervision release already delivered. */
  released: boolean
  /** Resolves when a supervisor stops THIS iteration's child (replaced for each continuation iteration). */
  stop: PromiseWithResolvers<'timeout' | 'stalled'>
  disposal?: Promise<void>
}

/**
 * What the owner of a run injects into the host: the workspace root `bash()` is contained to, the
 * approval decider, an executor override, the output spill sink, and the child supervisor
 * (the plug-in point for the stall watchdog and the done-when evaluator). Every member is optional.
 */
export interface HostRunExtras {
  /** Workspace root (default: the host process cwd). */
  cwd?: string
  /** Decides `approve()` questions; absent means `'unavailable'`. */
  approver?: WorkflowApprover
  /** Overrides the local bash executor. */
  bashExecutor?: WorkflowBashExecutor
  /** Receives every bash output chunk. */
  onBashOutput?: (info: { nodeId?: string }, stream: 'stdout' | 'stderr', chunk: Uint8Array) => void
  /** The child supervisor. */
  supervisor?: WorkflowChildSupervisor
  /** Tier label to model id. */
  tierModels?: Readonly<Record<string, string>>
  /** The compiled workflow's declared gates (see `WorkflowStartRequest.gateManifest`). */
  gateManifest?: readonly { nodeId: string; gateKind: string }[]
}

/** One approval question awaiting a decision. */
interface PendingApprovalEntry extends WorkflowPendingApproval {
  /** First settle wins (a single synchronous compare-and-set); returns whether this call won. */
  settle(outcome: WorkflowApprovalOutcome): boolean
}

/** Ceiling (and default) of one approval's wait: one hour. */
const APPROVAL_WAIT_CEILING_MS = 3_600_000

/** Host-side volume limits: a hostile worker cannot make the host do unbounded work. */
const MAX_CONCURRENT_BASH = 8
const MAX_BASH_CALLS_PER_RUN = 1000
const MAX_PENDING_APPROVALS = 16
const MAX_APPROVALS_PER_RUN = 1000
const MAX_DECIDED_APPROVAL_IDS = 4096
const MAX_NODES_PER_RUN = 1000
const MAX_NODE_GATE_EVENTS_PER_RUN = 10_000
const MAX_WORKER_MESSAGES_PER_RUN = 200_000
const MAX_LIVE_AGENTS = 10_000
const PHASE_TITLE_MAX_CHARS = 200
const LOG_MESSAGE_MAX_CHARS = 16_000
const AGENT_LABEL_MAX_CHARS = 500
const RESULT_ERROR_MAX_CHARS = 16_000
const NODE_ERROR_MAX_CHARS = 2000
const LABEL_PATTERN = /^[a-z][a-z_]{0,31}$/
const NODE_STATUSES: ReadonlySet<string> = new Set(['success', 'failed', 'skipped', 'cancelled', 'interrupted'])
const GATE_OUTCOMES: ReadonlySet<string> = new Set(['fired-pass', 'fired-block', 'skipped', 'not-reached', 'never-evaluated'])

const APPROVAL_OUTCOMES: ReadonlySet<string> = new Set<WorkflowApprovalOutcome>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * The scrubbed worker environment: no ambient credentials, no loader flags.
 * Windows derives `os.tmpdir()` from `TMP`/`TEMP` and falls back to the
 * literal relative path `undefined\temp` when the environment is empty, so
 * tsx's transform cache would land in a cwd-relative `undefined/temp`
 * directory; the host's real temp path (not a credential) is injected there.
 * The unbuilt shape additionally forwards `TSX_TSCONFIG_PATH` for path
 * resolution.
 * @param platform - host platform; overridable so tests exercise both peer arms.
 * @param tsconfigPath - the tsconfig pin to forward; only the unbuilt caller
 *   passes one, so the built worker never observes the host's pin.
 * @returns the scrubbed worker environment object.
 */
export function workerSpawnEnv(
  platform: NodeJS.Platform = process.platform,
  tsconfigPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform === 'win32') {
    const tmp = tmpdir()
    env.TMP = tmp
    env.TEMP = tmp
  }
  if (tsconfigPath !== undefined) env.TSX_TSCONFIG_PATH = tsconfigPath
  return env
}

/**
 * Resolve a built worker bundle or an unbuilt bootstrap that installs both tsx
 * transforms inside the worker. Both shapes clear `execArgv` and the ambient
 * environment (the worker only sees the platform temp path and, unbuilt,
 * `TSX_TSCONFIG_PATH`).
 * @param init - the run payload, passed as `workerData`.
 * @returns the entry path or URL and the Worker options to spawn it with.
 */
function resolveWorkerSpawn(init: WorkerInit): { entry: string | URL; options: WorkerOptions } {
  /* v8 ignore next 3 -- the built-output arm: tests always run unbuilt (src/); the built-worker e2e exercises this shape for real */
  if (!import.meta.url.endsWith('.ts')) {
    return { entry: fileURLToPath(new URL('./worker.cjs', import.meta.url)), options: { workerData: init, env: workerSpawnEnv(), execArgv: [] } }
  }
  // Resolve tsx only for unbuilt consumers and install it before importing TS.
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const tsxEsmApiEntry = import.meta.resolve('tsx/esm/api')
  const tsxCjsApiEntry = import.meta.resolve('tsx/cjs/api')
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(tsxEsmApiEntry)}`,
    `import { register as registerCjs } from ${JSON.stringify(tsxCjsApiEntry)}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: init,
      env: workerSpawnEnv(undefined, process.env.TSX_TSCONFIG_PATH),
      execArgv: [],
    },
  }
}

/**
 * One live worker-engine run — the seam's {@link WorkflowRun}, returned by
 * `start()` directly. Owns the Worker, the child registry, and the result
 * settlement; `result` never rejects. `meta` is trusted same-process data
 * borrowed as immutable by the handle and lifecycle events. The holder-bound
 * SubagentRuntime handle is captured before the
 * engine returns this run, so unloading the engine removes only the ability to
 * start another workflow; this run can still start and clean up its children.
 */
export class WorkerRun implements WorkflowRun {
  /** Settles exactly once with the run's outcome; never rejects. */
  readonly result: Promise<WorkflowResult>
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  /** A Result/death/grace outcome atomically won before teardown callbacks. */
  private terminalClaimed = false
  /** The first death signal closes worker-message admission and owns failure-time cleanup. */
  private workerDeathObserved = false
  private cancelReason: string | undefined
  private graceTimer: NodeJS.Timeout | undefined
  private readonly worker: Worker
  /** Set on `exit`: the thread is gone, so posting has nowhere to go. */
  private workerGone = false
  /** Accepted `child-start` messages — the terminate-path `agentsStarted` (see module doc). */
  private hostStarted = 0
  /** Published children by callId; an entry leaves only after disposal settles. */
  private readonly children = new Map<number, ChildRecord>()
  /** Provider starts that have not yet fulfilled or rejected. */
  private readonly pendingStarts = new Set<Promise<void>>()
  /** Started-but-not-ended nodes by id — the pairing ledger for `workflow/node-end` (see {@link endStrandedNodes}). */
  private readonly liveNodes = new Map<string, WorkflowNodeInfo>()
  /** Every node id that ever started (a pending gate on a node that never did reports `not-reached`). */
  private readonly everStarted = new Set<string>()
  /** Gates owed a `workflow/gate` event, keyed `nodeId NUL gateKind` (a node may owe several). */
  private readonly pendingGates = new Map<string, { nodeId: string; gateKind: string }>()
  /** Every gate key the manifest declared (the worker cannot override or extend it for those nodes). */
  private readonly manifestNodes = new Set<string>()
  /** Gate keys already evaluated (duplicates are dropped). */
  private readonly evaluatedGates = new Set<string>()
  private nodeGateEvents = 0
  private workerMessages = 0
  private bashCalls = 0
  private activeBash = 0
  private approvalsAsked = 0
  private killNote: string | undefined
  private readonly maxTotalAgents: number
  /** Approvals awaiting a decision, by id. */
  private readonly approvals = new Map<string, PendingApprovalEntry>()
  /** Ids already decided (answers `already-decided`). */
  private readonly decidedApprovals = new Set<string>()
  private readonly bashEnabled: boolean
  private readonly bashExecutor: WorkflowBashExecutor
  private readonly supervisor: WorkflowChildSupervisor | undefined
  /** Started-but-not-ended agents by seq — the pairing ledger the HOST guarantees (see {@link endAgent}). */
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private readonly quiescenceWaiters: (() => void)[] = []
  /** The per-run abort fanout every child start request carries. */
  private readonly controller = new AbortController()
  /** External start signal and the exact callback installed on it, retained only until first settle/teardown. */
  private inputSignal: AbortSignal | undefined
  private inputSignalAbort: (() => void) | undefined
  private disposed: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly subagents: SubagentRuntime,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    private readonly parent: Agent,
    init: WorkerInit,
    private readonly provider: string,
    private readonly disposeGraceMs: number,
    private readonly observer: ExecutionObserver,
    signal: AbortSignal | undefined,
    private readonly extras: HostRunExtras = {},
  ) {
    this.bashEnabled = init.bashEnabled === true
    this.bashExecutor = extras.bashExecutor ?? createLocalBashExecutor()
    // Default supervision: the child's session appends feed the stall watchdog through the host's
    // `session/event` listener (one per bound child, removed on release). A caller-supplied
    // supervisor replaces it entirely.
    this.supervisor = extras.supervisor ?? createWorkflowChildSupervisor({
      observe: (childId, listener) => {
        // Only a local run's appends reach this process; a remote run is deadline-only.
        const local = [...this.children.values()].some(record => record.run.id === childId && record.run.localAgent !== undefined)
        if (!local) return undefined
        return ctx.on('session/event', (session, event) => {
          if (session.id === childId) listener({ type: event.type, data: event.data })
        })
      },
      onWarning: (message) => { ctx.logger.warn(`workflow-worker-thread: ${message}`) },
    })
    this.maxTotalAgents = init.limits.maxTotalAgents
    for (const { nodeId, gateKind } of extras.gateManifest ?? []) {
      this.pendingGates.set(gateKey(nodeId, gateKind), { nodeId, gateKind })
      this.manifestNodes.add(nodeId)
    }
    this.result = new Promise<WorkflowResult>((resolve) => { this.settleResolve = resolve })
    // workerData rides the structured clone: args are plain JSON by the seam
    // contract, so the clone is total and doubles as the caller-isolation
    // copy (a clone failure throws loud out of start()).
    const { entry, options } = resolveWorkerSpawn(init)
    this.worker = new Worker(entry, options)
    this.worker.on('message', (message: WorkerToHostMessage) => { this.onMessage(message) })
    this.worker.on('error', (error) => { this.onWorkerDeath(`workflow worker failed: ${renderThrown(error)}`, false) })
    /* v8 ignore next -- messageerror: not constructible from the engine's own protocol (every payload is JSON data) */
    this.worker.on('messageerror', (error) => { this.onWorkerDeath(`workflow worker message failed to deserialize: ${renderThrown(error)}`, false) })
    this.worker.on('exit', (code) => {
      this.workerGone = true
      this.onWorkerDeath(this.killNote ?? `workflow worker exited before the run settled (exit code ${code})`, true)
    })
    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else if (signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal()
        this.cancel('workflow signal aborted')
      }
      this.inputSignal = signal
      this.inputSignalAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  /**
   * Cancel the run: the worker is told (its hooks start throwing and the
   * script dies at its next await), the required signal shared by every child
   * start is aborted, and the grace timer
   * arms: a run still unsettled `disposeGraceMs` later force-settles
   * `cancelled` and its worker is TERMINATED. Idempotent; the first reason
   * wins.
   * @param reason - human-readable cause (default `'workflow cancelled'`).
   */
  cancel(reason?: string): void {
    // A settled run has nothing left to cancel, and a terminal source claimed
    // before its cleanup callbacks must exclude cancellation reentered by one
    // of those callbacks. Without the settled guard the
    // ordinary consumer path (await result, then dispose -> cancel) would arm
    // a grace timer nothing ever clears, pinning the run and its Worker
    // closure until the grace expires - a bounded leak per completed run.
    if (this.settled || this.terminalClaimed || this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.post(HostToWorkerType.Cancel, { reason: this.cancelReason })
    this.abortChildren(this.cancelReason)
    this.graceTimer = setTimeout(() => {
      // Cancellation already owns the race through cancelReason; close the
      // terminal boundary explicitly before observer teardown callbacks.
      this.terminalClaimed = true
      // The worker may no longer speak (it is about to be terminated): pair
      // every stranded start before the run settles, so ends precede
      // workflow/end.
      this.endStrandedAgents()
      this.endStrandedNodes()
      this.settleResult(this.cancelledResult(this.hostStarted))
      void this.worker.terminate()
    }, this.disposeGraceMs)
    // unref'd: an armed grace timer must never hold the process open.
    this.graceTimer.unref()
  }

  /**
   * Cancel + bounded settle + termination. Host-drives every registered
   * child's disposal IMMEDIATELY — a wedged worker can relay no dispose RPC,
   * and deferring child teardown to the post-terminate reap would spend the
   * whole grace waiting for a quiescence that cannot start, then return with
   * the disposals still in flight — so child disposal overlaps the same
   * grace the worker gets to settle (the worker's own dispose RPCs join the
   * shared per-child disposal). Waits (at most the grace) for the result and
   * child quiescence, then terminates the worker unconditionally — the
   * thread never outlives its run — and reaps whatever children remain
   * (their disposal is contained, not awaited past the grace, the same
   * abandonment the seam documents for a slow-disposing child). Idempotent;
   * safe on every path.
   * @returns resolves when the run's resources are released or abandoned.
   */
  dispose(): Promise<void> {
    if (this.disposed !== undefined) return this.disposed
    // Claim the public transaction BEFORE its body invokes child/provider
    // disposal. A raw provider callback can reenter handle.dispose(); it must
    // join this promise rather than start a second traversal.
    const claimed = Promise.withResolvers<undefined>()
    this.disposed = claimed.promise
    void (async () => {
      this.detachInputSignal()
      this.cancel('workflow disposed')
      // cancel() deliberately becomes a no-op after terminal settlement, but
      // disposal still owns every registered child. Reap independently so an
      // already-settled workflow cannot wait on child quiescence before it has
      // started the surviving children's disposals. On an unsettled run this
      // joins the cancel path through the per-call cancellation/disposal gates.
      this.reapChildren('workflow disposed')
      await Promise.race([
        (async () => {
          await this.result
          await this.childQuiescence()
        })(),
        sleep(this.disposeGraceMs),
      ])
      await this.worker.terminate()
      this.reapChildren('workflow disposed')
    })().then(
      () => { claimed.resolve(undefined) },
      /* v8 ignore next -- result/quiescence never reject and Worker.terminate is the only external promise */
      (error: unknown) => { claimed.reject(error) },
    )
    return this.disposed
  }

  /** Post one message to the worker (payload looked up from the tag's map entry), tolerating a thread that is already gone. */
  private post<T extends HostToWorkerType>(type: T, payload: HostToWorkerPayloads[T]): void {
    if (this.workerGone || this.workerDeathObserved) return
    try {
      this.worker.postMessage({ type, ...payload })
    } catch (error: unknown) {
      // Only a teardown race can land here (every engine message is JSON
      // data, so serialization cannot fail); there is nothing left to
      // deliver to — log and move on.
      /* v8 ignore next -- postMessage teardown race (a throw between exit and its event): not constructible in-process */
      this.ctx.logger.warn(`workflow-worker-thread: postMessage failed: ${renderThrown(error)}`)
    }
  }

  /**
   * The worker message entry. The worker is untrusted: any throw while handling one of its messages
   * (a malformed shape, an unknown type) ends the worker and settles the run as an error instead of
   * escaping into the host process.
   */
  private onMessage(message: WorkerToHostMessage): void {
    try {
      this.handleMessage(message)
    } catch (error: unknown) {
      const note = `workflow worker sent a malformed message: ${renderThrown(error).slice(0, 300)}`
      if (this.killNote === undefined) this.killNote = note
      try {
        this.onWorkerDeath(note, false)
      } catch (inner: unknown) {
        this.ctx.logger.warn(`workflow-worker-thread: malformed-message settlement failed: ${renderThrown(inner)}`)
      }
      void this.worker.terminate().catch(() => { /* already gone */ })
    }
  }

  private handleMessage(message: WorkerToHostMessage): void {
    const probe: unknown = message
    if (typeof probe !== 'object' || probe === null || typeof (probe as { type?: unknown }).type !== 'string') {
      throw new TypeError('message is not an object with a string type')
    }
    // Node may emit `error`, then deliver an already-queued `message`, then
    // emit `exit`. The first death signal is the host's logical delivery
    // barrier: nothing arriving afterward may create a child, narrate after
    // workflow/end, or compete with the chosen outcome.
    if (this.workerDeathObserved) return
    this.workerMessages += 1
    if (this.workerMessages > MAX_WORKER_MESSAGES_PER_RUN) {
      // A worker flooding the host is treated as hostile: end it. Exit then settles the run as an error.
      if (this.killNote === undefined) {
        this.killNote = `workflow worker exceeded its message budget (${MAX_WORKER_MESSAGES_PER_RUN})`
        void this.worker.terminate()
      }
      return
    }
    switch (message.type) {
      case WorkerToHostType.Ready:
        this.post(HostToWorkerType.Go, {})
        break
      case WorkerToHostType.Phase:
        // Post-cancel narration is suppressed host-side: worker-side the
        // hooks throw once the cancel message is PROCESSED, but narration
        // already in flight (or emitted while the cancel crossed the
        // boundary) must not reach observers — nothing is emitted after
        // cancel() returns.
        if (this.cancelReason === undefined && typeof message.title === 'string') {
          this.observer.phase(cleanText(message.title, PHASE_TITLE_MAX_CHARS))
        }
        break
      case WorkerToHostType.Log:
        if (this.cancelReason === undefined && typeof message.message === 'string') {
          this.observer.log(cleanText(message.message, LOG_MESSAGE_MAX_CHARS))
        }
        break
      case WorkerToHostType.AgentStart:
        this.agentStarted(message.info)
        break
      case WorkerToHostType.AgentEnd:
        // NOT suppressed on cancel: cancelled children report their paired
        // agent-end with outcome 'cancelled'. The gate (with the termination
        // paths' synthesis) is what makes the one-pair-per-started-child
        // contract hold on every stop path.
        this.agentEndedByWorker(message.info)
        break
      case WorkerToHostType.NodeStart:
        if (this.cancelReason === undefined && !this.terminalClaimed) this.nodeStarted(message.info)
        break
      case WorkerToHostType.NodeEnd:
        // NOT suppressed on cancel, for the same reason as AgentEnd: the pairing must hold.
        this.nodeEnded(message.info)
        break
      case WorkerToHostType.Gate:
        this.gateEvaluated(message.info)
        break
      case WorkerToHostType.BashStart:
        this.trackHostWork(this.runBashCall(message.callId, message.command, message.options))
        break
      case WorkerToHostType.ApproveStart:
        this.trackHostWork(this.runApproval(message.callId, message.nodeId, message.message, message.timeoutMs))
        break
      case WorkerToHostType.ChildStart:
        this.onChildStart(message.callId, message.request)
        break
      case WorkerToHostType.ChildDispose:
        this.onChildDispose(message.callId)
        break
      case WorkerToHostType.Result:
        this.onResult(message.result)
        break
      /* v8 ignore next 2 -- closed engine-owned union; the arm only makes adding a message type a compile error */
      default:
        assertNever(message, 'worker-to-host message') // throws; the onMessage wrapper settles the run as an error
    }
  }

  /** Why a ready provider result may no longer be admitted to the worker. */
  private childAdmissionFailure(): { reason: string; rendered: string } | undefined {
    if (this.cancelReason !== undefined) {
      return { reason: this.cancelReason, rendered: `workflow run cancelled: ${this.cancelReason}` }
    }
    if (this.workerDeathObserved) {
      return { reason: 'workflow worker gone', rendered: 'workflow worker is no longer available' }
    }
    if (this.terminalClaimed) {
      return { reason: 'workflow settled', rendered: 'workflow run already settled' }
    }
    return undefined
  }

  private onChildStart(callId: number, request: ChildStartRequest): void {
    const initialFailure = this.childAdmissionFailure()
    if (initialFailure !== undefined) {
      // Refuse after a terminal boundary: a child must never start on an
      // already-aborted signal (a provider subscribing only to future abort
      // events would never observe it).
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: initialFailure.rendered })
      return
    }
    this.hostStarted += 1
    const task = this.startChild(callId, request)
    this.pendingStarts.add(task)
    void task.then(
      () => { this.finishPendingStart(task) },
      /* v8 ignore next -- startChild contains provider and cleanup failures */
      () => { this.finishPendingStart(task) },
    )
  }

  /** Resolve a tier label to a model id; own string entries only (never a prototype member). */
  private tierModel(tier: string): string | undefined {
    const map = this.extras.tierModels
    if (map === undefined || !Object.hasOwn(map, tier)) return undefined
    const model = map[tier]
    return typeof model === 'string' && model.length > 0 ? model : undefined
  }

  /**
   * Refuse a child whose final model names the denied family. The final id is the explicit model,
   * else the tier's model, else the parent's own; the model catalog's id and name for it are
   * checked too, so a catalog alias cannot carry the family past the static checks.
   */
  private async assertModelAllowed(request: ChildStartRequest, model: string | undefined): Promise<void> {
    const final = model ?? this.parent.options.model
    if (final === undefined) {
      throw new Error('the model for this node cannot be determined (no explicit, tier or parent model), so the Fable check cannot run; set a model on the node or the parent agent')
    }
    const candidates = [final]
    const provider = request.provider ?? this.parent.options.provider
    const llm = this.ctx.get('llm')
    if (llm !== undefined && provider !== undefined) {
      try {
        const info = await llm.resolveModelInfo(provider, final, this.controller.signal)
        candidates.push(info.id, info.name)
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow-worker-thread: model catalog lookup failed: ${renderThrown(error)}`)
        throw new Error(`model "${final}" could not be checked against the model catalog, so the node was not started`)
      }
    }
    if (candidates.some(namesDeniedModel)) {
      throw new Error(`model "${final}" resolves to a denied model family (Fable is not allowed in workflows)`)
    }
  }

  /** Provider start for one child (or continuation iteration); the caller handles failure and admission. */
  private async launchChild(request: ChildStartRequest, prompt: string): Promise<SubagentRun> {
    // A tier names a model only when the call gave none; an unmapped tier leaves the default model.
    const model = request.model ?? (request.tier !== undefined ? this.tierModel(request.tier) : undefined)
    await this.assertModelAllowed(request, model)
    return this.subagents.start(this.provider, {
      prompt: [{ type: 'text', text: prompt }],
      parent: this.parent,
      signal: this.controller.signal,
      ...request.schema !== undefined ? { outputSchema: request.schema } : {},
      ...request.provider !== undefined || model !== undefined
        ? {
          agentOptions: {
            ...request.provider !== undefined ? { provider: request.provider } : {},
            ...model !== undefined ? { model } : {},
          },
        }
        : {},
    })
  }

  /** Run a supervisor callback; its failure is logged and contained (the supervisor is advisory, never fatal). */
  private supervise(label: string, call: () => void): void {
    try {
      call()
    } catch (error: unknown) {
      this.ctx.logger.warn(`workflow-worker-thread: supervisor ${label} failed: ${renderThrown(error)}`)
    }
  }

  /** Deliver the supervisor's release exactly once per child. */
  private releaseSupervision(record: ChildRecord): void {
    if (record.released) return
    record.released = true
    this.supervise('release', () => { this.supervisor?.release?.(record.supervised, record.run.id) })
  }

  /** Await one provider-owned startup transaction and publish only while admitted. */
  private async startChild(callId: number, request: ChildStartRequest): Promise<void> {
    const invalid = invalidChildRequest(request)
    if (invalid !== undefined) {
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: invalid })
      return
    }
    if (request.doneWhen !== undefined) {
      // Fail loud: a done-when check nobody evaluates would silently accept unfinished work.
      let refusal: string | undefined
      if (!this.bashEnabled) refusal = 'doneWhen is not enabled for this run'
      else if (this.supervisor?.evaluate === undefined) refusal = 'doneWhen needs a child supervisor with an evaluate() hook, and none is installed'
      else {
        try {
          validateDoneWhen(request.doneWhen)
        } catch (error: unknown) {
          refusal = renderThrown(error)
        }
      }
      if (refusal !== undefined) {
        this.post(HostToWorkerType.ChildStartError, { callId, rendered: refusal })
        return
      }
    }
    const supervised: ChildRecord['supervised'] = {
      callId,
      prompt: request.prompt,
      iteration: 0,
      ...request.nodeId !== undefined ? { nodeId: request.nodeId } : {},
      ...request.tier !== undefined ? { tier: request.tier } : {},
      timeoutMs: Math.min(request.timeoutMs ?? DEFAULT_CHILD_DEADLINE_MS, MAX_CHILD_DEADLINE_MS),
      ...request.idleTimeoutMs !== undefined ? { idleTimeoutMs: request.idleTimeoutMs } : {},
      ...request.doneWhen !== undefined ? { doneWhen: request.doneWhen } : {},
    }
    // Registration happens BEFORE the provider start, while the child session id does not exist yet.
    this.supervise('register', () => { this.supervisor?.register?.({ ...supervised }) })
    let run: SubagentRun
    try {
      run = await this.launchChild(request, request.prompt)
    } catch (error: unknown) {
      this.supervise('release', () => { this.supervisor?.release?.({ ...supervised }, undefined) })
      const failure = this.childAdmissionFailure()
      this.post(HostToWorkerType.ChildStartError, {
        callId,
        rendered: failure?.rendered ?? renderThrown(error),
      })
      return
    }
    const failure = this.childAdmissionFailure()
    if (failure !== undefined) {
      this.supervise('release', () => { this.supervisor?.release?.({ ...supervised }, run.id) })
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: failure.rendered })
      try {
        await run.dispose()
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow-worker-thread: refused child dispose failed: ${renderThrown(error)}`)
      }
      return
    }

    const record: ChildRecord = { run, supervised, released: false, stop: Promise.withResolvers() }
    this.children.set(callId, record)
    this.supervise('bind', () => { this.supervisor?.bind?.({ ...supervised }, run.id, this.stopHandle(record)) })
    // Attach result forwarding before publishing the child handle. Because the
    // callback itself runs in a later microtask, ChildStarted is still posted
    // first even for an already-settled scripted provider.
    const forwardResult = this.collectChildResult(record, request).then<() => void, () => void>(
      (result) => {
        try {
          const snapshot = snapshotJsonValue<ChildResult>(result)
          if (snapshot === undefined) throw new TypeError('child result is not losslessly JSON-serializable')
          return () => { this.post(HostToWorkerType.ChildSettled, { callId, result: snapshot }) }
        } catch (error: unknown) {
          const rendered = `workflow child result could not cross the worker boundary: ${renderThrown(error)}`
          return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
        }
      },
      (error: unknown) => {
        const rendered = renderThrown(error)
        return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
      },
    )
    this.post(HostToWorkerType.ChildStarted, { callId, childId: run.id })
    void forwardResult.then((forward) => { forward() })
  }

  /** The handle a supervisor gets for ONE iteration's child: stop disposes it and settles the call with the stop reason. */
  private stopHandle(record: ChildRecord): WorkflowChildHandle {
    const stop = record.stop
    const run = record.run
    return {
      stop: (reason) => {
        if (record.stop !== stop || record.run !== run) return
        stop.resolve(reason)
        void Promise.resolve().then(() => run.dispose()).catch((error: unknown) => {
          this.ctx.logger.warn(`workflow-worker-thread: stopped child dispose failed: ${renderThrown(error)}`)
        })
      },
    }
  }

  /** Await the current iteration: its result, or the supervisor's stop, whichever comes first. */
  private async awaitIteration(record: ChildRecord): Promise<{ result: SubagentResult } | { stopped: 'timeout' | 'stalled' }> {
    const run = record.run
    // A disposed run's result may reject after a stop won the race; that rejection is not an infrastructure fault.
    run.result.catch(() => { /* consumed: see above */ })
    return await Promise.race([
      run.result.then(result => ({ result })),
      record.stop.promise.then(stopped => ({ stopped })),
    ])
  }

  /**
   * Await one child's terminal result, running the continuation loop when a done-when check is
   * attached: the supervisor evaluates each result; failure evidence starts a FRESH child (a
   * one-shot subagent run cannot be re-prompted) whose prompt carries the labelled evidence. The
   * cap is enforced here, host-side, and clamped to the ceiling regardless of what the script
   * asked. Rejects only on an infrastructure fault, like `SubagentRun.result`.
   */
  private async collectChildResult(record: ChildRecord, request: ChildStartRequest): Promise<ChildResult> {
    try {
      let step = await this.awaitIteration(record)
      if ('stopped' in step) return stoppedResult(step.stopped)
      let result = step.result
      let iterations = 1
      const doneWhen: WorkflowDoneWhen | undefined = request.doneWhen
      const supervisor = this.supervisor
      if (doneWhen === undefined || supervisor?.evaluate === undefined) return projectChildResult(result)
      const cap = Math.min(Math.max(doneWhen.maxContinuations ?? 3, 0), WORKFLOW_CONTINUATION_CEILING)
      for (;;) {
        // A closing run does not evaluate: the result is forwarded as-is for the cancel/death path.
        if (this.childAdmissionFailure() !== undefined) return projectChildResult(result)
        const outcome = { stopReason: result.stopReason, text: flattenText(result.output) }
        let raw: WorkflowContinuationEvidence | undefined
        try {
          raw = await supervisor.evaluate({ ...record.supervised }, outcome, {
            runBash: (command, options) => this.runSupervisorBash(command, options),
            signal: this.controller.signal,
          })
        } catch (error: unknown) {
          this.ctx.logger.warn(`workflow-worker-thread: supervisor evaluate failed: ${renderThrown(error)}`)
          // A check that could not run is a FAILED check, never "no opinion": accepting it would let unfinished work
          // through silently. The normal continuation/cap path applies and exhaustion fails the node with this tail.
          raw = {
            iteration: iterations,
            maxContinuations: cap,
            command: doneWhen.command,
            exitCode: null,
            tail: `done_when check could not run: ${error instanceof Error ? error.message : String(error)}`,
            truncated: false,
          }
        }
        if (raw === undefined || this.childAdmissionFailure() !== undefined) {
          return projectChildResult(result, { iterations, exhausted: false })
        }
        const clamped = evidenceTail(sanitizeEvidenceText(raw.tail, true))
        const evidence: WorkflowContinuationEvidence = {
          iteration: iterations,
          maxContinuations: cap,
          command: sanitizeEvidenceText(raw.command.slice(0, EVIDENCE_COMMAND_MAX_CHARS), false),
          exitCode: raw.exitCode,
          tail: clamped.tail,
          truncated: raw.truncated || clamped.truncated,
        }
        // Continuation children count toward the run's total-agent cap like any other child.
        if (iterations > cap || this.hostStarted >= this.maxTotalAgents) {
          // Exhausted: the node fails with the last evidence.
          return { ...projectChildResult(result), stopReason: 'done-when-exhausted', continuation: { iterations, exhausted: true, evidence } }
        }
        const previous = record.run
        // The old child leaves supervision before the next iteration registers; `released` stays true until the new child binds,
        // so a failed launch cannot release the old id a second time.
        this.releaseSupervision(record)
        const nextSupervised = { ...record.supervised, iteration: record.supervised.iteration + 1 }
        this.supervise('register', () => { supervisor.register?.({ ...nextSupervised }) })
        this.hostStarted += 1
        let next: SubagentRun
        try {
          next = await this.launchChild(request, composeContinuationPrompt(request.prompt, evidence))
        } catch (error: unknown) {
          // The next iteration was registered but never bound: release it (no child id) before the failure propagates.
          this.supervise('release', () => { supervisor.release?.({ ...nextSupervised }, undefined) })
          throw error
        }
        if (this.childAdmissionFailure() !== undefined) {
          await next.dispose().catch(() => { /* contained: refused continuation */ })
          return projectChildResult(result, { iterations, exhausted: false })
        }
        record.run = next
        record.stop = Promise.withResolvers()
        record.supervised.iteration = nextSupervised.iteration
        record.released = false
        this.supervise('bind', () => { supervisor.bind?.({ ...record.supervised }, next.id, this.stopHandle(record)) })
        void previous.dispose().catch((error: unknown) => {
          this.ctx.logger.warn(`workflow-worker-thread: continued child dispose failed: ${renderThrown(error)}`)
        })
        step = await this.awaitIteration(record)
        if ('stopped' in step) return stoppedResult(step.stopped)
        result = step.result
        iterations += 1
      }
    } finally {
      this.releaseSupervision(record)
    }
  }

  private onChildDispose(callId: number): void {
    const record = this.children.get(callId)
    if (record === undefined) {
      // Already disposed host-side (a dispose() drive or a death reap beat
      // the RPC) — the ack is still owed (the worker-side wrapper awaits it).
      this.post(HostToWorkerType.ChildDisposed, { callId })
      return
    }
    // disposeChild never rejects (containment is inside), so the ack always follows.
    void this.disposeChild(callId, record).then(() => { this.post(HostToWorkerType.ChildDisposed, { callId }) })
  }

  /**
   * Start (or join) one registered child's disposal; the registry entry
   * leaves when it settles. Memoized per callId: the worker's dispose RPC,
   * the dispose() host drive, and the reap can all land on the same child —
   * the child's `dispose()` runs once and every caller awaits that one
   * settlement. A rejection is contained (the subagent seam's dispose() is
   * not supposed to reject, but a backend that does anyway must not break
   * quiescence): logged, and the child still leaves the registry.
   * @param callId - the child's registry key.
   * @param record - the registered child (the caller looked it up).
   * @returns resolves when the disposal settled either way; never rejects.
   */
  private disposeChild(callId: number, record: ChildRecord): Promise<void> {
    if (record.disposal !== undefined) return record.disposal
    record.disposal = Promise.resolve()
      .then(() => { this.releaseSupervision(record) })
      .then(() => record.run.dispose())
      .catch((error: unknown) => {
        this.ctx.logger.warn(`workflow-worker-thread: child dispose failed: ${renderThrown(error)}`)
      })
      .then(() => { this.finishChild(callId) })
    return record.disposal
  }

  /** Drop a child record and release quiescence waiters when all work ends. */
  private finishChild(callId: number): void {
    this.children.delete(callId)
    this.notifyChildQuiescence()
  }

  /** Retire one provider startup transaction. */
  private finishPendingStart(task: Promise<void>): void {
    this.pendingStarts.delete(task)
    this.notifyChildQuiescence()
  }

  /** Release waiters only after both pending starts and published children end. */
  private notifyChildQuiescence(): void {
    if (this.children.size !== 0 || this.pendingStarts.size !== 0) return
    for (const waiter of this.quiescenceWaiters.splice(0)) waiter()
  }

  /** Resolves once every pending start and published child has reached quiescence. */
  private childQuiescence(): Promise<void> {
    if (this.children.size === 0 && this.pendingStarts.size === 0) return Promise.resolve()
    return new Promise((resolve) => { this.quiescenceWaiters.push(resolve) })
  }

  /** Abort + dispose every registered child (worker death / final teardown); disposal is contained, not awaited. */
  private reapChildren(reason: string): void {
    this.abortChildren(this.cancelReason ?? reason)
    for (const [callId, record] of [...this.children]) {
      void this.disposeChild(callId, record)
    }
  }

  /** Abort the one canonical signal shared by pending and published children. */
  private abortChildren(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  /** An agent started: rebuild the info from validated fields; drop duplicates and anything past the live bound. */
  private agentStarted(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) throw new TypeError('agent-start info is not an object')
    const r = raw as Record<string, unknown>
    if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 1) throw new TypeError('agent-start seq is invalid')
    if (typeof r.label !== 'string' || typeof r.childId !== 'string') throw new TypeError('agent-start label or childId is invalid')
    if (r.phase !== undefined && typeof r.phase !== 'string') throw new TypeError('agent-start phase is invalid')
    if (this.liveAgents.has(r.seq) || this.liveAgents.size >= MAX_LIVE_AGENTS) return
    const info: WorkflowAgentInfo = {
      seq: r.seq,
      label: cleanText(r.label, AGENT_LABEL_MAX_CHARS),
      ...r.phase !== undefined ? { phase: cleanText(r.phase, PHASE_TITLE_MAX_CHARS) } : {},
      childId: cleanText(r.childId, 256) as WorkflowAgentInfo['childId'],
    }
    this.liveAgents.set(info.seq, info)
    this.observer.agentStart(info)
  }

  /** An agent ended: only the outcome is taken from the worker; identity comes from the host ledger. */
  private agentEndedByWorker(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) throw new TypeError('agent-end info is not an object')
    const r = raw as Record<string, unknown>
    if (typeof r.seq !== 'number') throw new TypeError('agent-end seq is invalid')
    if (r.outcome !== 'completed' && r.outcome !== 'failed' && r.outcome !== 'cancelled') throw new TypeError('agent-end outcome is invalid')
    const started = this.liveAgents.get(r.seq)
    if (started === undefined) return
    this.endAgent({ ...started, outcome: r.outcome })
  }

  private onResult(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) throw new TypeError('result is not an object')
    const r = raw as Record<string, unknown>
    if (r.stopReason !== 'completed' && r.stopReason !== 'cancelled' && r.stopReason !== 'error') throw new TypeError('result stopReason is invalid')
    if (typeof r.agentsStarted !== 'number' || !Number.isSafeInteger(r.agentsStarted) || r.agentsStarted < 0) {
      throw new TypeError('result agentsStarted is invalid')
    }
    if (r.error !== undefined && typeof r.error !== 'string') throw new TypeError('result error is invalid')
    const result: WorkflowResult = {
      value: r.value ?? null,
      stopReason: r.stopReason,
      ...r.error !== undefined ? { error: cleanText(r.error, RESULT_ERROR_MAX_CHARS) } : {},
      agentsStarted: r.agentsStarted,
    }
    // The owned worker session sends one Result. Keep a late duplicate or a
    // Result queued behind another terminal source completely side-effect-free.
    if (this.terminalClaimed) return
    // First-wins is decided when the Result message reaches the host. If no
    // external cancellation was already in flight, this result won. Reaping a
    // stray child below may synchronously reenter cancel() through provider
    // callbacks, but that internal post-result cleanup must not retroactively
    // rewrite the worker result that arrived first.
    const cancellationWasRequested = this.cancelReason !== undefined
    // Claim before settlement cleanup invokes provider disposal. Once Result
    // won, a later cancellation cannot rewrite it.
    this.terminalClaimed = true
    // Abort pending starts and begin disposing published children before the
    // workflow becomes externally settled. Cleanup remains independently
    // tracked by childQuiescence and the holder's dispose().
    this.reapChildren('workflow settled')
    this.endStrandedNodes()
    if (!cancellationWasRequested) {
      this.settleResult(result)
      return
    }
    if (result.stopReason !== 'cancelled') {
      // The script settled while our cancel was crossing the thread boundary
      // — the seam-visible result had NOT settled when cancellation was
      // requested, so report cancelled (the vm drive()'s post-settle check,
      // relocated to the receiving side of the race).
      this.settleResult(this.cancelledResult(result.agentsStarted))
      return
    }
    this.settleResult(result)
  }

  /** Process an error/messageerror/exit signal; `exit` also performs the final disposal sweep. */
  private onWorkerDeath(message: string, isExit: boolean): void {
    if (!this.workerDeathObserved) {
      // Close message admission BEFORE cleanup callbacks: Node can deliver a
      // message queued before the crash after its `error` event. Treating the
      // first death signal as a logical barrier prevents that late message
      // from creating work or narrating after workflow/end.
      this.workerDeathObserved = true
      const outcomeWasClaimed = this.terminalClaimed
      const cancellationWasRequested = this.cancelReason !== undefined
      // When death is itself the terminal source, claim BEFORE child reap or
      // synthesized observer callbacks. Either can reenter cancel(); a death
      // that arrived first remains an error, while a cancellation already
      // accepted before death remains cancelled. If Result/grace already won,
      // preserve it while still performing prompt failure-time cleanup.
      if (!outcomeWasClaimed) this.terminalClaimed = true
      if (this.children.size > 0 || this.pendingStarts.size > 0) this.reapChildren('workflow worker gone')
      this.endStrandedAgents()
      this.endStrandedNodes()
      if (!outcomeWasClaimed) {
        if (cancellationWasRequested) {
          this.settleResult(this.cancelledResult(this.hostStarted))
        } else {
          this.settleResult({ value: null, stopReason: 'error', error: message, agentsStarted: this.hostStarted })
        }
      }
    }
    if (!isExit) return
    // `error` is not Node's physical delivery barrier: a queued message may
    // precede `exit`. Admission is already closed, so this final sweep only
    // joins/starts disposal for registry survivors; it deliberately does not
    // repeat explicit provider cancellation.
    for (const [callId, record] of [...this.children]) void this.disposeChild(callId, record)
    this.endStrandedAgents()
    this.endStrandedNodes()
  }

  /**
   * The single agent-end emission gate: forwards `end` iff its start is still
   * unpaired in the ledger, so every forwarded `workflow/agent-start` gets
   * EXACTLY one `workflow/agent-end` — the worker's own report where it can
   * speak, a host-synthesized one where it cannot ({@link endStrandedAgents}).
   * @param end - the settlement to emit (worker-reported or synthesized).
   */
  private endAgent(end: WorkflowAgentEndInfo): void {
    /* v8 ignore next -- a real end still in flight across the grace force-settle: not orderable in-process */
    if (!this.liveAgents.delete(end.seq)) return
    this.observer.agentEnd(end)
  }

  /**
   * Synthesize the missing `agent-end` for every started-but-unpaired agent,
   * outcome `'cancelled'`: the reap cancels every child, and a real
   * settlement racing the force-settle loses to that already-started external
   * cancellation. The atomic terminal boundaries in {@link onResult} and
   * {@link onWorkerDeath} deliberately exclude teardown callbacks as contenders.
   * Called where the worker can no longer speak (the grace force-settle,
   * worker death, physical exit). When grace/death is the terminal source it
   * runs before settleResult, so already-known pairs precede `workflow/end`;
   * after an earlier Result, exit cleanup may close a survivor afterward.
   * The ledger preserves exactly-once pairing in both orders.
   */
  private endStrandedAgents(): void {
    for (const info of [...this.liveAgents.values()]) {
      this.endAgent({ ...info, outcome: 'cancelled' })
    }
  }

  /** Whether the node/gate event budget still has room (the overflow is dropped, never forwarded). */
  private eventBudgetLeft(): boolean {
    if (this.nodeGateEvents >= MAX_NODE_GATE_EVENTS_PER_RUN) return false
    this.nodeGateEvents += 1
    return true
  }

  /**
   * A node started. The worker's message is untrusted data: every field is re-validated and the
   * event is rebuilt field by field, never spread. A restart of a still-live id first closes the old one.
   */
  private nodeStarted(raw: unknown): void {
    const parsed = readNodeInfo(raw)
    if (parsed === undefined) return
    // The manifest wins: a worker-supplied gate kind on a manifest node is discarded outright.
    const info = this.manifestNodes.has(parsed.nodeId) ? { nodeId: parsed.nodeId, kind: parsed.kind } : parsed
    if (!this.everStarted.has(info.nodeId) && this.everStarted.size >= MAX_NODES_PER_RUN) return
    if (!this.eventBudgetLeft()) return
    const prior = this.liveNodes.get(info.nodeId)
    if (prior !== undefined) this.emitNodeEnd(prior, 'interrupted', 'node restarted before it ended')
    this.liveNodes.set(info.nodeId, info)
    this.everStarted.add(info.nodeId)
    // The manifest wins: a worker cannot declare or change the gates of a node the manifest names.
    if (info.gateKind !== undefined && !this.manifestNodes.has(info.nodeId)) {
      this.pendingGates.set(gateKey(info.nodeId, info.gateKind), { nodeId: info.nodeId, gateKind: info.gateKind })
    }
    this.observer.nodeStart(info)
  }

  /** A node ended: forward iff its start is still unpaired; kind and gate kind come from the host ledger, the rest is re-validated. */
  private nodeEnded(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const end = raw as Record<string, unknown>
    if (typeof end.nodeId !== 'string') return
    const started = this.liveNodes.get(end.nodeId)
    if (started === undefined) return
    if (typeof end.status !== 'string' || !NODE_STATUSES.has(end.status)) return
    if (!this.eventBudgetLeft()) return
    this.liveNodes.delete(end.nodeId)
    this.observer.nodeEnd({
      nodeId: started.nodeId,
      kind: started.kind,
      ...started.gateKind !== undefined ? { gateKind: started.gateKind } : {},
      status: end.status as WorkflowNodeEndInfo['status'],
      ...typeof end.exitCode === 'number' && Number.isSafeInteger(end.exitCode) ? { exitCode: end.exitCode } : {},
      ...typeof end.durationMs === 'number' && Number.isFinite(end.durationMs) && end.durationMs >= 0 ? { durationMs: end.durationMs } : {},
      ...typeof end.truncated === 'boolean' ? { truncated: end.truncated } : {},
      ...typeof end.error === 'string' ? { error: cleanText(end.error, NODE_ERROR_MAX_CHARS) } : {},
      synthesized: false,
    })
  }

  /** A gate was evaluated. Accepted only for a declared gate of a known node; duplicates and post-terminal gates are dropped. */
  private gateEvaluated(raw: unknown): void {
    if (this.terminalClaimed || typeof raw !== 'object' || raw === null) return
    const gate = raw as Record<string, unknown>
    if (typeof gate.nodeId !== 'string' || typeof gate.gateKind !== 'string' || typeof gate.outcome !== 'string') return
    if (!WORKFLOW_NODE_ID_PATTERN.test(gate.nodeId) || !LABEL_PATTERN.test(gate.gateKind) || !GATE_OUTCOMES.has(gate.outcome)) return
    const key = gateKey(gate.nodeId, gate.gateKind)
    const declared = this.pendingGates.has(key) || this.evaluatedGates.has(key)
    if (!declared || this.evaluatedGates.has(key)) return
    if (!this.eventBudgetLeft()) return
    this.evaluatedGates.add(key)
    this.pendingGates.delete(key)
    this.observer.gate({ nodeId: gate.nodeId, gateKind: gate.gateKind, outcome: gate.outcome as WorkflowGateInfo['outcome'], synthesized: false })
  }

  private emitNodeEnd(started: WorkflowNodeInfo, status: 'cancelled' | 'interrupted', error: string): void {
    this.liveNodes.delete(started.nodeId)
    this.observer.nodeEnd({ ...started, status, error, synthesized: true })
  }

  /**
   * The stranded sweep: on every terminal path (completed, error, cancelled, worker death,
   * grace force-settle, dispose) synthesize the missing `node-end` for each started node and the
   * missing `gate` for each owed gate. A node cut off mid-flight, or one that never started,
   * reports its gate as `not-reached`; a node that ended without evaluating its gate reports
   * `never-evaluated`. Several gates on one node are tracked per kind. A script-initiated
   * `cancel()` reaches here as `interrupted` (the host did not request that cancel); a host
   * cancel reports `cancelled`. Idempotent through the ledgers.
   */
  private endStrandedNodes(): void {
    const status = this.cancelReason !== undefined ? 'cancelled' : 'interrupted'
    const reason = this.cancelReason !== undefined ? `workflow run cancelled: ${this.cancelReason}` : 'workflow run ended before the node did'
    const stranded = new Set(this.liveNodes.keys())
    for (const started of [...this.liveNodes.values()]) this.emitNodeEnd(started, status, reason)
    for (const [key, { nodeId, gateKind }] of [...this.pendingGates]) {
      this.pendingGates.delete(key)
      this.evaluatedGates.add(key)
      this.observer.gate({ nodeId, gateKind, outcome: stranded.has(nodeId) || !this.everStarted.has(nodeId) ? 'not-reached' : 'never-evaluated', synthesized: true })
    }
  }

  /** Track one unit of host-side work (a bash command or an approval wait) so quiescence waits for it. */
  private trackHostWork(task: Promise<void>): void {
    this.pendingStarts.add(task)
    void task.then(
      () => { this.finishPendingStart(task) },
      /* v8 ignore next -- the work bodies contain their own failures */
      () => { this.finishPendingStart(task) },
    )
  }

  /** Resolve a workdir against the workspace root, requiring the realpath to stay inside it. */
  private async containedCwd(workdir: string | undefined): Promise<string> {
    const root = await realpath(resolvePath(this.extras.cwd ?? process.cwd()))
    if (workdir === undefined) return root
    const target = await realpath(resolvePath(root, workdir))
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
      throw new Error('workdir resolves outside the workspace')
    }
    return target
  }

  /** The authoritative bash path: re-validate, contain, run through the executor, abort-linked to the run. */
  private async executeBash(call: ValidatedBashCall): Promise<WorkflowBashResult> {
    const cwd = await this.containedCwd(call.workdir)
    const nodeInfo = call.nodeId !== undefined ? { nodeId: call.nodeId } : {}
    return await this.bashExecutor.run({
      command: call.command,
      cwd,
      env: call.env,
      timeoutMs: call.timeoutMs,
      maxOutputBytes: WORKFLOW_BASH_OUTPUT_CAP_BYTES,
      signal: this.controller.signal,
      ...this.extras.onBashOutput !== undefined
        ? {
          onOutput: (stream: 'stdout' | 'stderr', chunk: Uint8Array) => {
            try {
              this.extras.onBashOutput?.(nodeInfo, stream, chunk)
            } catch (error: unknown) {
              this.ctx.logger.warn(`workflow-worker-thread: bash output sink failed: ${renderThrown(error)}`)
            }
          },
        }
        : {},
    })
  }

  /** The `bash-start` handler. Failures reply `bash-error` with a rendered reason (never the command's environment). */
  private async runBashCall(callId: number, command: unknown, options: unknown): Promise<void> {
    let counted = false
    try {
      if (!this.bashEnabled) throw new Error('bash() is not enabled for this run')
      const failure = this.childAdmissionFailure()
      if (failure !== undefined) throw new Error(failure.rendered)
      if (this.bashCalls >= MAX_BASH_CALLS_PER_RUN) throw new Error(`bash() call budget exhausted (${MAX_BASH_CALLS_PER_RUN} per run)`)
      if (this.activeBash >= MAX_CONCURRENT_BASH) throw new Error(`too many concurrent bash() commands (limit ${MAX_CONCURRENT_BASH})`)
      this.bashCalls += 1
      this.activeBash += 1
      counted = true
      const result = await this.executeBash(validateBashCall(command, options))
      this.post(HostToWorkerType.BashResult, { callId, result })
    } catch (error: unknown) {
      this.post(HostToWorkerType.BashError, { callId, rendered: renderThrown(error) })
    } finally {
      if (counted) this.activeBash -= 1
    }
  }

  /** The bash a supervisor may run (a done-when check): same validation, containment and abort link. */
  private runSupervisorBash(command: string, options?: { workdir?: string; timeoutMs?: number }): Promise<WorkflowBashResult> {
    return (async () => {
      if (!this.bashEnabled) throw new Error('bash is not enabled for this run')
      // A done-when check counts against the same budget and concurrency limit as a script's bash().
      if (this.bashCalls >= MAX_BASH_CALLS_PER_RUN) throw new Error(`bash() call budget exhausted (${MAX_BASH_CALLS_PER_RUN} per run)`)
      if (this.activeBash >= MAX_CONCURRENT_BASH) throw new Error(`too many concurrent bash() commands (limit ${MAX_CONCURRENT_BASH})`)
      this.bashCalls += 1
      this.activeBash += 1
      try {
        return await this.executeBash(validateBashCall(command, options))
      } finally {
        this.activeBash -= 1
      }
    })()
  }

  /**
   * The `approve-start` handler. Arguments are untrusted: every shape is checked, anything off
   * answers `unavailable`, and the whole body is wrapped so a bad message cannot throw out of the
   * host. A fresh 128-bit id is minted per question and stays host-side (never sent to the worker).
   * The question settles on the first of (approver answer, external {@link decideApproval}, wait
   * expiry, run abort). No approver, a throwing approver, or a rogue return all answer `unavailable`.
   */
  private async runApproval(callId: number, rawNodeId: unknown, rawMessage: unknown, rawTimeout: unknown): Promise<void> {
    const approvalId = newApprovalId()
    const answer = Promise.withResolvers<WorkflowApprovalOutcome>()
    let settledOutcome: WorkflowApprovalOutcome | undefined
    let nodeId = ''
    let message = ''
    const entry: PendingApprovalEntry = {
      approvalId,
      get nodeId() { return nodeId },
      get message() { return message },
      settle: (outcome) => {
        if (settledOutcome !== undefined) return false
        settledOutcome = outcome
        this.approvals.delete(approvalId)
        this.decidedApprovals.add(approvalId)
        if (this.decidedApprovals.size > MAX_DECIDED_APPROVAL_IDS) {
          const oldest = this.decidedApprovals.values().next().value
          if (oldest !== undefined) this.decidedApprovals.delete(oldest)
        }
        answer.resolve(outcome)
        return true
      },
    }
    const onAbort = (): void => { entry.settle('cancelled') }
    let expiry: NodeJS.Timeout | undefined
    try {
      if (typeof rawNodeId !== 'string' || !WORKFLOW_NODE_ID_PATTERN.test(rawNodeId)
        || typeof rawMessage !== 'string' || rawMessage.length === 0 || rawMessage.length > WORKFLOW_APPROVAL_MESSAGE_MAX_CHARS
        || (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1))) {
        entry.settle('unavailable')
      } else if (this.approvalsAsked >= MAX_APPROVALS_PER_RUN || this.approvals.size >= MAX_PENDING_APPROVALS) {
        entry.settle('unavailable')
      } else if (this.childAdmissionFailure() !== undefined || this.controller.signal.aborted) {
        entry.settle('cancelled')
      } else if (this.extras.approver === undefined) {
        entry.settle('unavailable')
      } else {
        nodeId = rawNodeId
        message = cleanText(rawMessage, WORKFLOW_APPROVAL_MESSAGE_MAX_CHARS)
        this.approvalsAsked += 1
        this.approvals.set(approvalId, entry)
        this.controller.signal.addEventListener('abort', onAbort, { once: true })
        const approver = this.extras.approver
        // Wait cap: the requested timeout, clamped to one hour. Expiry rejects the node and withdraws the question.
        const waitCap = Math.min(rawTimeout ?? APPROVAL_WAIT_CEILING_MS, APPROVAL_WAIT_CEILING_MS)
        const questionAbort = new AbortController()
        expiry = setTimeout(() => { if (entry.settle('rejected')) questionAbort.abort('approval wait expired') }, waitCap)
        expiry.unref()
        const onRunAbort = (): void => { questionAbort.abort(this.controller.signal.reason) }
        this.controller.signal.addEventListener('abort', onRunAbort, { once: true })
        void answer.promise.finally(() => {
          this.controller.signal.removeEventListener('abort', onRunAbort)
          if (!questionAbort.signal.aborted) questionAbort.abort('approval decided')
        })
        void (async () => approver({ approvalId, nodeId, message, signal: questionAbort.signal }))().then(
          (outcome) => { entry.settle(APPROVAL_OUTCOMES.has(outcome) ? outcome : 'unavailable') },
          (error: unknown) => {
            // The question text is deliberately not logged.
            this.ctx.logger.warn(`workflow-worker-thread: approver failed for node ${nodeId}: ${renderThrown(error)}`)
            entry.settle('unavailable')
          },
        )
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`workflow-worker-thread: approval handling failed: ${renderThrown(error)}`)
      entry.settle('unavailable')
    }
    try {
      const outcome = await answer.promise
      this.post(HostToWorkerType.ApproveResult, { callId, outcome })
    } finally {
      clearTimeout(expiry)
      this.controller.signal.removeEventListener('abort', onAbort)
    }
  }

  /** @inheritdoc */
  pendingApprovals(): readonly WorkflowPendingApproval[] {
    return [...this.approvals.values()].map(({ approvalId, nodeId, message }) => ({ approvalId, nodeId, message }))
  }

  /** @inheritdoc */
  decideApproval(approvalId: string, outcome: WorkflowApprovalOutcome): WorkflowApprovalDecision {
    if (!APPROVAL_OUTCOMES.has(outcome)) return 'unknown'
    // Constant-time scan: every candidate is compared; there is no early exit on a match.
    let match: PendingApprovalEntry | undefined
    for (const entry of this.approvals.values()) {
      if (approvalIdsEqual(entry.approvalId, approvalId)) match = entry
    }
    if (match !== undefined) return match.settle(outcome) ? 'decided' : 'already-decided'
    let wasDecided = false
    for (const id of this.decidedApprovals) {
      if (approvalIdsEqual(id, approvalId)) wasDecided = true
    }
    return wasDecided ? 'already-decided' : 'unknown'
  }

  private cancelledResult(agentsStarted: number): WorkflowResult {
    // cancel() is the only writer of cancelReason and every caller checks it
    // first; the fallback guards the type, not a reachable path.
    /* v8 ignore next */
    const reason = this.cancelReason ?? 'workflow cancelled'
    return { value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${reason}`, agentsStarted }
  }

  /** Remove the exact abort callback installed on the caller's start signal. */
  private detachInputSignal(): void {
    const signal = this.inputSignal
    const onAbort = this.inputSignalAbort
    if (signal === undefined || onAbort === undefined) return
    this.inputSignal = undefined
    this.inputSignalAbort = undefined
    signal.removeEventListener('abort', onAbort)
  }

  /** First settle wins; disarms the grace timer and releases the caller signal. */
  private settleResult(result: WorkflowResult): void {
    // Every current terminal source claims ownership before calling here; keep
    // the fallback local so a future caller cannot resolve twice.
    /* v8 ignore next -- defensive fallback outside the claimed state machine */
    if (this.settled) return
    this.terminalClaimed = true
    this.settled = true
    this.detachInputSignal()
    clearTimeout(this.graceTimer)
    this.settleResolve(result)
  }
}

/** A plain timer sleep (the dispose grace); unref'd so it never holds the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/** Flatten a child's final output blocks to text. */
function flattenText(blocks: SubagentResult['output']): string {
  return blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** The JSON projection of a settled child (before the snapshot check). */
function projectChildResult(result: SubagentResult, continuation?: ChildResult['continuation']): ChildResult {
  return {
    output: result.output,
    ...result.structured !== undefined ? { structured: result.structured } : {},
    stopReason: result.stopReason,
    ...continuation !== undefined ? { continuation } : {},
  }
}

/** The key identifying one gate of one node. */
function gateKey(nodeId: string, gateKind: string): string {
  return `${nodeId}\u0000${gateKind}`
}

/** Strip control characters (keeping newline and tab) and bound the length. */
function cleanText(text: string, max: number): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max)
}

/** Rebuild a worker-supplied node identity from validated fields only; `undefined` when anything is off. */
function readNodeInfo(raw: unknown): WorkflowNodeInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.nodeId !== 'string' || !WORKFLOW_NODE_ID_PATTERN.test(record.nodeId)) return undefined
  if (typeof record.kind !== 'string' || !LABEL_PATTERN.test(record.kind)) return undefined
  if (record.gateKind !== undefined && (typeof record.gateKind !== 'string' || !LABEL_PATTERN.test(record.gateKind))) return undefined
  return { nodeId: record.nodeId, kind: record.kind, ...record.gateKind !== undefined ? { gateKind: record.gateKind } : {} }
}

/** The result a supervisor-stopped child settles with; `timeout` and `stalled` are what the engine's retry treats as transient. */
function stoppedResult(reason: 'timeout' | 'stalled'): ChildResult {
  return { output: [], stopReason: reason }
}

const MAX_PROMPT_CHARS = 1_000_000
const MAX_CHILD_DEADLINE_MS = 86_400_000
/** Absolute deadline applied to a child whose script gave no `timeoutMs`: nothing runs unbounded. */
const DEFAULT_CHILD_DEADLINE_MS = 3_600_000

/** Re-validate a worker-supplied child request host-side; returns the refusal text, or `undefined` when sound. */
function invalidChildRequest(request: ChildStartRequest): string | undefined {
  const r = request as unknown as Record<string, unknown>
  if (typeof r.prompt !== 'string' || r.prompt.length === 0 || r.prompt.length > MAX_PROMPT_CHARS) return 'child prompt must be a non-empty string within bounds'
  if (r.nodeId !== undefined && (typeof r.nodeId !== 'string' || !WORKFLOW_NODE_ID_PATTERN.test(r.nodeId))) return 'child nodeId is malformed'
  if (r.tier !== undefined && (typeof r.tier !== 'string' || !LABEL_PATTERN.test(r.tier))) return 'child tier is malformed'
  for (const key of ['timeoutMs', 'idleTimeoutMs'] as const) {
    const value = r[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_CHILD_DEADLINE_MS)) {
      return `child ${key} is out of range`
    }
  }
  for (const key of ['provider', 'model'] as const) {
    const value = r[key]
    if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) {
      return `child ${key} is malformed`
    }
  }
  if (r.schema !== undefined) {
    try {
      assertObjectJsonSchema(r.schema)
    } catch {
      return 'child schema is outside the supported subset'
    }
  }
  return undefined
}

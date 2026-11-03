/**
 * Per-run worker-side vm hooks, child RPC, concurrency/caps, cancellation, and result serialization; it
 * never touches Cordis. Script values leaving the realm are materialized as plain JSON before
 * messaging. Values entering the trusted model-written realm are passed directly; `args` alone is
 * cloned so script mutation cannot alter initialization data. See `./realm.ts` for the trust model.
 *
 * Fatal workflow errors—bad hook arguments, unsupported schemas/options, caps, start failures, and
 * cancellation—propagate through combinators. Only child failures and ordinary stage errors become
 * per-item nulls. Every returned promise has a rejection consumer so dropped script promises cannot
 * kill the worker. A cancelled script that never settles emits nothing; the host force-settles the
 * run within grace and terminates the thread.
 * @module @deepseek-ai/dsh-workflow-worker-thread/runtime
 */

import * as vm from 'node:vm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema, JsonSchemaError } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  assertNodeId,
  isFatalWorkflowError,
  validateBashCall,
  validateDoneWhen,
  WORKFLOW_APPROVAL_MESSAGE_MAX_CHARS,
  WorkflowError,
} from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowBashOptions,
  WorkflowContinuationEvidence,
  WorkflowDoneWhen,
  WorkflowGateInfo,
  WorkflowGateOutcome,
  WorkflowMeta,
  WorkflowNodeEndInfo,
  WorkflowNodeInfo,
  WorkflowNodeStatus,
  WorkflowResult,
} from '@deepseek-ai/dsh-workflow'
import { materializeFromRealm, MaterializeError, renderThrown } from './realm.ts'
import type { ChildHandle, ChildPort, HookPort, WorkerLimits } from './types.ts'

/** The observers the execution reports progress through (the session posts them to the host). */
export interface ExecutionObserver {
  phase(title: string): void
  log(message: string): void
  agentStart(info: WorkflowAgentInfo): void
  agentEnd(info: WorkflowAgentEndInfo): void
  nodeStart(info: WorkflowNodeInfo): void
  nodeEnd(info: WorkflowNodeEndInfo): void
  gate(info: WorkflowGateInfo): void
}

const NODE_STATUSES: ReadonlySet<string> = new Set<WorkflowNodeStatus>(['success', 'failed', 'skipped', 'cancelled', 'interrupted'])
const GATE_OUTCOMES: ReadonlySet<string> = new Set<WorkflowGateOutcome>(['fired-pass', 'fired-block', 'skipped', 'not-reached', 'never-evaluated'])
/** Node kind and gate kind labels: short lowercase words. */
const LABEL_PATTERN = /^[a-z][a-z_]{0,31}$/
/** Bound on a node's error text carried in an event. */
const NODE_ERROR_MAX_CHARS = 2000

/**
 * The documented node failure for a supervisor stop. A stall is "no output for the idle window";
 * a timeout is the hard per-node limit. Both name the window and the retry count. The message
 * carries no code prefix (the code is `failure.code`); the back-compat `error` string adds it.
 */
function describeStop(
  stop: { code: 'NODE_STALLED' | 'NODE_TIMEOUT'; idleTimeoutMs?: number; timeoutMs?: number; subject?: 'bash' },
  attempts: number,
): NonNullable<WorkflowNodeEndInfo['failure']> {
  const retries = Math.max(attempts - 1, 0)
  const retried = `after ${attempts} attempt${attempts === 1 ? '' : 's'} (${retries} retr${retries === 1 ? 'y' : 'ies'})`
  if (stop.code === 'NODE_STALLED') {
    const window = stop.idleTimeoutMs === undefined ? 'the idle window' : `${stop.idleTimeoutMs} ms`
    return {
      code: 'NODE_STALLED',
      message: `the agent produced no output for ${window} (idleTimeoutMs) ${retried}`,
      remedy: "raise idleTimeoutMs for this node or check the agent's output",
    }
  }
  const limit = stop.timeoutMs === undefined ? 'the node deadline' : `${stop.timeoutMs} ms`
  return {
    code: 'NODE_TIMEOUT',
    message: `the ${stop.subject === 'bash' ? 'command' : 'agent'} did not finish within ${limit} (timeoutMs, the hard per-node limit) ${retried}`,
    remedy: 'raise timeoutMs (timeout_ms in YAML) for this node or split its work into smaller nodes',
  }
}

/** The `agent()` options the script may pass; everything else rejects loud. */
const SUPPORTED_AGENT_OPTIONS = new Set([
  'label', 'phase', 'schema', 'provider', 'model', 'nodeId', 'tier', 'timeoutMs', 'idleTimeoutMs', 'retry', 'doneWhen',
])
const SUPPORTED_AGENT_OPTIONS_TEXT = 'label, phase, schema, provider, model, nodeId, tier, timeoutMs, idleTimeoutMs, retry, doneWhen'
/**
 * Child stop reasons the engine's transient-only retry treats as retryable (a stall or a deadline,
 * reported by the child supervisor). Everything else, including an ordinary failed child, is final.
 */
export const TRANSIENT_STOP_REASONS: ReadonlySet<string> = new Set(['timeout', 'stalled'])
const RETRY_MAX_ATTEMPTS_CEILING = 5
const RETRY_DELAY_CEILING_MS = 60_000
/** The validated `retry` option. */
interface RetrySpec { maxAttempts: number; delayMs: number }
/** Deferred Claude Code options we name explicitly in the rejection message. */
const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType'])

/** Flatten a child's final output blocks to text (the non-schema `agent()` result). */
function outputText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** A short display label derived from the prompt when the script passes none. */
function defaultLabel(prompt: string): string {
  const newline = prompt.indexOf('\n')
  const line = newline === -1 ? prompt : prompt.slice(0, newline)
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`
}

/** Validate a `retry: { maxAttempts, delayMs }` option (shared by `agent()` and `bash()`). */
function readRetry(raw: unknown, hook: string): RetrySpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new WorkflowError(`${hook} retry must be an object`, 'INVALID_ARGUMENT')
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'maxAttempts' && key !== 'delayMs') throw new WorkflowError(`${hook} retry option "${key}" is not recognized (supported: maxAttempts, delayMs)`, 'INVALID_ARGUMENT')
  }
  const maxAttempts = record.maxAttempts ?? 1
  const delayMs = record.delayMs ?? 0
  if (typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new WorkflowError(`${hook} retry.maxAttempts must be a positive integer`, 'INVALID_ARGUMENT')
  }
  if (typeof delayMs !== 'number' || !Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new WorkflowError(`${hook} retry.delayMs must be a non-negative integer`, 'INVALID_ARGUMENT')
  }
  return { maxAttempts: Math.min(maxAttempts, RETRY_MAX_ATTEMPTS_CEILING), delayMs: Math.min(delayMs, RETRY_DELAY_CEILING_MS) }
}

/**
 * One live script execution inside the worker. Constructed per run by the
 * session; `drive()` is called exactly once and NEVER rejects — every failure
 * becomes a {@link WorkflowResult} with a non-`completed` stop reason. The
 * host owns cancellation and cleanup of any dropped child work.
 */
export class WorkflowExecution {
  /** 1-based count of `agent()` calls started (the `agentsStarted` result field). */
  private started = 0
  private activeSlots = 0
  private readonly slotWaiters: { resolve(): void; reject(error: unknown): void }[] = []
  private cancelReason: string | undefined
  private cancelError: WorkflowError | undefined
  private currentPhase: string | undefined
  private readonly context: vm.Context
  private readonly compiled: vm.Script
  /** Nodes started and not yet ended (worker-side well-formedness only; the host keeps the authoritative pairing ledger). */
  private readonly liveNodes = new Map<string, WorkflowNodeInfo>()
  /** The last exhausted done-when evidence per node label (read by the `evidence()` hook). */
  private readonly evidenceByNode = new Map<string, WorkflowContinuationEvidence>()
  /** Attempts the node's latest agent call ran, retries included (reported as `attempts` on node-end). */
  private readonly attemptsByNode = new Map<string, number>()
  /** The supervisor stop that ended a node's latest agent call, when it was a stall or a deadline. */
  private readonly stopByNode = new Map<string, { code: 'NODE_STALLED' | 'NODE_TIMEOUT'; idleTimeoutMs?: number; timeoutMs?: number; subject?: 'bash' }>()

  constructor(
    meta: WorkflowMeta,
    body: string,
    args: unknown,
    private readonly limits: WorkerLimits,
    private readonly observer: ExecutionObserver,
    private readonly children: ChildPort,
    private readonly hooks: HookPort,
    private readonly bashEnabled = false,
  ) {
    // Compile FIRST: a body syntax error must throw out of the constructor
    // before any realm state exists. The host pre-parses the identical
    // wrapper, so under one Node version this throw is unreachable in
    // production — the session still maps it to an error result defensively.
    // lineOffset compensates for the wrapper line, so stack traces carry the
    // script's own line numbers.
    try {
      this.compiled = new vm.Script(`(async () => {\n${body}\n})()`, {
        filename: `workflow:${meta.name}`,
        lineOffset: -1,
      })
    } catch (error: unknown) {
      throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
    }

    this.context = vm.createContext({}, { name: `workflow:${meta.name}` })

    const globals: Record<string, unknown> = {
      agent: (prompt: unknown, opts?: unknown) => this.contain(this.agent(prompt, opts)),
      parallel: (thunks: unknown) => this.contain(this.parallel(thunks)),
      pipeline: (items: unknown, ...stages: unknown[]) => this.contain(this.pipeline(items, stages)),
      phase: (title: unknown) => { this.phase(title) },
      log: (message: unknown) => { this.log(message) },
      bash: (command: unknown, opts?: unknown) => this.contain(this.bash(command, opts)),
      approve: (request: unknown) => this.contain(this.approve(request)),
      cancel: (reason?: unknown) => { this.cancelFromScript(reason) },
      nodeStart: (nodeId: unknown, kind: unknown, opts?: unknown) => { this.nodeStart(nodeId, kind, opts) },
      nodeEnd: (nodeId: unknown, info?: unknown) => { this.nodeEnd(nodeId, info) },
      gate: (nodeId: unknown, gateKind: unknown, outcome: unknown) => { this.gate(nodeId, gateKind, outcome) },
      evidence: (node: unknown) => this.evidence(node),
      // workerData already performed the real cross-thread structured clone.
      args,
    }
    for (const [key, value] of Object.entries(globals)) {
      // Data properties on the contextified global; frozen shape not required —
      // a script overwriting its own hooks only sabotages itself.
      ;(this.context as Record<string, unknown>)[key] = typeof value === 'function' ? Object.freeze(value) : value
    }
  }

  /**
   * Whether the run has been cancelled. A METHOD, not an inline property
   * read: `cancel()` mutates `cancelReason` concurrently (the session's
   * message handler), and an inline read after an `await` gets narrowed by
   * control flow into an always-false comparison.
   */
  private isCancelled(): boolean {
    return this.cancelReason !== undefined
  }

  /**
   * Shared hook entry guard: after {@link cancel}, EVERY hook throws
   * `CANCELLED` at its next call — cancellation is the next HOOK boundary,
   * not just the next `agent()`, so a script that caught one cancelled
   * rejection cannot keep emitting progress through `phase`/`log` or enter a
   * combinator.
   */
  private throwIfCancelled(): void {
    if (this.isCancelled()) throw this.cancelledError()
  }

  /**
   * Cancel the run: waiting `agent()` slots reject and every future hook call
   * throws `CANCELLED` — the script dies at its next await. A script that
   * never settles anyway (parked on a promise no hook owns) is the HOST's
   * problem: its grace timer force-settles the run and terminates the
   * worker. Idempotent; the first reason wins.
   * @param reason - human-readable cause carried on the CANCELLED error. The
   * host independently aborts the required signal shared by every child.
   */
  cancel(reason: string): void {
    if (this.cancelReason !== undefined) return
    this.cancelReason = reason
    this.cancelError = new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, 'CANCELLED')
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(this.cancelledError())
  }

  /**
   * Run the script to settlement. Resolves — never rejects — with the run's
   * {@link WorkflowResult}: the materialized return value on `completed`, the
   * failure message on `error`, and `cancelled` when the script died of
   * cancellation. This method only chooses the result; the session publishes
   * it and the host owns terminal child cancellation.
   * @returns the settled outcome — this promise NEVER rejects (the seam's
   * `result`-never-rejects contract); every failure maps to a variant.
   */
  async drive(): Promise<WorkflowResult> {
    try {
      // Cancelled before the body ever ran (an already-aborted start signal,
      // relayed by the host before its `go`): the script must not execute at
      // all, let alone report `completed`.
      if (this.isCancelled()) throw this.cancelledError()
      const scriptPromise = this.compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs }) as Promise<unknown>
      const raw: unknown = await this.contain(Promise.resolve(scriptPromise))
      // Cancelled while the body ran: a script that settled without touching
      // another hook (or without any) must still report `cancelled` — the
      // holder asked for cancellation and `completed` would be a lie.
      if (this.isCancelled()) throw this.cancelledError()
      const value = raw === undefined ? null : this.materializeResult(raw)
      return { value, stopReason: 'completed', agentsStarted: this.started }
    } catch (error: unknown) {
      // Any failure after cancel() reports `cancelled` with the canonical
      // reason — the reject path mirrors the resolve path's post-settle check.
      if (this.isCancelled()) {
        return { value: null, stopReason: 'cancelled', error: this.cancelledError().message, agentsStarted: this.started }
      }
      // renderThrown is total (thrown values of any realm), so this arm
      // cannot throw — drive() resolving is the `result` never-rejects contract
      // contract.
      return { value: null, stopReason: 'error', error: renderThrown(error), agentsStarted: this.started }
    }
  }

  /**
   * Attach a no-op rejection consumer WITHOUT changing what the caller
   * receives: if the script drops the promise (no await), cancellation cannot
   * become an unhandled rejection (which would kill the worker thread); if
   * the script does await it, it still observes the rejection.
   */
  private contain<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => { /* consumed: see method contract — a dropped hook promise must not surface an unhandled rejection */ })
    return promise
  }

  private cancelledError(): WorkflowError {
    // cancel() arms cancelError before any caller can observe isCancelled()
    // === true; the fallback guards the type, not a reachable path.
    /* v8 ignore next */
    return this.cancelError ?? new WorkflowError('workflow run cancelled', 'CANCELLED')
  }

  /** Materialize the script's return value; violations become RESULT_UNSERIALIZABLE. */
  private materializeResult(raw: unknown): unknown {
    try {
      return materializeFromRealm(raw, 'workflow result')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(
        `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
        'RESULT_UNSERIALIZABLE',
        { cause: error },
      )
    }
  }

  /**
   * Acquire one concurrency slot (FIFO). Cancellation rejects QUEUED waiters
   * (see {@link cancel}); the callers guard their own entry and post-acquire
   * windows, so no cancelled-precheck is duplicated here.
   */
  private acquireSlot(): Promise<void> {
    if (this.activeSlots < this.limits.maxConcurrentAgents) {
      this.activeSlots += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({
        resolve: () => {
          this.activeSlots += 1
          resolve()
        },
        reject,
      })
    })
  }

  private releaseSlot(): void {
    this.activeSlots -= 1
    const next = this.slotWaiters.shift()
    if (next) next.resolve()
  }

  /** Cancel-aware pause between retry attempts. */
  private async pause(ms: number): Promise<void> {
    if (ms > 0) await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
    this.throwIfCancelled()
  }

  /**
   * The `agent(prompt, opts)` hook. With `retry`, the ENGINE re-runs a call only for transient
   * failures (a start failure, or a child stop reason in {@link TRANSIENT_STOP_REASONS}); each
   * attempt is its own paired `agent-start`/`agent-end` and counts toward the total-agent cap.
   */
  private async agent(rawPrompt: unknown, rawOpts: unknown): Promise<unknown> {
    this.throwIfCancelled()
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw new WorkflowError('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT')
    }
    const opts = this.readAgentOptions(rawOpts)
    const maxAttempts = opts.retry?.maxAttempts ?? 1
    for (let attempt = 1; ; attempt += 1) {
      let outcome: { value: unknown; transient: boolean; stopReason?: string }
      try {
        outcome = await this.agentAttempt(rawPrompt, opts)
      } catch (error: unknown) {
        const startFailure = error instanceof WorkflowError && error.code === 'AGENT_START' && !this.isCancelled()
        if (!startFailure || attempt >= maxAttempts) {
          this.noteAgentCall(opts, attempt, undefined)
          throw error
        }
        outcome = { value: null, transient: true }
      }
      if (!outcome.transient || attempt >= maxAttempts) {
        this.noteAgentCall(opts, attempt, outcome.stopReason)
        return outcome.value
      }
      await this.pause(opts.retry?.delayMs ?? 0)
    }
  }

  /** Remember how many attempts a node's agent call ran and whether the supervisor stopped the last one. */
  private noteAgentCall(opts: ReturnType<WorkflowExecution['readAgentOptions']>, attempts: number, stopReason: string | undefined): void {
    const nodeId = opts.nodeId
    if (nodeId === undefined) return
    this.attemptsByNode.set(nodeId, attempts)
    if (stopReason === 'stalled') {
      this.stopByNode.set(nodeId, { code: 'NODE_STALLED', ...opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {} })
    } else if (stopReason === 'timeout') {
      this.stopByNode.set(nodeId, { code: 'NODE_TIMEOUT', ...opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {} })
    } else {
      this.stopByNode.delete(nodeId)
    }
  }

  /** One attempt of {@link agent}. */
  private async agentAttempt(rawPrompt: string, opts: ReturnType<WorkflowExecution['readAgentOptions']>): Promise<{ value: unknown; transient: boolean; stopReason?: string }> {
    if (this.started >= this.limits.maxTotalAgents) {
      throw new WorkflowError(
        `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise the applicable maxTotalAgents limit if the scale is intentional`,
        'AGENT_CAP',
      )
    }
    this.started += 1
    const seq = this.started
    const label = opts.label ?? defaultLabel(rawPrompt)
    const phase = opts.phase ?? this.currentPhase

    await this.acquireSlot()
    try {
      // Re-check after the acquire: the await yields at least one microtask
      // tick even when a slot is free, and a queued waiter resumes a tick
      // after its release — a cancel() landing in either window must not
      // reach the host (which would refuse anyway, but the refusal reads as
      // a start failure rather than the cancellation it is).
      this.throwIfCancelled()
      let run: ChildHandle
      try {
        run = await this.children.startAgent({
          prompt: rawPrompt,
          ...opts.schema !== undefined ? { schema: opts.schema } : {},
          ...opts.provider !== undefined ? { provider: opts.provider } : {},
          ...opts.model !== undefined ? { model: opts.model } : {},
          ...opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {},
          ...opts.tier !== undefined ? { tier: opts.tier } : {},
          ...opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
          ...opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {},
          ...opts.doneWhen !== undefined ? { doneWhen: opts.doneWhen } : {},
        })
      } catch (error: unknown) {
        // The host refuses starts once the run is cancelled — a refusal that
        // races our own cancel state must read as the cancellation it is,
        // not as a broken contract.
        if (this.isCancelled()) throw this.cancelledError()
        throw new WorkflowError(`agent() could not start a child: ${renderThrown(error)}`, 'AGENT_START', { cause: error })
      }
      // The start round-trip yields to the event loop, so a cancel CAN land
      // between the host starting the child and this continuation running —
      // wind the fresh child down instead of leaving it live behind a dead
      // script.
      if (this.isCancelled()) {
        await run.dispose()
        throw this.cancelledError()
      }
      const info: WorkflowAgentInfo = { seq, label, ...phase !== undefined ? { phase } : {}, childId: SessionId(run.id) }
      this.observer.agentStart(info)
      try {
        let result
        try {
          result = await run.result
        } catch (error: unknown) {
          // A rejected child result is an INFRASTRUCTURE fault relayed by the
          // host — distinct from a child that failed and resolved. Pair the
          // lifecycle before propagating, and propagate FATAL: an ordinary
          // throw would dissolve to a per-item null inside the combinators,
          // and a broken provider must not read as a failed child.
          if (this.isCancelled()) {
            this.observer.agentEnd({ ...info, outcome: 'cancelled' })
            throw this.cancelledError()
          }
          this.observer.agentEnd({ ...info, outcome: 'failed' })
          throw new WorkflowError(`child agent run failed: ${renderThrown(error)}`, 'AGENT_RESULT', { cause: error })
        }
        if (result.continuation?.evidence !== undefined && opts.nodeId !== undefined) {
          this.evidenceByNode.set(opts.nodeId, result.continuation.evidence)
        }
        if (result.stopReason === 'completed') {
          if (opts.nodeId !== undefined) this.evidenceByNode.delete(opts.nodeId)
          if (opts.schema !== undefined) {
            // The provider honored outputSchema (capability-gated at start), so
            // a completed run without a structured value is a child failure.
            if (result.structured === undefined) {
              this.observer.agentEnd({ ...info, outcome: 'failed' })
              return { value: null, transient: false }
            }
            this.observer.agentEnd({ ...info, outcome: 'completed' })
            return { value: result.structured, transient: false }
          }
          this.observer.agentEnd({ ...info, outcome: 'completed' })
          return { value: outputText(result.output), transient: false }
        }
        // A cancelled RUN kills the script; a child that failed for its own
        // reasons resolves null (scripts .filter(Boolean) per the CC contract).
        if (this.isCancelled()) {
          this.observer.agentEnd({ ...info, outcome: 'cancelled' })
          throw this.cancelledError()
        }
        this.observer.agentEnd({ ...info, outcome: 'failed' })
        return { value: null, transient: TRANSIENT_STOP_REASONS.has(result.stopReason), stopReason: result.stopReason }
      } finally {
        await run.dispose()
      }
    } finally {
      this.releaseSlot()
    }
  }

  /** Materialize + validate the `agent()` options bag from the realm. */
  private readAgentOptions(rawOpts: unknown): {
    label?: string
    phase?: string
    provider?: string
    model?: string
    nodeId?: string
    tier?: string
    timeoutMs?: number
    idleTimeoutMs?: number
    retry?: RetrySpec
    doneWhen?: WorkflowDoneWhen
    schema?: ObjectJsonSchema
  } {
    if (rawOpts === undefined) return {}
    let opts: unknown
    try {
      opts = materializeFromRealm(rawOpts, 'agent() options')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(`agent() options must be plain JSON data — ${error.message}`, 'INVALID_ARGUMENT', { cause: error })
    }
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      throw new WorkflowError('agent() options must be an object', 'INVALID_ARGUMENT')
    }
    const record = opts as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (SUPPORTED_AGENT_OPTIONS.has(key)) continue
      if (DEFERRED_AGENT_OPTIONS.has(key)) {
        throw new WorkflowError(`agent() option "${key}" is deferred and not supported by this engine (supported: ${SUPPORTED_AGENT_OPTIONS_TEXT})`, 'UNSUPPORTED_OPTION')
      }
      throw new WorkflowError(`agent() option "${key}" is not recognized (supported: ${SUPPORTED_AGENT_OPTIONS_TEXT})`, 'UNSUPPORTED_OPTION')
    }
    for (const key of ['label', 'phase', 'provider', 'model', 'nodeId', 'tier'] as const) {
      if (record[key] !== undefined && typeof record[key] !== 'string') {
        throw new WorkflowError(`agent() option "${key}" must be a string`, 'INVALID_ARGUMENT')
      }
    }
    if (record.nodeId !== undefined) assertNodeId(record.nodeId, 'agent()')
    if (record.tier !== undefined && (typeof record.tier !== 'string' || !LABEL_PATTERN.test(record.tier))) {
      throw new WorkflowError(`agent() option "tier" must match ${LABEL_PATTERN.source}`, 'INVALID_ARGUMENT')
    }
    for (const key of ['timeoutMs', 'idleTimeoutMs'] as const) {
      const value = record[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) {
        throw new WorkflowError(`agent() option "${key}" must be a positive safe integer`, 'INVALID_ARGUMENT')
      }
    }
    const retry = record.retry === undefined ? undefined : readRetry(record.retry, 'agent()')
    let doneWhen: WorkflowDoneWhen | undefined
    if (record.doneWhen !== undefined) {
      this.requireBash('agent() option "doneWhen"')
      doneWhen = validateDoneWhen(record.doneWhen)
    }
    let schema: ObjectJsonSchema | undefined
    if (record.schema !== undefined) {
      try {
        assertObjectJsonSchema(record.schema)
        schema = record.schema
      } catch (error: unknown) {
        /* v8 ignore next -- defensive rethrow arm: assertObjectJsonSchema only throws JsonSchemaError */
        if (!(error instanceof JsonSchemaError)) throw error
        throw new WorkflowError(`agent() schema is outside the supported subset — ${error.message}`, 'UNSUPPORTED_SCHEMA', { cause: error })
      }
    }
    return {
      ...record.label !== undefined ? { label: record.label as string } : {},
      ...record.phase !== undefined ? { phase: record.phase as string } : {},
      ...record.provider !== undefined ? { provider: record.provider as string } : {},
      ...record.model !== undefined ? { model: record.model as string } : {},
      ...record.nodeId !== undefined ? { nodeId: record.nodeId as string } : {},
      ...record.tier !== undefined ? { tier: record.tier } : {},
      ...record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs as number } : {},
      ...record.idleTimeoutMs !== undefined ? { idleTimeoutMs: record.idleTimeoutMs as number } : {},
      ...retry !== undefined ? { retry } : {},
      ...doneWhen !== undefined ? { doneWhen } : {},
      ...schema !== undefined ? { schema } : {},
    }
  }

  /** The `parallel(thunks)` hook: each thunk caught → `null`; fatal errors propagate. */
  private async parallel(rawThunks: unknown): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawThunks)) {
      throw new WorkflowError('parallel() requires an array of zero-argument functions', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawThunks.length, 'parallel()')
    const thunks = rawThunks.map((thunk, index) => {
      if (typeof thunk !== 'function') {
        throw new WorkflowError(`parallel() item ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return thunk as () => unknown
    })
    return Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk()
      } catch (error: unknown) {
        // Hook failures are WorkflowErrors built OUTSIDE the script's realm;
        // fatality is recognized by `instanceof` against this realm's class —
        // a script-built object can never pass it, so fatality cannot be
        // forged (nor accidentally dissolved).
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  /** The `pipeline(items, ...stages)` hook: per-item stage chains, NO cross-stage barrier. */
  private async pipeline(rawItems: unknown, rawStages: unknown[]): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError('pipeline() requires an items array', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawItems.length, 'pipeline()')
    if (rawStages.length === 0) {
      throw new WorkflowError('pipeline() requires at least one stage function', 'INVALID_ARGUMENT')
    }
    const stages = rawStages.map((stage, index) => {
      if (typeof stage !== 'function') {
        throw new WorkflowError(`pipeline() stage ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return stage as (previous: unknown, item: unknown, index: number) => unknown
    })
    return Promise.all(rawItems.map(async (item: unknown, index) => {
      let value: unknown = item
      try {
        for (const stage of stages) {
          value = await stage(value, item, index)
        }
        return value
      } catch (error: unknown) {
        // An ordinary stage throw drops the ITEM to null and skips its
        // remaining stages; a fatal WorkflowError (see parallel()) kills the
        // whole script.
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  private assertItemCap(length: number, hook: string): void {
    if (length > this.limits.maxItemsPerCall) {
      throw new WorkflowError(
        `${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}); split the work or raise maxItemsPerCall in the engine config`,
        'ITEM_CAP',
      )
    }
  }

  /** The `phase(title)` hook: sets the current label for subsequent `agent()` calls and notifies observers. */
  private phase(title: unknown): void {
    this.throwIfCancelled()
    if (typeof title !== 'string' || title.length === 0) {
      throw new WorkflowError('phase() requires a non-empty title string', 'INVALID_ARGUMENT')
    }
    this.currentPhase = title
    this.observer.phase(title)
  }

  /** The `log(message)` hook: narration to observers. */
  private log(message: unknown): void {
    this.throwIfCancelled()
    if (typeof message !== 'string') {
      throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    }
    this.observer.log(message)
  }

  /** Refuse a host-command capability the owner did not enable for this run. */
  private requireBash(what: string): void {
    if (!this.bashEnabled) {
      throw new WorkflowError(`${what} is not enabled for this run (the owner must vouch for the script)`, 'UNSUPPORTED_OPTION')
    }
  }

  /**
   * Remember a node's bash attempts and, when the last attempt hit its timeout, the `NODE_TIMEOUT`
   * stop that {@link nodeEnd} turns into the documented failure (same shape as an agent stop).
   */
  private noteBashCall(nodeId: string | undefined, attempts: number, timedOut: boolean, timeoutMs: number): void {
    if (nodeId === undefined) return
    if (timedOut) {
      this.attemptsByNode.set(nodeId, attempts)
      this.stopByNode.set(nodeId, { code: 'NODE_TIMEOUT', timeoutMs, subject: 'bash' })
    } else {
      if (attempts > 1) this.attemptsByNode.set(nodeId, attempts)
      this.stopByNode.delete(nodeId)
    }
  }

  /** The `bash(command, options)` hook: validated here (fail fast) and again host-side, then run on the host. */
  private async bash(rawCommand: unknown, rawOpts: unknown): Promise<unknown> {
    this.throwIfCancelled()
    this.requireBash('bash()')
    let options: WorkflowBashOptions = {}
    if (rawOpts !== undefined) {
      try {
        options = materializeFromRealm(rawOpts, 'bash() options') as WorkflowBashOptions
      } catch (error: unknown) {
        /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
        if (!(error instanceof MaterializeError)) throw error
        throw new WorkflowError(`bash() options must be plain JSON data — ${error.message}`, 'INVALID_ARGUMENT', { cause: error })
      }
    }
    // Validation result is discarded on purpose: the host re-validates the same raw inputs.
    const call = validateBashCall(rawCommand, rawOpts === undefined ? undefined : options)
    const retry = (options as { retry?: unknown }).retry === undefined ? undefined : readRetry((options as { retry?: unknown }).retry, 'bash()')
    const { retry: _retry, ...hostOptions } = options as WorkflowBashOptions & { retry?: unknown }
    void _retry
    // Transient-only retry: the ENGINE re-runs a command only when its timeout fired.
    for (let attempt = 1; ; attempt += 1) {
      let result: Awaited<ReturnType<HookPort['bash']>>
      try {
        result = await this.hooks.bash(call.command, hostOptions)
        this.throwIfCancelled()
      } catch (error: unknown) {
        if (this.isCancelled()) throw this.cancelledError()
        if (error instanceof WorkflowError) throw error
        throw new WorkflowError(`bash() failed: ${renderThrown(error)}`, 'BASH_FAILED_INFRA', { cause: error })
      }
      if (!result.timedOut || attempt >= (retry?.maxAttempts ?? 1)) {
        this.noteBashCall(call.nodeId, attempt, result.timedOut, call.timeoutMs)
        return result
      }
      await this.pause(retry?.delayMs ?? 0)
    }
  }

  /**
   * The `approve({ nodeId, message, timeoutMs })` hook: the host's approver decides and the script
   * branches on the returned outcome string (`allowed-once`, `rejected`, `cancelled`, `unavailable`).
   * `timeoutMs` is capped host-side (default and ceiling one hour); an expired question is `rejected`.
   */
  private async approve(rawRequest: unknown): Promise<unknown> {
    this.throwIfCancelled()
    if (typeof rawRequest !== 'object' || rawRequest === null || Array.isArray(rawRequest)) {
      throw new WorkflowError('approve() requires an object { nodeId, message, timeoutMs? }', 'INVALID_ARGUMENT')
    }
    const request = rawRequest as Record<string, unknown>
    for (const key of Object.keys(request)) {
      if (key !== 'nodeId' && key !== 'message' && key !== 'timeoutMs') {
        throw new WorkflowError(`approve() option "${key}" is not recognized (supported: nodeId, message, timeoutMs)`, 'INVALID_ARGUMENT')
      }
    }
    const message = request.message
    if (typeof message !== 'string' || message.length === 0 || message.length > WORKFLOW_APPROVAL_MESSAGE_MAX_CHARS) {
      throw new WorkflowError(`approve() requires a message string of 1..${WORKFLOW_APPROVAL_MESSAGE_MAX_CHARS} characters`, 'INVALID_ARGUMENT')
    }
    const nodeId = assertNodeId(request.nodeId, 'approve()')
    const timeoutMs = request.timeoutMs
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
      throw new WorkflowError('approve() timeoutMs must be a positive safe integer', 'INVALID_ARGUMENT')
    }
    try {
      const outcome = await this.hooks.approve(nodeId, message, timeoutMs)
      this.throwIfCancelled()
      return outcome
    } catch (error: unknown) {
      if (this.isCancelled()) throw this.cancelledError()
      throw error
    }
  }

  /** The `cancel(reason)` hook: cancel the run from the script and throw the engine's `CANCELLED` error. */
  private cancelFromScript(rawReason: unknown): never {
    const reason = typeof rawReason === 'string' && rawReason.length > 0 ? rawReason.slice(0, 500) : 'workflow cancel node'
    this.cancel(reason)
    throw this.cancelledError()
  }

  /** The `nodeStart(nodeId, kind, { gate? })` hook. */
  private nodeStart(rawNodeId: unknown, rawKind: unknown, rawOpts: unknown): void {
    this.throwIfCancelled()
    const nodeId = assertNodeId(rawNodeId, 'nodeStart()')
    if (typeof rawKind !== 'string' || !LABEL_PATTERN.test(rawKind)) {
      throw new WorkflowError(`nodeStart() kind must match ${LABEL_PATTERN.source}`, 'INVALID_ARGUMENT')
    }
    let gateKind: string | undefined
    if (rawOpts !== undefined) {
      if (typeof rawOpts !== 'object' || rawOpts === null) throw new WorkflowError('nodeStart() options must be an object', 'INVALID_ARGUMENT')
      const gate = (rawOpts as Record<string, unknown>).gate
      if (gate !== undefined) {
        if (typeof gate !== 'string' || !LABEL_PATTERN.test(gate)) {
          throw new WorkflowError(`nodeStart() gate must match ${LABEL_PATTERN.source}`, 'INVALID_ARGUMENT')
        }
        gateKind = gate
      }
    }
    if (this.liveNodes.has(nodeId)) throw new WorkflowError(`nodeStart() node "${nodeId}" is already running`, 'INVALID_ARGUMENT')
    const started: WorkflowNodeInfo = { nodeId, kind: rawKind, ...gateKind !== undefined ? { gateKind } : {} }
    this.liveNodes.set(nodeId, started)
    this.observer.nodeStart(started)
  }

  /** The `nodeEnd(nodeId, { status, ... })` hook. */
  private nodeEnd(rawNodeId: unknown, rawInfo: unknown): void {
    this.throwIfCancelled()
    const nodeId = assertNodeId(rawNodeId, 'nodeEnd()')
    if (typeof rawInfo !== 'object' || rawInfo === null) throw new WorkflowError('nodeEnd() requires an info object with a status', 'INVALID_ARGUMENT')
    const info = rawInfo as Record<string, unknown>
    if (typeof info.status !== 'string' || !NODE_STATUSES.has(info.status)) {
      throw new WorkflowError(`nodeEnd() status must be one of ${[...NODE_STATUSES].join(', ')}`, 'INVALID_ARGUMENT')
    }
    const started = this.liveNodes.get(nodeId)
    if (started === undefined) throw new WorkflowError(`nodeEnd() node "${nodeId}" was not started`, 'INVALID_ARGUMENT')
    // A command killed by a signal (timeout, abort) has no exit code: null means "none", like undefined.
    const exitCode = info.exitCode === null ? undefined : info.exitCode
    if (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) {
      throw new WorkflowError('nodeEnd() exitCode must be an integer', 'INVALID_ARGUMENT')
    }
    const durationMs = info.durationMs
    if (durationMs !== undefined && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
      throw new WorkflowError('nodeEnd() durationMs must be a non-negative number', 'INVALID_ARGUMENT')
    }
    if (info.truncated !== undefined && typeof info.truncated !== 'boolean') throw new WorkflowError('nodeEnd() truncated must be a boolean', 'INVALID_ARGUMENT')
    if (info.output !== undefined && typeof info.output !== 'string') throw new WorkflowError('nodeEnd() output must be a string', 'INVALID_ARGUMENT')
    if (info.error !== undefined && typeof info.error !== 'string') throw new WorkflowError('nodeEnd() error must be a string', 'INVALID_ARGUMENT')
    this.liveNodes.delete(nodeId)
    const attempts = this.attemptsByNode.get(nodeId)
    const stop = this.stopByNode.get(nodeId)
    this.attemptsByNode.delete(nodeId)
    this.stopByNode.delete(nodeId)
    const failure = info.status === 'failed' && stop !== undefined ? describeStop(stop, attempts ?? 1) : undefined
    this.observer.nodeEnd({
      ...started,
      status: info.status as WorkflowNodeStatus,
      ...attempts !== undefined ? { attempts } : {},
      ...failure !== undefined ? { failure, error: `${failure.code}: ${failure.message}`.slice(0, NODE_ERROR_MAX_CHARS) } : {},
      ...exitCode !== undefined ? { exitCode } : {},
      ...durationMs !== undefined ? { durationMs } : {},
      ...info.truncated !== undefined ? { truncated: info.truncated } : {},
      ...typeof info.error === 'string' && failure === undefined ? { error: info.error.slice(0, NODE_ERROR_MAX_CHARS) } : {},
    })
  }

  /** The `gate(nodeId, gateKind, outcome)` hook. */
  private gate(rawNodeId: unknown, rawGateKind: unknown, rawOutcome: unknown): void {
    this.throwIfCancelled()
    const nodeId = assertNodeId(rawNodeId, 'gate()')
    if (typeof rawGateKind !== 'string' || !LABEL_PATTERN.test(rawGateKind)) {
      throw new WorkflowError(`gate() kind must match ${LABEL_PATTERN.source}`, 'INVALID_ARGUMENT')
    }
    if (typeof rawOutcome !== 'string' || !GATE_OUTCOMES.has(rawOutcome)) {
      throw new WorkflowError(`gate() outcome must be one of ${[...GATE_OUTCOMES].join(', ')}`, 'INVALID_ARGUMENT')
    }
    this.observer.gate({ nodeId, gateKind: rawGateKind, outcome: rawOutcome as WorkflowGateOutcome })
  }

  /** The `evidence(node)` hook: the last exhausted done-when evidence for a node label, else `null`. */
  private evidence(rawNode: unknown): unknown {
    const nodeId = assertNodeId(rawNode, 'evidence()')
    return this.evidenceByNode.get(nodeId) ?? null
  }
}

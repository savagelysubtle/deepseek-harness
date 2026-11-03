/**
 * Child supervisor: the stall watchdog, the absolute node deadline and the done-when evaluator
 * that plug into the engine host through `WorkflowChildSupervisor`.
 *
 * The watchdog is a plain `setTimeout` rearmed on every append to the child's session log and
 * PAUSED while a tool call is in flight (`tool/call` seen, its `tool/result` not yet). It is
 * deliberately not the iterator-bound `idleWatchdog` helper: that timer only runs while a
 * `next()` demand is outstanding. The package adds no turn-stop listener of any kind, so the
 * hooks bridge's own Stop hook remains the only steering path inside a child turn.
 *
 * @module @deepseek-ai/dsh-workflow-worker-thread
 */

import type {
  WorkflowChildHandle,
  WorkflowChildSupervisor,
  WorkflowContinuationEvidence,
  WorkflowSupervisedChild,
  WorkflowSupervisedOutcome,
  WorkflowSupervisorTools,
} from '@deepseek-ai/dsh-workflow'

/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * One append observed on a child's session log, reduced to the two facts the watchdog reads.
 * `type` is the session event type (`tool/call` and `tool/result` are the tool-state pair).
 */
export interface ChildAppendEvent {
  /** The session event type, e.g. `assistant/chunk`, `tool/call`, `tool/result`. */
  readonly type: string
  /** The event payload exactly as recorded; only `callId` (call) and `message.source.callId` (result) are read. */
  readonly data?: unknown
}

/**
 * Subscribes to one child's session appends; returns the unsubscribe function, or `undefined` when
 * the child cannot be observed (a remote run whose appends never reach this process). An
 * unobservable child gets only the absolute deadline: a stall watchdog fed no appends would fire
 * falsely.
 */
export type ChildAppendFeed = (childId: string, listener: (event: ChildAppendEvent) => void) => (() => void) | undefined

/** Options of {@link createWorkflowChildSupervisor}. */
export interface WorkflowChildSupervisorOptions {
  /**
   * How the supervisor observes a child's session appends. Absent means appends are never seen,
   * so only the absolute deadline can fire (the stall watchdog stays off rather than firing
   * falsely on a child it cannot observe).
   */
  observe?: ChildAppendFeed
  /** Failure sink for contained problems (an unsubscribe that throws). Defaults to a no-op. */
  onWarning?: (message: string) => void
}

/** The session event type that opens a tool call. */
export const CHILD_TOOL_START_EVENT = 'tool/call'
/** The session event type that closes a tool call. */
export const CHILD_TOOL_END_EVENT = 'tool/result'

/** Most tool calls tracked as in flight per child; beyond it the oldest entry is dropped with a warning. */
const MAX_IN_FLIGHT_TOOLS = 1000

/** Live timers and tool state of one bound child iteration. */
interface Supervision {
  readonly childId: string
  readonly idleMs: number | undefined
  readonly handle: WorkflowChildHandle
  readonly inFlight: Set<string>
  /** Monotonic source of ids for tool calls that carry none. */
  anonymous: number
  deadlineTimer: ReturnType<typeof setTimeout> | undefined
  stallTimer: ReturnType<typeof setTimeout> | undefined
  unsubscribe: (() => void) | undefined
  done: boolean
}

function childKey(child: WorkflowSupervisedChild): string {
  return `${child.callId}:${child.iteration}`
}

function delay(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(ms, MAX_TIMER_DELAY_MS)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function toolCallId(event: ChildAppendEvent): string | undefined {
  const data = asRecord(event.data)
  if (data === undefined) return undefined
  if (event.type === CHILD_TOOL_START_EVENT) return typeof data['callId'] === 'string' ? data['callId'] : undefined
  const source = asRecord(asRecord(data['message'])?.['source'])
  return typeof source?.['callId'] === 'string' ? source['callId'] : undefined
}

/**
 * Create the child supervisor: absolute deadline (`stop('timeout')`), stall watchdog
 * (`stop('stalled')`, paused during a tool call) and the done-when evaluator.
 *
 * `register` must precede `bind` for the same child iteration; a `bind` without it throws a
 * clear error (the host logs and contains it, and the child then runs unsupervised, which the
 * log line makes visible). `release` is idempotent and clears every timer and subscription.
 *
 * @param options - the append feed and warning sink.
 * @returns a supervisor to install as `WorkflowStartRequest.supervisor`.
 */
export function createWorkflowChildSupervisor(options: WorkflowChildSupervisorOptions = {}): WorkflowChildSupervisor {
  const warn = options.onWarning ?? ((): void => {})
  const registered = new Map<string, WorkflowSupervisedChild>()
  const bound = new Map<string, Supervision>()
  const byKey = new Map<string, Supervision>()

  const clearTimers = (s: Supervision): void => {
    if (s.deadlineTimer !== undefined) clearTimeout(s.deadlineTimer)
    if (s.stallTimer !== undefined) clearTimeout(s.stallTimer)
    s.deadlineTimer = undefined
    s.stallTimer = undefined
  }

  const finish = (s: Supervision): void => {
    if (s.done) return
    s.done = true
    clearTimers(s)
    const unsubscribe = s.unsubscribe
    s.unsubscribe = undefined
    try {
      unsubscribe?.()
    } catch (error: unknown) {
      warn(`child ${s.childId} unsubscribe failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const armStall = (s: Supervision): void => {
    if (s.done || s.idleMs === undefined) return
    if (s.stallTimer !== undefined) clearTimeout(s.stallTimer)
    s.stallTimer = undefined
    if (s.inFlight.size > 0) return
    s.stallTimer = setTimeout(() => {
      s.stallTimer = undefined
      if (s.done) return
      s.handle.stop('stalled')
    }, s.idleMs)
  }

  const onAppend = (s: Supervision, event: ChildAppendEvent): void => {
    if (s.done) return
    if (event.type === CHILD_TOOL_START_EVENT) {
      const id = toolCallId(event) ?? `anonymous:${s.anonymous++}`
      s.inFlight.add(id)
      if (s.inFlight.size > MAX_IN_FLIGHT_TOOLS) {
        const oldest = s.inFlight.values().next()
        if (!oldest.done) s.inFlight.delete(oldest.value)
        warn(`child ${s.childId} has more than ${MAX_IN_FLIGHT_TOOLS} tool calls in flight; dropped the oldest`)
      }
    } else if (event.type === CHILD_TOOL_END_EVENT) {
      // A result without an extractable id deletes nothing: it only rearms (below).
      const id = toolCallId(event)
      if (id !== undefined) s.inFlight.delete(id)
    }
    armStall(s)
  }

  return {
    register(child) {
      registered.set(childKey(child), child)
    },

    bind(child, childId, handle) {
      const key = childKey(child)
      const known = registered.get(key)
      if (known === undefined) {
        throw new Error(`workflow child supervisor: bind for child ${key} without a prior register`)
      }
      registered.delete(key)
      const s: Supervision = {
        childId,
        idleMs: options.observe === undefined ? undefined : delay(known.idleTimeoutMs),
        handle,
        inFlight: new Set(),
        anonymous: 0,
        deadlineTimer: undefined,
        stallTimer: undefined,
        unsubscribe: undefined,
        done: false,
      }
      bound.set(childId, s)
      const deadlineMs = delay(known.timeoutMs)
      if (deadlineMs !== undefined) {
        s.deadlineTimer = setTimeout(() => {
          s.deadlineTimer = undefined
          if (s.done) return
          handle.stop('timeout')
        }, deadlineMs)
      }
      byKey.set(key, s)
      if (options.observe !== undefined && s.idleMs !== undefined) {
        s.unsubscribe = options.observe(childId, (event) => { onAppend(s, event) })
        // An unobservable child (remote run) keeps the deadline only.
        if (s.unsubscribe !== undefined) armStall(s)
      }
    },

    async evaluate(
      child: WorkflowSupervisedChild,
      _outcome: WorkflowSupervisedOutcome,
      tools: WorkflowSupervisorTools,
    ): Promise<WorkflowContinuationEvidence | undefined> {
      // The iteration's result is in hand: stop its deadline and stall timers before the check runs
      // (a done-when check can take minutes and must not get a finished child disposed).
      const live = byKey.get(childKey(child))
      if (live !== undefined) finish(live)
      const doneWhen = child.doneWhen
      if (doneWhen === undefined) return undefined
      const result = await tools.runBash(doneWhen.command, {
        ...doneWhen.workdir !== undefined ? { workdir: doneWhen.workdir } : {},
        ...doneWhen.timeoutMs !== undefined ? { timeoutMs: doneWhen.timeoutMs } : {},
      })
      if (result.exitCode === 0 && !result.timedOut && !result.aborted) return undefined
      const tail = [result.stdout, result.stderr].filter(part => part.length > 0).join('\n')
      return {
        iteration: child.iteration + 1,
        // Placeholder: the host overwrites iteration/maxContinuations with the clamped cap it enforces.
        maxContinuations: doneWhen.maxContinuations ?? 0,
        command: doneWhen.command,
        exitCode: result.exitCode,
        tail,
        truncated: result.truncated,
      }
    },

    release(child, childId) {
      registered.delete(childKey(child))
      byKey.delete(childKey(child))
      if (childId === undefined) return
      const s = bound.get(childId)
      if (s === undefined) return
      bound.delete(childId)
      finish(s)
    },
  }
}

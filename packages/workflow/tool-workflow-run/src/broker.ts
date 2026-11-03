/**
 * The store-backed approval broker used as the engine's `approver`. Every approval is written to
 * the run store first; when the parent agent has an open turn the question is mirrored to
 * `ctx.approval`. The first answer wins and the other path is cancelled; an unanswered approval
 * expires after the wait cap and the node is rejected. Headless deployments and the `never`
 * policy reject immediately with a reason and a remedy.
 * @module @deepseek-ai/dsh-tool-workflow-run/broker
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { WorkflowApprovalOutcome, WorkflowApprover } from '@deepseek-ai/dsh-workflow'
import type { WorkflowApprovalState, WorkflowRunStore } from '@deepseek-ai/dsh-workflow-run-store'
import { stripUnsafe } from './text.ts'
import type { WorkflowRunsEvent } from './types.ts'

/** Longest human reason kept on an approval record. */
export const MAX_REASON_CHARS = 500

/** Serializes the store writes of one run so records land in the order events arrived. */
export class WriteQueue {
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * Run `task` after every earlier task settled.
   * @param task - the store write.
   * @returns the task's result; a failure rejects this call only, never later tasks.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Resolves once every queued task settled. */
  async flush(): Promise<void> {
    await this.chain
  }
}

/** What the broker needs to know about one active run. */
export interface BrokerRun {
  readonly runId: string
  readonly store: WorkflowRunStore
  /** The agent whose open turn (if any) can answer through `ctx.approval`. */
  readonly parent: Agent
  /** Resolves when the run header is written; approvals wait for it. */
  readonly ready: Promise<void>
  readonly queue: WriteQueue
  /** Reason text by node id, shared with the gate report. */
  readonly reasons: Map<string, string>
}

/** Broker construction options. */
export interface ApprovalBrokerOptions {
  /** How long an approval may wait for an answer, in milliseconds. */
  readonly approvalWaitMs: number
  /** True in headless deployments: reject every approval immediately. */
  readonly headless: boolean
  /** Looks up the approval service at use time (it may mount after this plugin). */
  readonly getApproval?: () => ApprovalService | undefined
  /** True while someone listens for approval events (the Workflows UI); absent means nobody does. */
  readonly hasListeners?: () => boolean
  /** Receives approval events for the UI bridge. */
  readonly emit: (event: WorkflowRunsEvent) => void
  /** Receives contained failures. */
  readonly warn: (message: string) => void
}

/** A UI or tool answer to a pending approval. */
export type BrokerAnswer = 'allow' | 'reject'

/** One approval awaiting an answer. */
export interface PendingApprovalView {
  readonly runId: string
  readonly approvalId: string
  readonly nodeId: string
  readonly message: string
}

interface PendingEntry extends PendingApprovalView {
  readonly settle: (state: Exclude<WorkflowApprovalState, 'pending'>, reason?: string) => Promise<WorkflowApprovalState>
}

/** The remedy sentence appended to every immediate rejection. */
export const APPROVAL_REMEDY = 'Remedy: run with an approval answerer (Workflows UI) or change policy to ask.'

/**
 * Build the exact rejection reason for an approval that can never be answered.
 * @param nodeId - the approval node.
 * @param cause - why no answer is possible.
 * @returns the reason text recorded in the tool result, the store and the gate report.
 */
export function immediateRejectionReason(nodeId: string, cause: 'headless' | 'never' | 'no-answerer'): string {
  const why = cause === 'headless' ? 'this session is headless'
    : cause === 'never' ? "policy is 'never'"
      : 'nobody is connected to answer it'
  return `Approval node '${nodeId}' rejected: ${why}. ${APPROVAL_REMEDY}`
}

/**
 * Whether the log sits inside an open turn (the `ctx.approval.request` precondition).
 * @param agent - the agent whose session log is inspected.
 * @returns true when a turn has started and not yet ended.
 */
export function hasOpenTurn(agent: Agent): boolean {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = (events[index] as { type: string }).type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

function outcomeOf(state: WorkflowApprovalState): WorkflowApprovalOutcome {
  switch (state) {
    case 'allowed': return 'allowed-once'
    case 'rejected':
    case 'expired': return 'rejected'
    case 'cancelled': return 'cancelled'
    case 'pending': return 'unavailable'
  }
}

/** The broker. One instance serves every run of a service. */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(private readonly options: ApprovalBrokerOptions) {}

  /**
   * The approvals currently waiting for an answer.
   * @param runId - restrict to one run.
   * @returns views of the waiting approvals.
   */
  pendingApprovals(runId?: string): PendingApprovalView[] {
    return [...this.pending.values()]
      .filter(p => runId === undefined || p.runId === runId)
      .map(({ runId: r, approvalId, nodeId, message }) => ({ runId: r, approvalId, nodeId, message }))
  }

  /**
   * Answer a waiting approval (the UI and tool path). The first answer wins.
   * @param runId - the run.
   * @param approvalId - the store approval id.
   * @param answer - allow or reject.
   * @param reason - optional human reason.
   * @returns the state that won, or undefined when no such approval is waiting here.
   */
  async answer(runId: string, approvalId: string, answer: BrokerAnswer, reason?: string): Promise<WorkflowApprovalState | undefined> {
    const entry = this.pending.get(`${runId}:${approvalId}`)
    if (entry === undefined) return undefined
    const clean = reason === undefined ? undefined : stripUnsafe(reason, MAX_REASON_CHARS)
    return await entry.settle(answer === 'allow' ? 'allowed' : 'rejected', clean === undefined || clean === '' ? undefined : clean)
  }

  /**
   * Build the engine approver for one run.
   * @param run - the run it serves.
   * @returns the approver.
   */
  createApprover(run: BrokerRun): WorkflowApprover {
    return async (request) => {
      try {
        await run.ready
        return await this.ask(run, request.nodeId, request.message, request.signal)
      } catch (error: unknown) {
        this.options.warn(`workflow approval for node ${request.nodeId} failed: ${error instanceof Error ? error.message : String(error)}`)
        return 'unavailable'
      }
    }
  }

  private autoRejectCause(run: BrokerRun): 'headless' | 'never' | undefined {
    if (this.options.headless) return 'headless'
    const approval = this.options.getApproval?.()
    if (approval === undefined) return undefined
    const policy = approval.overrideOf(run.parent.session) ?? approval.config.policy ?? 'ask'
    return policy === 'never' ? 'never' : undefined
  }

  private async ask(run: BrokerRun, nodeId: string, message: string, signal: AbortSignal): Promise<WorkflowApprovalOutcome> {
    const { store, runId } = run
    const record = await run.queue.run(() => store.recordApproval(runId, { nodeId, message }))
    const approvalId = record.approvalId

    // Nothing can answer: no headless/never rule fired, but there is no chat mirror and no UI listening.
    const approval = this.options.getApproval?.()
    const mirrored = approval !== undefined && hasOpenTurn(run.parent)
    const cause = this.autoRejectCause(run) ?? (!mirrored && this.options.hasListeners?.() !== true ? 'no-answerer' : undefined)
    if (cause !== undefined) {
      const reason = immediateRejectionReason(nodeId, cause)
      run.reasons.set(nodeId, reason)
      await run.queue.run(() => store.decideApproval(runId, approvalId, { state: 'rejected', reason }))
      this.options.emit({ type: 'approval-decided', runId, approvalId, nodeId, state: 'rejected', reason: stripUnsafe(reason, MAX_REASON_CHARS) })
      return 'rejected'
    }

    const key = `${runId}:${approvalId}`
    const mirror = new AbortController()
    const done = Promise.withResolvers<WorkflowApprovalState>()
    let claimed = false
    let unrecorded = false as boolean
    const timer: { id?: ReturnType<typeof setTimeout> } = {}
    const settle = async (state: Exclude<WorkflowApprovalState, 'pending'>, reason?: string): Promise<WorkflowApprovalState> => {
      if (claimed) return await done.promise
      claimed = true
      if (timer.id !== undefined) clearTimeout(timer.id)
      mirror.abort()
      this.pending.delete(key)
      let finalState: WorkflowApprovalState = state
      try {
        const decision = await run.queue.run(() => (
          store.decideApproval(runId, approvalId, { state, ...reason === undefined ? {} : { reason } })
        ))
        finalState = decision.approval.state
        if (finalState !== 'allowed' && finalState !== 'cancelled') {
          const why = decision.approval.reason ?? reason
          if (why !== undefined) run.reasons.set(nodeId, why)
        }
      } catch (error: unknown) {
        // Never proceed on a decision the record does not hold.
        unrecorded = true
        finalState = 'cancelled'
        this.options.warn(`workflow approval ${approvalId} could not be recorded: ${error instanceof Error ? error.message : String(error)}`)
      }
      const why = run.reasons.get(nodeId) ?? reason
      this.options.emit({
        type: 'approval-decided',
        runId,
        approvalId,
        nodeId,
        state: unrecorded ? 'unavailable' : finalState,
        ...why === undefined ? {} : { reason: stripUnsafe(why, MAX_REASON_CHARS) },
      })
      done.resolve(finalState)
      return finalState
    }
    this.pending.set(key, { runId, approvalId, nodeId, message, settle })

    timer.id = setTimeout(() => {
      void settle('expired', `Approval node '${nodeId}' expired: no answer within ${this.options.approvalWaitMs} ms (approvalWaitMs). ${APPROVAL_REMEDY}`)
    }, this.options.approvalWaitMs)
    const onAbort = (): void => { void settle('cancelled', 'the run was cancelled before an answer arrived') }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    this.options.emit({ type: 'approval-pending', runId, approvalId, nodeId, message })
    this.mirrorToChat(run, nodeId, message, mirror.signal, settle)

    const state = await done.promise
    signal.removeEventListener('abort', onAbort)
    return unrecorded ? 'unavailable' : outcomeOf(state)
  }

  /** Ask `ctx.approval` as well when the parent agent has an open turn; first answer wins. */
  private mirrorToChat(
    run: BrokerRun,
    nodeId: string,
    message: string,
    signal: AbortSignal,
    settle: PendingEntry['settle'],
  ): void {
    const approval = this.options.getApproval?.()
    if (approval === undefined || !hasOpenTurn(run.parent)) return
    void approval.request({ agent: run.parent, toolName: 'workflow:approval', reason: `Workflow approval '${nodeId}': ${message}`, signal })
      .then((outcome) => {
        if (signal.aborted) return
        if (outcome === 'allowed-once') return settle('allowed', 'approved in chat')
        if (outcome === 'rejected') return settle('rejected', 'rejected in chat')
        // 'cancelled' and 'unavailable' leave the store path open, unless nobody else can answer.
        if (this.options.hasListeners?.() !== true) {
          return settle('rejected', immediateRejectionReason(nodeId, 'no-answerer'))
        }
        return undefined
      })
      .catch((error: unknown) => {
        this.options.warn(`workflow approval mirror to chat failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!signal.aborted && this.options.hasListeners?.() !== true) {
          void settle('rejected', immediateRejectionReason(nodeId, 'no-answerer'))
        }
      })
  }
}

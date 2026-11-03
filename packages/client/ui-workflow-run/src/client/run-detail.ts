import {
  capReason,
  type WorkflowApprovalDisplayState, type WorkflowRunNodeAttempt, type WorkflowNodeDisplayStatus, type WorkflowRunGateRow,
  type WorkflowRunNodeData,
} from './workflow-definition.ts'

/** The `runDetail` node shape this mapper reads (a structural subset of the remote `WorkflowNodeView`). */
export interface RunDetailNodeInput {
  readonly nodeId: string
  readonly kind: string
  /** `running`, `success`, `failed`, `skipped` or `cancelled`. */
  readonly status: string
  readonly startedAt?: number
  readonly durationMs?: number
  readonly exitCode?: number
  /** Failure text; shown as the reason when no approval reason exists. */
  readonly error?: string
  readonly truncated?: boolean
  /** The attempt this row records (the store keeps one row per attempt); absent reads as 1. */
  readonly attempt?: number
  /** Real attempts the node ran, when the producer knows it. */
  readonly attempts?: number
  /** The supervisor stop that ended the node. */
  readonly failure?: { readonly code: string; readonly message: string; readonly remedy: string }
}

/** The `runDetail` approval shape this mapper reads (a subset of the remote `WorkflowApprovalView`). */
export interface RunDetailApprovalInput {
  readonly nodeId: string
  /** `pending`, `allowed`, `rejected`, `expired`, `unavailable` or `cancelled`. */
  readonly state: string
  readonly reason?: string
  /** Epoch milliseconds of the last update. */
  readonly at: number
}

/** The `runDetail` gate shape this mapper reads (a subset of the remote `WorkflowGateView`). */
export interface RunDetailGateInput {
  readonly nodeId: string
  readonly gateKind: string
  readonly outcome: string
}

/** The `runDetail` result body this mapper reads (a subset of the remote `WorkflowRunDetailOk`). */
export interface RunDetailInput {
  readonly nodes: readonly RunDetailNodeInput[]
  readonly gates: readonly RunDetailGateInput[]
  readonly approvals: readonly RunDetailApprovalInput[]
}

/** The records the embeddable run components render. */
export interface RunDetailView {
  readonly nodes: readonly WorkflowRunNodeData[]
  readonly gateReport: readonly WorkflowRunGateRow[]
}

const APPROVAL_STATES: ReadonlySet<string> = new Set(['pending', 'allowed', 'rejected', 'expired', 'unavailable', 'cancelled'])

function nodeStatus(status: string): WorkflowNodeDisplayStatus {
  switch (status) {
    case 'running': return 'running'
    case 'success': return 'done'
    case 'failed': return 'failed'
    case 'skipped': return 'skipped'
    case 'cancelled': return 'cancelled'
    default: return 'interrupted'
  }
}

function approvalState(state: string): WorkflowApprovalDisplayState {
  return APPROVAL_STATES.has(state) ? state as WorkflowApprovalDisplayState : 'unavailable'
}

/**
 * Convert a `runDetail` result body into the records the node list and gate report render. Pure. A node
 * takes its latest approval (greatest `at`, later entry winning ties); an approval whose node is absent
 * becomes an `approval` row. An unknown node status reads `interrupted` and an unknown approval state
 * reads `unavailable`. The reason is the approval reason, else the node error, capped for display.
 * @param detail - the `runDetail` body (`nodes`, `gates`, `approvals`).
 * @returns node records in `nodes` order and the gate rows in `gates` order.
 */
export function runDetailToNodeData(detail: RunDetailInput): RunDetailView {
  const latest = new Map<string, RunDetailApprovalInput>()
  for (const approval of detail.approvals) {
    const prior = latest.get(approval.nodeId)
    if (prior === undefined || approval.at >= prior.at) latest.set(approval.nodeId, approval)
  }
  const order: string[] = []
  const byNode = new Map<string, RunDetailNodeInput[]>()
  for (const row of detail.nodes) {
    const rows = byNode.get(row.nodeId)
    if (rows === undefined) { order.push(row.nodeId); byNode.set(row.nodeId, [row]) } else rows.push(row)
  }
  const nodes: WorkflowRunNodeData[] = order.map((nodeId) => {
    // One row per node: the highest attempt (later entry wins ties) shown, the others kept as earlier attempts.
    const rows = (byNode.get(nodeId) ?? []).map((row, index) => ({ row, index, attempt: row.attempt ?? 1 }))
      .sort((x, y) => x.attempt - y.attempt || x.index - y.index)
    const last = rows[rows.length - 1]
    if (last === undefined) throw new Error('unreachable: node group is never empty')
    const node = last.row
    const approval = latest.get(node.nodeId)
    const reason = approval?.reason ?? node.error
    const total = Math.max(node.attempts ?? 0, last.attempt, rows.length)
    const earlier = rows.slice(0, -1).map(({ row, attempt }): WorkflowRunNodeAttempt => ({
      attempt,
      status: nodeStatus(row.status),
      ...row.durationMs === undefined ? {} : { durationMs: row.durationMs },
      ...row.exitCode === undefined ? {} : { exitCode: row.exitCode },
      ...row.error === undefined ? {} : { reason: capReason(row.error) },
    }))
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      status: nodeStatus(node.status),
      ...node.exitCode === undefined ? {} : { exitCode: node.exitCode },
      ...node.durationMs === undefined ? {} : { durationMs: node.durationMs },
      ...node.startedAt === undefined ? {} : { startedAt: node.startedAt },
      ...node.truncated === true ? { truncated: true } : {},
      ...total > 1 ? { attempt: last.attempt > 1 ? last.attempt : total, attempts: total } : {},
      ...earlier.length === 0 ? {} : { earlier },
      ...node.failure === undefined ? {} : { failure: { ...node.failure } },
      ...approval === undefined ? {} : { approval: approvalState(approval.state) },
      ...reason === undefined ? {} : { reason: capReason(reason) },
    }
  })
  for (const [nodeId, approval] of latest) {
    if (byNode.has(nodeId)) continue
    const state = approvalState(approval.state)
    nodes.push({
      nodeId,
      kind: 'approval',
      status: state === 'pending' ? 'running' : state === 'allowed' ? 'done' : 'failed',
      approval: state,
      ...approval.reason === undefined ? {} : { reason: capReason(approval.reason) },
    })
  }
  return { nodes, gateReport: detail.gates.map(gate => ({ ...gate })) }
}

import {
  capReason,
  type WorkflowApprovalDisplayState, type WorkflowNodeDisplayStatus, type WorkflowRunGateRow,
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
  const nodes: WorkflowRunNodeData[] = detail.nodes.map((node) => {
    const approval = latest.get(node.nodeId)
    const reason = approval?.reason ?? node.error
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      status: nodeStatus(node.status),
      ...node.exitCode === undefined ? {} : { exitCode: node.exitCode },
      ...node.durationMs === undefined ? {} : { durationMs: node.durationMs },
      ...node.startedAt === undefined ? {} : { startedAt: node.startedAt },
      ...node.truncated === true ? { truncated: true } : {},
      ...approval === undefined ? {} : { approval: approvalState(approval.state) },
      ...reason === undefined ? {} : { reason: capReason(reason) },
    }
  })
  for (const [nodeId, approval] of latest) {
    if (detail.nodes.some(node => node.nodeId === nodeId)) continue
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

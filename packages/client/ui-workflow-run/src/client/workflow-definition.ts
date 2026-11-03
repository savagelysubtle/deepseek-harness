import type {
  ChatConversationViewNode, ConversationLocation, ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ToolWorkflowAgentEndData, ToolWorkflowAgentStartData, ToolWorkflowApprovalData,
  ToolWorkflowApprovalState, ToolWorkflowGateReportData, ToolWorkflowNodeEndData,
  ToolWorkflowNodeStartData,
} from '@deepseek-ai/dsh-tool-workflow/types'
import type { WorkflowAgentOutcome, WorkflowStopReason } from '@deepseek-ai/dsh-workflow/types'

/** Status shown for a workflow, phase, or member. */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** Final renderer data for one member. */
export interface WorkflowRunMemberData {
  readonly seq: number
  readonly label: string
  readonly childId: SessionId
  readonly status: WorkflowRunStatus
}

/** Final renderer data for one exact phase identity. */
export interface WorkflowRunPhaseData {
  readonly key: string
  /** `null` is the absent field; the empty string remains a distinct identity. */
  readonly phase: string | null
  readonly members: readonly WorkflowRunMemberData[]
}

/** Display status of one YAML workflow node, from its `node-start` and `node-end` events. */
export type WorkflowNodeDisplayStatus = 'running' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'interrupted'

/** Approval state shown on an approval node, taken from the latest `tool-workflow/approval` event. */
export type WorkflowApprovalDisplayState = ToolWorkflowApprovalState

/** Outcome vocabulary of one gate-report row. */
export type WorkflowGateDisplayOutcome =
  'fired-pass' | 'fired-block' | 'skipped' | 'not-reached' | 'never-evaluated'

/** One settled YAML workflow node. */
export interface WorkflowRunNodeData {
  readonly nodeId: string
  readonly kind: string
  readonly status: WorkflowNodeDisplayStatus
  readonly exitCode?: number
  readonly durationMs?: number
  /** Epoch milliseconds from `node-start`, when seen. */
  readonly startedAt?: number
  /** True when the node's recorded output is cut. */
  readonly truncated?: boolean
  /** Present on nodes with an approval record. */
  readonly approval?: WorkflowApprovalDisplayState
  /** The approval reason (else the gate-report reason), shown verbatim (the remedy for a rejection). */
  readonly reason?: string
}

/** One gate-report row. */
export interface WorkflowRunGateRow {
  readonly nodeId: string
  readonly gateKind: string
  /** A {@link WorkflowGateDisplayOutcome}, or any other token passed through verbatim. */
  readonly outcome: string
  readonly reason?: string
}

/** Final keyed Chat payload for one workflow run. */
export interface WorkflowRunChatData {
  readonly name: string
  readonly status: WorkflowRunStatus
  readonly phases: readonly WorkflowRunPhaseData[]
  /** Settled YAML nodes in first-settlement order; omitted when none settled. */
  readonly nodes?: readonly WorkflowRunNodeData[]
  /** The end-of-run gate report; omitted until it arrives. */
  readonly gateReport?: readonly WorkflowRunGateRow[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Durable top-level workflow run and all members that actually started. */
    'workflow-run': WorkflowRunChatData
  }
}

interface WorkflowMemberState extends Omit<ToolWorkflowAgentStartData, 'runId'> {
  readonly outcome?: WorkflowAgentOutcome
}

interface WorkflowNodeState {
  readonly nodeId: string
  readonly kind: string
  readonly startedAt?: number
  readonly ended?: Omit<ToolWorkflowNodeEndData, 'runId' | 'nodeId' | 'kind'>
}

type ApprovalRecord = Omit<ToolWorkflowApprovalData, 'runId'>

interface WorkflowState {
  readonly name: string
  readonly stopReason?: WorkflowStopReason
  readonly members: readonly WorkflowMemberState[]
  readonly nodes?: readonly WorkflowNodeState[]
  readonly approvals?: readonly ApprovalRecord[]
  readonly gateReport?: ToolWorkflowGateReportData['rows']
}

/**
 * Build a collision-free phase key preserving absent versus empty identity.
 * @param phase - exact phase string, or null for an omitted field.
 * @returns the stable renderer key for that phase identity.
 */
export function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${phase.length}:${phase}`
}

function statusFromStopReason(stopReason: WorkflowStopReason): WorkflowRunStatus {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
    /* v8 ignore next -- WorkflowStopReason is closed and every variant is handled above. */
    default: return stopReason satisfies never
  }
}

function statusFromOutcome(outcome: WorkflowAgentOutcome): WorkflowRunStatus {
  switch (outcome) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
    /* v8 ignore next -- WorkflowAgentOutcome is closed and every variant is handled above. */
    default: return outcome satisfies never
  }
}

const REASON_CAP = 500

/**
 * Cap a reason for display: at most 500 characters plus an ellipsis. Always rendered as a text node.
 * @param reason - the recorded reason text.
 * @returns the reason, clipped when longer than 500 characters.
 */
export function capReason(reason: string): string {
  return reason.length > REASON_CAP ? `${reason.slice(0, REASON_CAP)}…` : reason
}

function nodeDisplayStatus(status: ToolWorkflowNodeEndData['status']): Exclude<WorkflowNodeDisplayStatus, 'running'> {
  switch (status) {
    case 'success': return 'done'
    case 'failed': return 'failed'
    case 'skipped': return 'skipped'
    case 'cancelled': return 'cancelled'
    case 'interrupted': return 'interrupted'
    /* v8 ignore next -- WorkflowNodeStatus is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

/** The latest approval record of a node: the greatest `at`, later arrival winning ties. */
function latestApproval(state: WorkflowState, nodeId: string): ApprovalRecord | undefined {
  let latest: ApprovalRecord | undefined
  for (const record of state.approvals ?? []) {
    if (record.nodeId === nodeId && (latest === undefined || record.at >= latest.at)) latest = record
  }
  return latest
}

function projectNodes(state: WorkflowState, interrupted: boolean): readonly WorkflowRunNodeData[] {
  return (state.nodes ?? []).map((n) => {
    const approval = latestApproval(state, n.nodeId)
    const gateReason = state.gateReport?.find(row => row.nodeId === n.nodeId && row.reason !== undefined)?.reason
    const rawReason = approval?.reason ?? gateReason
    const reason = rawReason === undefined ? undefined : capReason(rawReason)
    const status: WorkflowNodeDisplayStatus = n.ended !== undefined
      ? nodeDisplayStatus(n.ended.status)
      : interrupted || state.stopReason !== undefined ? 'interrupted' : 'running'
    return {
      nodeId: n.nodeId,
      kind: n.kind,
      status,
      ...n.ended?.exitCode === undefined ? {} : { exitCode: n.ended.exitCode },
      ...n.ended?.durationMs === undefined ? {} : { durationMs: n.ended.durationMs },
      ...n.startedAt === undefined ? {} : { startedAt: n.startedAt },
      ...n.ended?.truncated === true ? { truncated: true } : {},
      ...approval === undefined ? {} : { approval: approval.state },
      ...reason === undefined ? {} : { reason },
    }
  })
}

function locationClosed(location: ConversationLocation): boolean {
  if (location.kind === 'step') {
    return location.step.status === 'closed' || location.turn.status === 'closed'
  }
  return location.kind === 'turn' && location.turn.status === 'closed'
}

function projectWorkflow(
  context: ConversationNodeContext<WorkflowState>,
  location: ConversationLocation,
): WorkflowRunChatData {
  const state = context.state as WorkflowState
  const interrupted = state.stopReason === undefined
    && locationClosed(location)
  const phases = new Map<string, { phase: string | null; members: WorkflowRunMemberData[] }>()
  for (const member of state.members) {
    const phase = member.phase === undefined ? null : member.phase
    const key = workflowPhaseKey(phase)
    let group = phases.get(key)
    if (group === undefined) {
      group = { phase, members: [] }
      phases.set(key, group)
    }
    group.members.push({
      seq: member.seq,
      label: member.label,
      childId: member.childId,
      status: member.outcome === undefined
        ? interrupted ? 'interrupted' : 'running'
        : statusFromOutcome(member.outcome),
    })
  }
  const projectedPhases = [...phases].map(([key, phase]) => ({
    key,
    phase: phase.phase,
    members: phase.members,
  }))
  return {
    name: state.name,
    status: state.stopReason === undefined
      ? interrupted ? 'interrupted' : 'running'
      : statusFromStopReason(state.stopReason),
    phases: projectedPhases,
    ...state.nodes === undefined ? {} : { nodes: projectNodes(state, interrupted) },
    ...state.gateReport === undefined ? {} : {
      gateReport: state.gateReport.map(row => ({
        ...row,
        ...row.reason === undefined ? {} : { reason: capReason(row.reason) },
      })),
    },
  }
}

function updateAgentStart(state: WorkflowState, data: ToolWorkflowAgentStartData): WorkflowState {
  const member: WorkflowMemberState = {
    seq: data.seq,
    label: data.label,
    ...data.phase === undefined ? {} : { phase: data.phase },
    childId: data.childId,
  }
  return { ...state, members: [...state.members, member] }
}

function updateAgentEnd(state: WorkflowState, data: ToolWorkflowAgentEndData): WorkflowState {
  return {
    ...state,
    members: state.members.map(member => member.seq === data.seq
      ? { ...member, outcome: data.outcome }
      : member),
  }
}

function upsertNode(
  state: WorkflowState,
  nodeId: string,
  kind: string,
  patch: (node: WorkflowNodeState) => WorkflowNodeState,
): WorkflowState {
  const nodes = state.nodes ?? []
  const index = nodes.findIndex(n => n.nodeId === nodeId)
  if (index < 0) return { ...state, nodes: [...nodes, patch({ nodeId, kind })] }
  return { ...state, nodes: nodes.map((n, i) => i === index ? patch(n) : n) }
}

function updateNodeStart(state: WorkflowState, data: ToolWorkflowNodeStartData): WorkflowState {
  // An out-of-order start never reopens a node that already settled.
  return upsertNode(state, data.nodeId, data.kind, n => ({ ...n, kind: data.kind, startedAt: data.at }))
}

function updateNodeEnd(state: WorkflowState, data: ToolWorkflowNodeEndData): WorkflowState {
  // A later record for the same node replaces the earlier one (corrective truncation at run end).
  return upsertNode(state, data.nodeId, data.kind, n => ({
    ...n,
    kind: data.kind,
    ended: {
      status: data.status,
      ...data.exitCode === undefined ? {} : { exitCode: data.exitCode },
      ...data.durationMs === undefined ? {} : { durationMs: data.durationMs },
      ...data.truncated === undefined ? {} : { truncated: data.truncated },
    },
  }))
}

function updateApproval(state: WorkflowState, data: ToolWorkflowApprovalData): WorkflowState {
  const record: ApprovalRecord = {
    nodeId: data.nodeId,
    kind: data.kind,
    approvalId: data.approvalId,
    state: data.state,
    ...data.reason === undefined ? {} : { reason: data.reason },
    at: data.at,
  }
  const prior = (state.approvals ?? []).find(a => a.approvalId === data.approvalId)
  // Decisions are final: a late `pending` never reverts a decided approval, and the first decision stands.
  if (prior !== undefined && (prior.state !== 'pending' || data.state === 'pending')) return state
  // A decision takes the arrival position of the decision, not of the pending record it replaces. Ordering
  // between approvals uses `at` with arrival order as the tie-break, so clock skew between the producers of
  // two records on one node can misorder them; the host writes both records, so skew is not expected.
  const approvals = [...(state.approvals ?? []).filter(a => a.approvalId !== data.approvalId), record]
  return upsertNode({ ...state, approvals }, data.nodeId, data.kind, n => n)
}

/** Durable workflow event family folded into one keyed Chat node. */
export const workflowRunDefinition: ConversationNodeDefinition<WorkflowState> = {
  kind: 'workflow-run',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool-workflow/run-start') return { id: String(event.data.runId), role: 'start' }
    if (event.type === 'tool-workflow/agent-start'
      || event.type === 'tool-workflow/agent-end'
      || event.type === 'tool-workflow/node-start'
      || event.type === 'tool-workflow/approval'
      || event.type === 'tool-workflow/node-end'
      || event.type === 'tool-workflow/gate-report'
      || event.type === 'tool-workflow/run-end') {
      return { id: String(event.data.runId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool-workflow/run-start') {
      throw new Error('workflow-run start requires tool-workflow/run-start')
    }
    return { name: match.event.data.name, members: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool-workflow/agent-start') {
      return updateAgentStart(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/agent-end') {
      return updateAgentEnd(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/node-start') {
      return updateNodeStart(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/approval') {
      return updateApproval(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/node-end') {
      return updateNodeEnd(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/gate-report') {
      return { ...context.state, gateReport: match.event.data.rows }
    }
    if (match.event.type === 'tool-workflow/run-end') {
      return { ...context.state, stopReason: match.event.data.stopReason }
    }
    return context.state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    const data = projectWorkflow(context, context.start.location)
    return {
      key: context.key,
      kind: 'workflow-run',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data,
    }
  },
}

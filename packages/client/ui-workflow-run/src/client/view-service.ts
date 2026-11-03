/**
 * The `workflowRunView` client service: the node list, gate report, approval badge and `runDetail`
 * mapper that other UI plugins (the Workflows overlay) reuse without value-importing this plugin's entry.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { ApprovalBadge, GateReport, NodeList, NodeRow } from './WorkflowRunPanel.tsx'
import { runDetailToNodeData } from './run-detail.ts'

/** The shape of `ctx.workflowRunView`; consumers import this type only, never the values. */
export interface WorkflowRunViewContract {
  /** The node list of one run. */
  readonly NodeList: typeof NodeList
  /** One node row. */
  readonly NodeRow: typeof NodeRow
  /** The text badge of one approval state. */
  readonly ApprovalBadge: typeof ApprovalBadge
  /** The controlled, collapsible gate-report table. */
  readonly GateReport: typeof GateReport
  /** Pure mapper from a `runDetail` body to the records the components render. */
  readonly runDetailToNodeData: typeof runDetailToNodeData
}

/** Provides `ctx.workflowRunView` for the lifetime of the plugin fiber that mounts it. */
export class WorkflowRunViewService extends Service implements WorkflowRunViewContract {
  readonly NodeList = NodeList
  readonly NodeRow = NodeRow
  readonly ApprovalBadge = ApprovalBadge
  readonly GateReport = GateReport
  readonly runDetailToNodeData = runDetailToNodeData

  /**
   * @param ctx - the owning context; the service registers itself as `workflowRunView`.
   */
  constructor(ctx: Context) {
    super(ctx, 'workflowRunView')
  }
}

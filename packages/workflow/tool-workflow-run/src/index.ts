/**
 * The model-facing `workflow_run` tool and the `ctx.workflowRuns` service that execute YAML
 * workflow definitions (`<workflowsDir>/<name>.yaml`, parsed by `@deepseek-ai/dsh-workflow-yaml`)
 * over `ctx.workflowEngine`, recording each run through `@deepseek-ai/dsh-workflow-run-store`.
 * The plugin mounts the service and registers the tool; the model-written `workflow` tool is
 * untouched.
 * @module @deepseek-ai/dsh-tool-workflow-run
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { assertConfigUsable, Config } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { WorkflowRunsService } from './runner.ts'
import { registerWorkflowRunTool } from './tool.ts'

export const name = 'tool-workflow-run'
export const inject = ['tools', 'workflowEngine']

export { assertConfigUsable, Config } from './config.ts'
export type { ResolvedConfig, TierModels, TrustPolicy } from './config.ts'
export { ApprovalBroker, APPROVAL_REMEDY, immediateRejectionReason, WriteQueue } from './broker.ts'
export type { BrokerAnswer, PendingApprovalView } from './broker.ts'
export {
  listWorkflowNames, readWorkflowByName, readWorkflowByPath, resolveWorkflowsDir, WORKFLOW_NAME_PATTERN, WorkflowFileError,
} from './discover.ts'
export type { WorkflowSourceFile } from './discover.ts'
export { createShellBashExecutor } from './executor.ts'
export { buildGateReport, renderOutcome } from './report.ts'
export { planResume, seedScript } from './resume.ts'
export { TrustStore, renderTrustReason } from './trust.ts'
export { renderDiagnostics, WorkflowRunsService } from './runner.ts'
export type { RunView, WorkflowStoreReader } from './runner.ts'
export { WORKFLOW_RUN_DESCRIPTION } from './tool.ts'
export type * from './types.ts'

/**
 * Mount the runner service and register the `workflow_run` tool.
 * @param ctx - the plugin context.
 * @param config - plugin config; the schema fills the defaults.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // schemastery (the exported Config schema) has already filled the defaulted fields.
  const resolved = config as ResolvedConfig
  assertConfigUsable(resolved)
  new WorkflowRunsService(ctx, resolved)
  registerWorkflowRunTool(ctx, resolved)
}

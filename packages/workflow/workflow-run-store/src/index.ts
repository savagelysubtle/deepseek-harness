/**
 * Durable on-disk store for YAML workflow runs: an append-only record log, the pinned workflow
 * source, spilled node output, and a folded index, kept outside the checkout under the dsh home.
 * Pure Node I/O that depends on the `@deepseek-ai/dsh-workflow` types only.
 * @module @deepseek-ai/dsh-workflow-run-store
 */

export type { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
export { WORKFLOW_RUN_RECORD_VERSION } from './constants.ts'
export { WorkflowStoreError, WRITER_BUSY_REMEDY } from './errors.ts'
export type { WorkflowStoreErrorCode, WriterHolder } from './errors.ts'
export { writeFileAtomic } from './fs-util.ts'
export { createProcessProbe } from './lock.ts'
export type { ProbeOptions, ProcessProbe } from './lock.ts'
export { openStore, WorkflowRunStore, workflowStoreDir } from './store.ts'
export type { OpenStoreOptions } from './store.ts'
export { GATE_NOT_REACHED, LIMITS } from './types.ts'
export type * from './types.ts'

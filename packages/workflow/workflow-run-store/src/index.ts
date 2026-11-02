/**
 * Durable on-disk store for YAML workflow runs: an append-only record log, the pinned workflow
 * source, spilled node output, and a folded index. Pure Node I/O that depends on the
 * `@deepseek-ai/dsh-workflow` types only. This revision is the package scaffold; the writer
 * lock, record schema, and retention land in later slices of OP-240.
 * @module @deepseek-ai/dsh-workflow-run-store
 */

export type { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'

/** Schema version stamped as `v` on every persisted record; readers refuse other values. */
export const WORKFLOW_RUN_RECORD_VERSION = 1

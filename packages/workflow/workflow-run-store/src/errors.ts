/** Stable failure codes thrown by the run store. */
export type WorkflowStoreErrorCode =
  | 'WRITER_BUSY'
  | 'NOT_WRITER'
  | 'UNSUPPORTED_VERSION'
  | 'WORKSPACE_MISMATCH'
  | 'INVALID_ID'
  | 'RUN_EXISTS'
  | 'RUN_NOT_FOUND'
  | 'APPROVAL_NOT_FOUND'
  | 'OUTPUT_NOT_FOUND'
  | 'INVALID_INPUT'

/** Who holds the single-writer lock, as recorded in `writer.lock`. */
export interface WriterHolder {
  readonly pid: number
  readonly hostname: string
  readonly startedAt: number
  readonly runId?: string
  readonly workflowName?: string
}

/** Error with a machine-readable code and a plain-English message that already carries the remedy. */
export class WorkflowStoreError extends Error {
  readonly code: WorkflowStoreErrorCode
  /** Present on `WRITER_BUSY` when the lock content could be read. */
  readonly holder?: WriterHolder
  constructor(code: WorkflowStoreErrorCode, message: string, holder?: WriterHolder) {
    super(message)
    this.name = 'WorkflowStoreError'
    this.code = code
    if (holder) this.holder = holder
  }
}

/** Remedy text appended to every `WRITER_BUSY` message. */
export const WRITER_BUSY_REMEDY =
  'Wait for it to finish, or cancel it in Workflows (Cancel button) / `workflow_run {cancel}`.'

/**
 * Machine-routable failures of the worktree seam. Every refusal carries its
 * reason in the message — never a silent fence.
 *
 * @module @deepseek-ai/dsh-worktree/errors
 */

/** Stable failure classes a consumer can switch on. */
export type WorktreeErrorCode =
  | 'ALREADY_LOCKED'
  | 'BRANCH_EXISTS'
  | 'COPY_LIST_UNSUPPORTED'
  | 'COPY_SOURCE_MISSING'
  | 'DUPLICATE_PROVIDER'
  | 'ENV_MISSING'
  | 'GIT_FAILED'
  | 'INTENT_INVALID'
  | 'LOCKED'
  | 'NOT_LOCKED'
  | 'NO_PROVIDER'
  | 'NO_ROW'
  | 'PATH_EXISTS'
  | 'REASON_INVALID'
  | 'REGISTRY_CORRUPT'
  | 'SEAT_INVALID'

/**
 * Failure carrying a stable {@link WorktreeErrorCode}. The message always
 * names the reason the operation refused; the underlying failure, when one
 * exists, stays reachable through `cause`.
 */
export class WorktreeError extends Error {
  constructor(message: string, readonly code: WorktreeErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorktreeError'
  }
}

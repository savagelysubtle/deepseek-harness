/**
 * The worktree seam's contract, declared by this consumer.
 *
 * The seam provider (the worktree registry plugin) is being built separately;
 * until its integration commit lands, this module is the declaration of
 * record for everything the consumer codes against: the service interface and
 * the typed refusal the seam reports. The row, handle, and spawn-input data
 * shapes live in `api/worktree.ts` — one declaration serves both
 * the wire projection and the seam, so a drift between them cannot compile.
 * When the real package exists, its types replace the local ones here and
 * the import edges below (and in `api-proxy.ts`) move to it; nothing else in
 * the consumer may change.
 *
 * Composition is optional: the service is read with `ctx.get('worktree')`,
 * never declared injection, so a deployment without the seam serves every
 * other domain and the worktree surface answers `worktree-unavailable`
 * instead of degrading silently.
 *
 * @module worktree seam contract (consumer-declared)
 */

import type { WorktreeHandle, WorktreeRef, WorktreeRow, WorktreeSpawnInput } from './api/worktree.ts'

/**
 * Stable refusal codes the seam reports through {@link WorktreeSeamError}.
 * The seam owns the full refusal vocabulary; these are the codes the
 * consumer distinguishes on, and the seam must report any other refusal as
 * `worktree-forbidden` (an operation the caller is not allowed to perform
 * the way it asked) so the reason text it carries stays the caller's
 * explanation.
 */
export type WorktreeSeamRefusalCode =
  /** The addressed worktree is locked; its lock reason explains why. */
  | 'worktree-locked'
  /** No live worktree answers the given reference. */
  | 'worktree-unknown'
  /** The operation is not permitted as asked (frozen seat, disallowed verb, ...). */
  | 'worktree-forbidden'

/**
 * The typed refusal the seam reports. The consumer surfaces every seam
 * throw — this one with its `code` echoed into the wire error's details,
 * any other as an untyped refusal — and always forwards the message text
 * verbatim, because the message is the reason the caller sees.
 */
export class WorktreeSeamError extends Error {
  /**
   * @param code - the seam's stable refusal code.
   * @param message - the refusal reason, surfaced to the caller verbatim.
   */
  constructor(readonly code: WorktreeSeamRefusalCode, message: string) {
    super(message)
    this.name = 'WorktreeSeamError'
  }
}

/**
 * The worktree seam service: mints worktrees per seat/session pair and owns
 * the live registry behind `list`. The consumer never constructs references;
 * a worktree is addressed by the token the seam minted into its handle
 * (`WorktreeHandle.slug`, the locally declared ref convention).
 */
export interface WorktreeSeam {
  /**
   * Mints (or resolves) the worktree for the named seat and session.
   * @param input - the seat the worktree belongs to and the session it hosts.
   * @returns the handle of the live worktree the session runs in.
   * @throws WorktreeSeamError when the seat is frozen or the pair cannot be served.
   */
  spawn(input: WorktreeSpawnInput): Promise<WorktreeHandle>

  /**
   * Snapshots the live registry.
   * @returns every live worktree row, lock state and lock reason included.
   * @throws WorktreeSeamError when the registry cannot be read.
   */
  list(): Promise<WorktreeRow[]>

  /**
   * Locks the addressed worktree against removal.
   * @param ref - the worktree's minted reference (see {@link WorktreeSeam}).
   * @param reason - why the lock is held; surfaced verbatim in registry rows.
   * @throws WorktreeSeamError when the reference is unknown or already locked.
   */
  lock(ref: WorktreeRef, reason: string): Promise<void>

  /**
   * Removes the addressed worktree.
   * @param ref - the worktree's minted reference (see {@link WorktreeSeam}).
   * @param reason - why the removal is requested; surfaced in refusals.
   * @throws WorktreeSeamError when the reference is unknown or locked.
   */
  remove(ref: WorktreeRef, reason: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The worktree seam, when the deployment mounts its provider. Optional
     * by composition: read with `ctx.get`, absent means every worktree
     * operation refuses with `worktree-unavailable`.
     */
    worktree: WorktreeSeam
  }
}

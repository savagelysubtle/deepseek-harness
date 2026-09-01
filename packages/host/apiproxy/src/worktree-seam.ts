/**
 * The consumer's adaptation layer over the real worktree capability seam,
 * `@deepseek-ai/dsh-worktree`.
 *
 * The gateway's handlers and the wire domain (`api/worktree.ts`) are written
 * against the consumer-facing {@link WorktreeSeam} contract, which predates
 * the seam package; {@link worktreeSeamOf} wraps the service mounted under the
 * package's own `worktrees` Context key in that contract. The mapping: the
 * spawn input's `sessionName` is the service's `intent`, the service's minted
 * `session` names the handle and rows, `lockReason` projects to
 * `locked`/`lockReason`, and a worktree is addressed by the slug the seam
 * minted into its handle (the ref=slug convention). The wire vocabulary in
 * `api/worktree.ts` stays the declaration of record for the handle, row, and
 * spawn-input data shapes, so a drift between the two sides cannot compile.
 *
 * Refusals: the service's typed `WorktreeError` codes fold into the consumer's
 * refusal vocabulary — `LOCKED`/`ALREADY_LOCKED` → `worktree-locked`,
 * `NO_ROW` → `worktree-unknown`, every other code and any non-`WorktreeError`
 * throw → `worktree-forbidden` — and the service's message always reaches the
 * caller verbatim, because the message is the reason the caller sees.
 *
 * Composition stays optional: the service is read with `ctx.get`, never
 * declared injection, so a deployment without the seam serves every other
 * domain and the worktree surface answers `worktree-unavailable` instead of
 * degrading silently.
 *
 * @module worktree seam adaptation (consumer of @deepseek-ai/dsh-worktree)
 */

import { WorktreeError } from '@deepseek-ai/dsh-worktree'
import type { Context } from '@deepseek-ai/cordis'
import type { WorktreeRow as ServiceWorktreeRow, WorktreeService, WorktreeSlug } from '@deepseek-ai/dsh-worktree'
import type { WorktreeHandle, WorktreeRef, WorktreeRow, WorktreeSpawnInput } from './api/worktree.ts'

/**
 * Stable refusal codes the seam reports through {@link WorktreeSeamError}.
 * The consumer distinguishes exactly these; every service refusal outside the
 * vocabulary folds into `worktree-forbidden` (an operation the caller is not
 * allowed to perform the way it asked) so the reason text it carries stays the
 * service's own explanation.
 */
export type WorktreeSeamRefusalCode =
  /** The addressed worktree is locked; its lock reason explains why. */
  | 'worktree-locked'
  /** No live worktree answers the given reference. */
  | 'worktree-unknown'
  /** The operation is not permitted as asked (invalid seat, missing env, ...). */
  | 'worktree-forbidden'

/**
 * The typed refusal the seam reports. The consumer surfaces every seam
 * throw — this one with its `code` echoed into the wire error's details — and
 * always forwards the message text verbatim, because the message is the
 * reason the caller sees.
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
 * (`WorktreeHandle.slug`, the ref=slug convention).
 */
export interface WorktreeSeam {
  /**
   * Mints (or resolves) the worktree for the named seat and session.
   * @param input - the seat the worktree belongs to and the session it hosts.
   * @returns the handle of the live worktree the session runs in.
   * @throws WorktreeSeamError when the seat is refused or the worktree cannot be served.
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

/**
 * Fold a service throw into the consumer's refusal vocabulary.
 * @param error - the value the service threw.
 * @returns the typed refusal carrying the service's reason verbatim.
 */
function seamRefusal(error: unknown): WorktreeSeamError {
  if (error instanceof WorktreeError) {
    switch (error.code) {
      case 'LOCKED':
      case 'ALREADY_LOCKED':
        return new WorktreeSeamError('worktree-locked', error.message)
      case 'NO_ROW':
        return new WorktreeSeamError('worktree-unknown', error.message)
      default:
        // The service's refusal vocabulary can grow; every code this consumer
        // does not distinguish folds into the forbidden refusal rather than
        // coupling the consumer to the full code list.
        return new WorktreeSeamError('worktree-forbidden', error.message)
    }
  }
  return new WorktreeSeamError('worktree-forbidden', error instanceof Error ? error.message : String(error))
}

/**
 * Project one registry row onto the wire row.
 * @param row - the live service row.
 * @returns the wire row with lock state folded from the service's lock reason.
 */
function seamRow(row: ServiceWorktreeRow): WorktreeRow {
  return {
    seat: row.seat,
    path: row.path,
    branch: row.branch,
    sessionName: row.session,
    locked: row.lockReason !== undefined,
    ...(row.lockReason === undefined ? {} : { lockReason: row.lockReason }),
  }
}

/**
 * Wrap the mounted worktree service in the consumer's seam contract. Pure
 * adaptation: every call forwards to the service and every throw folds
 * through {@link seamRefusal}.
 * @param service - the `@deepseek-ai/dsh-worktree` service to adapt.
 * @returns the seam the gateway handlers consume.
 */
export function adaptWorktreeService(service: WorktreeService): WorktreeSeam {
  return {
    async spawn(input: WorktreeSpawnInput): Promise<WorktreeHandle> {
      try {
        // The session name the caller passes is the spawn's intent; the
        // service mints the session that will actually host the seat's work.
        const minted = await service.spawn({ seat: input.seat, intent: input.sessionName })
        return {
          slug: minted.slug,
          branch: minted.branch,
          path: minted.path,
          sessionName: minted.session,
          seat: minted.seat,
        }
      } catch (error: unknown) {
        throw seamRefusal(error)
      }
    },

    async list(): Promise<WorktreeRow[]> {
      try {
        return service.list().map(seamRow)
      } catch (error: unknown) {
        throw seamRefusal(error)
      }
    },

    async lock(ref: WorktreeRef, reason: string): Promise<void> {
      try {
        // The wire reference is the seam-minted slug, so the string re-brands
        // onto the service's slug id verbatim.
        await service.lock(ref as string as WorktreeSlug, reason)
      } catch (error: unknown) {
        throw seamRefusal(error)
      }
    },

    async remove(ref: WorktreeRef, reason: string): Promise<void> {
      try {
        await service.remove(ref as string as WorktreeSlug, reason)
      } catch (error: unknown) {
        throw seamRefusal(error)
      }
    },
  }
}

/**
 * Resolve the worktree seam for the gateway: read the real service and wrap
 * it once per read. Absent service means the deployment mounts no seam; the
 * caller answers `worktree-unavailable`.
 * @param ctx - the host context.
 * @returns the adapted seam, or undefined when no service is mounted.
 */
export function worktreeSeamOf(ctx: Context): WorktreeSeam | undefined {
  const service = ctx.get('worktrees')
  return service === undefined ? undefined : adaptWorktreeService(service)
}

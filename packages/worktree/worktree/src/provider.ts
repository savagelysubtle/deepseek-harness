/**
 * The provider contract of the worktree seam: one swappable worktree
 * mechanics backend. The local implementation shells out to git
 * (`./local-git.ts`); the service owns slugs, fences, the registry, and the
 * bootstrap policy, and never runs git itself.
 *
 * @module @deepseek-ai/dsh-worktree/provider
 */

import type { WorktreeAddSpec, WorktreeListEntry } from './types.ts'

/**
 * One worktree backend. Force is unrepresentable: no method accepts a force
 * flag, and the service refuses — before calling the provider — the two
 * states force would paper over (an existing target path, an existing
 * branch). Removal is likewise never forced; a dirty worktree surfaces git's
 * refusal instead of being destroyed.
 */
export interface WorktreeProvider {
  /** Registry-unique provider name. */
  readonly name: string

  /**
   * Create the worktree at `spec.path` on the new branch `spec.branch` cut
   * from `spec.mainRef`, created locked with `spec.lockReason` — the exact
   * `git worktree add --lock -b <branch> <path> <main-ref>` contract for the
   * local provider.
   * @param spec - fully resolved spawn input; the service has already refused existing paths and branches.
   */
  add(spec: WorktreeAddSpec): Promise<void>

  /**
   * Lock an existing worktree with a reason.
   * @param path - absolute worktree path.
   * @param reason - reason recorded with the git lock.
   */
  lock(path: string, reason: string): Promise<void>

  /**
   * Remove an existing lock. Git records no unlock reason; the service keeps
   * the caller's reason on the row.
   * @param path - absolute worktree path.
   */
  unlock(path: string): Promise<void>

  /**
   * Remove the worktree's admin metadata and directory. Refuses (via git)
   * when the worktree is locked or dirty — force-removal is unrepresentable.
   * @param path - absolute worktree path.
   */
  remove(path: string): Promise<void>

  /**
   * Whether the target path already exists in the provider's filesystem —
   * the fence that makes force-spawning (`git worktree add -f`)
   * unrepresentable before `add` runs.
   * @param path - absolute candidate worktree path.
   * @returns true when something already occupies the path.
   */
  pathExists(path: string): Promise<boolean>

  /**
   * Whether a local branch with this exact name already exists — the fence
   * that makes branch reuse impossible before `add` runs.
   * @param branch - full branch name.
   * @returns true when the branch exists.
   */
  branchExists(branch: string): Promise<boolean>

  /**
   * Enumerate the repository's worktrees as git sees them — the reconciliation
   * view tests and operators read rows against.
   * @returns one entry per worktree git reports, in git's order.
   */
  list(): Promise<readonly WorktreeListEntry[]>
}

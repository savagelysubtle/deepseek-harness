/**
 * Data contracts of the worktree seam. Types only — runtime behavior lives in
 * the service (`./index.ts`), the provider contract (`./provider.ts`), and the
 * local git provider (`./local-git.ts`).
 *
 * @module @deepseek-ai/dsh-worktree/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Seam-minted identifier of one spawn: unique per parallel round, never chosen
 * by the caller. Every derived name — branch, session, path — is a pure
 * function of the seat and this slug, so a row is reproducible from two strings.
 */
export type WorktreeSlug = Branded<'worktree-slug'>

/**
 * Request to create one seat-scoped worktree. The caller supplies ownership
 * and intent; the seam mints the slug and derives every name from it.
 */
export interface WorktreeSpawnRequest {
  /**
   * Seat that will work inside the worktree. Uses the session-name grammar
   * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, from `@deepseek-ai/dsh-named-sessions`):
   * filename-safe and valid inside a git branch name.
   */
  readonly seat: string
  /** Short caller intent, recorded on the row as the spawn's `lastReason`. */
  readonly intent: string
  /** Explicit ref to branch from; omitted resolves to `Config.mainRef`. */
  readonly mainRef?: string | undefined
}

/** Published result of one successful spawn. */
export interface WorktreeSpawnResult {
  /** Seam-minted slug behind every derived name. */
  readonly slug: WorktreeSlug
  /** Seat the worktree was spawned for. */
  readonly seat: string
  /** New branch the worktree checked out: `<seat>/<slug>`. */
  readonly branch: string
  /** Session name reserved for the seat's work in this worktree: `<seat>.<slug>`. */
  readonly session: string
  /** Absolute worktree path: `<worktreesRoot>/<seat>-<slug>`. */
  readonly path: string
  /** Ref the branch was cut from. */
  readonly branchRef: string
  /** Reason the creation lock carries: `<seat> <session>`. */
  readonly lockReason: string
  /** Repo-root-relative files the copy-list bootstrap placed into the worktree. */
  readonly copied: readonly string[]
}

/**
 * One registry row: seat → worktree path → branch → session name. Exactly one
 * row exists per live branch; removal deletes it.
 */
export interface WorktreeRow {
  /** Seam-minted slug; the row's stable identity across lock state changes. */
  readonly slug: WorktreeSlug
  /** Seat the worktree belongs to. */
  readonly seat: string
  /** Branch the worktree checked out. */
  readonly branch: string
  /** Session name reserved for the seat's work in this worktree. */
  readonly session: string
  /** Absolute worktree path. */
  readonly path: string
  /** Ref the branch was cut from. */
  readonly branchRef: string
  /** Epoch milliseconds at which the seam published the row. */
  readonly createdAt: number
  /**
   * Reason the current git lock carries; `undefined` while unlocked. A row is
   * born locked (spawn creates the worktree under lock) and removal refuses
   * while this is set.
   */
  readonly lockReason?: string | undefined
  /** Reason attached to the most recent mutation (spawn intent, lock, or unlock). */
  readonly lastReason?: string | undefined
}

/** Event payload emitted after a registry mutation commits. */
export interface WorktreeEventPayload {
  /** Row state after the mutation. */
  readonly row: WorktreeRow
  /** Reason the mutation carried (spawn intent, lock reason, or unlock reason). */
  readonly reason: string
}

/** Fully resolved spawn input handed to a provider's {@link WorktreeProvider.add}. */
export interface WorktreeAddSpec {
  /** Absolute target worktree path. */
  readonly path: string
  /** New branch to create and check out. */
  readonly branch: string
  /** Ref to branch from. */
  readonly mainRef: string
  /** Reason the creation lock carries. */
  readonly lockReason: string
}

/** One entry of the provider's worktree listing. */
export interface WorktreeListEntry {
  /** Absolute worktree path. */
  readonly path: string
  /** Checked-out branch, without the `refs/heads/` prefix; absent for detached worktrees. */
  readonly branch?: string | undefined
  /** Whether the worktree is currently locked. */
  readonly locked: boolean
  /** Reason the lock carries, when locked and reported by git. */
  readonly lockReason?: string | undefined
}

/** Provider options resolved by the owning implementation. */
export interface LocalGitWorktreeProviderOptions {
  /** Absolute path of the main checkout every git invocation addresses. */
  readonly repoRoot: string
  /**
   * Test seam replacing the git invocation itself (the
   * `subprocess-local/process-inspector` `exec` precedent): the provider
   * defaults to the real `git` child process; tests inject failures and
   * porcelain fixtures through this.
   */
  readonly exec?: (args: readonly string[]) => Promise<string>
}

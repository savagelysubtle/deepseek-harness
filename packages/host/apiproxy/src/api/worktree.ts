/**
 * worktree domain contract. Wire projection of the worktree seam: the
 * seat→worktree→branch registry every live worktree row is visible in, and
 * the management verbs over it. Method signatures are the source of truth,
 * same as the sessions and workspace domains.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * Wire-side worktree reference brand. Deliberately re-declared here rather
 * than imported from the seam package: api/ must stay browser-importable with
 * zero host-package dependencies, and the brand string matches, so both sides
 * agree structurally.
 */
export type WorktreeRef = Branded<'WorktreeRef'>

/**
 * What a caller must name to mint (or bind) one worktree: the seat the
 * worktree belongs to and the session name it hosts. The same object is the
 * spawn input the consumer forwards verbatim to the seam, so a
 * `session.create` worktree intent and a `worktree.create` request carry
 * exactly the seam's vocabulary.
 */
export interface WorktreeSpawnInput {
  /** Seat the worktree belongs to (the seat→worktree chain's head). */
  seat: string
  /** Name of the session the worktree hosts (echoed by the handle and rows). */
  sessionName: string
}

/** One seam-minted worktree, as `worktree.create` and the spawn flow return it. */
export interface WorktreeHandle {
  /** Seam-minted unique token of the worktree (the reference lock/remove address). */
  slug: string
  /** Git branch checked out inside the worktree. */
  branch: string
  /** Absolute directory path the session runs in. */
  path: string
  /** Name of the session the worktree hosts. */
  sessionName: string
  /** Seat the worktree belongs to. */
  seat: string
}

/**
 * One live worktree registry row. Every live worktree is visible — seat,
 * path, branch, hosted session, and lock state with its reason — never a
 * silent fence: a hidden or redacted row is a contract violation, and a lock
 * always names why it is held.
 */
export interface WorktreeRow {
  /** Seat the worktree belongs to. */
  seat: string
  /** Absolute directory path of the worktree. */
  path: string
  /** Git branch checked out inside the worktree. */
  branch: string
  /** Name of the session the worktree hosts. */
  sessionName: string
  /** Whether the worktree is currently locked against mutation. */
  locked: boolean
  /** Why the lock is held; present exactly when `locked` is true. */
  lockReason?: string
}

/** Worktree-domain unary methods (the map keys worktree.* of RpcMethodMap). */
export interface WorktreeApi {
  /**
   * Lists every live worktree row the seam serves, lock state and lock
   * reason included. A deployment without the seam refuses with
   * `worktree-unavailable` rather than answering an empty list: an empty
   * answer would read as "no worktrees" when the truth is "no registry".
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ items: WorktreeRow[] }>>

  /**
   * Mints (or resolves) one worktree through the seam's spawn for the named
   * seat and session. The seam's rejections — a frozen seat, an existing
   * locked worktree, a refused branch — surface as `worktree-refused`
   * carrying the seam's own message; they are never folded into a generic
   * error or an empty success.
   */
  create(request: RpcRequest<WorktreeSpawnInput>):
  Promise<RpcResponse<{ worktree: WorktreeHandle }>>

  /**
   * Locks the addressed worktree against removal with a required non-empty
   * reason. The reference is the seam's worktree token (`WorktreeHandle.slug`
   * under the locally declared seam contract); the consumer treats it as
   * opaque and validates only that it is present. Locking an already-locked
   * worktree surfaces the seam's refusal as `worktree-refused`.
   */
  lock(request: RpcRequest<{ ref: WorktreeRef; reason: string }>):
  Promise<RpcResponse<{ locked: true }>>

  /**
   * Removes the addressed worktree with a required non-empty reason. A
   * locked worktree stays listed and the seam's refusal surfaces as
   * `worktree-refused` with its reason; removal of an unknown reference
   * surfaces the seam's `worktree-unknown` refusal the same way.
   */
  remove(request: RpcRequest<{ ref: WorktreeRef; reason: string }>):
  Promise<RpcResponse<{ removed: true }>>
}

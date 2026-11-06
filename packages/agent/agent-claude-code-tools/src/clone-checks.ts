/**
 * Clone-check registry: the seam through which a later package (the S7 seat-checks plugin) hands the
 * policy a synchronous check of a seat's working-directory clone. The check runs inside `extend()` on
 * every query, because only the query knows the clone path; readiness is host-global and cannot see it.
 * A failing check throws {@link CloneCheckError}, which is a `SeatMutedByPolicyError`, so the driver
 * records the refusal and raises a typed turn error instead of crashing the seat.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/clone-checks
 */

import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import type { PolicyRole } from './contributors.ts'

/** Id the `rules-hooks` clone check must be registered under; `extend()` refuses a coder without it. */
export const CLONE_HOOKS_CHECK_ID = 'clone-hooks-check'

/** A clone check refused a seat's working directory. */
export class CloneCheckError extends SeatMutedByPolicyError {
  /**
   * @param seat the seat's bare name.
   * @param code a short machine-readable code (for example `git-missing`, `parse`, `hooks-path`, `check-missing`).
   * @param reason what is wrong, the key or path involved and the exact remedy; shown to the operator, not the model.
   */
  constructor(seat: string, readonly code: string, reason: string) {
    super(seat, reason)
    this.name = 'CloneCheckError'
  }
}

/** What a clone check is told about the query. */
export interface CloneCheckContext {
  /** The seat's bare name. */
  readonly seat: string
  /** The seat's canonical working directory, already pinned and inside the allowed roots. */
  readonly cwd: string
}

/** One registered clone check. */
export interface CloneCheck {
  /** Unique id; the rules-hooks check uses {@link CLONE_HOOKS_CHECK_ID}. */
  readonly id: string
  /** The roles whose queries it runs for. */
  readonly roles: readonly PolicyRole[]
  /**
   * Judge one query's clone. Must be synchronous and must fail closed: the caller (`extend`) refuses on any throw.
   * @throws {CloneCheckError} to refuse; any other thrown value is wrapped into a refusal by the caller.
   */
  readonly check: (ctx: CloneCheckContext) => void
}

/** Holds the registered clone checks. Entries cannot be removed. */
export class CloneCheckRegistry {
  private readonly checks = new Map<string, CloneCheck>()

  /**
   * Register a check.
   * @param check - its id, roles and function.
   * @throws when the id is already registered.
   */
  register(check: CloneCheck): void {
    if (this.checks.has(check.id)) throw new Error(`agent-claude-code-tools: clone check ${check.id} is already registered`)
    this.checks.set(check.id, { id: check.id, roles: [...check.roles], check: check.check })
  }

  /**
   * Whether a check with this id is registered.
   * @param id - the check id.
   * @returns true when registered.
   */
  has(id: string): boolean {
    return this.checks.has(id)
  }

  /**
   * The checks that run for a role, in registration order.
   * @param role - the seat's role.
   * @returns the matching checks.
   */
  checksFor(role: PolicyRole): readonly CloneCheck[] {
    return [...this.checks.values()].filter(entry => entry.roles.includes(role))
  }
}

/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-worktree`.
 * @module @deepseek-ai/dsh-worktree/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-worktree'

/** Cordis companion plugin name. */
export const name = 'worktree-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the registry rows are private mutable state whose
 * every relation (lock fences, one row per live branch, row deletion on
 * removal) is enforced in the mutating operation and asserted directly by the
 * lifecycle and provider tests; git's own worktree state remains the external
 * authority the provider mirrors, so the seam owns no independent event
 * stream to re-derive.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

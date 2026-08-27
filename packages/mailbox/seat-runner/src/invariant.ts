/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-seat-runner`.
 * @module @deepseek-ai/dsh-seat-runner/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-seat-runner'

/** Cordis companion plugin name. */
export const name = 'seat-runner-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the daemon runs as its own process outside a Loader,
 * so no cross-plugin event stream exists for a companion to watch. Its one
 * owned relation — at most one in-flight wake per seat, issued only for
 * registry-resolved seats whose namespace matches the pending address — is
 * enforced inside the tick and pinned by unit tests on the injected
 * collaborators.
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

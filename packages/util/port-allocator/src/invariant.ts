/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-port-allocator`.
 * @module @deepseek-ai/dsh-port-allocator/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-port-allocator'

/** Cordis companion plugin name. */
export const name = 'port-allocator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this pure utility owns no event stream or mutable runtime data; the
 * allocation probe and env isolation algebra are enforced by unit tests against the real
 * kernel listen path.
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

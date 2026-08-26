/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mailbox-bridge`.
 * @module @deepseek-ai/dsh-mailbox-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mailbox-bridge'

/** Cordis companion plugin name. */
export const name = 'mailbox-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bridge owns no durable artifact and no event
 * stream of its own. Every relation it relies on is asserted by the operation
 * that makes the decision — claim exclusivity and settlement legitimacy live
 * in the provider's SQL, residency is the named-session lock file itself,
 * and address-grammar membership is validated once at mount with direct
 * tests. Delivery outcomes are recorded through the store's own settled
 * state, which the provider package already covers.
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

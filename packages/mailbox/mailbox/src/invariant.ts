/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mailbox`.
 * @module @deepseek-ai/dsh-mailbox/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mailbox'

/** Cordis companion plugin name. */
export const name = 'mailbox-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the seam owns no durable artifact and no event
 * stream of its own. Provider uniqueness is enforced loudly at registration,
 * default-provider resolution fails loud at each convenience call, and
 * address-grammar enforcement lives in the admitting operation — every
 * relation this package could assert is already a same-process precondition
 * with its rejection tested directly.
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

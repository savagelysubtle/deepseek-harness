/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mailbox-local`.
 * @module @deepseek-ai/dsh-mailbox-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mailbox-local'

/** Cordis companion plugin name. */
export const name = 'mailbox-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every relation this package owns is enforced inside
 * the SQL operation that makes the decision — single-winner claims by the
 * IMMEDIATE transaction plus its guarded `changes === 1` update, settlement
 * legitimacy by the lease-token predicate, and foreign/newer-file rejection
 * by the version-stamped meta table at open — and each rejection has a direct
 * test. No cross-plugin event stream exists for a companion to watch.
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

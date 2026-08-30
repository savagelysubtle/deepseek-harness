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
 * No runtime invariant: every relation this package owns is enforced by the
 * operation that makes the decision, each with direct tests. The one event
 * stream the bridge emits (`mailbox/refused`) is emitted by the same `refuse`
 * call that settles the recipient's row `failed` with the same reason and
 * logs the sender's durable notice node — the event, the settlement, and the
 * notice are that single operation, not a cross-operation state relation a
 * companion could watch — and the store's settled state itself remains the
 * provider package's coverage. The notice's loop and interrupt safety are
 * structural, not observational: it is appended to the sender's session log
 * directly, so it never enters the mail store (nothing can claim, judge, or
 * refuse it) and never touches the inbox (nothing can wake on it). Residency
 * is the named-session lock file, and address-grammar membership is validated
 * once at mount.
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

/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-org-controls`.
 * @module @deepseek-ai/dsh-client-ui-org-controls/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-org-controls'

/** Cordis companion plugin name. */
export const name = 'client-ui-org-controls-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package registers two footer-action buttons
 * that call through `ctx.sessions.stopAll`/`sendAll` and render whatever
 * those calls report; it owns no mutable cross-plugin state and emits no
 * cordis events of its own for a companion to police.
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

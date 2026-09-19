/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-org-board`.
 * @module @deepseek-ai/dsh-client-ui-org-board/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-org-board'

/** Cordis companion plugin name. */
export const name = 'client-ui-org-board-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package registers one footer-action button that
 * opens a modal rendering whatever `org.get` reports; it owns no mutable
 * cross-plugin state and emits no cordis events of its own for a companion
 * to police. It issues no writes at all (SWD-134 slice 2 is read-only).
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

/**
 * Package-owned invariant companion for
 * `@deepseek-ai/dsh-agent-claude-code-seat-checks`.
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-claude-code-seat-checks'

/** Cordis companion plugin name. */
export const name = 'agent-claude-code-seat-checks-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package writes no session record and owns no durable data; the refusals are typed
 * `CloneCheckError`s and the registration order, pinned by this package's specs.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - plugin context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

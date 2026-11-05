/**
 * Package-owned invariant companion for
 * `@deepseek-ai/dsh-agent-claude-code-tools`.
 * @module @deepseek-ai/dsh-agent-claude-code-tools/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-claude-code-tools'

/** Cordis companion plugin name. */
export const name = 'agent-claude-code-tools-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package holds no state of its own and writes no session record; the confinement
 * decisions are pure functions of the policy file, pinned by this package's specs.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - plugin context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

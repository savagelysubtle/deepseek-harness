/**
 * Package-owned invariant companion for
 * `@deepseek-ai/dsh-agent-claude-code-driver`.
 * @module @deepseek-ai/dsh-agent-claude-code-driver/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-claude-code-driver'

/** Cordis companion plugin name. */
export const name = 'agent-claude-code-driver-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the durable `claude-code/*` record relations belong to
 * `@deepseek-ai/dsh-agent-claude-code`, and the single-live-query rule is a
 * process-local phase machine, not a log relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - plugin context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

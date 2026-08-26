/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-headless`.
 * @module @deepseek-ai/dsh-headless/invariant
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  lockPathForToken,
  NAMED_SESSION_ID_PREFIX,
  NAMED_SESSION_TOKEN_PATTERN_SOURCE,
} from './named-session.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-headless'

/** Cordis companion plugin name. */
export const name = 'headless-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

const DERIVED_ID_PATTERN = new RegExp(`^${NAMED_SESSION_ID_PREFIX}${NAMED_SESSION_TOKEN_PATTERN_SOURCE}$`)

/**
 * Id/lock relation invariant: every announced session whose id carries the
 * named-run derivation must hold its per-name lock at that moment. The runner
 * acquires the lock before agent creation/resumption and releases it after
 * the run settles, so a lock-less announcement means a named id reached the
 * registry without passing through {@link ./named-session.ts} acquisition.
 * The id's token and the lock filename share one derivation, so existence of
 * `headless/locks/<token>.lock` is the whole checkable relation.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  ctx.on('session/created', (session: Session) => {
    const id = String(session.id)
    if (!id.startsWith(NAMED_SESSION_ID_PREFIX)) return
    if (!DERIVED_ID_PATTERN.test(id)) {
      fail(`a named-prefixed session id "${id}" must be the derivation's ${NAMED_SESSION_ID_PREFIX}<32 hex> form`)
    }
    const lockPath = lockPathForToken(id.slice(NAMED_SESSION_ID_PREFIX.length))
    if (!existsSync(lockPath)) {
      fail(`named session "${id}" was announced without its held per-name lock at ${lockPath}`)
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

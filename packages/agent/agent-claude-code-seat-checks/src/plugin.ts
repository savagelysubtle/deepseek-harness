/**
 * The cordis plugin. Mount order, all inside ONE try/catch: (1) run the guard probe, (2) run the
 * checker self-test,
 * (3) only then, synchronously with no await, register the clone check, the `rules-hooks` readiness
 * contributor and
 * the `canary` contributor, the last one only on an explicit `{ ok: true }` probe result. A failure
 * before step 3
 * registers nothing, so nothing is half-registered. Any caught error logs at error level
 * `agent-claude-code-seat-checks: canary FAILED <code>`, records a note the not-ready error shows,
 * and registers
 * nothing; the coder stays refused until the host restarts. A second mount throws before
 * registering
 * anything. The registries cannot unregister, so unloading the
 * plugin makes the clone check refuse every later query.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { CLONE_HOOKS_CHECK_ID, CloneCheckError } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { runBootCanary, selfTestCloneChecker } from './canary.ts'
import { createCloneChecker } from './clone-state.ts'
import { resolveSeatChecksConfig } from './config.ts'
import type { Config } from './config.ts'
import { realCloneFs } from './fingerprint.ts'
import { realRunGit } from './git-config.ts'
import type { RunGit } from './git-config.ts'
import { CANARY_ID, LOG_PREFIX } from './limits.ts'
import type { CloneFs } from './fingerprint.ts'

/** Cordis plugin name. */
export const name = 'agent-claude-code-seat-checks'

/** Services the plugin needs: the policy registries to register into and the guard probe to run. */
export const inject = ['claudeCodePolicyRegistries', 'claudeCodeGuardProbe']

/** Test hooks of {@link mountSeatChecks}. */
export interface SeatChecksInternals {
  /** Whether a path exists (git lookup). */
  readonly exists?: (path: string) => boolean
  /** Replacement for the git runner. */
  readonly run?: RunGit
  /** Replacement for the filesystem calls. */
  readonly fs?: CloneFs
}

/** What went wrong, as a short code and the full reason. */
function describe(error: unknown): { code: string; reason: string } {
  if (error instanceof CloneCheckError) return { code: error.code, reason: error.reason }
  return { code: 'error', reason: error instanceof Error ? error.message : String(error) }
}

/**
 * Mount the seat checks.
 * @param ctx - plugin context (needs `claudeCodePolicyRegistries` and `claudeCodeGuardProbe`).
 * @param config - the row's config.
 * @param internals - test hooks.
 * @returns `true` when everything was registered, `false` when nothing was.
 * @throws {SeatChecksConfigError} when a config value is invalid.
 * @throws {Error} when the checks are already mounted (a reload fails loud instead of registering
 *   twice).
 */
export async function mountSeatChecks(ctx: Context, config: Config,
  internals: SeatChecksInternals = {}): Promise<boolean> {
  if (config.enabled === false) {
    ctx.logger.warn(
      `${LOG_PREFIX} disabled by config; the canary and rules-hooks entries are not registered `
      + 'and coder seats stay not-ready',
    )
    ctx.claudeCodePolicyRegistries.readiness.note(CANARY_ID, 'disabled by config')
    return false
  }
  const resolved = internals.exists === undefined
    ? resolveSeatChecksConfig(config)
    : resolveSeatChecksConfig(config, internals.exists)
  const registries = ctx.claudeCodePolicyRegistries
  if (registries.cloneChecks.has(CLONE_HOOKS_CHECK_ID)) {
    throw new Error(
      `${LOG_PREFIX} already mounted: the clone check ${CLONE_HOOKS_CHECK_ID} is registered `
      + 'and the registries cannot unregister it',
    )
  }
  const fail = (code: string, reason: string): false => {
    ctx.logger.error(`${LOG_PREFIX} canary FAILED ${code}`)
    ctx.logger.error(`${LOG_PREFIX} ${reason.replace(/[\r\n]+/g, ' ')}`)
    // A concurrent duplicate mount must not leave a failure note behind a canary that the first
    // mount registered.
    if (registries.readiness.readiness().missing.includes('canary')) {
      registries.readiness.note(CANARY_ID, `canary FAILED ${code}`)
    }
    return false
  }
  try {
    if (resolved.gitPath === undefined) {
      return fail(
        'git-missing',
        'git was not found at /usr/bin/git or /usr/local/bin/git; '
        + 'set gitPath in the agent-claude-code-seat-checks row',
      )
    }
    const deps = {
      gitPath: resolved.gitPath,
      run: internals.run ?? realRunGit,
      fs: internals.fs ?? realCloneFs,
      remoteUrlAllow: resolved.remoteUrlAllow,
    }
    if (resolved.remoteUrlAllow.length === 0) {
      ctx.logger.warn(
        `${LOG_PREFIX} remoteUrlAllow is empty: every clone that has a remote url will be refused; `
        + 'set it to the source repository',
      )
    }
    const probe = await runBootCanary(ctx.claudeCodeGuardProbe, resolved.canaryTimeoutMs)
    if (!probe.ok) return fail(probe.code, probe.reason)
    selfTestCloneChecker(deps)
    // From here on nothing awaits: the three registrations land together or the first throw leaves
    // the rest unregistered.
    const checker = createCloneChecker(deps)
    registries.cloneChecks.register({ id: CLONE_HOOKS_CHECK_ID, roles: ['coder'],
      check: checker.check })
    registries.readiness.register({ id: CLONE_HOOKS_CHECK_ID, provides: 'rules-hooks' })
    registries.readiness.register({ id: CANARY_ID, provides: 'canary' })
    ctx.effect(() => () => { checker.dispose() }, 'seat checks unload')
    ctx.logger.info(
      `${LOG_PREFIX} guard canary passed and the clone check is self-tested; `
      + 'registered canary and rules-hooks '
      + '(the canary proves the hook command through /bin/sh, not the Claude CLI)',
    )
    return true
  } catch (error: unknown) {
    const { code, reason } = describe(error)
    return fail(code, reason)
  }
}

/**
 * The cordis plugin: preflights the seat sandbox at mount and, only when the preflight passes, registers the
 * `sandbox` readiness contributor and the `bash` tool into the policy registries. When the config turns the tool off
 * or the preflight fails, NOTHING is registered, so a coder seat stays not-ready, and the reason is warn-logged.
 * Registration order is tool, contributor, readiness: the readiness entry is what unlocks the role, so it goes last.
 * A coder is still refused after this plugin alone: `canary` and `rules-hooks` come from the
 * `agent-claude-code-seat-checks` plugin, and readiness lists coder only when all three are registered.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { Config, ResolveEnv } from './config.ts'
import { SandboxHost } from './host.ts'
import { BASH_TOOL, READINESS_ID, TOOL_CONTRIBUTOR_ID } from './limits.ts'
import { realPreflightDeps } from './preflight.ts'
import type { PreflightDeps } from './preflight.ts'
import { realRunnerDeps } from './runner.ts'
import { createBashToolFactory } from './tool.ts'

/** Cordis plugin name. */
export const name = 'agent-claude-code-bash'

/** Services the plugin needs: the policy registries to register into, and the subprocess seam to spawn through. */
export const inject = ['claudeCodePolicyRegistries', 'subprocess']

/** Test hooks of {@link mountBashSandbox}. */
export interface MountInternals {
  /** Host facts for config resolution. */
  readonly host?: ResolveEnv
  /** Replacement preflight dependencies. */
  readonly deps?: (ctx: Context) => PreflightDeps
}

/**
 * Mount the sandbox: resolve the config, run the preflight, register on success.
 * @param ctx - plugin context (needs `claudeCodePolicyRegistries` and `subprocess`).
 * @param config - the row's config.
 * @param internals - test hooks.
 * @returns the host, or `undefined` when nothing was registered.
 * @throws {BashConfigError} when a config value is invalid.
 */
export async function mountBashSandbox(ctx: Context, config: Config, internals: MountInternals = {}): Promise<SandboxHost | undefined> {
  if (config.enabled === false) {
    ctx.logger.warn('agent-claude-code-bash: disabled by config; the sandbox bash tool is not registered and coder seats stay not-ready')
    return undefined
  }
  const resolved = internals.host === undefined ? resolveConfig(config) : resolveConfig(config, internals.host)
  if (!resolved.ok) {
    ctx.logger.warn(`agent-claude-code-bash: ${resolved.reason}; the sandbox bash tool is not registered and coder seats stay not-ready`)
    return undefined
  }
  const warn = (message: string): void => { ctx.logger.warn(message) }
  const deps = internals.deps?.(ctx) ?? realPreflightDeps(realRunnerDeps(ctx.subprocess.spawn.bind(ctx.subprocess), warn))
  const host = new SandboxHost(resolved.config, deps, warn)
  const preflight = await host.start()
  if (!preflight.ok) {
    ctx.logger.warn('agent-claude-code-bash: the sandbox bash tool is not registered and coder seats stay not-ready')
    return undefined
  }
  const registries = ctx.claudeCodePolicyRegistries
  registries.tools.register(BASH_TOOL, createBashToolFactory(host))
  registries.contributors.registerToolContributor({ id: TOOL_CONTRIBUTOR_ID, roles: ['coder'], names: [BASH_TOOL] })
  registries.readiness.register({ id: READINESS_ID, provides: 'sandbox' })
  // The registries cannot unregister; once this plugin is gone the tool must refuse rather than spawn through a dead service.
  ctx.effect(() => () => { host.unload() }, 'sandbox bash unload')
  ctx.logger.info('agent-claude-code-bash: sandbox preflight passed; registered the sandbox readiness contributor and the bash tool')
  return host
}

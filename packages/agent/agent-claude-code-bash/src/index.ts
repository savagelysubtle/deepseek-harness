/**
 * The sandboxed `bash` tool of Claude Code coder seats. A cordis plugin that preflights the bwrap seat sandbox
 * and, when it passes, registers the `sandbox` readiness contributor and the `bash` tool (served to the model as
 * `mcp__dsh__bash`) through the `claudeCodePolicyRegistries` service.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountBashSandbox } from './plugin.ts'
import type { Config } from './config.ts'

export { BashConfigError, baseSpec, Config, resolveConfig } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { SandboxHost } from './host.ts'
export { BASH_TOOL, DEFAULT_DEADLINE_S, HOST_MAX_DEADLINE_S, MAX_COMMAND_LENGTH, READINESS_ID, TAIL_BYTES } from './limits.ts'
export { inject, mountBashSandbox, name } from './plugin.ts'
export { runPreflight } from './preflight.ts'
export type { PreflightFailure, PreflightResult } from './preflight.ts'
export { resolveWorkdir } from './provision-check.ts'
export { buildRunResult } from './result.ts'
export { runPlan } from './runner.ts'
export type { SandboxRunOutcome } from './runner.ts'
export { cleanStream, escapeStatusLookalikes, sanitizeOutput } from './sanitize.ts'
export { bashDescription, bashSchema, createBashToolFactory } from './tool.ts'

/**
 * Cordis plugin entry: preflight the sandbox and register the readiness contributor and the `bash` tool.
 * Declared here (not re-exported) so the config catalog can classify the package as a plugin.
 * @param ctx - plugin context.
 * @param config - the row's config.
 * @returns when the preflight has run and, if it passed, the registrations are made.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await mountBashSandbox(ctx, config)
}

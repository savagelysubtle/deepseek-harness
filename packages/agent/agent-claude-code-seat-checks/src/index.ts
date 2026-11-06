/**
 * The seat checks of Claude Code coder seats. A cordis plugin that runs the guard boot canary and
 * the clone-check
 * self-test and, when both pass, registers the `canary` and `rules-hooks` readiness entries and the
 * per-query
 * clone hook check through the `claudeCodePolicyRegistries` service. Together with the sandbox
 * entry of the bash
 * package that lifts the coder refusal.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountSeatChecks } from './plugin.ts'
import type { Config } from './config.ts'

export { checkConfigRecords } from './allowlist.ts'
export type { AllowlistViolation, ConfigRecord } from './allowlist.ts'
export { runBootCanary, selfTestCloneChecker } from './canary.ts'
export { assertCloneHookState, createCloneChecker, inspectCloneState } from './clone-state.ts'
export type { AssertCloneHookOptions, CloneChecker, CloneInspectDeps } from './clone-state.ts'
export { Config, resolveSeatChecksConfig, SeatChecksConfigError } from './config.ts'
export type { ResolvedSeatChecksConfig } from './config.ts'
export { fingerprintClone } from './fingerprint.ts'
export type { CloneFs } from './fingerprint.ts'
export { parseConfigRecords, printableName, readGitConfig, realRunGit } from './git-config.ts'
export type { GitRunResult, RunGit } from './git-config.ts'
export { CANARY_ID, SCRUB_REMEDY } from './limits.ts'
export { inject, mountSeatChecks, name } from './plugin.ts'
export type { SeatChecksInternals } from './plugin.ts'

/**
 * Cordis plugin entry: run the boot proofs and register the readiness entries and the clone check.
 * Declared here (not re-exported) so the config catalog can classify the package as a plugin.
 * @param ctx - plugin context.
 * @param config - the row's config.
 * @returns when the proofs have run and, if they passed, the registrations are made.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await mountSeatChecks(ctx, config)
}

/**
 * Permission policy for Claude Code seats: generated deny/allow rules, the path guard, the
 * seat-guard hook logic, the policy file and the readiness and contributor registries.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountPolicyProvider } from './provider.ts'
import type { Config } from './provider.ts'

export { assertAttestedUnchanged, attestFile } from './attest-guard.ts'
export { installGuardCopy } from './guard-copy.ts'
export type { AttestedFile, AttestFileOptions } from './attest-guard.ts'
export {
  BASE_TOOL_TEMPLATE, CODER_NATIVE_TOOLS, ContributorRegistry, MAILBOX_DIRECTORY_TOOL, MAILBOX_SEND_TOOL, MCP_SERVER_NAME,
  MCP_TOOL_PREFIX, mcpToolName,
} from './contributors.ts'
export type { HookContext, HookContributor, PolicyRole, ToolContributor } from './contributors.ts'
export { decide, FILE_TOOLS } from './decide.ts'
export { isSeatName, isSha256, SEAT_NAME_PATTERN, SHA256_PATTERN, TOOL_NAME_PATTERN } from './grammar.ts'
export { MAX_STDIN_BYTES, runGuard } from './guard-core.ts'
export type { GuardDeps, GuardOutcome } from './guard-core.ts'
export { buildHookCommand, ENV_PATH, GUARD_MATCHER, guardHookGroup, guardScriptPath, HOOK_TIMEOUT_SECONDS, shellQuote } from './hook-command.ts'
export { verifyGuardCommand } from './verify-guard.ts'
export type { HookCommandInput, HookGroup } from './hook-command.ts'
export {
  assertCanonicalDir, assertCaseSensitiveEntries, checkGlob, checkPath, globStaticPrefix, isInside, reachesProtected, UnsafePathError,
} from './path-guard.ts'
export type { GuardScope, Verdict } from './path-guard.ts'
export { ensurePolicyDir, serializePolicy, writePolicyFile } from './policy-file.ts'
export type { WrittenPolicyFile } from './policy-file.ts'
export { MAX_POLICY_BYTES, readPolicyFile, SUPPORTED_POLICY_VERSION, validatePolicy } from './policy-read.ts'
export type { PolicyReadResult, ToolsPolicyFile } from './policy-read.ts'
export { CODER_REQUIREMENTS, ReadinessRegistry } from './readiness.ts'
export { readStdinCapped } from './stdin.ts'
export { generateRules } from './rules.ts'
export type { GeneratedRules } from './rules.ts'
export { buildPolicyFile, generateSeatPolicy } from './settings.ts'
export type { PolicyInput, SeatPolicy, SeatPolicyInput } from './settings.ts'
export { createDirectoryTool } from './mcp/directory.ts'
export { createSeatMcpServer } from './mcp/server.ts'
export type { SeatServerInput } from './mcp/server.ts'
export { assertConvertible, DIRECTORY_SCHEMA, MAX_BODY_BYTES, MAX_TRACE_ID_LENGTH, SEND_SCHEMA } from './mcp/schema.ts'
export type { SendInput } from './mcp/schema.ts'
export { createSendTool, MAX_SENDS_PER_TURN } from './mcp/send.ts'
export { MAX_RESULT_LENGTH, REDACTED_PATH, scrubText } from './mcp/scrub.ts'
export type { ScrubOptions } from './mcp/scrub.ts'
export { createLeadTemplate, SeatToolTemplate } from './mcp/template.ts'
export { defineSeatTool, textResult } from './mcp/types.ts'
export type { SeatTool, SeatToolContext, SeatToolFactory, SeatToolResult } from './mcp/types.ts'
export { Config, createClaudeCodePolicy, mountPolicyProvider, name } from './provider.ts'
export type { PolicyOptions, PolicyRegistries } from './provider.ts'

/**
 * Cordis plugin entry: register the `claudeCodePolicy` service. Declared here (not re-exported) so the
 * config catalog can classify the package as a plugin.
 * @param ctx - plugin context.
 * @param config - policy directory and optional home, node and guard paths.
 * @throws when `policyDir` or an explicit path is not absolute.
 */
export function apply(ctx: Context, config: Config): void {
  mountPolicyProvider(ctx, config)
}

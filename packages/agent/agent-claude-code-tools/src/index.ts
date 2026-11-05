/**
 * Permission policy for Claude Code seats: generated deny/allow rules, the path guard, the
 * seat-guard hook logic, the policy file and the readiness and contributor registries.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools
 */

export { assertAttestedUnchanged, attestFile } from './attest-guard.ts'
export type { AttestedFile, AttestFileOptions } from './attest-guard.ts'
export {
  BASE_TOOL_TEMPLATE, CODER_NATIVE_TOOLS, ContributorRegistry, MAILBOX_DIRECTORY_TOOL, MAILBOX_SEND_TOOL, MCP_SERVER_NAME,
  MCP_TOOL_PREFIX, mcpToolName,
} from './contributors.ts'
export type { HookContext, HookContributor, PolicyRole, ToolContributor } from './contributors.ts'
export { decide, FILE_TOOLS } from './decide.ts'
export { isSeatName, isSha256, SEAT_NAME_PATTERN, SHA256_PATTERN, TOOL_NAME_PATTERN } from './grammar.ts'
export { runGuard } from './guard-core.ts'
export type { GuardDeps, GuardOutcome } from './guard-core.ts'
export { buildHookCommand, GUARD_MATCHER, guardHookGroup, HOOK_TIMEOUT_SECONDS, shellQuote } from './hook-command.ts'
export type { HookCommandInput, HookGroup } from './hook-command.ts'
export { assertCanonicalDir, checkGlob, checkPath, isInside, UnsafePathError } from './path-guard.ts'
export type { GuardScope, Verdict } from './path-guard.ts'
export { serializePolicy, writePolicyFile } from './policy-file.ts'
export type { WrittenPolicyFile } from './policy-file.ts'
export { readPolicyFile, SUPPORTED_POLICY_VERSION, validatePolicy } from './policy-read.ts'
export type { PolicyReadResult } from './policy-read.ts'
export { CODER_REQUIREMENTS, ReadinessRegistry } from './readiness.ts'
export { generateRules } from './rules.ts'
export type { GeneratedRules } from './rules.ts'
export { buildPolicyFile, generateSeatPolicy } from './settings.ts'
export type { PolicyInput, SeatPolicy, SeatPolicyInput } from './settings.ts'

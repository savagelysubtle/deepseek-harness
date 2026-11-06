/**
 * Settings generator: from host-private inputs only (the host seat's policy fields, the cwd, the
 * seat name) it produces the inline settings, the allow list, the tool list and the policy file
 * contents for one seat. A registry row is never an input. Only the SHA-256 of the result is meant
 * to be logged.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/settings
 */

import { createHash } from 'node:crypto'
import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import type { ExtensionSettings, PolicyHostSeatFields } from '@deepseek-ai/dsh-agent-claude-code-driver'
import type { AttestedFile } from './attest-guard.ts'
import { CODER_NATIVE_TOOLS, mcpToolName } from './contributors.ts'
import type { ContributorRegistry, PolicyRole } from './contributors.ts'
import { buildHookCommand, guardHookGroup } from './hook-command.ts'
import type { HookGroup } from './hook-command.ts'
import { writePolicyFile } from './policy-file.ts'
import type { ToolsPolicyFile } from './policy-read.ts'
import { generateRules } from './rules.ts'
import type { GeneratedRules } from './rules.ts'

/** Inputs of {@link buildPolicyFile}. */
export interface PolicyInput {
  /** The seat's bare name. */
  readonly seat: string
  /** The seat's role. */
  readonly role: PolicyRole
  /** The seat's working directory (canonical). */
  readonly cwd: string
  /** The operator's home directory (canonical). */
  readonly home: string
  /** Host-private policy fields of the seat. */
  readonly host: PolicyHostSeatFields
  /** Tool and hook contributors. */
  readonly contributors: ContributorRegistry
  /**
   * Set to false to let Grep and Glob search directories that contain protected locations. Default
   * (absent) is true: such a search is denied. Only a live probe showing the tools skip hidden
   * directories justifies turning it off.
   */
  readonly denyDirsContainingProtected?: boolean
}

/** Inputs of {@link generateSeatPolicy}. */
export interface SeatPolicyInput extends PolicyInput {
  /** Directory the policy file is written into. */
  readonly policyDir: string
  /** The attested node binary the hook runs under. */
  readonly node: AttestedFile
  /** The attested guard script; the built `lib/seat-guard.js` (see `guardScriptPath`). */
  readonly guard: AttestedFile
  /** Allow a `.ts` guard source (in-workspace tests only; it cannot run from an installed package). */
  readonly allowSourceGuard?: boolean
}

/** Everything one seat's query needs from the policy. */
export interface SeatPolicy {
  /** Inline settings: the guard hook (plus contributors') and `permissions.deny`. */
  readonly settings: ExtensionSettings
  /** Allow entries: `mcp__dsh__<name>` for each tool and, for a coder, `Read`/`Edit` limited to the cwd. */
  readonly allow: string[]
  /** Native tools to disallow outright. */
  readonly disallowedTools: string[]
  /** The exact tool list the query is given. */
  readonly tools: string[]
  /** Query fences a coder-shaped policy asks for. */
  readonly fences: { readonly permissionMode: 'dontAsk'; readonly settingSources: []; readonly strictMcpConfig: true }
  /** The policy file that was written. */
  readonly policyPath: string
  /** SHA-256 of the policy file bytes. */
  readonly policySha256: string
  /** SHA-256 of the canonical JSON of settings, allow, disallowedTools and tools: the only thing to log. */
  readonly settingsSha256: string
}

/**
 * Resolve the dsh tools a seat gets: the role template, cut down to what the host seat lists.
 * @param input - the policy inputs.
 * @returns bare dsh tool names; names the host lists but the template lacks are ignored.
 */
function resolveDshTools(input: PolicyInput): string[] {
  const listed = new Set(input.host.tools ?? [])
  return input.contributors.templateTools(input.role).filter(name => listed.has(name))
}

/**
 * Build the policy file contents for a seat.
 * @param input - host-private inputs.
 * @param rules - the generated rules (computed from the input when omitted).
 * @returns the policy.
 * @throws {SeatMutedByPolicyError} when the seat is left with no tool at all.
 * @throws {UnsafePathError} when the cwd or home cannot be used in rules.
 */
export function buildPolicyFile(
  input: PolicyInput,
  rules: GeneratedRules = generateRules(input.role, input.cwd, input.home),
): ToolsPolicyFile {
  const dsh = resolveDshTools(input).map(mcpToolName)
  const tools = [...input.role === 'coder' ? CODER_NATIVE_TOOLS : [], ...dsh]
  if (tools.length === 0) throw new SeatMutedByPolicyError(input.seat, 'the host entry lists no tool that the role template offers')
  return {
    v: 1,
    seat: input.seat,
    role: input.role,
    cwd: input.cwd,
    allowedRoots: rules.allowedRoots,
    deniedPrefixes: rules.deniedPrefixes,
    tools,
    ...input.denyDirsContainingProtected === false ? { denyDirsContainingProtected: false } : {},
  }
}

/**
 * Generate and persist the whole policy for one seat: write the policy file atomically, then build
 * the settings that point the guard hook at it.
 * @param input - host-private inputs, the attested hook files and the policy directory.
 * @returns the settings, allow list, tools and hashes.
 * @throws on an unusable cwd or home, a muted seat, an invalid hook value or a failed write.
 */
export function generateSeatPolicy(input: SeatPolicyInput): SeatPolicy {
  const rules = generateRules(input.role, input.cwd, input.home)
  const policy = buildPolicyFile(input, rules)
  const written = writePolicyFile(input.policyDir, policy)
  const command = buildHookCommand({
    nodePath: input.node.realPath,
    guardPath: input.guard.realPath,
    policyPath: written.path,
    sha256: written.sha256,
    seat: input.seat,
    allowSourceGuard: input.allowSourceGuard === true,
  })
  const extra = input.contributors.extraHookGroups({ seat: input.seat, role: input.role })
  const hooks: Record<string, readonly HookGroup[]> = { ...extra, PreToolUse: [guardHookGroup(command), ...extra['PreToolUse'] ?? []] }
  const settings: ExtensionSettings = { hooks, permissions: { deny: rules.deny } }
  const allow = [...rules.allow, ...policy.tools.filter(name => name.startsWith('mcp__'))]
  const disallowedTools = ['Bash']
  const settingsSha256 = createHash('sha256').update(JSON.stringify({ settings, allow, disallowedTools, tools: policy.tools })).digest('hex')
  return {
    settings,
    allow,
    disallowedTools,
    tools: [...policy.tools],
    fences: { permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true },
    policyPath: written.path,
    policySha256: written.sha256,
    settingsSha256,
  }
}

/**
 * Seat-row configuration for the Claude Code driver: schema, semantic
 * validation (the fable-model fence), and the per-role tool allowlists.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/seat-config
 */

import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** The registry `driver` value that selects this package's factory. */
export const CLAUDE_CODE_DRIVER_KEY = 'claude-code'

/** What a seat may do: `coder` edits files; `lead` and `mail-only` use dsh MCP tools only. */
export type ClaudeCodeRole = 'coder' | 'lead' | 'mail-only'

/** Every accepted {@link ClaudeCodeRole}. */
export const CLAUDE_CODE_ROLES: readonly ClaudeCodeRole[] = ['coder', 'lead', 'mail-only']

/** Reasoning effort levels the SDK accepts. */
export type ClaudeCodeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Every accepted {@link ClaudeCodeEffort}. */
export const CLAUDE_CODE_EFFORTS: readonly ClaudeCodeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The `claude_code` block of a seat registry row, as written in config. */
export interface ClaudeCodeSeatBlock {
  /** Model alias (`opus`, `sonnet`, `haiku`) or full id. */
  model: string
  /** Optional reasoning effort. */
  effort?: ClaudeCodeEffort
  /** Tool surface of the seat. */
  role: ClaudeCodeRole
  /** Hard cap on agentic turns for one query. */
  max_turns: number
  /** Absolute path of the real `claude` binary; never resolved through PATH. */
  claude_path: string
  /** Per-seat query cap per subscription window (enforced by a later slice). */
  max_calls_per_window?: number
}

/** One seat row as the registry writes it. */
export interface ClaudeCodeSeatRow {
  /** Always `claude-code`. */
  driver: typeof CLAUDE_CODE_DRIVER_KEY
  /** The Claude Code settings block: model, effort, role, turn cap, pinned binary path. */
  claude_code: ClaudeCodeSeatBlock
  /** Founder-only opt-in that lets a fable model id through the validator. */
  fable_ok?: boolean
}

/** Schema of {@link ClaudeCodeSeatBlock}. */
export const ClaudeCodeSeatBlock: z<ClaudeCodeSeatBlock> = z.object({
  model: z.string().required(),
  effort: z.union(CLAUDE_CODE_EFFORTS.map(level => z.const(level))),
  role: z.union(CLAUDE_CODE_ROLES.map(role => z.const(role))).required(),
  max_turns: z.number().step(1).min(1).required(),
  claude_path: z.string().required(),
  max_calls_per_window: z.number().step(1).min(1),
})

/** Schema of {@link ClaudeCodeSeatRow}. */
export const ClaudeCodeSeatRow: z<ClaudeCodeSeatRow> = z.object({
  driver: z.const(CLAUDE_CODE_DRIVER_KEY).required(),
  claude_code: ClaudeCodeSeatBlock.required(),
  fable_ok: z.boolean().default(false),
})

/** A validated seat configuration in camelCase. */
export interface ClaudeCodeSeatConfig {
  readonly model: string
  readonly effort?: ClaudeCodeEffort
  readonly role: ClaudeCodeRole
  readonly maxTurns: number
  readonly claudePath: string
  readonly maxCallsPerWindow?: number
}

/**
 * Whether a model id names a fable model after Unicode compatibility folding.
 * Format characters (zero-width joiners and the like) are dropped first so a
 * hidden character cannot split the word.
 * @param model - the configured model id.
 * @returns true when the folded id contains `fable`.
 */
export function isFableModel(model: string): boolean {
  return model.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase().includes('fable')
}

/**
 * Validate one seat row and return its resolved configuration.
 * @param row - the registry row for the seat.
 * @param seat - seat label used in error messages.
 * @returns the validated configuration.
 * @throws when the driver is wrong, a field is malformed, the binary path is
 *   not absolute, or the model is a fable id without `fable_ok: true`.
 */
export function parseSeatRow(row: ClaudeCodeSeatRow, seat: string): ClaudeCodeSeatConfig {
  const fail = (message: string): never => {
    throw new Error(`agent-claude-code-driver: seat "${seat}": ${message}`)
  }
  if ((row.driver as string) !== CLAUDE_CODE_DRIVER_KEY) fail(`driver must be "${CLAUDE_CODE_DRIVER_KEY}"`)
  // Config rows arrive untyped from YAML, so the block may be absent despite its type.
  const block = row.claude_code as ClaudeCodeSeatBlock | null | undefined
  if (block === undefined || block === null) return fail('claude_code block is required')
  if (typeof block.model !== 'string' || block.model.trim() === '') fail('claude_code.model must be a non-empty string')
  if (isFableModel(block.model) && row.fable_ok !== true) {
    fail(`model "${block.model}" is a fable model; fable seats need an explicit fable_ok: true row (founder only)`)
  }
  if (!CLAUDE_CODE_ROLES.includes(block.role)) {
    fail(`claude_code.role must be one of ${CLAUDE_CODE_ROLES.join(', ')}`)
  }
  if (block.effort !== undefined && !CLAUDE_CODE_EFFORTS.includes(block.effort)) {
    fail(`claude_code.effort must be one of ${CLAUDE_CODE_EFFORTS.join(', ')}`)
  }
  if (!Number.isSafeInteger(block.max_turns) || block.max_turns < 1) {
    fail('claude_code.max_turns must be a positive integer')
  }
  if (typeof block.claude_path !== 'string' || !isAbsolute(block.claude_path) || block.claude_path.includes('\0')) {
    fail('claude_code.claude_path must be an absolute path to the real claude binary (no PATH lookup)')
  }
  if (
    block.max_calls_per_window !== undefined
    && (!Number.isSafeInteger(block.max_calls_per_window) || block.max_calls_per_window < 1)
  ) {
    fail('claude_code.max_calls_per_window must be a positive integer')
  }
  return {
    model: block.model,
    ...block.effort === undefined ? {} : { effort: block.effort },
    role: block.role,
    maxTurns: block.max_turns,
    claudePath: block.claude_path,
    ...block.max_calls_per_window === undefined ? {} : { maxCallsPerWindow: block.max_calls_per_window },
  }
}

/** Native tool surface of one role. */
export interface ClaudeCodeToolPolicy {
  /** The SDK `tools` allowlist (an empty list disables every built-in tool). */
  readonly tools: readonly string[]
  /** The SDK `disallowedTools` list; native Bash is denied for every role. */
  readonly disallowedTools: readonly string[]
}

/** Tools denied for every role: native shell (it goes through the dsh sandbox) and the interactive question tool. */
const ALWAYS_DISALLOWED: readonly string[] = ['Bash', 'AskUserQuestion']

/**
 * The native tool policy of a role.
 * @param role - the seat role.
 * @returns the allowlist and denylist for the SDK options.
 */
export function toolPolicyFor(role: ClaudeCodeRole): ClaudeCodeToolPolicy {
  return {
    tools: role === 'coder' ? ['Read', 'Grep', 'Glob', 'Edit', 'Write'] : [],
    disallowedTools: ALWAYS_DISALLOWED,
  }
}

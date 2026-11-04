/**
 * Seat-row configuration for the Claude Code driver: schema, semantic
 * validation (the fable-model fence), and the per-role tool allowlists.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/seat-config
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
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

/** Default hard cap on agentic turns for one query. */
export const DEFAULT_MAX_TURNS = 25

/** Default notional spend cap in USD for one query (a subscription is not billed per call; this bounds runaway loops). */
export const DEFAULT_MAX_BUDGET_USD = 5

/** Default number of queries a seat may start per call window. */
export const DEFAULT_MAX_CALLS_PER_WINDOW = 120

/** Default call window length: the five-hour subscription window. */
export const DEFAULT_CALL_WINDOW_MS = 5 * 60 * 60 * 1000

/** Shortest call window accepted: a window under a minute would make the per-seat cap meaningless. */
export const MIN_CALL_WINDOW_MS = 60_000

/** The `claude_code` block of a seat registry row, as written in config. */
export interface ClaudeCodeSeatBlock {
  /** Model alias (`opus`, `sonnet`, `haiku`) or a full `claude-(opus|sonnet|haiku)-<version>` id; anything else is refused. */
  model: string
  /** Optional reasoning effort. */
  effort?: ClaudeCodeEffort
  /** Tool surface of the seat. */
  role: ClaudeCodeRole
  /** Hard cap on agentic turns for one query; defaults to 25. */
  max_turns?: number
  /** Notional spend cap in USD for one query; defaults to 5. */
  max_budget_usd?: number
  /** Absolute path of the real `claude` binary; never resolved through PATH. */
  claude_path: string
  /** Per-seat cap on queries started per call window; defaults to 120. Refused turns leave a record. */
  max_calls_per_window?: number
  /** Call window length in milliseconds, at least one minute; defaults to five hours. */
  call_window_ms?: number
  /** Optional SHA-256 (hex) of the pinned binary; an explicit value re-pins the recorded first-seen hash. */
  claude_path_sha256?: string
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
  max_turns: z.number().step(1).min(1).default(DEFAULT_MAX_TURNS),
  max_budget_usd: z.number().min(0.01).default(DEFAULT_MAX_BUDGET_USD),
  claude_path: z.string().required(),
  max_calls_per_window: z.number().step(1).min(1).default(DEFAULT_MAX_CALLS_PER_WINDOW),
  call_window_ms: z.number().step(1).min(MIN_CALL_WINDOW_MS).default(DEFAULT_CALL_WINDOW_MS),
  claude_path_sha256: z.string(),
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
  /** Notional spend cap in USD for one query. */
  readonly maxBudgetUsd: number
  readonly claudePath: string
  /** Queries a seat may start per {@link ClaudeCodeSeatConfig.callWindowMs}. */
  readonly maxCallsPerWindow: number
  /** Length of the call window in milliseconds. */
  readonly callWindowMs: number
  /** Lower-case hex SHA-256 pin of the binary, when the row carries one. */
  readonly claudePathSha256?: string
  /** Whether the row opted into fable models (founder only). */
  readonly fableOk: boolean
}

/**
 * Fold a model id for comparison: Unicode compatibility folding (so
 * full-width letters fold), format characters (zero-width joiners and the
 * like) dropped so a hidden character cannot split a word, then lower case.
 * @param model - the configured model id.
 * @returns the folded id.
 */
export function foldModelId(model: string): string {
  return model.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase()
}

/**
 * Whether a model id names a fable model after folding.
 * @param model - the configured model id.
 * @returns true when the folded id contains `fable`.
 */
export function isFableModel(model: string): boolean {
  return foldModelId(model).includes('fable')
}

/** The accepted model spellings: the three aliases, and full ids of those families. */
const ALLOWED_MODEL = /^(?:opus|sonnet|haiku|claude-(?:opus|sonnet|haiku)-[0-9][0-9-]*)$/

/**
 * Whether a model may run on a seat: an allowlist, not a denylist, so an alias
 * the CLI would resolve to something else (`best`, `default`, `opusplan`,
 * `opus[1m]`) is refused. A fable id passes only for a `fable_ok` row.
 * @param model - the folded model id (see {@link foldModelId}).
 * @param fableOk - whether the row opted into fable models.
 * @returns true when the id may be used.
 */
export function isAllowedModel(model: string, fableOk: boolean): boolean {
  if (model.includes('fable')) return fableOk
  return ALLOWED_MODEL.test(model)
}

/** Options of {@link parseSeatRow}. */
export interface ParseSeatRowOptions {
  /**
   * Whether a permission-policy extension is registered (slice S5).
   * Without one a `coder` row is refused: its edit tools would run with no
   * generated deny entries.
   */
  readonly policyExtension?: boolean
}

/**
 * Validate one seat row and return its resolved configuration.
 * @param row - the registry row for the seat.
 * @param seat - seat label used in error messages.
 * @param options - whether a policy extension is registered.
 * @returns the validated configuration.
 * @throws when the driver is wrong, a field is malformed, the binary path is
 *   not absolute, the model is not on the allowlist (or is a fable id without
 *   `fable_ok: true`), or the role is `coder` and no policy extension exists.
 */
export function parseSeatRow(row: ClaudeCodeSeatRow, seat: string, options: ParseSeatRowOptions = {}): ClaudeCodeSeatConfig {
  const fail = (message: string): never => {
    throw new Error(`agent-claude-code-driver: seat "${seat}": ${message}`)
  }
  if ((row.driver as string) !== CLAUDE_CODE_DRIVER_KEY) fail(`driver must be "${CLAUDE_CODE_DRIVER_KEY}"`)
  // Config rows arrive untyped from YAML, so the block may be absent despite its type.
  const block = row.claude_code as ClaudeCodeSeatBlock | null | undefined
  if (block === undefined || block === null) return fail('claude_code block is required')
  if (typeof block.model !== 'string' || block.model.trim() === '') fail('claude_code.model must be a non-empty string')
  const model = foldModelId(block.model)
  const fableOk = row.fable_ok === true
  if (isFableModel(model) && !fableOk) {
    fail(`model "${block.model}" is a fable model; fable seats need an explicit fable_ok: true row (founder only)`)
  }
  if (!isAllowedModel(model, fableOk)) {
    fail(`model "${block.model}" is not allowed: use opus, sonnet, haiku, or a full claude-(opus|sonnet|haiku)-<version> id (aliases such as best, default, opusplan or opus[1m] resolve elsewhere)`)
  }
  if (!CLAUDE_CODE_ROLES.includes(block.role)) {
    fail(`claude_code.role must be one of ${CLAUDE_CODE_ROLES.join(', ')}`)
  }
  if (block.role === 'coder' && options.policyExtension !== true) {
    fail('role "coder" is refused until the permission-policy extension (slice S5) is registered; use "lead" or "mail-only"')
  }
  if (block.effort !== undefined && !CLAUDE_CODE_EFFORTS.includes(block.effort)) {
    fail(`claude_code.effort must be one of ${CLAUDE_CODE_EFFORTS.join(', ')}`)
  }
  const maxTurns = block.max_turns ?? DEFAULT_MAX_TURNS
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    fail('claude_code.max_turns must be a positive integer')
  }
  const maxBudgetUsd = block.max_budget_usd ?? DEFAULT_MAX_BUDGET_USD
  if (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    fail('claude_code.max_budget_usd must be a positive number')
  }
  const callWindowMs = block.call_window_ms ?? DEFAULT_CALL_WINDOW_MS
  if (!Number.isSafeInteger(callWindowMs) || callWindowMs < MIN_CALL_WINDOW_MS) {
    fail(`claude_code.call_window_ms must be an integer of at least ${MIN_CALL_WINDOW_MS} (one minute)`)
  }
  if (typeof block.claude_path !== 'string' || !isAbsolute(block.claude_path) || block.claude_path.includes('\0')) {
    fail('claude_code.claude_path must be an absolute path to the real claude binary (no PATH lookup)')
  }
  const maxCallsPerWindow = block.max_calls_per_window ?? DEFAULT_MAX_CALLS_PER_WINDOW
  if (!Number.isSafeInteger(maxCallsPerWindow) || maxCallsPerWindow < 1) {
    fail('claude_code.max_calls_per_window must be a positive integer')
  }
  if (block.claude_path_sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(block.claude_path_sha256)) {
    fail('claude_code.claude_path_sha256 must be 64 hexadecimal characters')
  }
  return {
    model,
    ...block.effort === undefined ? {} : { effort: block.effort },
    role: block.role,
    maxTurns,
    maxBudgetUsd,
    claudePath: block.claude_path,
    maxCallsPerWindow,
    callWindowMs,
    ...block.claude_path_sha256 === undefined ? {} : { claudePathSha256: block.claude_path_sha256.toLowerCase() },
    fableOk,
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

/**
 * One host-private seat entry: everything that costs money or widens trust for a registry-routed seat.
 * The registry row only names the seat's driver and who may mail it; this entry (in the profile, which a
 * seat cannot write) decides the model, caps, binary, working directory and the widest sender list.
 */
export interface ClaudeCodeHostSeat {
  /** Model alias or full id; the same allowlist and fable fence as a static row. */
  model: string
  /** Optional reasoning effort. */
  effort?: ClaudeCodeEffort
  /** Tool surface. Only `mail-only` is accepted until the permission slice (S5) lands; any other role is refused. */
  role: ClaudeCodeRole
  /** Hard cap on agentic turns for one query; defaults to 25. */
  max_turns?: number
  /** Notional spend cap in USD for one query; defaults to 5. */
  max_budget_usd?: number
  /** Per-seat cap on queries started per call window; defaults to 120. */
  max_calls_per_window?: number
  /** Call window length in milliseconds, at least one minute; defaults to five hours. */
  call_window_ms?: number
  /** Absolute path of the real `claude` binary; its realpath must lie under one of `claudePathPrefixes`. */
  claude_path: string
  /** Optional SHA-256 (hex) of the pinned binary; an explicit value re-pins the recorded first-seen hash. */
  claude_path_sha256?: string
  /** Founder-only opt-in that lets a fable model id through the validator. */
  fable_ok?: boolean
  /** The seat's working directory (a realpath). The registry row's `cwd` must equal it. */
  cwd: string
  /** The widest set of senders the registry row's `admit_from` may name: seats the founder attests are not externally exposed. */
  admit_from_ceiling: string[]
  /** Founder-authorised session id for a reseed: the one new id the driver accepts in place of the pinned one. */
  session_id?: string
}

/** Schema of {@link ClaudeCodeHostSeat}. */
export const ClaudeCodeHostSeat: z<ClaudeCodeHostSeat> = z.object({
  model: z.string().required(),
  effort: z.union(CLAUDE_CODE_EFFORTS.map(level => z.const(level))),
  role: z.union(CLAUDE_CODE_ROLES.map(role => z.const(role))).required(),
  max_turns: z.number().step(1).min(1).default(DEFAULT_MAX_TURNS),
  max_budget_usd: z.number().min(0.01).default(DEFAULT_MAX_BUDGET_USD),
  max_calls_per_window: z.number().step(1).min(1).default(DEFAULT_MAX_CALLS_PER_WINDOW),
  call_window_ms: z.number().step(1).min(MIN_CALL_WINDOW_MS).default(DEFAULT_CALL_WINDOW_MS),
  claude_path: z.string().required(),
  claude_path_sha256: z.string(),
  fable_ok: z.boolean().default(false),
  cwd: z.string().required(),
  admit_from_ceiling: z.array(z.string()).default([]),
  session_id: z.string(),
})

/** The part of a registry seat row the host merge reads; the full row type lives in the mailbox package. */
export interface RegistrySeatView {
  /** The row's driver; anything but `claude-code` is refused. */
  readonly driver?: string | undefined
  /** The row's working directory. */
  readonly cwd: string
  /** The sender list the registry writer asked for. */
  readonly admit_from?: readonly string[] | undefined
}

/** Make a host entry look like a static row so the one set of semantic checks runs on it. */
function hostSeatAsRow(host: ClaudeCodeHostSeat): ClaudeCodeSeatRow {
  return {
    driver: CLAUDE_CODE_DRIVER_KEY,
    claude_code: {
      model: host.model,
      ...host.effort === undefined ? {} : { effort: host.effort },
      role: host.role,
      ...host.max_turns === undefined ? {} : { max_turns: host.max_turns },
      ...host.max_budget_usd === undefined ? {} : { max_budget_usd: host.max_budget_usd },
      claude_path: host.claude_path,
      ...host.max_calls_per_window === undefined ? {} : { max_calls_per_window: host.max_calls_per_window },
      ...host.call_window_ms === undefined ? {} : { call_window_ms: host.call_window_ms },
      ...host.claude_path_sha256 === undefined ? {} : { claude_path_sha256: host.claude_path_sha256 },
    },
    ...host.fable_ok === undefined ? {} : { fable_ok: host.fable_ok },
  }
}

/** Whether `target` lies strictly inside `directory`. */
function isInside(directory: string, target: string): boolean {
  const rel = relative(directory, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

/**
 * Validate a host seat entry on its own (no registry row) and return its configuration. Runs the static
 * row's checks (model allowlist, fable fence, limits, absolute binary path), refuses every role but
 * `mail-only`, and requires the binary's realpath to lie under one allowed prefix.
 * @param host - the host entry.
 * @param seat - seat label used in error messages.
 * @param prefixes - the allowed binary directories (`claudePathPrefixes`).
 * @param realpath - symlink resolution; defaults to the filesystem's.
 * @returns the validated configuration.
 * @throws when any check fails.
 */
export function parseHostSeat(
  host: ClaudeCodeHostSeat,
  seat: string,
  prefixes: readonly string[],
  realpath: (path: string) => string = realpathSync.native,
): ClaudeCodeSeatConfig {
  const fail = (message: string): never => {
    throw new Error(`agent-claude-code-driver: seat "${seat}": ${message}`)
  }
  const config = parseSeatRow(hostSeatAsRow(host), seat, { policyExtension: false })
  if (config.role !== 'mail-only') {
    fail(`role "${config.role}" is refused for registry-routed seats until the permission-policy extension (slice S5) is registered; use "mail-only"`)
  }
  if (typeof host.cwd !== 'string' || !isAbsolute(host.cwd) || host.cwd.includes('\0')) {
    fail('host cwd must be an absolute path (the seat\'s realpath)')
  }
  if (prefixes.length === 0) fail('claudePathPrefixes is empty; a host seat needs at least one allowed binary directory')
  let real: string
  try {
    real = realpath(config.claudePath)
  } catch (error: unknown) {
    return fail(`claude_path ${config.claudePath} cannot be resolved (${String((error as NodeJS.ErrnoException).code)})`)
  }
  const allowed = prefixes.some((prefix) => {
    if (isInside(resolve(prefix), real)) return true
    try {
      return isInside(realpath(prefix), real)
    } catch {
      return false
    }
  })
  if (!allowed) fail(`claude_path ${config.claudePath} resolves to ${real}, outside every claudePathPrefixes entry (${prefixes.join(', ')})`)
  return config
}

/**
 * Build a registry-routed seat's configuration from its host entry and its registry row: the host entry
 * decides everything that costs or trusts, and the row may only narrow within it.
 * @param row - the registry row (an untrusted request).
 * @param host - the founder's host entry for the same seat.
 * @param prefixes - the allowed binary directories (`claudePathPrefixes`).
 * @param seat - seat label used in error messages.
 * @param realpath - symlink resolution; defaults to the filesystem's.
 * @returns the validated configuration.
 * @throws when the host entry is invalid, the row's driver is not `claude-code`, the row's `admit_from`
 *   names a sender beyond `admit_from_ceiling`, or the row's `cwd` differs from the host `cwd` pin.
 */
export function mergeHostSeat(
  row: RegistrySeatView,
  host: ClaudeCodeHostSeat,
  prefixes: readonly string[],
  seat: string,
  realpath: (path: string) => string = realpathSync.native,
): ClaudeCodeSeatConfig {
  const config = parseHostSeat(host, seat, prefixes, realpath)
  const fail = (message: string): never => {
    throw new Error(`agent-claude-code-driver: seat "${seat}": ${message}`)
  }
  if (row.driver !== CLAUDE_CODE_DRIVER_KEY) fail(`the registry row's driver is ${JSON.stringify(row.driver ?? 'default')}, not "${CLAUDE_CODE_DRIVER_KEY}"`)
  const beyond = (row.admit_from ?? []).filter(sender => !host.admit_from_ceiling.includes(sender))
  if (beyond.length > 0) {
    fail(`registry admit_from names ${beyond.map(sender => JSON.stringify(sender)).join(', ')} beyond the host admit_from_ceiling [${host.admit_from_ceiling.join(', ')}]; the founder must widen the ceiling in the profile, or the row must drop them`)
  }
  if (row.cwd !== host.cwd) {
    fail(`registry cwd ${JSON.stringify(row.cwd)} differs from the host cwd pin ${JSON.stringify(host.cwd)}; write the absolute pinned path in the row, or ask the founder to change the pin`)
  }
  return config
}

/**
 * The host-config lines a founder adds to authorise a registry-routed seat that has no host entry.
 * @param seat - the seat name.
 * @param row - the registry row, used to prefill the cwd pin and the ceiling.
 * @returns a YAML snippet for the driver row's `hostSeats`.
 */
export function hostSeatStanza(seat: string, row: RegistrySeatView): string {
  const ceiling = (row.admit_from ?? []).map(sender => JSON.stringify(sender)).join(', ')
  return [
    'hostSeats:',
    `  ${JSON.stringify(seat)}:`,
    '    model: haiku',
    '    role: mail-only',
    '    claude_path: /absolute/path/to/claude   # verify the path and its sha256 yourself',
    `    cwd: ${JSON.stringify(row.cwd)}`,
    '    # Listing a seat in admit_from_ceiling attests it is not externally exposed: check every name, do not paste blindly',
    `    admit_from_ceiling: [${ceiling}]`,
  ].join('\n')
}

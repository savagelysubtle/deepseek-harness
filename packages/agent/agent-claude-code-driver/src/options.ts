/**
 * The SDK `query()` options every seat uses. The fences (no inherited user
 * settings, strict MCP, dontAsk, an explicit tool allowlist, a turn cap, the
 * pinned binary, the scrubbed environment) are applied last. The optional
 * policy extension may contribute inline `settings` (cut down to hooks and
 * permission deny/ask entries), one in-process `dsh` MCP server, and `allow`
 * entries that pass a strict grammar; anything else refuses the whole extension,
 * so it can never loosen a fence.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/options
 */

import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance, Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { forbiddenEnvPresent } from './env.ts'
import type { PolicyExtension, PolicyQueryContext } from './policy-contract.ts'
import type { ClaudeCodeSeatConfig } from './seat-config.ts'
import { isAllowedModel, toolPolicyFor } from './seat-config.ts'

/** How the query binds to its Claude session: first query pins a new id, later ones resume. */
export type QueryBinding =
  | { readonly kind: 'first'; readonly sdkSessionId: string }
  | { readonly kind: 'resume'; readonly sdkSessionId: string }

/** What the policy extension may see about the query being built, plus the live taint controls. */
export type QueryOptionsContext = PolicyQueryContext

/** The live taint and delivery state of the seat, handed to the policy extension through its context. */
export interface QueryTaintControls {
  /** Whether the session (or this turn) has taken in untrusted content. */
  isTurnTainted(): boolean
  /** Mark the session tainted; the driver logs the reason. */
  markTurnTainted(reason: string): void
  /** Trace ids of mail already delivered to this seat, rebuilt from its log. */
  deliveredTraceIds(): ReadonlySet<string>
}

/** Controls for a caller that has no live seat: never tainted, nothing delivered. */
const NO_TAINT_CONTROLS: QueryTaintControls = {
  isTurnTainted: () => false,
  markTurnTainted: () => undefined,
  deliveredTraceIds: () => new Set<string>(),
}

/**
 * The only inline settings an extension may contribute: lifecycle hooks and
 * permission deny/ask entries. Anything else it returns is stripped and logged.
 */
export interface ExtensionSettings {
  /** Hook definitions keyed by event name. */
  readonly hooks?: Readonly<Record<string, unknown>>
  readonly permissions?: {
    /** Permission entries that are always denied. */
    readonly deny?: readonly string[]
    /** Permission entries that always ask (and, under dontAsk, are denied). */
    readonly ask?: readonly string[]
  }
}

/**
 * Extension point for the permission-policy slice (S5): returns the policy's
 * contribution to one query. Objects only (never a path or JSON string); settings
 * are cut down to {@link ExtensionSettings}, `mcpServers` must be exactly one
 * in-process `dsh` server, `allow` must pass a strict grammar. It is applied
 * BEFORE the fixed fences, so it cannot change tools, permission mode, setting
 * sources, MCP strictness, the executable, the model, or the environment.
 */
export type QueryOptionsExtension = (context: QueryOptionsContext) => PolicyExtension

/** Inputs of {@link buildQueryOptions}. */
export interface BuildQueryOptionsInput {
  readonly seat: string
  readonly config: ClaudeCodeSeatConfig
  readonly cwd: string
  readonly binding: QueryBinding
  readonly env: Record<string, string>
  readonly abortController: AbortController
  readonly spawn: (options: SpawnOptions) => SpawnedProcess
  readonly extension?: QueryOptionsExtension | undefined
  /** Live taint and delivery state offered to the extension; defaults to never tainted, nothing delivered. */
  readonly controls?: QueryTaintControls | undefined
  /**
   * A throwaway query (tainted mail): the tool list is forced empty, nothing is persisted, and the
   * binding must be a fresh `first` id that is never written to the seat's log.
   */
  readonly throwaway?: boolean | undefined
  /** The attested real path of the binary to run; defaults to the configured `claude_path`. */
  readonly executable?: string | undefined
  /** Receives one line per stripped settings key. */
  readonly warn?: ((message: string) => void) | undefined
}

/** Whether a value is a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The string entries of a list; a non-list or a list with a non-string is dropped whole. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string') ? [...value] : undefined
}

const HOOK_EVENT_NAMES: ReadonlySet<string> = new Set(HOOK_EVENTS)

/**
 * Validate an extension's hook map: known event names only, and every handler
 * a `{type: 'command', command: string, timeout?: number}` entry. `prompt`,
 * `agent` and `http` handlers make model calls or send tool input off the
 * machine, so anything else, or any extra key, refuses the whole settings
 * object: a partially applied policy is worse than none.
 * @param hooks - the extension's `hooks` object.
 * @param seat - seat label for the error.
 * @returns a rebuilt copy of the validated hooks (never the input object).
 * @throws when any event or handler is outside the allowed shape.
 */
function validatedHooks(hooks: Record<string, unknown>, seat: string): Record<string, unknown> {
  const refuse = (why: string): never => {
    throw new Error(`agent-claude-code-driver: seat "${seat}": policy extension hooks refused (${why}); refusing to apply a partial policy`)
  }
  const out: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!HOOK_EVENT_NAMES.has(event)) refuse(`unknown hook event "${event}"`)
    if (!Array.isArray(groups)) refuse(`${event} must be a list`)
    out[event] = (groups as unknown[]).map((group) => {
      if (!isRecord(group)) return refuse(`${event} entries must be {matcher?: string, hooks: [...]}`)
      // Each property is read exactly once into a local, and the result is rebuilt from the validated
      // locals, so a getter, a Proxy or a later mutation of the input cannot change what is returned.
      const keys = Object.keys(group)
      const matcher = group['matcher']
      const handlers = group['hooks']
      if (!Array.isArray(handlers) || !keys.every(key => key === 'matcher' || key === 'hooks') || (matcher !== undefined && typeof matcher !== 'string')) {
        return refuse(`${event} entries must be {matcher?: string, hooks: [...]}`)
      }
      return {
        ...matcher === undefined ? {} : { matcher },
        hooks: (handlers as unknown[]).map((handler) => {
          if (!isRecord(handler)) return refuse(`${event} handlers must be {type: "command", command: string}`)
          const handlerKeys = Object.keys(handler)
          const { type, command, timeout } = handler as { type: unknown; command: unknown; timeout: unknown }
          if (type !== 'command' || typeof command !== 'string') {
            return refuse(`${event} handlers must be {type: "command", command: string}; prompt, agent, http and other types are not allowed`)
          }
          const extra = handlerKeys.find(key => key !== 'type' && key !== 'command' && key !== 'timeout')
          if (extra !== undefined) return refuse(`${event} handler carries "${extra}"`)
          if (timeout !== undefined && typeof timeout !== 'number') return refuse(`${event} handler timeout must be a number`)
          return { type: 'command', command, ...timeout === undefined ? {} : { timeout } }
        }),
      }
    })
  }
  return out
}

/**
 * Cut an extension's settings down to the allowlist: `hooks`,
 * `permissions.deny`, `permissions.ask`. A string (a file path or JSON text the
 * CLI would read) or any other shape is dropped entirely. Every dropped key is
 * reported.
 * @param raw - whatever the extension returned.
 * @param seat - seat label for the report.
 * @param warn - receives one line per stripped key.
 * @returns the settings object to pass to the SDK, or `undefined` when nothing survives.
 * @throws when the hooks contain an unknown event or any handler that is not a plain command.
 */
export function allowlistSettings(raw: unknown, seat: string, warn: (message: string) => void): Options['settings'] {
  const stripped = (what: string): void => {
    warn(`agent-claude-code-driver: seat "${seat}": policy extension settings key "${what}" is not allowed and was stripped`)
  }
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    stripped(typeof raw === 'string' ? '<string settings (path or JSON)>' : '<non-object settings>')
    return undefined
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'hooks' && isRecord(value)) out['hooks'] = validatedHooks(value, seat)
    else if (key === 'permissions' && isRecord(value)) {
      const permissions: Record<string, string[]> = {}
      for (const [rule, entries] of Object.entries(value)) {
        const list = stringList(entries)
        if ((rule === 'deny' || rule === 'ask') && list !== undefined) permissions[rule] = list
        else stripped(`permissions.${rule}`)
      }
      if (Object.keys(permissions).length > 0) out['permissions'] = permissions
    } else stripped(key)
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** An `allow` entry naming a tool of the seat's in-process dsh server. */
const DSH_ALLOW_ENTRY = /^mcp__dsh__[a-z][a-z0-9_]{0,63}$/

/** Prefix every dsh server tool name carries. */
const DSH_TOOL_PREFIX = 'mcp__dsh__'

/**
 * A working directory the path grammar can state unambiguously: an allowlist of ASCII letters, digits and
 * `. _ / @ + -` only, so no shell, glob, quote, separator, whitespace, control or non-ASCII character.
 */
const SAFE_CWD = /^\/[A-Za-z0-9._/@+-]+$/

/** Cut a refused value down for an error message. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : typeof value
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text)
}

/**
 * Validate an extension's `allow` list against the strict grammar: `mcp__dsh__<name>`, `Read(//<cwd>/**)`, and
 * `Edit(//<cwd>/**)` for a coder only, where `//` marks an absolute path and `<cwd>` is the seat's own working
 * directory. Anything else (a bare tool, `Bash(...)`, a wildcard, another path, another role's entry) refuses the
 * whole list: a partially applied allow list is worse than none.
 * @param raw - the extension's `allow` value.
 * @param seat - seat label for the error.
 * @param role - the seat's role.
 * @param cwd - the seat's working directory (a realpath).
 * @param hasServer - whether the extension also supplied the `dsh` server.
 * @returns a rebuilt copy of the validated entries, in order, without duplicates.
 * @throws when the value is not a list of exactly-allowed strings.
 */
function validatedAllow(raw: unknown, seat: string, role: ClaudeCodeSeatConfig['role'], cwd: string, hasServer: boolean): string[] {
  const refuse = (why: string): never => {
    throw new Error(`agent-claude-code-driver: seat "${seat}": policy extension allow list refused (${why}); refusing to apply a partial policy`)
  }
  if (!Array.isArray(raw)) return refuse('allow must be a list of strings')
  const entries = [...raw as unknown[]]
  const pattern = pathPattern(cwd)
  const out = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'string') return refuse(`entry ${shown(entry)} is not a string`)
    if (DSH_ALLOW_ENTRY.test(entry)) {
      if (!hasServer) refuse(`${shown(entry)} names a dsh tool but no dsh server was supplied`)
    } else if (pattern !== undefined && (entry === `Read(${pattern})` || entry === `Edit(${pattern})`)) {
      if (entry.startsWith('Edit') && role !== 'coder') refuse(`${shown(entry)}: only a coder may edit`)
    } else refuse(`entry ${shown(entry)} is outside the grammar (mcp__dsh__<name>, Read(//<cwd>/**), Edit(//<cwd>/**))`)
    out.add(entry)
  }
  return [...out]
}

/** The path pattern for a working directory, or `undefined` when it cannot be stated unambiguously (then no path entry is accepted). */
function pathPattern(cwd: string): string | undefined {
  return SAFE_CWD.test(cwd) && !cwd.endsWith('/') ? `//${cwd.slice(1)}/**` : undefined
}

/**
 * Validate an extension's `mcpServers`: exactly one key, `dsh`, holding an in-process (`sdk`) server named `dsh`.
 * A stdio, http or sse server would spawn a process or reach the network, so it refuses the whole extension.
 * @param raw - the extension's `mcpServers` value.
 * @param seat - seat label for the error.
 * @returns a rebuilt single-server map, or `undefined` when none was supplied.
 * @throws when anything but the one `dsh` sdk server is present.
 */
function validatedServers(raw: unknown, seat: string): Record<'dsh', McpSdkServerConfigWithInstance> | undefined {
  if (raw === undefined) return undefined
  const refuse = (why: string): never => {
    throw new Error(`agent-claude-code-driver: seat "${seat}": policy extension mcpServers refused (${why}); refusing to apply a partial policy`)
  }
  if (!isRecord(raw)) return refuse('mcpServers must be an object')
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'dsh') return refuse('the only server allowed is "dsh"')
  const server = raw['dsh']
  if (!isRecord(server)) return refuse('the dsh server must be an object')
  const { type, name, instance } = server as { type: unknown; name: unknown; instance: unknown }
  if (type !== 'sdk' || name !== 'dsh' || typeof instance !== 'object' || instance === null) {
    return refuse('the dsh server must be an in-process sdk server named "dsh" (no stdio, http or sse)')
  }
  return { dsh: { type: 'sdk', name: 'dsh', instance } as McpSdkServerConfigWithInstance }
}

/**
 * The tool names a query's `system/init` message must report: the native tools plus the allowed dsh tools.
 * @param options - the options built for the query.
 * @returns the expected names, without duplicates.
 */
export function expectedInitTools(options: Options): string[] {
  const native = Array.isArray(options.tools) ? options.tools : []
  const settings = options.settings
  const allow = isRecord(settings) && isRecord(settings['permissions']) ? stringList(settings['permissions']['allow']) ?? [] : []
  return [...new Set([...native, ...allow.filter(entry => entry.startsWith(DSH_TOOL_PREFIX))])]
}

/**
 * Compare the tool list a `system/init` message reports with the expected set.
 * @param expected - the names {@link expectedInitTools} gave.
 * @param reported - the init message's `tools` value (anything; a non-list never matches).
 * @returns a one-line description of the difference, or `undefined` when the sets are equal.
 */
export function toolSetMismatch(expected: readonly string[], reported: unknown): string | undefined {
  const names = stringList(reported)
  if (names === undefined) return 'the init message did not report a tool list'
  const have = new Set(names)
  const want = new Set(expected)
  const extra = names.filter(name => !want.has(name))
  const missing = expected.filter(name => !have.has(name))
  if (extra.length === 0 && missing.length === 0) return undefined
  const list = (items: readonly string[]): string => items.slice(0, 12).map(item => shown(item)).join(', ')
  return `init reported unexpected tools [${list(extra)}] and lacked expected tools [${list(missing)}]`
}

/**
 * Compose the options for one query.
 * @param input - seat identity, binding, environment, cancellation, spawn hook, and extension.
 * @returns the SDK options with every fence applied.
 * @throws when the child environment still carries a forbidden variable or the model is off the allowlist.
 */
export function buildQueryOptions(input: BuildQueryOptionsInput): Options {
  const { config, binding } = input
  const policy = toolPolicyFor(config.role)
  const controls = input.controls ?? NO_TAINT_CONTROLS
  // A throwaway (tainted-mail) query takes no policy extension at all: no hooks, no settings, no servers, nothing but the fences.
  const returned: unknown = input.throwaway === true
    ? {}
    : input.extension?.({
      seat: input.seat,
      role: config.role,
      config,
      cwd: input.cwd,
      binding,
      isTurnTainted: () => controls.isTurnTainted(),
      markTurnTainted: (reason) => { controls.markTurnTainted(reason) },
      deliveredTraceIds: () => controls.deliveredTraceIds(),
    }) ?? {}
  if (!isRecord(returned)) {
    throw new Error(`agent-claude-code-driver: seat "${input.seat}": policy extension returned a non-object; refusing to apply a partial policy`)
  }
  // Each property is read once, so a getter or a later mutation cannot change what is validated and then used.
  const { settings: rawSettings, mcpServers: rawServers, allow: rawAllow } =
    returned as { settings: unknown; mcpServers: unknown; allow: unknown }
  const servers = validatedServers(rawServers, input.seat)
  const allow = rawAllow === undefined ? [] : validatedAllow(rawAllow, input.seat, config.role, input.cwd, servers !== undefined)
  const allowlisted = allowlistSettings(rawSettings, input.seat, input.warn ?? (() => undefined)) as Record<string, unknown> | undefined
  const permissions = {
    ...isRecord(allowlisted?.['permissions']) ? allowlisted['permissions'] : {},
    ...allow.length === 0 ? {} : { allow },
  }
  // Auto-memory is switched off through the inline settings (the SDK `Settings.autoMemoryEnabled` switch), which
  // load whatever `settingSources` says; a throwaway query has no tools to reach a memory directory and takes no settings.
  const settings = input.throwaway === true
    ? undefined
    : { ...allowlisted, ...Object.keys(permissions).length === 0 ? {} : { permissions }, autoMemoryEnabled: false }
  // Re-check after the extension ran: the fences must hold whatever it did.
  const leaked = forbiddenEnvPresent(input.env)
  if (leaked.length > 0) {
    throw new Error(`agent-claude-code-driver: seat "${input.seat}": child environment carries forbidden variable(s) ${leaked.join(', ')}; refusing to start the query`)
  }
  if (!isAllowedModel(config.model, config.fableOk)) {
    throw new Error(`agent-claude-code-driver: seat "${input.seat}": model "${config.model}" is not allowed; refusing to start the query`)
  }
  return {
    ...settings === undefined ? {} : { settings },
    ...servers === undefined ? {} : { mcpServers: servers },
    // Fixed fences: spread last so nothing above can override them.
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'dontAsk',
    tools: input.throwaway === true ? [] : [...policy.tools],
    disallowedTools: [...policy.disallowedTools],
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    model: config.model,
    ...config.effort === undefined ? {} : { effort: config.effort },
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.executable ?? config.claudePath,
    env: input.env,
    abortController: input.abortController,
    persistSession: input.throwaway !== true,
    ...binding.kind === 'first' ? { sessionId: binding.sdkSessionId } : { resume: binding.sdkSessionId },
    spawnClaudeCodeProcess: input.spawn,
  }
}

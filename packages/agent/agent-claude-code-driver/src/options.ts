/**
 * The SDK `query()` options every seat uses. The fences (no inherited user
 * settings, strict MCP, dontAsk, an explicit tool allowlist, a turn cap, the
 * pinned binary, the scrubbed environment) are applied last, and the optional
 * extension hook can only contribute inline `settings` whose content is cut
 * down to hooks and permission deny/ask entries, so it can never loosen a fence.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/options
 */

import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { forbiddenEnvPresent } from './env.ts'
import type { ClaudeCodeSeatConfig } from './seat-config.ts'
import { isAllowedModel, toolPolicyFor } from './seat-config.ts'

/** How the query binds to its Claude session: first query pins a new id, later ones resume. */
export type QueryBinding =
  | { readonly kind: 'first'; readonly sdkSessionId: string }
  | { readonly kind: 'resume'; readonly sdkSessionId: string }

/** What the extension hook may see about the query being built. */
export interface QueryOptionsContext {
  readonly seat: string
  readonly config: ClaudeCodeSeatConfig
  readonly cwd: string
  readonly binding: QueryBinding
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
 * Extension point for the permission-policy and git-fence slice (S5): returns
 * inline settings for one query. It is an object only (never a path or JSON
 * string), is cut down to {@link ExtensionSettings}, and is applied BEFORE
 * the fixed fences, so it cannot change tools, permission mode, setting
 * sources, MCP strictness, the executable, the model, or the environment.
 */
export type QueryOptionsExtension = (context: QueryOptionsContext) => { readonly settings?: ExtensionSettings }

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

/**
 * Compose the options for one query.
 * @param input - seat identity, binding, environment, cancellation, spawn hook, and extension.
 * @returns the SDK options with every fence applied.
 * @throws when the child environment still carries a forbidden variable or the model is off the allowlist.
 */
export function buildQueryOptions(input: BuildQueryOptionsInput): Options {
  const { config, binding } = input
  const policy = toolPolicyFor(config.role)
  const extension = input.extension?.({ seat: input.seat, config, cwd: input.cwd, binding }) ?? {}
  const settings = allowlistSettings(extension.settings, input.seat, input.warn ?? (() => undefined))
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
    // Fixed fences: spread last so nothing above can override them.
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'dontAsk',
    tools: [...policy.tools],
    disallowedTools: [...policy.disallowedTools],
    maxTurns: config.maxTurns,
    model: config.model,
    ...config.effort === undefined ? {} : { effort: config.effort },
    cwd: input.cwd,
    pathToClaudeCodeExecutable: input.executable ?? config.claudePath,
    env: input.env,
    abortController: input.abortController,
    persistSession: true,
    ...binding.kind === 'first' ? { sessionId: binding.sdkSessionId } : { resume: binding.sdkSessionId },
    spawnClaudeCodeProcess: input.spawn,
  }
}

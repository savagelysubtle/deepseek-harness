/**
 * The SDK `query()` options every seat uses. The fences (no inherited user
 * settings, strict MCP, dontAsk, an explicit tool allowlist, a turn cap, the
 * pinned binary, the scrubbed environment) are applied last, and the optional
 * extension hook can only contribute inline `settings` whose content is cut
 * down to hooks and permission deny/ask entries, so it can never loosen a fence.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/options
 */

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

/**
 * Cut an extension's settings down to the allowlist: `hooks`,
 * `permissions.deny`, `permissions.ask`. A string (a file path or JSON text the
 * CLI would read) or any other shape is dropped entirely. Every dropped key is
 * reported.
 * @param raw - whatever the extension returned.
 * @param seat - seat label for the report.
 * @param warn - receives one line per stripped key.
 * @returns the settings object to pass to the SDK, or `undefined` when nothing survives.
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
    if (key === 'hooks' && isRecord(value)) out['hooks'] = value
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
    pathToClaudeCodeExecutable: config.claudePath,
    env: input.env,
    abortController: input.abortController,
    persistSession: true,
    ...binding.kind === 'first' ? { sessionId: binding.sdkSessionId } : { resume: binding.sdkSessionId },
    spawnClaudeCodeProcess: input.spawn,
  }
}

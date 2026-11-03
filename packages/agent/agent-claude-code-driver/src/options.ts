/**
 * The SDK `query()` options every seat uses. The fences (no inherited user
 * settings, strict MCP, dontAsk, an explicit tool allowlist, a turn cap, the
 * pinned binary, the scrubbed environment) are applied last, so the optional
 * extension hook can add inline `settings` but can never loosen a fence.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/options
 */

import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeCodeSeatConfig } from './seat-config.ts'
import { toolPolicyFor } from './seat-config.ts'

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
 * Extension point for the rules and git-fence slice (S5): returns inline
 * settings (hooks and permission rules) for one query. It is applied BEFORE
 * the fixed fences, so it cannot change tools, permission mode, setting
 * sources, MCP strictness, the executable, or the environment.
 */
export type QueryOptionsExtension = (context: QueryOptionsContext) => { readonly settings?: Options['settings'] }

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
}

/**
 * Compose the options for one query.
 * @param input - seat identity, binding, environment, cancellation, spawn hook, and extension.
 * @returns the SDK options with every fence applied.
 */
export function buildQueryOptions(input: BuildQueryOptionsInput): Options {
  const { config, binding } = input
  const policy = toolPolicyFor(config.role)
  const extension = input.extension?.({ seat: input.seat, config, cwd: input.cwd, binding }) ?? {}
  return {
    ...extension.settings === undefined ? {} : { settings: extension.settings },
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

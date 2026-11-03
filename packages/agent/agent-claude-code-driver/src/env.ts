/**
 * Child-environment construction and the host-environment preflight: the
 * seat runs under the operator's own login, so API-key and token overrides
 * must never reach it and must not exist in the host at all.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/env
 */

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/**
 * Variables that would redirect the child off the operator's subscription
 * login or change which model it runs. Names confirmed in the SDK 0.3.263
 * bundle (`sdk.mjs`): the credential overrides, `ANTHROPIC_MODEL` and
 * `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_CUSTOM_HEADERS`,
 * `CLAUDE_CONFIG_DIR` (a different login directory), and the provider
 * switches `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_MANTLE`, `_GATEWAY`.
 * The per-tier remaps `ANTHROPIC_DEFAULT_*_MODEL` are matched by
 * {@link FORBIDDEN_ENV_PATTERN}.
 */
export const CLAUDE_CODE_FORBIDDEN_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
]

/** Per-tier model remaps (`ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_`, `_HAIKU_`, `_FABLE_`, and any future tier). */
const FORBIDDEN_ENV_PATTERN = /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/

/** Whether an environment variable name is on the forbidden list. */
function isForbiddenName(name: string): boolean {
  const upper = name.toUpperCase()
  return CLAUDE_CODE_FORBIDDEN_ENV.includes(upper) || FORBIDDEN_ENV_PATTERN.test(upper)
}

/**
 * The forbidden variable names present in an environment (case-insensitive).
 * @param env - environment to inspect; defaults to the host environment.
 * @returns the offending names as they appear in `env`.
 */
export function forbiddenEnvPresent(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter(key => isForbiddenName(key) && env[key] !== undefined)
}

/**
 * Startup preflight: refuse to run when the host carries an override that
 * would send the seat's traffic anywhere but the operator's own login.
 * @param env - environment to inspect; defaults to the host environment.
 * @throws when any forbidden variable is set, naming each and the remedy.
 */
export function assertCleanHostEnv(env: NodeJS.ProcessEnv = process.env): void {
  const present = forbiddenEnvPresent(env)
  if (present.length === 0) return
  throw new Error(
    `agent-claude-code-driver: refusing to run: ${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set in the host environment. `
    + 'Claude Code seats run under the operator\'s own subscription login only; unset them and restart the host.',
  )
}

/**
 * The child environment: the credential-scrubbed parent environment minus
 * every {@link CLAUDE_CODE_FORBIDDEN_ENV} name.
 * @param base - parent environment to start from; defaults to the scrubbed host environment.
 * @returns a fresh environment object for the SDK `env` option.
 */
export function buildChildEnv(base: Record<string, string> = scrubbedParentEnv()): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (!isForbiddenName(key)) env[key] = value
  }
  return env
}

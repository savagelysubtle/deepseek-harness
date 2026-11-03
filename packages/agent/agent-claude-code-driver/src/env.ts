/**
 * Child-environment construction and the host-environment preflight: the
 * seat runs under the operator's own login, so API-key and token overrides
 * must never reach it and must not exist in the host at all.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/env
 */

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Variables that would redirect the child off the operator's subscription login. */
export const CLAUDE_CODE_FORBIDDEN_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
]

/**
 * The forbidden variable names present in an environment (case-insensitive).
 * @param env - environment to inspect; defaults to the host environment.
 * @returns the offending names as they appear in `env`.
 */
export function forbiddenEnvPresent(env: NodeJS.ProcessEnv = process.env): string[] {
  const wanted = new Set(CLAUDE_CODE_FORBIDDEN_ENV)
  return Object.keys(env).filter(key => wanted.has(key.toUpperCase()) && env[key] !== undefined)
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
  const wanted = new Set(CLAUDE_CODE_FORBIDDEN_ENV)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (!wanted.has(key.toUpperCase())) env[key] = value
  }
  return env
}

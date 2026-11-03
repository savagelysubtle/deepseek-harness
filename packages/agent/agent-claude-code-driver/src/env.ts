/**
 * Child-environment construction and the host-environment preflight: the
 * seat runs under the operator's own login, so API-key and token overrides
 * must never reach it and must not exist in the host at all.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/env
 */

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/**
 * Exact names that are always forbidden: the credential overrides, the model
 * pins, custom headers, the login directory, and the provider switches. The
 * patterns in {@link FORBIDDEN_ENV_PATTERNS} catch every other name of the
 * same families (so a name the SDK adds later is refused too); this list keeps
 * the well-known ones, including `CLAUDE_CONFIG_DIR` which no pattern covers.
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

/**
 * Name families that are denied wholesale (matched case-insensitively):
 * every `ANTHROPIC_*` (credentials, base URLs, models, profiles, identity
 * federation, betas, sockets), every `CLAUDE_CODE_USE_*` (provider switches,
 * including `_ANTHROPIC_AWS` and `_ANTHROPIC_GOOGLE_CLOUD`), every
 * `CLAUDE_CODE_SKIP_*` (skipped auth checks), any `CLAUDE_CODE_*` naming a base
 * URL, OAuth, auth, certificate, proxy or extra-body setting, and any
 * `ANTHROPIC*` / `CLAUDE*` name that looks like a key, token, password or secret.
 */
export const FORBIDDEN_ENV_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/,
  /^CLAUDE_CODE_USE_/,
  /^CLAUDE_CODE_SKIP_/,
  /^CLAUDE_CODE_.*(?:BASE_URL|OAUTH|AUTH|CERT|PROXY|EXTRA_BODY)/,
  /^(?:ANTHROPIC|CLAUDE)[A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET)/,
]

/**
 * Names that match a denied family but are known to be benign, each checked in
 * the SDK 0.3.263 bundle: `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH` and
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL` only switch a local tool implementation,
 * and `CLAUDE_CODE_SKIP_PROMPT_HISTORY` only stops local prompt-history writes.
 * None changes the login, the endpoint, or the model.
 */
export const CLAUDE_CODE_ALLOWED_ENV: readonly string[] = [
  'CLAUDE_CODE_USE_NATIVE_FILE_SEARCH',
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
  'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
]

/** Whether an environment variable name is on the forbidden list (explicit allow wins over the patterns). */
function isForbiddenName(name: string): boolean {
  const upper = name.toUpperCase()
  if (CLAUDE_CODE_ALLOWED_ENV.includes(upper)) return false
  return CLAUDE_CODE_FORBIDDEN_ENV.includes(upper) || FORBIDDEN_ENV_PATTERNS.some(pattern => pattern.test(upper))
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

/**
 * Environment presence check for work sessions. A worktree spawned for a seat
 * is worked in by an agent that calls the DeepSeek API; a missing key fails
 * the spawn before any git or filesystem mutation, with the variable named.
 *
 * @module @deepseek-ai/dsh-worktree/env
 */

/** Variable that must be present in the working environment. */
export const WORK_ENV_VAR = 'DEEPSEEK_API_KEY'

const REQUIRED_WORK_ENV_VARS: readonly string[] = [WORK_ENV_VAR]

/** Outcome of the presence check. */
export type EnvPresence =
  | { readonly present: true }
  | { readonly present: false; readonly missing: readonly string[] }

/**
 * Check the working environment for the variables work inside a worktree
 * needs. Whitespace-only values count as missing: they carry no credential.
 * @param env - environment to check; defaults to `process.env`.
 * @returns the outcome, naming every missing variable when absent.
 */
export function checkEnvPresence(env: NodeJS.ProcessEnv = process.env): EnvPresence {
  const missing = REQUIRED_WORK_ENV_VARS.filter(name => (env[name] ?? '').trim().length === 0)
  return missing.length === 0 ? { present: true } : { present: false, missing }
}

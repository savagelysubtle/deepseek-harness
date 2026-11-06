/**
 * Plugin configuration of the seat checks: the schema the cordis row validates and its resolution into the
 * values the mount needs.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/config
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CANARY_TIMEOUT_MS, GIT_CANDIDATES, LOG_PREFIX } from './limits.ts'

/** Longest canary timeout the config may ask for, in milliseconds. */
export const MAX_CANARY_TIMEOUT_MS = 300_000

/** Deployment configuration of the plugin. */
export interface Config {
  /** Turn the checks off without removing the row: nothing is registered and coder seats stay not-ready. Default true. */
  enabled?: boolean
  /** Absolute path of the git binary; default the first of /usr/bin/git, /usr/local/bin/git that exists. */
  gitPath?: string
  /** Timeout of the guard boot canary in milliseconds. Default 20000, ceiling 300000. */
  canaryTimeoutMs?: number
}

/** Schema of {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  gitPath: z.string(),
  canaryTimeoutMs: z.natural().default(DEFAULT_CANARY_TIMEOUT_MS),
})

/** A configuration value the operator must fix; thrown at mount. */
export class SeatChecksConfigError extends Error {
  override readonly name = 'SeatChecksConfigError'
}

/** The config with every default filled. */
export interface ResolvedSeatChecksConfig {
  /** The git binary, or `undefined` when none was found (the mount then refuses and says so). */
  readonly gitPath: string | undefined
  /** The canary timeout in milliseconds. */
  readonly canaryTimeoutMs: number
}

/**
 * Validate the config and resolve the git path.
 * @param config - the row's config (defaults may be absent).
 * @param exists - whether a path exists (tests inject it).
 * @returns the resolved values.
 * @throws {SeatChecksConfigError} when `gitPath` is not an absolute normalised path or the timeout is out of range.
 */
export function resolveSeatChecksConfig(config: Config, exists: (path: string) => boolean = existsSync): ResolvedSeatChecksConfig {
  const canaryTimeoutMs = config.canaryTimeoutMs ?? DEFAULT_CANARY_TIMEOUT_MS
  if (!Number.isSafeInteger(canaryTimeoutMs) || canaryTimeoutMs < 1 || canaryTimeoutMs > MAX_CANARY_TIMEOUT_MS) {
    throw new SeatChecksConfigError(`${LOG_PREFIX} canaryTimeoutMs must be a whole number of milliseconds between 1 and ${MAX_CANARY_TIMEOUT_MS}`)
  }
  if (config.gitPath !== undefined) {
    if (!isAbsolute(config.gitPath) || resolve(config.gitPath) !== config.gitPath) {
      throw new SeatChecksConfigError(`${LOG_PREFIX} gitPath must be an absolute, normalised path, got ${JSON.stringify(config.gitPath)}`)
    }
    return { gitPath: config.gitPath, canaryTimeoutMs }
  }
  return { gitPath: GIT_CANDIDATES.find(candidate => exists(candidate)), canaryTimeoutMs }
}

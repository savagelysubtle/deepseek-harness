/**
 * Session environment isolation. Given a session's base environment and its
 * allocated port, produce the session env as a fresh object — the port var,
 * an optional session-id var, and session-suffixed values for configured base
 * variables. The parent process env and the caller's base environment are
 * never read from nor written to: this module holds no reference to
 * `process.env` at all.
 * @module @deepseek-ai/dsh-port-allocator
 */

import { assertEnvName, assertTcpPort } from './validate.ts'

/** Raw isolator configuration as a consumer supplies it; validated by {@link resolveEnvIsolatorConfig}. */
export interface EnvIsolatorInput {
  /** Variable receiving the allocated port in every session env (e.g. `PORT`). */
  readonly portVar: string
  /** Variable receiving the session id; required whenever a caller passes one. */
  readonly sessionVar?: string
  /** Base variables whose values are suffixed with the session id for session-scoped state (tmp dirs, cache paths). */
  readonly suffixVars?: readonly string[]
  /** Separator between a base value and the session suffix (e.g. `-`); required when `suffixVars` is non-empty. */
  readonly suffixSeparator?: string
}

/** Validated isolator configuration produced by {@link resolveEnvIsolatorConfig}. */
export interface EnvIsolatorConfig {
  /** Validated port variable name. */
  readonly portVar: string
  /** Validated session variable name, or `undefined` when the consumer stamps no session id. */
  readonly sessionVar: string | undefined
  /** Validated suffix variable names. */
  readonly suffixVars: ReadonlySet<string>
  /** Validated suffix separator, or `undefined` when `suffixVars` is empty. */
  readonly suffixSeparator: string | undefined
}

/**
 * Resolve and validate isolator configuration. This is the module's config
 * boundary: variable names must be POSIX environment names, suffix names must
 * be unique, and a non-empty `suffixVars` requires a non-empty separator. The
 * separator must be non-empty so a suffixed value can never collide with its
 * unsuffixed base.
 *
 * @param input - raw configuration, typically resolved from consumer Config.
 * @returns the validated configuration.
 * @throws when any field is empty, malformed, duplicated, or inconsistent with the others.
 */
export function resolveEnvIsolatorConfig(input: EnvIsolatorInput): EnvIsolatorConfig {
  assertEnvName(input.portVar, 'env isolator', 'portVar')
  if (input.sessionVar !== undefined) {
    assertEnvName(input.sessionVar, 'env isolator', 'sessionVar')
  }
  const suffixVars = new Set<string>()
  for (const name of input.suffixVars ?? []) {
    assertEnvName(name, 'env isolator', 'suffixVars entry')
    if (suffixVars.has(name)) {
      throw new Error(`env isolator: suffixVars entry ${JSON.stringify(name)} is duplicated`)
    }
    suffixVars.add(name)
  }
  let suffixSeparator = input.suffixSeparator
  if (suffixSeparator !== undefined && suffixSeparator.length === 0) {
    throw new Error('env isolator: suffixSeparator must be a non-empty string when present')
  }
  if (suffixVars.size > 0 && suffixSeparator === undefined) {
    throw new Error('env isolator: suffixSeparator is required when suffixVars is non-empty')
  }
  if (suffixVars.size === 0) {
    // A separator with nothing to suffix has no effect; drop it so the
    // validated config only describes behavior this isolator will perform.
    suffixSeparator = undefined
  }
  return { portVar: input.portVar, sessionVar: input.sessionVar, suffixVars, suffixSeparator }
}

/** One session-env request as a consumer supplies it. */
export interface SessionEnvRequest {
  /**
   * The session's base environment (e.g. a filtered snapshot the consumer
   * resolved itself). Copied into the result, never mutated.
   */
  readonly baseEnv: Readonly<Record<string, string>>
  /** The port allocated for this session, e.g. by the port allocator's `allocate()`. */
  readonly port: number
  /** The session id stamped into `sessionVar` and appended to suffixed values. */
  readonly sessionId?: string
}

/**
 * Build isolated per-session environments. One instance holds one validated
 * configuration; {@link EnvIsolator.sessionEnv} is pure with respect to
 * everything the caller owns — it returns a fresh object and mutates neither
 * `process.env` nor the request's `baseEnv`.
 */
export class EnvIsolator {
  private readonly config: EnvIsolatorConfig

  /**
   * Construct an isolator.
   * @param input - raw configuration; validated through {@link resolveEnvIsolatorConfig}.
   * @throws when `input` fails validation.
   */
  constructor(input: EnvIsolatorInput) {
    this.config = resolveEnvIsolatorConfig(input)
  }

  /**
   * Produce one session's environment. The result always carries `portVar`
   * set to the allocated port. When a `sessionId` is supplied, it is stamped
   * into `sessionVar` (configured at construction) and appended after
   * `suffixSeparator` to the base value of every configured suffix variable —
   * a suffix variable absent from `baseEnv` stays absent, because isolation
   * never invents values.
   *
   * @param request - the session's base environment, allocated port, and optional session id.
   * @returns a fresh environment object; the caller owns it.
   * @throws when `port` is not a legal TCP port, `sessionId` is empty or contains a NUL
   *   character, `sessionId` is supplied without a configured `sessionVar`, or `sessionId`
   *   is omitted while suffix variables are configured.
   */
  sessionEnv(request: SessionEnvRequest): Record<string, string> {
    assertTcpPort(request.port, 'env isolator', 'port')
    const session = request.sessionId
    if (session !== undefined && (session.length === 0 || session.includes('\0'))) {
      throw new Error('env isolator: sessionId must be a non-empty string without NUL characters when present')
    }
    const { portVar, sessionVar, suffixVars, suffixSeparator } = this.config
    if (session === undefined && suffixVars.size > 0) {
      throw new Error('env isolator: sessionId is required because suffixVars is configured')
    }
    const result: Record<string, string> = { ...request.baseEnv }
    result[portVar] = String(request.port)
    if (session !== undefined) {
      if (sessionVar === undefined) {
        throw new Error('env isolator: sessionVar must be configured to stamp a sessionId')
      }
      result[sessionVar] = session
      for (const name of suffixVars) {
        const base = request.baseEnv[name]
        if (base !== undefined) {
          result[name] = `${base}${suffixSeparator}${session}`
        }
      }
    }
    return result
  }
}

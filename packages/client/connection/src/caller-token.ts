/**
 * Per-boot caller authentication for the local `/api` gateway. A single
 * random token is minted once per {@link createCallerAuth} call and kept
 * only inside that closure — never in a module global, an environment
 * variable, or persistent storage — so it lives exactly as long as the boot
 * that minted it. Launch codes are the separate secret used to hand the
 * token to a browser: they are stored only as sha256 digests, are single
 * use, and expire. Every entry point fails closed on malformed input and
 * never throws, and no token or code material is ever placed in an error
 * message — rejection is expressed purely by returning `undefined` or
 * `false`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Default lifetime of a minted launch code. A design choice, 10 minutes:
 * long enough to open a browser from a printed URL, short enough that a
 * stale log line is dead.
 */
export const LAUNCH_CODE_TTL_MS = 10 * 60 * 1000

/**
 * Upper bound on concurrently pending launch codes, bounding the memory the
 * digest map can hold. When a mint would push the map past the bound, the
 * oldest pending code (Map insertion order) is evicted first.
 */
export const MAX_PENDING_LAUNCH_CODES = 16

/**
 * Options for {@link createCallerAuth}.
 */
export interface CallerAuthOptions {
  /**
   * Clock used for all expiry decisions, defaulting to `Date.now`;
   * injectable for tests.
   */
  now?: () => number
  /** Launch-code lifetime in ms, defaulting to {@link LAUNCH_CODE_TTL_MS}. */
  launchCodeTtlMs?: number
}

/**
 * The auth surface the `/api` gateway consumes. All methods fail closed and
 * never throw on malformed input; no method reports why a check failed, so
 * no secret material can leak through an error path.
 */
export interface CallerAuth {
  /**
   * Mint a fresh single-use launch code for the browser handshake.
   * @returns the plaintext code, to be delivered out of band (printed URL).
   */
  mintLaunchCode(): string
  /**
   * Exchange a launch code for the per-boot caller token. Single use: the
   * code is consumed even when it turns out to be expired.
   * @param code - the plaintext code as presented; any non-string is rejected.
   * @returns the caller token, or undefined when the code is unknown, already
   * used, malformed, or expired.
   */
  exchange(code: unknown): string | undefined
  /**
   * Verify a presented caller token against this boot's token in constant
   * time.
   * @param token - the presented token; any non-string is rejected.
   * @returns true only for this boot's exact token.
   */
  verify(token: unknown): boolean
}

/**
 * Create the per-boot caller auth. The token is minted immediately from
 * `randomBytes(32)` as base64url and kept, together with its sha256 digest,
 * only in this closure. Pending launch codes are likewise never stored in
 * plaintext: the map holds the sha256 hex digest of a code mapped to its
 * absolute expiry timestamp, so a memory snapshot taken between mint and
 * exchange does not reveal a code that is still live.
 * @param options - optional clock and TTL overrides; injectable for tests.
 * @returns an auth surface bound to this boot's token.
 */
export function createCallerAuth(options: CallerAuthOptions = {}): CallerAuth {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.launchCodeTtlMs ?? LAUNCH_CODE_TTL_MS

  const callerToken = randomBytes(32).toString('base64url')
  const callerTokenDigest = createHash('sha256').update(callerToken, 'utf8').digest()

  // sha256 hex digest of a pending code -> absolute expiry; insertion order = mint order.
  const pending = new Map<string, number>()

  return {
    mintLaunchCode(): string {
      const code = randomBytes(32).toString('base64url')
      const nowMs = now()
      for (const [key, expiry] of pending) {
        if (expiry <= nowMs) pending.delete(key)
      }
      if (pending.size >= MAX_PENDING_LAUNCH_CODES) {
        for (const oldest of pending.keys()) {
          pending.delete(oldest)
          break
        }
      }
      const digest = createHash('sha256').update(code, 'utf8').digest('hex')
      pending.set(digest, nowMs + ttlMs)
      return code
    },
    exchange(code: unknown): string | undefined {
      if (typeof code !== 'string' || code === '' || code.length > 256) return undefined
      const digest = createHash('sha256').update(code, 'utf8').digest('hex')
      const expiry = pending.get(digest)
      pending.delete(digest)
      if (expiry === undefined) return undefined
      if (expiry <= now()) return undefined
      return callerToken
    },
    verify(token: unknown): boolean {
      if (typeof token !== 'string') return false
      return timingSafeEqual(createHash('sha256').update(token, 'utf8').digest(), callerTokenDigest)
    },
  }
}

export { CALLER_TOKEN_HEADER } from './caller-token-header.ts'

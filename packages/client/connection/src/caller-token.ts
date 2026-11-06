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

/**
 * Cookie name carrying the caller token, parameterized by the server port so
 * that two instances on one host do not collide. The port comes from the
 * request's Host header; URL parsing strips the default port, so an empty
 * string means 80.
 * @param port - the Host header port, `''` when it is the default.
 * @returns the cookie name, e.g. `dsh_auth_80`.
 */
export function authCookieName(port: string): string {
  return `dsh_auth_${port === '' ? '80' : port}`
}

/**
 * Read one cookie value out of a raw `Cookie` header. The header is split on
 * `;`, each pair trimmed, then split at the FIRST `=`; the first pair whose
 * name matches exactly wins. Values are returned verbatim with no decoding,
 * which is correct for the base64url token.
 * @param header - the request's `Cookie` header, or null/undefined when absent.
 * @param name - the exact cookie name to find.
 * @returns the first matching value, or undefined for an absent or empty
 * header or when no pair matches.
 */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (header === null || header === undefined || header === '') return undefined
  for (const piece of header.split(';')) {
    const pair = piece.trim()
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator) === name) return pair.slice(separator + 1)
  }
  return undefined
}

/**
 * Serialize the caller-token cookie for a `Set-Cookie` header, with exactly
 * the attributes `HttpOnly; SameSite=Strict; Path=/`, in this order. No
 * `Secure`, because the server is plain HTTP on loopback/LAN; no `Max-Age`,
 * because the cookie is a session cookie that dies with the browser.
 * @param name - cookie name from {@link authCookieName}.
 * @param token - the per-boot caller token to hand to the browser.
 * @returns the full `Set-Cookie` value.
 */
export function authCookieHeader(name: string, token: string): string {
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/`
}

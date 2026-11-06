/** OP-270: the in-memory caller token, single-use launch codes, and the cookie helpers. */
import { describe, expect, it } from 'vitest'
import {
  authCookieHeader, authCookieName, createCallerAuth, LAUNCH_CODE_TTL_MS, MAX_PENDING_LAUNCH_CODES, readCookie,
} from '../src/caller-token.ts'

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('createCallerAuth', () => {
  it('mints codes that exchange once for a 256-bit base64url token that verifies', () => {
    const auth = createCallerAuth()
    const code = auth.mintLaunchCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const token = auth.exchange(code)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(auth.verify(token)).toBe(true)
    expect(token).not.toBe(code)
  })

  it('a code is single use: the replay fails and the token stays valid', () => {
    const auth = createCallerAuth()
    const code = auth.mintLaunchCode()
    const token = auth.exchange(code)
    expect(auth.exchange(code)).toBeUndefined()
    expect(auth.verify(token)).toBe(true)
  })

  it('every code exchanges to the same per-boot token; separate instances have different tokens', () => {
    const a = createCallerAuth()
    const b = createCallerAuth()
    expect(a.exchange(a.mintLaunchCode())).toBe(a.exchange(a.mintLaunchCode()))
    const tokenA = a.exchange(a.mintLaunchCode())
    expect(b.verify(tokenA)).toBe(false)
    expect(b.exchange(a.mintLaunchCode())).toBeUndefined()
  })

  it('a code expires after the injected lifetime, and an expired attempt still consumes it', () => {
    const c = clock()
    const auth = createCallerAuth({ now: c.now })
    const fresh = auth.mintLaunchCode()
    c.advance(LAUNCH_CODE_TTL_MS - 1)
    expect(auth.exchange(fresh)).toBeDefined()
    const stale = auth.mintLaunchCode()
    c.advance(LAUNCH_CODE_TTL_MS)
    expect(auth.exchange(stale)).toBeUndefined()
    expect(auth.exchange(stale)).toBeUndefined()
  })

  it('honours a custom launchCodeTtlMs', () => {
    const c = clock()
    const auth = createCallerAuth({ now: c.now, launchCodeTtlMs: 1000 })
    const code = auth.mintLaunchCode()
    c.advance(1000)
    expect(auth.exchange(code)).toBeUndefined()
  })

  it('verify never throws and refuses anything that is not the token, whatever its length or type', () => {
    const auth = createCallerAuth()
    const token = auth.exchange(auth.mintLaunchCode())!
    for (const bad of [undefined, null, 0, {}, [], '', 'x', token.slice(1), `${token}x`, 'A'.repeat(100_000), token.toUpperCase()]) {
      expect(auth.verify(bad)).toBe(false)
    }
  })

  it('exchange refuses non-string, empty and over-long input without throwing', () => {
    const auth = createCallerAuth()
    for (const bad of [undefined, null, 1, {}, '', 'x'.repeat(257)]) expect(auth.exchange(bad)).toBeUndefined()
  })

  it('bounds pending codes: the oldest is evicted past the cap', () => {
    const auth = createCallerAuth()
    const codes = Array.from({ length: MAX_PENDING_LAUNCH_CODES + 1 }, () => auth.mintLaunchCode())
    expect(auth.exchange(codes[0])).toBeUndefined()
    expect(auth.exchange(codes[MAX_PENDING_LAUNCH_CODES])).toBeDefined()
  })

  it('the token does not appear in its own object or in an environment variable', () => {
    const auth = createCallerAuth()
    const token = auth.exchange(auth.mintLaunchCode())!
    expect(JSON.stringify(auth)).not.toContain(token)
    expect(JSON.stringify(process.env)).not.toContain(token)
  })
})

describe('cookie helpers', () => {
  it('names the cookie after the Host port, treating a stripped default port as 80', () => {
    expect(authCookieName('3080')).toBe('dsh_auth_3080')
    expect(authCookieName('')).toBe('dsh_auth_80')
  })

  it('emits exactly HttpOnly; SameSite=Strict; Path=/', () => {
    expect(authCookieHeader('dsh_auth_3080', 'abc')).toBe('dsh_auth_3080=abc; HttpOnly; SameSite=Strict; Path=/')
  })

  it('reads an exact-name match from a Cookie header and nothing else', () => {
    expect(readCookie('a=1; dsh_auth_3080=tok; b=2', 'dsh_auth_3080')).toBe('tok')
    expect(readCookie('xdsh_auth_3080=bad', 'dsh_auth_3080')).toBeUndefined()
    expect(readCookie('dsh_auth_3081=other', 'dsh_auth_3080')).toBeUndefined()
    expect(readCookie('dsh_auth_3080=a=b', 'dsh_auth_3080')).toBe('a=b')
    expect(readCookie('', 'dsh_auth_3080')).toBeUndefined()
    expect(readCookie(null, 'dsh_auth_3080')).toBeUndefined()
    expect(readCookie(undefined, 'dsh_auth_3080')).toBeUndefined()
    expect(readCookie('dsh_auth_3080', 'dsh_auth_3080')).toBeUndefined()
  })
})

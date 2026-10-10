/**
 * Tests for `captureAuthorizationCode`'s `expectedState` anti-CSRF check
 * (the Host-only addition on top of the CLI's original behavior, which stays
 * covered end to end by `auth-cli.spec.ts`'s unchanged, no-options call
 * site). Isolated file: each test owns its own ephemeral loopback port.
 */
import { describe, expect, it } from 'vitest'
import { captureAuthorizationCode } from '@deepseek-ai/dsh-mcp-client/src/oauth-callback.ts'

let nextPort = 18_600
function freshPort(): number {
  return nextPort++
}

describe('captureAuthorizationCode — expectedState', () => {
  it('omitting expectedState accepts any state (unchanged CLI behavior)', async () => {
    const port = freshPort()
    const capturing = captureAuthorizationCode(port, 5_000)
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=anything`)
    expect(response.ok).toBe(true)
    expect(await capturing).toBe('abc')
  })

  it('accepts a callback whose state matches exactly', async () => {
    const port = freshPort()
    const capturing = captureAuthorizationCode(port, 5_000, { expectedState: 'tok-1' })
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=good-code&state=tok-1`)
    expect(response.ok).toBe(true)
    expect(await capturing).toBe('good-code')
  })

  it('400s a mismatched-state callback without consuming its code, and the flow stays pending for the real redirect', async () => {
    const port = freshPort()
    const capturing = captureAuthorizationCode(port, 5_000, { expectedState: 'tok-2' })

    const forged = await fetch(`http://127.0.0.1:${port}/callback?code=stolen-code&state=wrong`)
    expect(forged.status).toBe(400)
    expect(await forged.text()).toMatch(/state mismatch/)

    // The forged request did not settle the capture — it is still waiting,
    // and a later request carrying the correct state resolves it normally.
    const legit = await fetch(`http://127.0.0.1:${port}/callback?code=real-code&state=tok-2`)
    expect(legit.ok).toBe(true)
    expect(await capturing).toBe('real-code')
  })

  it('400s a callback missing state entirely when one is expected, leaving the flow pending', async () => {
    const port = freshPort()
    const capturing = captureAuthorizationCode(port, 5_000, { expectedState: 'tok-3' })

    const noState = await fetch(`http://127.0.0.1:${port}/callback?code=stolen-code`)
    expect(noState.status).toBe(400)

    const legit = await fetch(`http://127.0.0.1:${port}/callback?code=real-code&state=tok-3`)
    expect(legit.ok).toBe(true)
    expect(await capturing).toBe('real-code')
  })

  it('times out if only mismatched-state callbacks ever arrive', async () => {
    const port = freshPort()
    const capturing = captureAuthorizationCode(port, 50, { expectedState: 'tok-4' })
    await fetch(`http://127.0.0.1:${port}/callback?code=stolen-code&state=wrong`)
    await expect(capturing).rejects.toThrow(/no consent callback within 50ms/)
  })
})

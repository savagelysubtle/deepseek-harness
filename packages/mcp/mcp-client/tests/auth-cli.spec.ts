/**
 * Tests for the `dsh-mcp-client-auth` consent CLI (`runAuthCli`) that the
 * OAuth end-to-end flow in oauth.spec.ts does not already exercise: argv
 * validation, full-flow runs that reach every parseArgs default and every
 * scope/client-id forwarding branch, the loopback callback server's
 * non-happy paths (wrong path, authorization-server error redirect, missing
 * code, timeout, port conflict), and the "Already authorized" short circuit
 * (auth-cli.ts ~192-195) against a store seeded exactly as a prior run would
 * leave it.
 */
import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'

import { startOAuthFixture } from './oauth-fixture.ts'
import { parseArgs, runAuthCli } from '@deepseek-ai/dsh-mcp-client/src/auth-cli.ts'
import { oauthCredentialRef } from '@deepseek-ai/dsh-mcp-client/src/oauth.ts'

/** Bind `server` to an OS-assigned free port on 127.0.0.1 and resolve with the
 * assigned port once listening (rejects on a bind error). The caller decides
 * whether to close it right away (`getFreePort`) or keep it open as a decoy
 * occupying the port (the port-conflict test below) — either way the port
 * number itself always comes from the OS, never a fixed or banded literal. */
function bindToFreePort(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no free port'))
        return
      }
      resolve(address.port)
    })
  })
}

/** Bind a throwaway server on port 0 to learn an OS-assigned free port, close
 * it, and hand the port back for a caller (e.g. `--redirect-port`) to bind
 * next — never a fixed or banded port number. */
async function getFreePort(): Promise<number> {
  const probe = createServer()
  const port = await bindToFreePort(probe)
  await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
  return port
}

/** Capture console.log lines the CLI prints (the authorization URL, status). */
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(part => String(part)).join(' '))
  })
  return { lines, restore: () => { spy.mockRestore() } }
}

/** Drive one full consent round trip: wait for the printed authorization URL,
 * follow it (the fixture consents instantly and redirects into the CLI's own
 * loopback listener), then let the run settle. */
async function completeConsentFlow(run: Promise<void>, log: { lines: string[] }): Promise<void> {
  await vi.waitFor(() => {
    expect(log.lines.some(line => line.includes('Open this URL'))).toBe(true)
  })
  const matched = log.lines.join('\n').match(/https?:\/\/\S+/)
  if (matched === null) throw new Error('the CLI never printed an authorization URL')
  const browserResponse = await fetch(matched[0], { redirect: 'follow' })
  expect(browserResponse.ok).toBe(true)
  await run
}

describe('parseArgs validation (runAuthCli argv)', () => {
  it('rejects an unrecognized flag', async () => {
    await expect(runAuthCli(['--bogus'])).rejects.toThrow(/unknown or incomplete argument: --bogus/)
  })

  it('rejects a flag missing its value', async () => {
    await expect(runAuthCli(['--url'])).rejects.toThrow(/unknown or incomplete argument: --url/)
  })

  it('rejects a repeated flag', async () => {
    await expect(runAuthCli(['--url', 'a', '--server-name', 's', '--url', 'b']))
      .rejects.toThrow(/repeated argument: --url/)
  })

  it('rejects when --url or --server-name is missing', async () => {
    await expect(runAuthCli(['--scope', 's']))
      .rejects.toThrow(/usage: dsh-mcp-client-auth --url <mcp-endpoint> --server-name <name>/)
  })

  it('rejects a non-integer --redirect-port', async () => {
    await expect(runAuthCli(['--url', 'http://x', '--server-name', 'y', '--redirect-port', 'abc']))
      .rejects.toThrow(/--redirect-port must be an integer between 1 and 65535/)
  })

  it('rejects a --redirect-port above 65535', async () => {
    await expect(runAuthCli(['--url', 'http://x', '--server-name', 'y', '--redirect-port', '70000']))
      .rejects.toThrow(/--redirect-port must be an integer between 1 and 65535/)
  })

  // Regression for the bug where numberFlag applied the 1..65535 port bound
  // to --timeout-ms too: 0, a negative value, and a non-numeric value are
  // still rejected, each with the timeout-specific message (not the port
  // one). The 65535 port ceiling no longer applies to this flag — it has its
  // own, much higher ceiling (Node's timer max) — see the acceptance and
  // ceiling-rejection cases below.
  it.each(['0', '-1', 'abc'])('rejects --timeout-ms %s', async (bad) => {
    await expect(runAuthCli(['--url', 'http://x', '--server-name', 'y', '--timeout-ms', bad]))
      .rejects.toThrow(/--timeout-ms must be an integer between 1 and 2147483647 \(Node's timer ceiling\)/)
  })

  it('rejects a --timeout-ms above Node\'s 32-bit setTimeout ceiling (2147483648)', async () => {
    // Above 2147483647ms, Node's setTimeout silently clamps the delay to 1ms
    // (with a TimeoutOverflowWarning) instead of honoring it — the opposite
    // of the longer wait the caller asked for — so this must be rejected,
    // not merely accepted and misbehave at runtime.
    await expect(runAuthCli(['--url', 'http://x', '--server-name', 'y', '--timeout-ms', '2147483648']))
      .rejects.toThrow(/--timeout-ms must be an integer between 1 and 2147483647 \(Node's timer ceiling\)/)
  })
})

describe('parseArgs — accepted --timeout-ms values (defect: the port bound used to reject these)', () => {
  // Exercises parseArgs directly: these values must parse successfully, not
  // merely "not throw while also doing real network/credential-fiber work",
  // so this checks parseArgs in isolation rather than through runAuthCli.
  it('accepts the documented default (300000) passed explicitly', () => {
    const args = parseArgs(['--url', 'http://x', '--server-name', 'y', '--timeout-ms', '300000'])
    expect(args.timeoutMs).toBe(300_000)
  })

  it('accepts a value above the old 65535 port-shaped ceiling (600000)', () => {
    const args = parseArgs(['--url', 'http://x', '--server-name', 'y', '--timeout-ms', '600000'])
    expect(args.timeoutMs).toBe(600_000)
  })

  it("accepts Node's timer ceiling itself (2147483647)", () => {
    const args = parseArgs(['--url', 'http://x', '--server-name', 'y', '--timeout-ms', '2147483647'])
    expect(args.timeoutMs).toBe(2_147_483_647)
  })
})

describe('full consent flow — parseArgs defaults and client-id forwarding', () => {
  it('completes the flow through every parseArgs default (no --credentials-path, --redirect-port, or --timeout-ms)', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-home-'))
    const originalDshHome = process.env.DSH_HOME
    // Contain the default credentials-document location (~/.dsh by default)
    // to a throwaway directory for this one process-wide env var mutation.
    process.env.DSH_HOME = dir
    const log = captureLog()
    try {
      const run = runAuthCli(['--url', fixture.url, '--server-name', 'all-defaults'])
      await completeConsentFlow(run, log)
    } finally {
      log.restore()
      if (originalDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalDshHome
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('completes the flow with a static --client-id, bypassing dynamic registration', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    const log = captureLog()
    try {
      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'static-client-flow',
        '--credentials-path', credPath,
        '--client-id', 'preset-static-1',
        '--timeout-ms', '15000',
      ])
      await completeConsentFlow(run, log)
      // Static client id means the fixture's dynamic-registration endpoint
      // was never hit for this flow.
      expect(fixture.tokenRequests.every(request => request.client_id !== 'dyn-client-1')).toBe(true)
    } finally {
      log.restore()
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })
})

describe('captureAuthorizationCode (loopback listener)', () => {
  it('answers an unmatched path with 404 before completing on the real callback', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    const port = await getFreePort()
    const log = captureLog()
    try {
      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'not-found-path',
        '--credentials-path', credPath,
        '--redirect-port', String(port),
        '--timeout-ms', '15000',
      ])
      await vi.waitFor(() => {
        expect(log.lines.some(line => line.includes('Open this URL'))).toBe(true)
      })

      const stray = await fetch(`http://127.0.0.1:${port}/not-the-callback-path`)
      expect(stray.status).toBe(404)

      const matched = log.lines.join('\n').match(/https?:\/\/\S+/)
      if (matched === null) throw new Error('the CLI never printed an authorization URL')
      const browserResponse = await fetch(matched[0], { redirect: 'follow' })
      expect(browserResponse.ok).toBe(true)
      await run
    } finally {
      log.restore()
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('surfaces an authorization-server error redirect without a description', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    const port = await getFreePort()
    const log = captureLog()
    try {
      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'err-no-desc',
        '--credentials-path', credPath,
        '--redirect-port', String(port),
        '--timeout-ms', '15000',
      ])
      // Attach the rejection assertion NOW (synchronously after creating the
      // promise): the server-side handler below rejects `run` as soon as the
      // request lands, and awaiting other work first would leave the
      // rejection briefly unhandled.
      const rejection = expect(run).rejects.toThrow(/authorization server redirected with error: access_denied/)
      await vi.waitFor(() => {
        expect(log.lines.some(line => line.includes('Open this URL'))).toBe(true)
      })

      const response = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('Authorization failed: access_denied\n')
      await rejection
    } finally {
      log.restore()
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('surfaces an authorization-server error redirect with a description', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    const port = await getFreePort()
    const log = captureLog()
    try {
      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'err-with-desc',
        '--credentials-path', credPath,
        '--redirect-port', String(port),
        '--timeout-ms', '15000',
      ])
      const rejection = expect(run).rejects.toThrow(/authorization server redirected with error: access_denied/)
      await vi.waitFor(() => {
        expect(log.lines.some(line => line.includes('Open this URL'))).toBe(true)
      })

      const response = await fetch(
        `http://127.0.0.1:${port}/callback?error=access_denied&error_description=${encodeURIComponent('User said no')}`,
      )
      expect(await response.text()).toBe('Authorization failed: access_denied (User said no)\n')
      await rejection
    } finally {
      log.restore()
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('reports "missing code" when the callback carries neither code nor error', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    const port = await getFreePort()
    const log = captureLog()
    try {
      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'missing-code',
        '--credentials-path', credPath,
        '--redirect-port', String(port),
        '--timeout-ms', '15000',
      ])
      const rejection = expect(run).rejects.toThrow(/authorization server redirected with error: missing code/)
      await vi.waitFor(() => {
        expect(log.lines.some(line => line.includes('Open this URL'))).toBe(true)
      })

      const response = await fetch(`http://127.0.0.1:${port}/callback`)
      expect(await response.text()).toBe('Authorization failed: missing code\n')
      await rejection
    } finally {
      log.restore()
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('times out waiting for the consent callback', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    const port = await getFreePort()
    const log = captureLog()
    try {
      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'times-out',
        '--credentials-path', credPath,
        '--redirect-port', String(port),
        '--timeout-ms', '50',
      ])
      await expect(run).rejects.toThrow(/no consent callback within 50ms — rerun the command to get a fresh login URL/)
    } finally {
      log.restore()
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('fails loud when the loopback port is already bound', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    const decoy = createServer()
    const log = captureLog()
    try {
      const port = await bindToFreePort(decoy)

      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'port-conflict',
        '--credentials-path', credPath,
        '--redirect-port', String(port),
        '--timeout-ms', '15000',
      ])
      await expect(run).rejects.toThrow(
        new RegExp(`cannot listen on 127\\.0\\.0\\.1:${port} for the consent redirect`),
      )
    } finally {
      log.restore()
      decoy.close()
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })
})

describe('already-authorized short circuit', () => {
  it('skips the entire consent flow when a valid stored grant already exists', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    // Never bound: proving nothing ever listens on it is exactly the "no
    // loopback listener" assertion below.
    const port = await getFreePort()
    const log = captureLog()
    try {
      // Seed exactly what a prior completed CLI login leaves behind: a
      // dynamically registered client and a refreshable token pair. The SDK's
      // auth() always re-validates a stored grant by refreshing it, so the
      // refresh_token must match what the fixture's /token endpoint accepts.
      const seedCtx = new Context()
      const seedFiber = seedCtx.plugin(LocalCredentialProvider, { path: credPath, watch: false })
      await seedFiber
      const ref = oauthCredentialRef('already-authorized')
      await seedCtx.credentials.set(ref, JSON.stringify({
        version: 1,
        tokens: { access_token: 'at-stale', refresh_token: 'rt-1', token_type: 'Bearer' },
        clientInformation: { client_id: 'dyn-client-1' },
      }))
      await seedFiber.dispose()
      const registrationsAfterSeed = fixture.registrationRequests.length

      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'already-authorized',
        '--credentials-path', credPath,
        '--redirect-port', String(port),
        '--timeout-ms', '15000',
      ])
      await expect(run).resolves.toBeUndefined()

      // Prints the short-circuit message, never the consent-flow prompt.
      expect(log.lines.some(line => line.includes('Already authorized'))).toBe(true)
      expect(log.lines.some(line => line.includes('Open this URL'))).toBe(false)

      // No loopback listener: captureAuthorizationCode (the function that
      // binds the redirect port) never ran, so nothing answers on it.
      await expect(fetch(`http://127.0.0.1:${port}/callback?code=unused`)).rejects.toThrow()

      // No dynamic-registration request: the fixture's /register endpoint
      // always returns the same client_id regardless of whether it was ever
      // called, so comparing the stored clientInformation to that id proves
      // nothing either way. The fixture's own request counter is the real
      // proof — it must sit exactly where seeding left it (zero calls).
      expect(fixture.registrationRequests.length).toBe(registrationsAfterSeed)

      // The refresh grant is the only token-endpoint traffic — no
      // authorization_code exchange ran because no code was ever captured.
      expect(fixture.tokenRequests.map(request => request.grant_type)).toEqual(['refresh_token'])
    } finally {
      log.restore()
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })
})

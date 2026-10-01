/**
 * Tests for the `dsh-mcp-client-auth` consent CLI (`runAuthCli`) that the
 * OAuth end-to-end flow in oauth.spec.ts does not already exercise: argv
 * validation, full-flow runs that reach every parseArgs default and every
 * scope/client-id forwarding branch, and the loopback callback server's
 * non-happy paths (wrong path, authorization-server error redirect, missing
 * code, timeout, port conflict).
 *
 * NOTE on the "Already authorized" short circuit (auth-cli.ts:173-176): it is
 * NOT exercised here. `runAuthCli` constructs its `LocalCredentialProvider`
 * with a bare `new LocalCredentialProvider(ctx, {...})` (auth-cli.ts:154-157)
 * instead of `ctx.plugin(LocalCredentialProvider, {...})`. Cordis's
 * `Service.init` async generator — where credentials-local's `loadInitial()`
 * reads the existing `.credentials.yaml` into memory — runs only when a
 * Service subclass is loaded as a Cordis "class plugin" via `ctx.plugin(...)`
 * (see `[Service.init]` doc in vendor/cordis/src/service.ts and its only
 * caller in the plugin loader); a bare constructor call never triggers it.
 * Verified empirically: constructing `LocalCredentialProvider` directly
 * against a `.credentials.yaml` that already holds a valid entry and calling
 * `.resolve()` immediately after (even after a 200ms grace delay) returns
 * `undefined` — see the reasoning recorded in the task's final report. This
 * means every real `runAuthCli` invocation starts from a provider whose
 * in-memory store is empty regardless of what is on disk, so the "already
 * authorized" check can never see a grant a PRIOR process wrote — it is
 * live, reachable code in principle, but dead in every actual call path
 * through the shipped `runAuthCli`. Reported as a real defect, not fixed here
 * (this package's write list is tests/** only).
 */
import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startOAuthFixture } from './oauth-fixture.ts'
import { runAuthCli } from '@deepseek-ai/dsh-mcp-client/src/auth-cli.ts'

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

/**
 * The exact messages `captureAuthorizationCode` (auth-cli.ts) rejects with on
 * its four failure paths — the only reasons `toleratingKnownFinallyLeak`
 * below is allowed to swallow.
 */
const KNOWN_FINALLY_LEAK_PATTERNS = [
  /^authorization server redirected with error:/,
  /^no consent callback within \d+ms — rerun the command to get a fresh login URL$/,
  /^cannot listen on 127\.0\.0\.1:\d+ for the consent redirect /,
]

/**
 * `captureAuthorizationCode` (auth-cli.ts) does
 * `void captured.promise.finally(() => {...})`: the promise `.finally()`
 * returns is discarded, so on EVERY rejection path (error redirect, missing
 * code, timeout, port conflict) that returned promise carries the same
 * rejection and is never handled — a real, independent unhandled-rejection
 * event, on top of the `run` promise this file properly awaits and asserts
 * on. This is a source defect (reported in the task write-up, not fixed here
 * — this package's write list is tests/** only); it fires regardless of how
 * a caller handles `captureAuthorizationCode`'s own returned promise, so it
 * cannot be avoided by attaching handlers earlier in this file.
 *
 * Driving these real failure paths is the only way to cover them, so this
 * saves and swaps out `process`'s own `unhandledRejection` listeners around
 * exactly the call that exercises one — but ONLY the four known leak
 * messages above are swallowed; any other reason is forwarded to the saved
 * listeners (vitest's own included) so an unrelated failure during the same
 * call can never hide behind this.
 */
async function toleratingKnownFinallyLeak<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const forwardUnlessKnownLeak = (reason: unknown, promise: Promise<unknown>): void => {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (KNOWN_FINALLY_LEAK_PATTERNS.some(pattern => pattern.test(message))) return
    for (const listener of saved) listener(reason, promise)
  }
  process.on('unhandledRejection', forwardUnlessKnownLeak)
  try {
    return await fn()
  } finally {
    process.off('unhandledRejection', forwardUnlessKnownLeak)
    for (const listener of saved) process.on('unhandledRejection', listener)
  }
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

  it('rejects an out-of-range --timeout-ms', async () => {
    await expect(runAuthCli(['--url', 'http://x', '--server-name', 'y', '--timeout-ms', '0']))
      .rejects.toThrow(/--timeout-ms must be an integer between 1 and 65535/)
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

  it('surfaces an authorization-server error redirect without a description', () => toleratingKnownFinallyLeak(async () => {
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
  }))

  it('surfaces an authorization-server error redirect with a description', () => toleratingKnownFinallyLeak(async () => {
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
  }))

  it('reports "missing code" when the callback carries neither code nor error', () => toleratingKnownFinallyLeak(async () => {
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
  }))

  it('times out waiting for the consent callback', () => toleratingKnownFinallyLeak(async () => {
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
  }))

  it('fails loud when the loopback port is already bound', () => toleratingKnownFinallyLeak(async () => {
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
  }))
})

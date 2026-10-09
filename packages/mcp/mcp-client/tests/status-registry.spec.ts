/**
 * Tests for `McpStatusRegistryService` ({@link ../src/status-registry.ts}):
 * `list`/`register`, `authorize-start`'s single-flight consent flow against a
 * real OAuth fixture (no SDK mocks — the state anti-CSRF check and the
 * eventual `forceReconnectAfterAuthorization` call are real SDK behavior),
 * `reconnect`, `set-enabled`'s atomic patch-file rewrite, and
 * `ensureStatusRegistry`'s lazy-mount-once dedup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A concurrent writer landing between setEnabled's initial read and its
// pre-rename re-check cannot be timed from outside; `vi.spyOn` on a node
// builtin's ESM namespace is refused ("Module namespace is not
// configurable"), so the injection goes through `vi.mock`, same pattern as
// `packages/settings/settings-file/tests/lock-race.spec.ts`. Off by default
// (`racePath` undefined) so every other test's readFile passes straight
// through to the real implementation.
const fsRaceState = vi.hoisted(() => ({
  racePath: undefined as string | undefined,
  raceAtCall: 0,
  raceContents: '',
  callsSeen: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const [path] = args
      if (fsRaceState.racePath !== undefined && typeof path === 'string' && path === fsRaceState.racePath) {
        fsRaceState.callsSeen += 1
        if (fsRaceState.callsSeen === fsRaceState.raceAtCall) {
          await actual.writeFile(fsRaceState.racePath, fsRaceState.raceContents, 'utf8')
          fsRaceState.racePath = undefined // one-shot: never re-arms for a later call or test
        }
      }
      return actual.readFile(...args)
    }) as typeof actual.readFile,
  }
})

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

import { startOAuthFixture, type OAuthFixture } from './oauth-fixture.ts'
import { CredentialsOAuthProvider } from '@deepseek-ai/dsh-mcp-client/src/oauth.ts'
import { HOST_CONSENT_TIMEOUT_MS, McpStatusRegistryService, ensureStatusRegistry }
  from '@deepseek-ai/dsh-mcp-client/src/status-registry.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { McpServerState } from '@deepseek-ai/dsh-mcp-client/src/status.ts'

async function mountRegistry(credentialsPath: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, watch: false })
  return ctx
}

function httpConfig(fixture: OAuthFixture, serverName: string): Config {
  return {
    transport: 'streamable-http',
    serverName,
    url: fixture.url,
    headers: {},
    auth: { mode: 'oauth' },
    toolCallTimeoutMs: 10_000,
    failOnStartupError: false,
    reconnect: { enabled: false },
  }
}

/**
 * A fake, non-supervised {@link ConnectionHandle} wrapping a real OAuth
 * provider: exercises status-registry's own logic (single-flight, state
 * checks, the reconnect hand-off) without the full connection supervisor.
 */
function buildOAuthHandle(fixture: OAuthFixture, ctx: Context, serverName: string): {
  handle: ConnectionHandle
  forceReconnectAfterAuthorization: ReturnType<typeof vi.fn>
  reconnectNow: ReturnType<typeof vi.fn>
} {
  const box: { consentUrl: string | undefined; state: McpServerState } = { consentUrl: undefined, state: 'connecting' }
  const provider = CredentialsOAuthProvider.create({
    serverName,
    serverUrl: new URL(fixture.url),
    store: ctx.credentials,
    redirectUri: 'http://127.0.0.1:18700/callback',
    onAuthorizationUrl(url) {
      box.consentUrl = String(url)
      box.state = 'needs-authorization'
    },
  })
  const forceReconnectAfterAuthorization = vi.fn()
  const reconnectNow = vi.fn()
  const handle: ConnectionHandle = {
    ready: Promise.resolve({}),
    async dispose() {},
    status() {
      // consentUrl is deliberately NOT part of McpServerStatus (SWD-164
      // sentinel finding: it carries the CSRF state, so it must never cross
      // the public status poll) — peekConsentUrl() below is the only path
      // authorize-start reads it through.
      return {
        serverName,
        state: box.state,
        attempts: 0,
        maxAttempts: 10,
      }
    },
    peekConsentUrl() { return box.consentUrl },
    reconnectNow,
    onStatusChange() { return () => {} },
    authProvider: provider,
    forceReconnectAfterAuthorization,
  }
  return { handle, forceReconnectAfterAuthorization, reconnectNow }
}

describe('McpStatusRegistryService — list/register', () => {
  let dir: string
  let credPath: string
  let ctx: Context
  let fixture: OAuthFixture

  beforeEach(async () => {
    fixture = await startOAuthFixture()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-status-'))
    credPath = join(dir, 'creds.yaml')
    ctx = await mountRegistry(credPath)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await fixture.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('register exposes the handle through list, and unregister removes it', async () => {
    const registry = new McpStatusRegistryService(ctx, { patchPath: join(dir, 'cordis.patch.yml') })
    const { handle } = buildOAuthHandle(fixture, ctx, 'listed')
    const config = httpConfig(fixture, 'listed')
    const unregister = registry.register(config, handle)

    expect(registry.list()).toEqual([handle.status()])

    unregister()
    expect(registry.list()).toEqual([])
  })

  it('an HMR replacement registration is not torn down by the OLD instance\'s unregister', async () => {
    const registry = new McpStatusRegistryService(ctx, { patchPath: join(dir, 'cordis.patch.yml') })
    const config = httpConfig(fixture, 'hmr')
    const { handle: oldHandle } = buildOAuthHandle(fixture, ctx, 'hmr')
    const { handle: newHandle } = buildOAuthHandle(fixture, ctx, 'hmr')

    const unregisterOld = registry.register(config, oldHandle)
    registry.register(config, newHandle)
    // The old registration's unregister must not drop the NEW handle that
    // already replaced it in the map.
    unregisterOld()
    expect(registry.list()).toEqual([newHandle.status()])
  })
})

describe('McpStatusRegistryService — authorize-start', () => {
  let dir: string
  let credPath: string
  let ctx: Context
  let fixture: OAuthFixture
  let registry: McpStatusRegistryService

  beforeEach(async () => {
    fixture = await startOAuthFixture()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-status-'))
    credPath = join(dir, 'creds.yaml')
    ctx = await mountRegistry(credPath)
    registry = new McpStatusRegistryService(ctx, { patchPath: join(dir, 'cordis.patch.yml') })
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await fixture.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an unknown server', async () => {
    await expect(registry.authorizeStart('ghost')).rejects.toThrow(/unknown server "ghost"/)
  })

  it('rejects a server with no OAuth configured', async () => {
    const { handle } = buildOAuthHandle(fixture, ctx, 'plain')
    // Simulate an unauthenticated registration: no provider at all.
    const unauthHandle: ConnectionHandle = { ...handle, authProvider: undefined }
    registry.register(httpConfig(fixture, 'plain'), unauthHandle)
    await expect(registry.authorizeStart('plain')).rejects.toThrow(/has no OAuth configured/)
  })

  it('rejects when the server is already authorized, directing the caller to Reconnect instead', async () => {
    const { handle } = buildOAuthHandle(fixture, ctx, 'already')
    registry.register(httpConfig(fixture, 'already'), handle)
    await ctx.credentials.set(handle.authProvider!.ref, JSON.stringify({
      version: 1,
      tokens: { access_token: 'at-stale', refresh_token: 'rt-1', token_type: 'Bearer' },
      clientInformation: { client_id: 'dyn-client-1' },
    }))
    await expect(registry.authorizeStart('already')).rejects.toThrow(/already authorized — try Reconnect/)
  })

  it('a second authorize-start rejects while the first is pending (single shared listener)', async () => {
    const { handle: h1, forceReconnectAfterAuthorization } = buildOAuthHandle(fixture, ctx, 's1')
    const { handle: h2 } = buildOAuthHandle(fixture, ctx, 's2')
    registry.register(httpConfig(fixture, 's1'), h1)
    registry.register(httpConfig(fixture, 's2'), h2)

    const first = await registry.authorizeStart('s1')
    expect(first.consentUrl).toBeDefined()

    await expect(registry.authorizeStart('s2')).rejects.toThrow(/consent flow is already pending for "s1"/)

    // Complete the pending flow so it does not leak into other tests.
    const state = new URL(first.consentUrl).searchParams.get('state')!
    const port = Number(new URL(h1.authProvider!.redirectUrl).port)
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code-1&state=${state}`)
    expect(response.ok).toBe(true)
    await vi.waitFor(() => { expect(forceReconnectAfterAuthorization).toHaveBeenCalledTimes(1) })
  })

  it('rejects immediately when the loopback port is already held, releasing the slot for a retry (SWD-164 sentinel: bind before promising a URL)', async () => {
    const { handle, forceReconnectAfterAuthorization } = buildOAuthHandle(fixture, ctx, 'port-busy')
    registry.register(httpConfig(fixture, 'port-busy'), handle)
    const port = Number(new URL(handle.authProvider!.redirectUrl).port)

    // Occupy the loopback port with an unrelated listener (standing in for a
    // concurrent `dsh-mcp-client-auth` run) BEFORE calling authorize-start.
    const occupier = createServer()
    await new Promise<void>((resolve, reject) => {
      occupier.once('error', reject)
      occupier.listen(port, '127.0.0.1', () => { resolve() })
    })
    try {
      // Fails immediately — not ~HOST_CONSENT_TIMEOUT_MS later — and never
      // hands back a consent URL for a listener that cannot receive it.
      await expect(registry.authorizeStart('port-busy')).rejects.toThrow(/could not start the consent listener/)
    } finally {
      await new Promise<void>((resolve) => { occupier.close(() => { resolve() }) })
    }

    // The slot was released, not left pending behind the bind failure: the
    // same server retries immediately and this time succeeds.
    const retried = await registry.authorizeStart('port-busy')
    expect(typeof retried.consentUrl).toBe('string')

    // Complete the real listener this retry started so it does not stay
    // bound to the shared port into the next test.
    const state = new URL(retried.consentUrl).searchParams.get('state')!
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code-port-busy&state=${state}`)
    expect(response.ok).toBe(true)
    await vi.waitFor(() => { expect(forceReconnectAfterAuthorization).toHaveBeenCalledTimes(1) })
  })

  it('a forged callback with the wrong state 400s without consuming the real flow, which stays pending and then succeeds', async () => {
    const { handle, forceReconnectAfterAuthorization } = buildOAuthHandle(fixture, ctx, 'wrongstate')
    registry.register(httpConfig(fixture, 'wrongstate'), handle)

    const { consentUrl } = await registry.authorizeStart('wrongstate')
    const port = Number(new URL(handle.authProvider!.redirectUrl).port)
    const realState = new URL(consentUrl).searchParams.get('state')!

    const forged = await fetch(`http://127.0.0.1:${port}/callback?code=stolen&state=not-the-real-state`)
    expect(forged.status).toBe(400)

    // The flow is still pending: a second authorize-start for any server still rejects.
    await expect(registry.authorizeStart('wrongstate')).rejects.toThrow(/already pending for "wrongstate"/)

    const legit = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code-1&state=${realState}`)
    expect(legit.ok).toBe(true)
    await vi.waitFor(() => { expect(forceReconnectAfterAuthorization).toHaveBeenCalledTimes(1) })

    // The slot released: a fresh authorize-start on a different server now succeeds.
    const { handle: otherHandle, forceReconnectAfterAuthorization: otherForceReconnect } = buildOAuthHandle(fixture, ctx, 'other')
    registry.register(httpConfig(fixture, 'other'), otherHandle)
    const released = await registry.authorizeStart('other')
    expect(typeof released.consentUrl).toBe('string')

    // Complete this flow too so its real listener does not stay bound to
    // the shared port into a later test.
    const otherState = new URL(released.consentUrl).searchParams.get('state')!
    const otherResponse = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code-other&state=${otherState}`)
    expect(otherResponse.ok).toBe(true)
    await vi.waitFor(() => { expect(otherForceReconnect).toHaveBeenCalledTimes(1) })
  })

  it('a timed-out consent capture logs and releases the slot for the next caller', async () => {
    vi.useFakeTimers()
    try {
      const { handle, forceReconnectAfterAuthorization } = buildOAuthHandle(fixture, ctx, 'timeout-srv')
      const errors: string[] = []
      vi.spyOn(ctx.logger, 'error').mockImplementation(((message: unknown) => { errors.push(String(message)) }) as never)
      registry.register(httpConfig(fixture, 'timeout-srv'), handle)

      const authorizing = registry.authorizeStart('timeout-srv')
      await vi.advanceTimersByTimeAsync(0)
      const { consentUrl } = await authorizing
      expect(consentUrl).toBeDefined()

      await vi.advanceTimersByTimeAsync(HOST_CONSENT_TIMEOUT_MS)
      await vi.waitFor(() => {
        expect(errors.some(line => line.includes('consent flow failed'))).toBe(true)
      }, { timeout: 2_000, interval: 10 })
      expect(forceReconnectAfterAuthorization).not.toHaveBeenCalled()

      // The slot is released: a new flow may start immediately.
      const { handle: nextHandle } = buildOAuthHandle(fixture, ctx, 'next-srv')
      registry.register(httpConfig(fixture, 'next-srv'), nextHandle)
      const released = await registry.authorizeStart('next-srv')
      expect(typeof released.consentUrl).toBe('string')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('McpStatusRegistryService — reconnect', () => {
  it('rejects an unknown server', () => {
    const registry = new McpStatusRegistryService(new Context(), { patchPath: '/nonexistent/path.yml' })
    expect(() => { registry.reconnect('ghost') }).toThrow(/unknown server "ghost"/)
  })

  it('delegates to the handle\'s reconnectNow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-status-'))
    try {
      const fixture = await startOAuthFixture()
      try {
        const ctx = await mountRegistry(join(dir, 'creds.yaml'))
        const registry = new McpStatusRegistryService(ctx, { patchPath: join(dir, 'cordis.patch.yml') })
        const { handle, reconnectNow } = buildOAuthHandle(fixture, ctx, 'r1')
        registry.register(httpConfig(fixture, 'r1'), handle)
        registry.reconnect('r1')
        expect(reconnectNow).toHaveBeenCalledTimes(1)
        await ctx.fiber.dispose()
      } finally {
        await fixture.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('McpStatusRegistryService — set-enabled', () => {
  let dir: string
  let patchPath: string
  let registry: McpStatusRegistryService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-set-enabled-'))
    patchPath = join(dir, 'cordis.patch.yml')
    registry = new McpStatusRegistryService(new Context(), { patchPath })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects a server name that fails SERVER_NAME_PATTERN', async () => {
    await expect(registry.setEnabled('not valid!', true)).rejects.toThrow(/is not a valid server name/)
  })

  it('rejects when the patch file does not exist', async () => {
    await expect(registry.setEnabled('srv', true)).rejects.toThrow(/cordis patch file could not be read/)
  })

  it('rejects when the patch file is not valid YAML', async () => {
    await writeFile(patchPath, ': : not yaml ][', 'utf8')
    await expect(registry.setEnabled('srv', true)).rejects.toThrow(/not valid YAML/)
  })

  it('rejects when the patch file has no top-level list', async () => {
    await writeFile(patchPath, 'id: srv\n', 'utf8')
    await expect(registry.setEnabled('srv', true)).rejects.toThrow(/does not contain a top-level list/)
  })

  it('rejects a mount id that does not exist — set-enabled never inserts', async () => {
    await writeFile(patchPath, '- id: other-mount\n  disabled: false\n', 'utf8')
    await expect(registry.setEnabled('srv', true)).rejects.toThrow(/no mount with id "srv" exists/)
  })

  it('flips a flat top-level mount and writes an atomic backup', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n- id: other\n  disabled: false\n', 'utf8')
    await registry.setEnabled('srv', true)

    const written = await readFile(patchPath, 'utf8')
    expect(written).toMatch(/id: srv/)
    expect(written).toMatch(/disabled: false/)
    // The other entry survives untouched.
    expect(written).toMatch(/id: other/)

    const dirEntries = await readdir(dir)
    expect(dirEntries.some(name => name.startsWith('cordis.patch.yml.bak-'))).toBe(true)
  })

  it('flips a nested mount under a group\'s insert list', async () => {
    await writeFile(
      patchPath,
      '- id: group\n  insert:\n    - id: nested-srv\n      disabled: false\n    - id: sibling\n      disabled: false\n',
      'utf8',
    )
    await registry.setEnabled('nested-srv', false)
    const written = await readFile(patchPath, 'utf8')
    expect(written).toMatch(/id: nested-srv\s*\n\s*disabled: true/)
    expect(written).toMatch(/id: sibling\s*\n\s*disabled: false/)
  })

  it('refuses to write when the patch file changes between the read and the pre-rename re-check (SWD-164 sentinel: compare-before-write)', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    // The SECOND readFile call setEnabled makes is its pre-rename re-check:
    // land a concurrent writer's edit right before it fires, simulating
    // another `set-enabled` call (or a hand edit) racing this one.
    fsRaceState.racePath = patchPath
    fsRaceState.raceAtCall = 2
    fsRaceState.raceContents = '- id: srv\n  disabled: true\n- id: concurrent\n  disabled: false\n'
    fsRaceState.callsSeen = 0
    try {
      await expect(registry.setEnabled('srv', false)).rejects.toThrow(/changed since it was read — retry/)
    } finally {
      fsRaceState.racePath = undefined
    }
    // Refused, not clobbered: the concurrent writer's content survives untouched.
    const written = await readFile(patchPath, 'utf8')
    expect(written).toMatch(/id: concurrent/)
    expect(written).toMatch(/id: srv\s*\n\s*disabled: true/)
    // Never even attempted a backup for the refused write.
    expect(await readdir(dir)).toEqual(['cordis.patch.yml'])
  })

  it('never silently overwrites an existing same-timestamp backup', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    // Pre-create every backup filename the collision-avoidance loop would try
    // at a frozen instant, forcing it to exhaust its attempts and fail loud.
    const now = new Date('2026-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const stamp = now.toISOString().replace(/[:.]/g, '-')
      await writeFile(`${patchPath}.bak-${stamp}`, 'placeholder', 'utf8')
      for (let i = 0; i < 100; i++) {
        await writeFile(`${patchPath}.bak-${stamp}-${i}`, 'placeholder', 'utf8')
      }
      await expect(registry.setEnabled('srv', false)).rejects.toThrow(/has no free backup filename/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ensureStatusRegistry — lazy mount-once-per-root dedup', () => {
  it('two calls on the same root resolve to the same instance', async () => {
    const ctx = new Context()
    try {
      const [a, b] = await Promise.all([ensureStatusRegistry(ctx), ensureStatusRegistry(ctx)])
      expect(a).toBe(b)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a derived context\'s call still mounts on the shared root', async () => {
    const root = new Context()
    try {
      const child = root.extend()
      const [fromRoot, fromChild] = await Promise.all([ensureStatusRegistry(root), ensureStatusRegistry(child)])
      expect(fromRoot).toBe(fromChild)
    } finally {
      await root.fiber.dispose()
    }
  })
})

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
import { createServer as createHttpServer } from 'node:http'
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
  // Coverage-only I/O failure injections for the handful of real-but-rare
  // failure paths below (a non-ENOENT read error, a non-Error throw, a
  // backup/rename/cleanup failure) that cannot be timed or shaped through
  // the real filesystem alone. Each is a ONE-SHOT: it consumes itself
  // (resets to undefined) the moment it fires, so it can never leak into a
  // later call in the same test or into another test's `afterEach` cleanup.
  readFileFailPath: undefined as string | undefined,
  readFileFailAtCall: 0,
  readFileFailCallsSeen: 0,
  readFileFailError: undefined as unknown,
  openWxFailError: undefined as unknown,
  renameFailError: undefined as unknown,
  rmFailError: undefined as unknown,
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
      if (fsRaceState.readFileFailPath !== undefined && typeof path === 'string' && path === fsRaceState.readFileFailPath) {
        fsRaceState.readFileFailCallsSeen += 1
        if (fsRaceState.readFileFailCallsSeen === fsRaceState.readFileFailAtCall) {
          const error = fsRaceState.readFileFailError
          fsRaceState.readFileFailPath = undefined // one-shot
          fsRaceState.readFileFailError = undefined
          throw error
        }
      }
      return actual.readFile(...args)
    }) as typeof actual.readFile,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [, flags] = args
      if (flags === 'wx' && fsRaceState.openWxFailError !== undefined) {
        const error = fsRaceState.openWxFailError
        fsRaceState.openWxFailError = undefined // one-shot
        throw error
      }
      return actual.open(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsRaceState.renameFailError !== undefined) {
        const error = fsRaceState.renameFailError
        fsRaceState.renameFailError = undefined // one-shot
        throw error
      }
      return actual.rename(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fsRaceState.rmFailError !== undefined) {
        const error = fsRaceState.rmFailError
        fsRaceState.rmFailError = undefined // one-shot
        throw error
      }
      return actual.rm(...args)
    },
  }
})

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'

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

function httpConfig(fixture: OAuthFixture, serverName: string): StreamableHttpConfig {
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
  box: { consentUrl: string | undefined; state: McpServerState; lastError: string | undefined }
} {
  const box: { consentUrl: string | undefined; state: McpServerState; lastError: string | undefined } =
    { consentUrl: undefined, state: 'connecting', lastError: undefined }
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
        ...(box.lastError === undefined ? {} : { lastError: box.lastError }),
      }
    },
    peekConsentUrl() { return box.consentUrl },
    reconnectNow,
    onStatusChange() { return () => {} },
    authProvider: provider,
    forceReconnectAfterAuthorization,
    reportAuthorizationFailure(message: string) { box.lastError = message },
  }
  return { handle, forceReconnectAfterAuthorization, reconnectNow, box }
}

/**
 * `authorizeStart` against a server that actually needs the shared loopback
 * listener (port 18700, hardcoded in {@link buildOAuthHandle}). Retried as
 * cheap insurance against the brief, legitimate window between a PRECEDING
 * test's `server.close()` call and the OS actually releasing the port —
 * every test below is careful to complete or otherwise settle its own flow
 * before finishing, so this should normally succeed on the first try. A
 * server that is deliberately unreachable (this file's own "not reachable"
 * test) never gets here at all — the reachability probe rejects first.
 */
async function authorizeStartOnSharedListener(
  registry: McpStatusRegistryService,
  serverName: string,
): ReturnType<McpStatusRegistryService['authorizeStart']> {
  return vi.waitFor(() => registry.authorizeStart(serverName), { timeout: 2_000, interval: 20 })
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
    // Defensively clear any one-shot injection an earlier test in this
    // block armed but never consumed (e.g. it threw before reaching the
    // matching fs call) -- never leak into a later test's fs calls.
    fsRaceState.readFileFailPath = undefined
    fsRaceState.readFileFailAtCall = 0
    fsRaceState.readFileFailCallsSeen = 0
    fsRaceState.readFileFailError = undefined
    fsRaceState.openWxFailError = undefined
    fsRaceState.renameFailError = undefined
    fsRaceState.rmFailError = undefined
  })

  it('register exposes the handle through list, and unregister removes it', async () => {
    const registry = new McpStatusRegistryService(ctx, { patchPath: join(dir, 'cordis.patch.yml') })
    const { handle } = buildOAuthHandle(fixture, ctx, 'listed')
    const config = httpConfig(fixture, 'listed')
    const unregister = registry.register(config, handle)

    expect(await registry.list()).toEqual([handle.status()])

    await unregister()
    expect(await registry.list()).toEqual([])
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
    await unregisterOld()
    expect(await registry.list()).toEqual([newHandle.status()])
  })

  it('list() synthesizes a disabled row (attempts 0, no live handle) for an OTHER mcp-client mount the patch file disables', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(
      patchPath,
      [
        '- id: live',
        '  name: \'@deepseek-ai/dsh-mcp-client\'',
        '- id: dormant',
        '  name: \'@deepseek-ai/dsh-mcp-client\'',
        '  disabled: true',
        '- id: other-plugin',
        '  name: \'@deepseek-ai/dsh-some-other-plugin\'',
        '  disabled: true',
        '',
      ].join('\n'),
      'utf8',
    )
    const registry = new McpStatusRegistryService(ctx, { patchPath })
    const { handle } = buildOAuthHandle(fixture, ctx, 'live')
    registry.register(httpConfig(fixture, 'live'), handle)

    const rows = await registry.list()
    expect(rows).toEqual(expect.arrayContaining([handle.status()]))
    expect(rows).toEqual(expect.arrayContaining([
      { serverName: 'dormant', state: 'disabled', attempts: 0, maxAttempts: 10 },
    ]))
    // The disabled mount belonging to a DIFFERENT plugin package must never
    // be reported as an mcp server.
    expect(rows.some(row => row.serverName === 'other-plugin')).toBe(false)
    expect(rows).toHaveLength(2)
  })

  it('a live handle wins over a stale patch-file disabled entry for the same serverName', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    // HMR / a reload race could momentarily leave the on-disk file still
    // saying `disabled: true` for a server that already has a live handle;
    // the live status must not be shadowed by the synthesized row.
    await writeFile(patchPath, '- id: both\n  name: \'@deepseek-ai/dsh-mcp-client\'\n  disabled: true\n', 'utf8')
    const registry = new McpStatusRegistryService(ctx, { patchPath })
    const { handle } = buildOAuthHandle(fixture, ctx, 'both')
    registry.register(httpConfig(fixture, 'both'), handle)

    expect(await registry.list()).toEqual([handle.status()])
  })

  it('a malformed patch file logs one warn and list() still returns live rows (ENOENT stays silent, malformed YAML does not)', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, ': : not yaml ][', 'utf8')
    const registry = new McpStatusRegistryService(ctx, { patchPath })
    const { handle } = buildOAuthHandle(fixture, ctx, 'live-despite-malformed')
    registry.register(httpConfig(fixture, 'live-despite-malformed'), handle)

    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    expect(await registry.list()).toEqual([handle.status()])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('not valid YAML')

    // A missing file, by contrast, is the ordinary no-patch-file deployment
    // shape and must stay silent. A fresh bare Context — `mcpStatus` is a
    // named service and `ctx` already has one registered above.
    const registryNoFile = new McpStatusRegistryService(new Context(), { patchPath: join(dir, 'does-not-exist.yml') })
    expect(await registryNoFile.list()).toEqual([])
    expect(warns).toHaveLength(1)
  })

  it('a non-ENOENT readFile failure (Error instance) logs one warn and list() still returns live rows', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, '- id: live\n  name: \'@deepseek-ai/dsh-mcp-client\'\n', 'utf8')
    const registry = new McpStatusRegistryService(ctx, { patchPath })
    const { handle } = buildOAuthHandle(fixture, ctx, 'live-despite-read-error')
    registry.register(httpConfig(fixture, 'live-despite-read-error'), handle)

    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException
    error.code = 'EACCES'
    fsRaceState.readFileFailPath = patchPath
    fsRaceState.readFileFailAtCall = 1
    fsRaceState.readFileFailError = error

    expect(await registry.list()).toEqual([handle.status()])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('cordis patch file could not be read')
    expect(warns[0]).toContain('EACCES')
  })

  it('a non-ENOENT readFile failure (non-Error thrown value) logs one warn and list() still returns live rows', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, '- id: live\n  name: \'@deepseek-ai/dsh-mcp-client\'\n', 'utf8')
    const registry = new McpStatusRegistryService(ctx, { patchPath })
    const { handle } = buildOAuthHandle(fixture, ctx, 'live-despite-nonerror-throw')
    registry.register(httpConfig(fixture, 'live-despite-nonerror-throw'), handle)

    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    // A deliberately non-Error thrown value: exercises the `String(error)`
    // ternary arm (the real fs module only ever throws Error instances, so
    // this is otherwise untestable without injecting the throw directly).
    fsRaceState.readFileFailPath = patchPath
    fsRaceState.readFileFailAtCall = 1
    fsRaceState.readFileFailError = 'a plain thrown string, not an Error'

    expect(await registry.list()).toEqual([handle.status()])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('a plain thrown string, not an Error')
  })

  it('a patch file that parses to a non-list value logs one warn and list() still returns live rows', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, 'serverName: not-a-list\n', 'utf8')
    const registry = new McpStatusRegistryService(ctx, { patchPath })
    const { handle } = buildOAuthHandle(fixture, ctx, 'live-despite-non-list')
    registry.register(httpConfig(fixture, 'live-despite-non-list'), handle)

    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    expect(await registry.list()).toEqual([handle.status()])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('does not contain a top-level list')
  })

  it('locateMcpMount and collectMcpPatchEntries ignore non-object top-level and nested entries while still finding the real mounts', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(
      patchPath,
      [
        '- null',
        '- a plain string top-level entry',
        '- id: group',
        '  insert:',
        '    - a plain string nested entry',
        '    - id: sibling',
        '      name: \'@deepseek-ai/dsh-mcp-client\'',
        '      disabled: true',
        '    - id: target',
        '      name: \'@deepseek-ai/dsh-mcp-client\'',
        '      disabled: true',
        '',
      ].join('\n'),
      'utf8',
    )
    const registry = new McpStatusRegistryService(ctx, { patchPath })

    // Exercises collectMcpPatchEntries (via list()): garbage entries at both
    // nesting levels are skipped, and the loop keeps going past the
    // non-matching `sibling` nested entry to find `target` too.
    const rows = await registry.list()
    expect(rows).toEqual(expect.arrayContaining([
      { serverName: 'sibling', state: 'disabled', attempts: 0, maxAttempts: 10 },
      { serverName: 'target', state: 'disabled', attempts: 0, maxAttempts: 10 },
    ]))
    expect(rows).toHaveLength(2)

    // Exercises the sibling function locateMcpMount (via setEnabled), over
    // the same garbage-entry shapes, continuing past `sibling` to reach
    // `target`.
    await registry.setEnabled('target', true)
    const written = await readFile(patchPath, 'utf8')
    expect(written).toMatch(/id: target\s*\n\s*name: '@deepseek-ai\/dsh-mcp-client'\s*\n\s*disabled: false/)
    expect(written).toMatch(/id: sibling\s*\n\s*name: '@deepseek-ai\/dsh-mcp-client'\s*\n\s*disabled: true/)
  })

  it('unregister emits a final mcp/status-changed with state disabled when the mount is still named (disabled) in the patch file', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, '- id: toggled\n  name: \'@deepseek-ai/dsh-mcp-client\'\n  disabled: true\n', 'utf8')
    const registry = new McpStatusRegistryService(ctx, { patchPath })
    const { handle } = buildOAuthHandle(fixture, ctx, 'toggled')
    const unregister = registry.register(httpConfig(fixture, 'toggled'), handle)

    const events: unknown[] = []
    ctx.on('mcp/status-changed', (status) => { events.push(status) })

    await unregister()

    expect(events).toEqual([
      { serverName: 'toggled', state: 'disabled', attempts: 0, maxAttempts: 10 },
    ])
  })

  it('unregister emits a final mcp/status-changed with removed: true when the mount is no longer in the patch file at all', async () => {
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, '- id: someone-else\n  name: \'@deepseek-ai/dsh-mcp-client\'\n', 'utf8')
    const registry = new McpStatusRegistryService(ctx, { patchPath })
    const { handle } = buildOAuthHandle(fixture, ctx, 'gone')
    const unregister = registry.register(httpConfig(fixture, 'gone'), handle)

    const events: unknown[] = []
    ctx.on('mcp/status-changed', (status) => { events.push(status) })

    await unregister()

    // `toEqual` pins the object exactly — including that it carries no
    // `consentUrl` key, since `handle.status()` never has one (SWD-164).
    expect(events).toEqual([{ ...handle.status(), removed: true }])
  })

  // Reviewer block: the identity check (`handles.get(name)?.handle !== handle`)
  // only proves "superseded" when the loader happens to register the
  // replacement BEFORE disposing the old fork. It must never be the SOLE
  // decision mechanism for "disabled" vs "removed" vs "ordinary reload" —
  // only a fast path for the one order where it's provably equivalent to
  // reading the file (a replacement is already live, so the mount is
  // provably enabled). Every other order falls through to reading the patch
  // file fresh. This matrix exercises both orderings crossed with all three
  // profile states.
  describe('unregister emit decision is order-independent, driven by the patch file', () => {
    it.each([
      { label: 'enabled', patch: (name: string) => `- id: ${name}\n  name: '@deepseek-ai/dsh-mcp-client'\n` },
      { label: 'disabled', patch: (name: string) => `- id: ${name}\n  name: '@deepseek-ai/dsh-mcp-client'\n  disabled: true\n` },
      { label: 'absent', patch: (_name: string) => '- id: someone-else\n  name: \'@deepseek-ai/dsh-mcp-client\'\n' },
    ])(
      'register-new-then-dispose-old, profile $label: the fast path short-circuits — no event, regardless of what the file says',
      async ({ label, patch }) => {
        const serverName = `order-a-${label}`
        const patchPath = join(dir, 'cordis.patch.yml')
        await writeFile(patchPath, patch(serverName), 'utf8')
        const registry = new McpStatusRegistryService(ctx, { patchPath })
        const config = httpConfig(fixture, serverName)
        const { handle: oldHandle } = buildOAuthHandle(fixture, ctx, serverName)
        const { handle: newHandle } = buildOAuthHandle(fixture, ctx, serverName)

        const unregisterOld = registry.register(config, oldHandle)
        registry.register(config, newHandle)

        const events: unknown[] = []
        ctx.on('mcp/status-changed', (status) => { events.push(status) })

        await unregisterOld()

        expect(events).toEqual([])
        expect(await registry.list()).toEqual([newHandle.status()])
      },
    )

    it('dispose-old-then-register-new, profile enabled: no event — the replacement reports its own status once it registers', async () => {
      const serverName = 'order-b-enabled'
      const patchPath = join(dir, 'cordis.patch.yml')
      await writeFile(patchPath, `- id: ${serverName}\n  name: '@deepseek-ai/dsh-mcp-client'\n`, 'utf8')
      const registry = new McpStatusRegistryService(ctx, { patchPath })
      const config = httpConfig(fixture, serverName)
      const { handle: oldHandle } = buildOAuthHandle(fixture, ctx, serverName)
      const { handle: newHandle } = buildOAuthHandle(fixture, ctx, serverName)

      const unregisterOld = registry.register(config, oldHandle)
      const events: unknown[] = []
      ctx.on('mcp/status-changed', (status) => { events.push(status) })

      // Dispose runs BEFORE the replacement registers: at this instant the
      // identity check sees `handle === oldHandle` (still the current
      // registration) and cannot short-circuit — it must read the file.
      await unregisterOld()
      expect(events).toEqual([])

      registry.register(config, newHandle)
      expect(await registry.list()).toEqual([newHandle.status()])
    })

    it('dispose-old-then-register-new, profile disabled: one disabled event, emitted before the replacement ever registers', async () => {
      const serverName = 'order-b-disabled'
      const patchPath = join(dir, 'cordis.patch.yml')
      await writeFile(patchPath, `- id: ${serverName}\n  name: '@deepseek-ai/dsh-mcp-client'\n  disabled: true\n`, 'utf8')
      const registry = new McpStatusRegistryService(ctx, { patchPath })
      const config = httpConfig(fixture, serverName)
      const { handle: oldHandle } = buildOAuthHandle(fixture, ctx, serverName)

      const unregisterOld = registry.register(config, oldHandle)
      const events: unknown[] = []
      ctx.on('mcp/status-changed', (status) => { events.push(status) })

      await unregisterOld()

      expect(events).toEqual([
        { serverName, state: 'disabled', attempts: 0, maxAttempts: 10 },
      ])
    })

    it('dispose-old-then-register-new, profile absent: one removed event, emitted before the replacement ever registers', async () => {
      const serverName = 'order-b-removed'
      const patchPath = join(dir, 'cordis.patch.yml')
      await writeFile(patchPath, '- id: someone-else\n  name: \'@deepseek-ai/dsh-mcp-client\'\n', 'utf8')
      const registry = new McpStatusRegistryService(ctx, { patchPath })
      const config = httpConfig(fixture, serverName)
      const { handle: oldHandle } = buildOAuthHandle(fixture, ctx, serverName)

      const unregisterOld = registry.register(config, oldHandle)
      const events: unknown[] = []
      ctx.on('mcp/status-changed', (status) => { events.push(status) })

      await unregisterOld()

      expect(events).toEqual([{ ...oldHandle.status(), removed: true }])
    })

    it('dispose-old-then-register-new, malformed patch file: no event — a failed read is not "absent", so it never reports removed', async () => {
      const serverName = 'order-b-malformed'
      const patchPath = join(dir, 'cordis.patch.yml')
      await writeFile(patchPath, ': : not yaml ][', 'utf8')
      const registry = new McpStatusRegistryService(ctx, { patchPath })
      const config = httpConfig(fixture, serverName)
      const { handle: oldHandle } = buildOAuthHandle(fixture, ctx, serverName)

      const warns: string[] = []
      vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

      const unregisterOld = registry.register(config, oldHandle)
      const events: unknown[] = []
      ctx.on('mcp/status-changed', (status) => { events.push(status) })

      await unregisterOld()

      expect(events).toEqual([])
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('not valid YAML')
    })
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

  it('runConsentCapture drops a completed callback silently (no error, pending-flow slot released) when its server deregistered first', async () => {
    const errors: string[] = []
    vi.spyOn(ctx.logger, 'error').mockImplementation(((message: unknown) => { errors.push(String(message)) }) as never)

    const { handle } = buildOAuthHandle(fixture, ctx, 'deregistered-mid-flow')
    const unregister = registry.register(httpConfig(fixture, 'deregistered-mid-flow'), handle)
    const { consentUrl } = await registry.authorizeStart('deregistered-mid-flow')
    const port = Number(new URL(handle.authProvider!.redirectUrl).port)
    const state = new URL(consentUrl).searchParams.get('state')!

    // The mount is deregistered (e.g. disabled or removed through the Tools
    // panel) while a stale consent tab is still open.
    await unregister()

    const response = await fetch(`http://127.0.0.1:${port}/callback?code=stale-code&state=${state}`)
    expect(response.ok).toBe(true)

    // runConsentCapture resumes in the background, finds no entry for the
    // now-deregistered server, and returns without attempting a token
    // exchange or logging an error — but it still releases the pending-flow
    // slot via its `finally`.
    await vi.waitFor(() => {
      expect((registry as unknown as { pendingFlow: string | undefined }).pendingFlow).toBeUndefined()
    })
    expect(errors).toHaveLength(0)
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

  it('a timed-out consent capture logs, reports lastError on the row, and releases the slot for the next caller', async () => {
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
      // SWD-164 pilot finding: this used to be logged here and nowhere
      // else — a client watching the row never learned the 5-minute
      // consent timeout happened at all.
      expect(handle.status().lastError).toBe('Authorization timed out after 5 minutes — try again')

      // The slot is released: a new flow may start immediately.
      const { handle: nextHandle, forceReconnectAfterAuthorization: nextForceReconnect } = buildOAuthHandle(fixture, ctx, 'next-srv')
      registry.register(httpConfig(fixture, 'next-srv'), nextHandle)
      const released = await registry.authorizeStart('next-srv')
      expect(typeof released.consentUrl).toBe('string')

      // Complete this flow too so its real listener does not stay bound to
      // the shared port into a later test (same reason the "second
      // authorize-start" test above completes its own trailing flow).
      vi.useRealTimers()
      const nextState = new URL(released.consentUrl).searchParams.get('state')!
      const nextPort = new URL(nextHandle.authProvider!.redirectUrl).port
      const nextResponse = await fetch(`http://127.0.0.1:${nextPort}/callback?code=auth-code-next-srv&state=${nextState}`)
      expect(nextResponse.ok).toBe(true)
      await vi.waitFor(() => { expect(nextForceReconnect).toHaveBeenCalledTimes(1) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a consent denial (non-timeout exchange failure) reports the redacted real error as lastError', async () => {
    const { handle } = buildOAuthHandle(fixture, ctx, 'denied-srv')
    registry.register(httpConfig(fixture, 'denied-srv'), handle)
    const { consentUrl } = await authorizeStartOnSharedListener(registry, 'denied-srv')
    const state = new URL(consentUrl).searchParams.get('state')!
    const port = new URL(handle.authProvider!.redirectUrl).port

    // The user denies consent: the authorization server redirects back with
    // `error`, not `code` — a real failure distinct from the listener's own
    // timeout, so it must take the "redacted real error" branch, not the
    // fixed timeout message.
    const response = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=${state}`)
    expect(response.ok).toBe(true)

    await vi.waitFor(() => {
      expect(handle.status().lastError).toMatch(/authorization server redirected with error: access_denied/)
    })
    expect(handle.status().lastError).not.toContain('timed out')
  })

  it('rejects authorize-start immediately when the server is unreachable, instead of handing back a dead-page URL', async () => {
    // A port nothing is listening on: bind then release it immediately so
    // the OS frees it, but no server is live when the probe fires.
    const probe = createServer()
    await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
    const address = probe.address()
    if (address === null || typeof address === 'string') throw new Error('no probe port')
    const deadPort = address.port
    await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })

    const { handle } = buildOAuthHandle(fixture, ctx, 'down')
    registry.register({ ...httpConfig(fixture, 'down'), url: `http://127.0.0.1:${deadPort}/mcp` }, handle)

    await expect(registry.authorizeStart('down')).rejects.toThrow(/is not reachable/)
    // The single-flight slot must be released on this up-front rejection too.
    const { handle: nextHandle } = buildOAuthHandle(fixture, ctx, 'next-after-down')
    registry.register(httpConfig(fixture, 'next-after-down'), nextHandle)
    const released = await authorizeStartOnSharedListener(registry, 'next-after-down')
    expect(typeof released.consentUrl).toBe('string')
  })

  it('treats a redirect response from the reachability probe as reachable, not a dead server', async () => {
    // `redirect: 'manual'` means `fetch` itself never chases this 3xx — the
    // probe must accept the 302 response itself as proof the server is up.
    // Every other request gets a fixed 500 so the SDK's own OAuth discovery
    // fails cleanly and deterministically right after (never reaching the
    // shared port listener — nothing to clean up) without ever following
    // the redirect target anywhere: this test only cares that the eventual
    // rejection is THAT discovery failure, never the probe's own "is not
    // reachable".
    const redirecting = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(302, { Location: '/elsewhere' })
        response.end()
        return
      }
      response.writeHead(500)
      response.end()
    })
    await new Promise<void>((resolve) => { redirecting.listen(0, '127.0.0.1', resolve) })
    const address = redirecting.address()
    if (address === null || typeof address === 'string') throw new Error('no redirect-server port')
    const redirectingPort = address.port

    try {
      const { handle } = buildOAuthHandle(fixture, ctx, 'redirecting')
      registry.register({ ...httpConfig(fixture, 'redirecting'), url: `http://127.0.0.1:${redirectingPort}/mcp` }, handle)

      const error = await registry.authorizeStart('redirecting').then(
        () => { throw new Error('UNEXPECTED_SUCCESS: expected sdkAuth discovery to fail against a fixed-500 fake server') },
        (rejected: unknown) => rejected,
      )
      expect(String(error)).not.toMatch(/is not reachable/)
    } finally {
      await new Promise<void>((resolve) => { redirecting.close(() => { resolve() }) })
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
    // Defensively clear any one-shot injection an earlier test in this
    // block armed but never consumed (e.g. it threw before reaching the
    // matching fs call) -- never leak into a later test's fs calls.
    fsRaceState.readFileFailPath = undefined
    fsRaceState.readFileFailAtCall = 0
    fsRaceState.readFileFailCallsSeen = 0
    fsRaceState.readFileFailError = undefined
    fsRaceState.openWxFailError = undefined
    fsRaceState.renameFailError = undefined
    fsRaceState.rmFailError = undefined
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

  it('fails loud (Error instance) when the backup file cannot be created for a reason other than it already existing', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException
    error.code = 'EACCES'
    fsRaceState.openWxFailError = error
    await expect(registry.setEnabled('srv', false)).rejects.toThrow(/could not be backed up before set-enabled.*EACCES/s)
  })

  it('fails loud (non-Error thrown value) when the backup file cannot be created for a reason other than it already existing', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    fsRaceState.openWxFailError = 'a plain thrown string, not an Error'
    await expect(registry.setEnabled('srv', false)).rejects.toThrow(/could not be backed up before set-enabled.*a plain thrown string, not an Error/s)
  })

  it('rejects the initial read (non-Error thrown value) with the error folded into the message', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    fsRaceState.readFileFailPath = patchPath
    fsRaceState.readFileFailAtCall = 1
    fsRaceState.readFileFailError = 'a plain thrown string, not an Error'
    await expect(registry.setEnabled('srv', false))
      .rejects.toThrow(/cordis patch file could not be read.*a plain thrown string, not an Error/s)
  })

  it('rejects the pre-rename re-check (Error instance) when the file disappears between the two reads', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    const error = new Error('EIO: i/o error') as NodeJS.ErrnoException
    error.code = 'EIO'
    fsRaceState.readFileFailPath = patchPath
    fsRaceState.readFileFailAtCall = 2
    fsRaceState.readFileFailError = error
    await expect(registry.setEnabled('srv', false))
      .rejects.toThrow(/could not be re-read for the concurrency check.*EIO/s)
  })

  it('rejects the pre-rename re-check (non-Error thrown value) when the file disappears between the two reads', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    fsRaceState.readFileFailPath = patchPath
    fsRaceState.readFileFailAtCall = 2
    fsRaceState.readFileFailError = 'a plain thrown string, not an Error'
    await expect(registry.setEnabled('srv', false))
      .rejects.toThrow(/could not be re-read for the concurrency check.*a plain thrown string, not an Error/s)
  })

  it('fails loud (Error instance) when the atomic rename fails, and the temp-file cleanup failure itself is swallowed', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    const renameError = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
    renameError.code = 'EXDEV'
    const rmError = new Error('EACCES: permission denied') as NodeJS.ErrnoException
    rmError.code = 'EACCES'
    fsRaceState.renameFailError = renameError
    // The temp-file cleanup itself also fails (not ENOENT, so `force: true`
    // does not swallow it) — the outer failure must still win and the
    // cleanup's own rejection must be caught, not left unhandled.
    fsRaceState.rmFailError = rmError
    await expect(registry.setEnabled('srv', false))
      .rejects.toThrow(/could not be written atomically.*EXDEV/s)
    // The original content is untouched — the failed write never replaced it.
    const written = await readFile(patchPath, 'utf8')
    expect(written).toMatch(/id: srv\s*\n\s*disabled: true/)
  })

  it('fails loud (non-Error thrown value) when the atomic rename fails', async () => {
    await writeFile(patchPath, '- id: srv\n  disabled: true\n', 'utf8')
    fsRaceState.renameFailError = 'a plain thrown string, not an Error'
    await expect(registry.setEnabled('srv', false))
      .rejects.toThrow(/could not be written atomically.*a plain thrown string, not an Error/s)
  })
})

describe('ensureStatusRegistry — lazy mount-once-per-root dedup', () => {
  // Neither test below exercises the default patchPath resolution (that is
  // `defaultPatchPath`'s own describe block, below) — these bare Contexts
  // have no `baseUrl`, so an explicit patchPath is required regardless of
  // what defaultPatchPath would otherwise resolve.
  it('two calls on the same root resolve to the same instance', async () => {
    const ctx = new Context()
    try {
      const [a, b] = await Promise.all([
        ensureStatusRegistry(ctx, { patchPath: '/nonexistent/cordis.patch.yml' }),
        ensureStatusRegistry(ctx, { patchPath: '/nonexistent/cordis.patch.yml' }),
      ])
      expect(a).toBe(b)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a derived context\'s call still mounts on the shared root', async () => {
    const root = new Context()
    try {
      const child = root.extend()
      const [fromRoot, fromChild] = await Promise.all([
        ensureStatusRegistry(root, { patchPath: '/nonexistent/cordis.patch.yml' }),
        ensureStatusRegistry(child, { patchPath: '/nonexistent/cordis.patch.yml' }),
      ])
      expect(fromRoot).toBe(fromChild)
    } finally {
      await root.fiber.dispose()
    }
  })
})

describe('defaultPatchPath — derives the patch-file path from the running profile, never a hardcoded name', () => {
  it('resolves under profiles/web when ctx.baseUrl is the web profile directory', async () => {
    const ctx = new Context()
    ctx.baseUrl = 'file:///home/dsh/profiles/web/'
    try {
      const registry = await ensureStatusRegistry(ctx)
      expect((registry as unknown as { patchPath: string }).patchPath)
        .toBe('/home/dsh/profiles/web/cordis.patch.yml')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never throws (mcp-client must still mount with no profile loader) when ctx.baseUrl is unset and no patchPath is given — warns once, degrades gracefully', async () => {
    // e2e harnesses and embedded hosts have no `@deepseek-ai/dsh-app-boot`
    // profile loader mounted at all, so `ctx.baseUrl` is never set — that
    // must never block mcp-client activation (SWD-164 pilot finding:
    // mcp-client.e2e.ts failed to mount entirely before this fix).
    const ctx = new Context()
    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    const registry = await ensureStatusRegistry(ctx)
    expect(warns.some(line => line.includes('ctx.baseUrl is unset'))).toBe(true)

    // list() degrades to live rows only — no synthesized disabled rows, but
    // no throw either.
    await expect(registry.list()).resolves.toEqual([])
    // set-enabled has no file to edit on this host and must say so loudly,
    // never silently no-op or guess a path.
    await expect(registry.setEnabled('srv', true)).rejects.toThrow(/this host has no profile file to edit/)

    await ctx.fiber.dispose()
  })
})

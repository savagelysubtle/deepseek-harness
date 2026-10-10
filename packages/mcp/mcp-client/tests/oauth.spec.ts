/**
 * OAuth tests for the mcp-client plugin: real SDK transport against an
 * in-process consent-gated MCP fixture (no SDK mocks). Covers the manual
 * consent CLI end to end, host-side token pickup and refresh rotation,
 * containment when consent is missing, fail-loud config, and envelope
 * corruption handling.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

import { startOAuthFixture, type OAuthFixture } from './oauth-fixture.ts'
import { oauthCredentialRef, CredentialsOAuthProvider }
  from '@deepseek-ai/dsh-mcp-client/src/oauth.ts'
import { apply as mcpApply, inject as mcpInject, name as mcpName, Config as ConfigSchema, DEFAULT_OAUTH_REDIRECT_PORT }
  from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { runAuthCli } from '@deepseek-ai/dsh-mcp-client/src/auth-cli.ts'
import { startConnection, resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'

async function mountRegistry(credentialsPath?: string): Promise<Context> {
  const ctx = new Context()
  // No profile loader is mounted in these tests, so the status registry's
  // default cordis.patch.yml resolution (ctx.baseUrl) needs a stand-in — see
  // defaultPatchPath in status-registry.ts. The path is never read or
  // written by these tests; it only has to resolve to something.
  ctx.baseUrl = 'file:///test-profile/'
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (credentialsPath !== undefined) {
    await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, watch: false })
  }
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

describe('OAuth config schema', () => {
  it('materializes redirectPort default and leaves scope/clientId optional', () => {
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'supa',
      url: 'http://127.0.0.1/mcp',
      auth: { mode: 'oauth' },
    } as never)
    // transport is Config's discriminant: auth exists only on the streamable-http branch.
    if (resolved.transport !== 'streamable-http') {
      throw new Error('the streamable-http config resolved into the stdio branch')
    }
    expect(resolved.auth).toEqual({ mode: 'oauth', redirectPort: DEFAULT_OAUTH_REDIRECT_PORT })
  })

  it('rejects an unknown auth mode', () => {
    expect(() => ConfigSchema({
      transport: 'streamable-http',
      serverName: 'supa',
      url: 'http://127.0.0.1/mcp',
      auth: { mode: 'apikey' },
    } as never)).toThrow()
  })

  it('fails activation when an auth block rides a stdio server', async () => {
    // Schemastery unions strip unknown keys per branch, so the schema alone
    // would drop the auth block silently; apply() owns the loud failure.
    const fixture = await startOAuthFixture()
    try {
      const ctx = await mountRegistry()
      await expect(mcpApply(ctx, {
        ...httpConfig(fixture, 'supa'),
        transport: 'stdio',
        command: 'echo',
        args: [],
        env: {},
        cwd: '',
      })).rejects.toThrow(/auth\.oauth applies only to transport: streamable-http/)
      await ctx.fiber.dispose()
    } finally {
      await fixture.close()
    }
  })
})

describe('fail-loud wiring', () => {
  // Shipped activation polls up to 10s (CREDENTIALS_WAIT_TIMEOUT_MS) for a
  // late-mounting credential service before rejecting; the reject path under
  // test is the exhausted poll, so this case's budget clears that bound.
  const credentialsWaitBudgetMs = 15_000
  it('rejects activation when auth is configured without the credential service', async () => {
    const fixture = await startOAuthFixture()
    try {
      const ctx = await mountRegistry()
      await expect(mcpApply(ctx, httpConfig(fixture, 'supa')))
        .rejects.toThrow(/auth\.oauth requires the credential-reference service/)
      expect(ctx.tools.get('mcp__supa__ping')).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      await fixture.close()
    }
  }, credentialsWaitBudgetMs)
})

describe('consent CLI and host pickup', () => {
  it('runs the full consent flow through runAuthCli and stores tokens in the credentials document', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    // The CLI's loopback capture port; distinct per test run to avoid collisions.
    const port = 15_400 + Math.floor(Math.random() * 300)
    try {
      const lines: string[] = []
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
        lines.push(parts.map(part => String(part)).join(' '))
      })
      const run = runAuthCli([
        '--url', fixture.url,
        '--server-name', 'supa',
        '--credentials-path', credPath,
        '--redirect-port', String(port),
        '--timeout-ms', '15000',
        // --reset on a not-yet-populated store is a no-op (nothing to drop);
        // --scope exercises parseArgs' and runAuthCli's scope-forwarding
        // branches end to end. The fixture ignores the scope value.
        '--reset',
        '--scope', 'mcp:tools',
      ])
      await vi.waitFor(() => {
        expect(lines.some(line => line.includes('Open this URL'))).toBe(true)
      })
      // Emulate the user's browser: follow the printed authorization URL; the
      // fixture consents instantly and redirects into the CLI's loopback listener.
      const matched = lines.join('\n').match(/https?:\/\/\S+/)
      if (matched === null) throw new Error('the CLI never printed an authorization URL')
      const browserResponse = await fetch(matched[0], { redirect: 'follow' })
      expect(browserResponse.ok).toBe(true)
      await run

      const stored = await readFile(credPath, 'utf8')
      expect(stored).toContain('DSH_MCP_OAUTH_SUPA')
      expect(stored).toContain('at-cli')
      logSpy.mockRestore()

      // The stored envelope parses back into live state.
      const ctx = await mountRegistry(credPath)
      const provider = CredentialsOAuthProvider.create({
        serverName: 'supa',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: `http://127.0.0.1:${port}/callback`,
      })
      expect(await provider.tokens()).toMatchObject({ access_token: 'at-cli', refresh_token: 'rt-1' })
      expect(await provider.clientInformation()).toMatchObject({ client_id: 'dyn-client-1' })
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('a running host picks up CLI-written tokens and rotates them on refresh', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      // Seed exactly what a completed CLI login leaves behind.
      const seeded = await mountRegistry(credPath)
      const ref = oauthCredentialRef('supa')
      await seeded.credentials.set(ref, JSON.stringify({
        version: 1,
        tokens: { access_token: 'at-stale', refresh_token: 'rt-1', token_type: 'Bearer' },
        clientInformation: { client_id: 'dyn-client-1' },
      }))
      await seeded.fiber.dispose()

      // The fixture rejects at-stale with 401; the transport must refresh
      // through the stored grant and retry without any human action. The
      // rotation result is the only bearer the fixture accepts from now on.
      fixture.setValidToken('at-rotated')
      const ctx = await mountRegistry(credPath)
      const fiber = ctx.plugin({ name: mcpName, inject: mcpInject, apply: mcpApply }, httpConfig(fixture, 'supa'))
      await vi.waitFor(() => {
        expect(ctx.tools.get('mcp__supa__ping')).toBeDefined()
      })

      expect(fixture.tokenRequests.map(request => request.grant_type)).toContain('refresh_token')
      const rotated = JSON.parse((await ctx.credentials.resolve(ref))!.value) as {
        tokens: { access_token: string }
      }
      expect(rotated.tokens.access_token).toBe('at-rotated')
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('contains the missing-consent failure: no tools, no throw, guidance instead', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    const errors: string[] = []
    try {
      const ctx = await mountRegistry(credPath)
      vi.spyOn(ctx.logger, 'error').mockImplementation(((message: unknown) => {
        errors.push(String(message))
      }) as never)
      await expect(mcpApply(ctx, httpConfig(fixture, 'noconsent'))).resolves.toBeUndefined()
      expect(ctx.tools.get('mcp__noconsent__ping')).toBeUndefined()
      await ctx.fiber.dispose()
      expect(errors.join('\n')).toMatch(/human consent required/)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })
})

describe('stored-state robustness', () => {
  it('fails loud on a corrupted credential envelope instead of looping consent', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const ref = oauthCredentialRef('corrupt')
      await ctx.credentials.set(ref, '{not json')
      const provider = CredentialsOAuthProvider.create({
        serverName: 'corrupt',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19999/callback',
      })
      await expect(provider.tokens()).rejects.toThrow(/stored OAuth state under DSH_MCP_OAUTH_CORRUPT is not valid JSON/)
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('invalidate drops scoped state and all removes the reference', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const ref = oauthCredentialRef('scope-test')
      const provider = CredentialsOAuthProvider.create({
        serverName: 'scope-test',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19998/callback',
      })
      await provider.saveClientInformation({ client_id: 'c1' })
      await provider.saveTokens({ access_token: 'a1', token_type: 'Bearer' })
      await provider.saveCodeVerifier('verifier')

      await provider.invalidateCredentials('tokens')
      expect(await provider.tokens()).toBeUndefined()
      expect(await provider.clientInformation()).toMatchObject({ client_id: 'c1' })
      expect(await provider.codeVerifier()).toBe('verifier')

      await provider.invalidateCredentials('all')
      expect(await ctx.credentials.resolve(ref)).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('rejects a stored envelope at the wrong version', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const ref = oauthCredentialRef('wrong-version')
      await ctx.credentials.set(ref, JSON.stringify({ version: 2 }))
      const provider = CredentialsOAuthProvider.create({
        serverName: 'wrong-version',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19995/callback',
      })
      await expect(provider.tokens()).rejects.toThrow(/stored OAuth state under DSH_MCP_OAUTH_WRONG_VERSION is not a version 1 envelope/)
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('rejects a stored tokens entry that is not an object', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const ref = oauthCredentialRef('bad-tokens')
      await ctx.credentials.set(ref, JSON.stringify({ version: 1, tokens: 'nope' }))
      const provider = CredentialsOAuthProvider.create({
        serverName: 'bad-tokens',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19994/callback',
      })
      await expect(provider.tokens()).rejects.toThrow(/stored OAuth state under DSH_MCP_OAUTH_BAD_TOKENS has an invalid tokens entry/)
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('rejects a stored codeVerifier entry that is not a string', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const ref = oauthCredentialRef('bad-verifier')
      await ctx.credentials.set(ref, JSON.stringify({ version: 1, codeVerifier: 123 }))
      const provider = CredentialsOAuthProvider.create({
        serverName: 'bad-verifier',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19993/callback',
      })
      await expect(provider.tokens())
        .rejects.toThrow(/stored OAuth state under DSH_MCP_OAUTH_BAD_VERIFIER has an invalid codeVerifier entry/)
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })
})

describe('CredentialsOAuthProvider direct unit coverage', () => {
  it('clientMetadata forwards a configured scope', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const provider = CredentialsOAuthProvider.create({
        serverName: 'scope-meta',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19992/callback',
        scope: 'mcp:tools extra',
      })
      expect(provider.clientMetadata.scope).toBe('mcp:tools extra')
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('codeVerifier throws when none is pending', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const provider = CredentialsOAuthProvider.create({
        serverName: 'no-verifier',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19991/callback',
      })
      await expect(provider.codeVerifier()).rejects.toThrow(
        /no pending PKCE verifier under DSH_MCP_OAUTH_NO_VERIFIER — restart the login command/,
      )
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('a static client id bypasses both the store read and the dynamic-registration write', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const provider = CredentialsOAuthProvider.create({
        serverName: 'static-client',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19990/callback',
        staticClientId: 'preset-client-1',
      })
      expect(await provider.clientInformation()).toEqual({ client_id: 'preset-client-1' })

      // Attempting to persist a dynamic registration must be a silent no-op:
      // the static id always wins and the store is never written.
      await provider.saveClientInformation({ client_id: 'dyn-would-be-1' })
      expect(await provider.clientInformation()).toEqual({ client_id: 'preset-client-1' })
      expect(await ctx.credentials.resolve(oauthCredentialRef('static-client'))).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('invalidateCredentials clears client, verifier, and discovery independently', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const provider = CredentialsOAuthProvider.create({
        serverName: 'scoped-invalidate',
        serverUrl: new URL(fixture.url),
        store: ctx.credentials,
        redirectUri: 'http://127.0.0.1:19989/callback',
      })
      await provider.saveClientInformation({ client_id: 'c1' })
      await provider.saveCodeVerifier('verifier')
      await provider.saveDiscoveryState({ authorizationServerUrl: 'https://as.example' })

      await provider.invalidateCredentials('client')
      expect(await provider.clientInformation()).toBeUndefined()
      // Unrelated state classes survive a scoped invalidate.
      expect(await provider.codeVerifier()).toBe('verifier')
      expect(await provider.discoveryState()).toBeDefined()

      await provider.invalidateCredentials('verifier')
      await expect(provider.codeVerifier()).rejects.toThrow(/no pending PKCE verifier/)

      await provider.invalidateCredentials('discovery')
      expect(await provider.discoveryState()).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })
})

describe('resolveAuthProvider (connection.ts) direct wiring', () => {
  it('a direct startConnection caller gets the same named diagnostic apply() fails loud with', async () => {
    const fixture = await startOAuthFixture()
    try {
      // No credentials plugin mounted: ctx.get('credentials') is undefined.
      const ctx = await mountRegistry()
      const config: Config = { ...httpConfig(fixture, 'direct-no-creds'), reconnect: { enabled: false } }
      expect(() => startConnection(ctx, config, resolveReconnectPolicy(undefined, 'reconnect')))
        .toThrow(/direct-no-creds\): auth\.oauth requires the credential-reference service — mount @deepseek-ai\/dsh-credentials-local/)
      await ctx.fiber.dispose()
    } finally {
      await fixture.close()
    }
  })

  it('logs consent guidance once per server across repeated reconnect attempts, with scope and clientId forwarded', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const errors: string[] = []
      vi.spyOn(ctx.logger, 'error').mockImplementation(((message: unknown) => {
        errors.push(String(message))
      }) as never)
      const config: Config = {
        transport: 'streamable-http',
        serverName: 'noconsent-repeat',
        url: fixture.url,
        headers: {},
        auth: { mode: 'oauth', scope: 'mcp:tools', clientId: 'preset-repeat-1' },
        toolCallTimeoutMs: 10_000,
        failOnStartupError: false,
        reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 20, maxAttempts: 3 },
      }
      await mcpApply(ctx, config)
      await vi.waitFor(() => {
        expect(errors.some(line => line.includes('giving up after 3 consecutive failed reconnect attempts'))).toBe(true)
      })
      // The full consent guidance (URL + instructions) is logged exactly once
      // even though every one of the 4 attempts hits the same auth-required path.
      expect(errors.filter(line => line.includes('human consent required')).length).toBe(1)
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('a fresh 401 against a streamable-http server leaves status() at needs-authorization, with the consent URL captured internally only (never on the public status)', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const config: Config = {
        ...httpConfig(fixture, 'needs-auth'),
        // A large initialDelayMs keeps the armed reconnect timer from firing
        // (and re-entering scheduleReconnect) during the assertion window —
        // the connection stays parked in `needs-authorization`.
        reconnect: { enabled: true, initialDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 5 },
      }
      const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'reconnect'))
      await handle.ready
      const status = handle.status()
      expect(status.state).toBe('needs-authorization')
      // consentUrl is deliberately absent from the public status object (it
      // carries the CSRF `state`; SWD-164 sentinel finding) — only the
      // internal peek `authorize-start` itself uses sees it.
      expect('consentUrl' in status).toBe(false)
      const consentUrl = handle.peekConsentUrl()
      expect(consentUrl).toBeDefined()
      expect(new URL(consentUrl!).pathname).toBe('/authorize')
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })

  it('a redirect reported after disposal is ignored (onNeedsAuthorization no-ops once disposed)', async () => {
    const fixture = await startOAuthFixture()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
    const credPath = join(dir, 'creds.yaml')
    try {
      const ctx = await mountRegistry(credPath)
      const config: Config = {
        ...httpConfig(fixture, 'needs-auth-disposed'),
        reconnect: { enabled: true, initialDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 5 },
      }
      const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'reconnect'))
      await handle.ready
      expect(handle.status().state).toBe('needs-authorization')
      const consentUrlBeforeDispose = handle.peekConsentUrl()
      expect(consentUrlBeforeDispose).toBeDefined()

      await handle.dispose()

      // A straggling attempt's redirect, reported by the SDK after disposal
      // already ran, must be a flat no-op: no new consent URL captured, no
      // state mutation.
      handle.authProvider!.redirectToAuthorization(new URL('https://attacker.example/authorize?fresh=1'))
      expect(handle.peekConsentUrl()).toBe(consentUrlBeforeDispose)
      expect(handle.status().state).toBe('needs-authorization')

      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await fixture.close()
    }
  })
})

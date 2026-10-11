/**
 * SWD-167 regression: `auth` must be genuinely optional on the
 * streamable-http Config branch. Schemastery gives every `z.object()` an
 * implicit `default: {}`, so an omitted `auth` used to be backfilled to
 * `{}` and then fail `auth.mode missing required value` — the exact shape
 * of the README's own header-only, static-token example.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import { Config as ConfigSchema, DEFAULT_OAUTH_REDIRECT_PORT } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { startConnection, resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import { startOAuthFixture, type OAuthFixture } from './oauth-fixture.ts'

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = 'file:///test-profile/'
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function headerOnlyConfig(fixture: OAuthFixture, serverName: string, token: string): Config {
  return {
    transport: 'streamable-http',
    serverName,
    url: fixture.url,
    headers: { Authorization: `Bearer ${token}` },
    toolCallTimeoutMs: 10_000,
    failOnStartupError: false,
    reconnect: { enabled: false },
  }
}

describe('streamable-http Config schema: auth is optional (SWD-167)', () => {
  it('a header-only config (no auth block) validates and produces no auth', () => {
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1/mcp',
      headers: { Authorization: 'Bearer static-token' },
    } as never)
    if (resolved.transport !== 'streamable-http') {
      throw new Error('the streamable-http config resolved into the stdio branch')
    }
    expect(resolved.auth).toBeUndefined()
    expect('auth' in resolved).toBe(false)
  })

  it('the validated config keeps headers.Authorization verbatim', () => {
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1/mcp',
      headers: { Authorization: 'Bearer static-token' },
    } as never)
    if (resolved.transport !== 'streamable-http') {
      throw new Error('the streamable-http config resolved into the stdio branch')
    }
    expect(resolved.headers).toEqual({ Authorization: 'Bearer static-token' })
  })

  it('auth: { mode: "oauth" } still validates exactly as before', () => {
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'supa',
      url: 'http://127.0.0.1/mcp',
      auth: { mode: 'oauth' },
    } as never)
    if (resolved.transport !== 'streamable-http') {
      throw new Error('the streamable-http config resolved into the stdio branch')
    }
    expect(resolved.auth).toEqual({ mode: 'oauth', redirectPort: DEFAULT_OAUTH_REDIRECT_PORT })
  })

  it('an unknown auth mode still fails validation', () => {
    expect(() => ConfigSchema({
      transport: 'streamable-http',
      serverName: 'supa',
      url: 'http://127.0.0.1/mcp',
      auth: { mode: 'apikey' },
    } as never)).toThrow()
  })

  it('auth: null (a bare `auth:` key in YAML) is treated exactly like an omitted auth', () => {
    const resolved = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1/mcp',
      auth: null,
    } as never)
    if (resolved.transport !== 'streamable-http') {
      throw new Error('the streamable-http config resolved into the stdio branch')
    }
    expect(resolved.auth).toBeUndefined()
    expect('auth' in resolved).toBe(false)
  })
})

describe('Config validation never leaks a secret through the union error dump (SWD-167 round 2)', () => {
  const secret = 'Bearer MY-SUPER-SECRET-TOKEN-1234'

  it('a header-only config with a missing url (an unrelated field) throws WITHOUT the secret, and still names the broken field', () => {
    let caught: unknown
    try {
      ConfigSchema({
        transport: 'streamable-http',
        serverName: 'web',
        // `url` omitted — the error must name this, not dump headers.
        headers: { Authorization: secret },
      } as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const message = (caught as Error).message
    expect(message).not.toContain(secret)
    expect(String(caught)).not.toContain(secret)
    expect(message).toContain('url')
  })

  it('a header-only config with an invalid serverName throws WITHOUT the secret, and still names the broken field', () => {
    let caught: unknown
    try {
      ConfigSchema({
        transport: 'streamable-http',
        serverName: 'bad name has spaces!',
        url: 'http://127.0.0.1/mcp',
        headers: { Authorization: secret },
      } as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const message = (caught as Error).message
    expect(message).not.toContain(secret)
    expect(String(caught)).not.toContain(secret)
    expect(message).toContain('serverName')
  })

  it('a header-only config with a wrong-typed field throws WITHOUT the secret, and still names the broken field', () => {
    let caught: unknown
    try {
      ConfigSchema({
        transport: 'streamable-http',
        serverName: 'web',
        url: 'http://127.0.0.1/mcp',
        headers: { Authorization: secret },
        toolCallTimeoutMs: 'not-a-number',
      } as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const message = (caught as Error).message
    expect(message).not.toContain(secret)
    expect(String(caught)).not.toContain(secret)
    expect(message).toContain('toolCallTimeoutMs')
  })

  it('a missing/unknown transport throws WITHOUT the secret, and still names the problem', () => {
    let caught: unknown
    try {
      ConfigSchema({
        serverName: 'web',
        url: 'http://127.0.0.1/mcp',
        headers: { Authorization: secret },
      } as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const message = (caught as Error).message
    expect(message).not.toContain(secret)
    expect(String(caught)).not.toContain(secret)
    expect(message).toContain('transport')
  })
})

/**
 * Assert neither `.message` nor `String(error)` contains `secret`, via both
 * the call form and the `~standard` form cordis actually uses. Shared by the
 * round 3 (headers/env) and round 4 (any field) leak-redaction suites.
 */
function assertRedacted(config: unknown, namedKey: string, secret: string): void {
  let caught: unknown
  try {
    ConfigSchema(config as never)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeDefined()
  const message = (caught as Error).message
  expect(message).not.toContain(secret)
  expect(String(caught)).not.toContain(secret)
  expect(message).toContain(namedKey)

  const result = (ConfigSchema as never as { '~standard': { validate(v: unknown): { issues?: { message: string }[] } } })['~standard'].validate(config)
  expect(result.issues).toBeDefined()
  const issueMessage = result.issues![0]!.message
  expect(issueMessage).not.toContain(secret)
  expect(issueMessage).toContain(namedKey)
}

describe('headers/env values never leak through a validation error, at any depth (SWD-167 round 3)', () => {
  const secret = 'Bearer MY-SUPER-SECRET-TOKEN-5678'

  it('headers given as a string (not a mapping) withholds the secret but still names headers', () => {
    assertRedacted({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1/mcp',
      headers: secret,
    }, 'headers', secret)
  })

  it('headers.Authorization as an array containing the secret withholds it but still names headers.Authorization', () => {
    assertRedacted({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1/mcp',
      headers: { Authorization: [secret, 'x'] },
    }, 'headers.Authorization', secret)
  })

  it('a custom-toString object as a header value withholds the secret but still names headers.Authorization', () => {
    assertRedacted({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1/mcp',
      headers: { Authorization: { toString() { return secret } } },
    }, 'headers.Authorization', secret)
  })

  it('stdio env given as a string (not a mapping) withholds the secret but still names env', () => {
    assertRedacted({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      env: secret,
    }, 'env', secret)
  })

  it('a stdio env value as an array containing the secret withholds it but still names env.API_KEY', () => {
    assertRedacted({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      env: { API_KEY: [secret, 'x'] },
    }, 'env.API_KEY', secret)
  })

  it('transport set to a secret-shaped string never echoes it, and still names transport', () => {
    let caught: unknown
    try {
      ConfigSchema({
        transport: secret,
        serverName: 'web',
        url: 'http://127.0.0.1/mcp',
      } as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const message = (caught as Error).message
    expect(message).not.toContain(secret)
    expect(String(caught)).not.toContain(secret)
    expect(message).toContain('transport')
  })

  it('a non-object top-level config (a bare string) never echoes it, and still names transport', () => {
    let caught: unknown
    try {
      ConfigSchema('not-an-object' as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const message = (caught as Error).message
    expect(message).not.toContain('not-an-object')
    expect(String(caught)).not.toContain('not-an-object')
    expect(message).toContain('transport')
  })

  it('a non-object top-level config (an array) never echoes it, and still names transport', () => {
    let caught: unknown
    try {
      ConfigSchema(['secret-looking-element'] as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const message = (caught as Error).message
    expect(message).not.toContain('secret-looking-element')
    expect(String(caught)).not.toContain('secret-looking-element')
    expect(message).toContain('transport')
  })
})

describe('any field can carry a credential, not only headers/env, so redaction is path-agnostic (SWD-167 round 4)', () => {
  const secret = 'Bearer MY-SUPER-SECRET-TOKEN-9999'

  it('url given as an array with a token-in-query secret withholds it but still names $.url', () => {
    assertRedacted({
      transport: 'streamable-http',
      serverName: 'web',
      url: [`http://127.0.0.1/mcp?token=${secret}`],
    }, '$.url', secret)
  })

  it('stdio args with a nested-array secret element withholds it but still names $.args[1]', () => {
    assertRedacted({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      args: ['--token', [secret]],
    }, '$.args[1]', secret)
  })

  it('auth given directly as a secret-shaped string (operator pasted a token into auth) withholds it but still names $.auth', () => {
    assertRedacted({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1/mcp',
      auth: secret,
    }, '$.auth', secret)
  })

  it('auth given as an array withholds the secret but still names $.auth', () => {
    assertRedacted({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1/mcp',
      auth: [secret],
    }, '$.auth', secret)
  })

  it('a normal non-secret type error still names the full expectation, so operators are not blinded', () => {
    let caught: unknown
    try {
      ConfigSchema({
        transport: 'streamable-http',
        serverName: 'web',
        url: 'http://127.0.0.1/mcp',
        toolCallTimeoutMs: 'not-a-number',
      } as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const message = (caught as Error).message
    expect(message).toBe('$.toolCallTimeoutMs expected number (received value withheld)')
  })
})

describe('connection built from a header-only config (SWD-167)', () => {
  it('attaches no OAuth provider and still delivers headers.Authorization to the server', async () => {
    const fixture = await startOAuthFixture()
    try {
      fixture.setValidToken('static-token-1')
      const ctx = await mountRegistry()
      const config = headerOnlyConfig(fixture, 'web', 'static-token-1')
      const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'reconnect'))
      await handle.ready
      expect(handle.status().state).toBe('connected')
      expect(handle.authProvider).toBeUndefined()
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await fixture.close()
    }
  })

  it('attaches no OAuth provider when auth is explicitly null, proven end-to-end through schema validation (SWD-167 round 3, should-fix 3)', async () => {
    const fixture = await startOAuthFixture()
    try {
      fixture.setValidToken('static-token-null-auth')
      const ctx = await mountRegistry()
      // A bare `auth:` key in YAML parses to `null` — validate it through the
      // real Config schema (not a hand-built Config literal) so this proves
      // the null-to-omitted normalization end to end, not only at the schema
      // layer in isolation.
      const config = ConfigSchema({
        ...headerOnlyConfig(fixture, 'web-null-auth', 'static-token-null-auth'),
        auth: null,
      } as never)
      const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'reconnect'))
      await handle.ready
      expect(handle.status().state).toBe('connected')
      expect(handle.authProvider).toBeUndefined()
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await fixture.close()
    }
  })

  it('a 401 against a header-only mount never leaks the Authorization header value into logs or lastError', async () => {
    const fixture = await startOAuthFixture()
    try {
      // The fixture only accepts 'the-real-secret'; this config sends a
      // different value so every attempt 401s without ever running OAuth.
      fixture.setValidToken('the-real-secret')
      const ctx = await mountRegistry()
      const errors: string[] = []
      const warns: string[] = []
      vi.spyOn(ctx.logger, 'error').mockImplementation(((message: unknown) => {
        errors.push(String(message))
      }) as never)
      vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => {
        warns.push(String(message))
      }) as never)
      const config = headerOnlyConfig(fixture, 'leaky', 'wrong-token-value')
      const handle = startConnection(ctx, config, resolveReconnectPolicy(config.reconnect, 'reconnect'))
      await handle.ready
      expect(handle.authProvider).toBeUndefined()

      const status = handle.status()
      expect(status.lastError).toBeDefined()
      const allLogged = [...errors, ...warns, status.lastError ?? ''].join('\n')
      expect(allLogged).not.toContain('wrong-token-value')
      expect(allLogged).not.toContain('Bearer wrong-token-value')
      expect(allLogged).not.toContain('the-real-secret')

      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      await fixture.close()
    }
  })
})

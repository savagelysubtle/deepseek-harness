import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId as sessionIdOf } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { AgUiServer } from '../src/server.ts'

const TOKEN = 'dashboard-secret-1'

const servers: AgUiServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.dispose()
})

async function makeServer(): Promise<{ url: (path: string) => string }> {
  // One persisted session so admitted requests reach the SSE response rather
  // than the unknown-thread 404; auth behavior is what this suite varies.
  const logs = new Map([[sessionIdOf('s-1'), { events: [] as SessionEvent[] }]])
  const server = new AgUiServer(
    { host: '127.0.0.1', port: 0, bearerToken: TOKEN, keepAliveMs: 15_000, maxBufferedEvents: 256 },
    threadId => logs.get(threadId)?.events,
    undefined,
  )
  await server.listen()
  servers.push(server)
  return { url: (path: string): string => `http://127.0.0.1:${server.port}${path}` }
}

describe('bearer auth', () => {
  it('admits a request presenting the exact configured token', async () => {
    const harness = await makeServer()
    const response = await fetch(harness.url('/ag-ui/s-1'), {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    await response.body!.cancel()
  })

  it('rejects a wrong token with 401 and WWW-Authenticate: Bearer', async () => {
    const harness = await makeServer()
    const response = await fetch(harness.url('/ag-ui/s-1'), {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token-value' },
      body: '',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(await response.text()).toBe('')
  })

  it('rejects a missing or non-bearer header before routing', async () => {
    const harness = await makeServer()
    const bare = await fetch(harness.url('/ag-ui/s-1'), { method: 'POST', body: '' })
    expect(bare.status).toBe(401)
    // Auth gates every path: an unknown path without credentials reads as 401,
    // not 404, so the listener leaks nothing to unauthenticated probes.
    const unknown = await fetch(harness.url('/anything'), { method: 'POST', body: '' })
    expect(unknown.status).toBe(401)
  })

  it('fails loud at load when the configured token is absent or shorter than 8 characters', () => {
    // The resolve step runs before any socket or service access exists.
    expect(() => { plugin.apply(undefined as never, { port: 0, bearerToken: 'short' }) }).toThrow(/bearerToken/)
    expect(() => plugin.Config({ port: 0, bearerToken: 'short' })).toThrow()
    const resolved = plugin.Config({ port: 0, bearerToken: 'long-enough-token' })
    expect(resolved.keepAliveMs).toBe(15_000)
    expect(resolved.maxBufferedEvents).toBe(256)
  })
})

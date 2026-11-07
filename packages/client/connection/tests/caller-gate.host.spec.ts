/**
 * OP-270 slice C2: the per-boot caller-token gate on /api, driven through the REAL route handler,
 * the REAL shared fetch handler and the REAL `toFetchHandler` (the ApiProxy behind it is a
 * recording fake). Every negative case below must fail without the guard it names.
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH, apply, AUTH_EXCHANGE_PATH, AUTH_RELINK_PATH, RELINK_KEY_HEADER, CALLER_TOKEN_HEADER, CALLER_TOKEN_REQUIRED_MESSAGE, inject,
  LAUNCH_CODE_REJECTED_MESSAGE, type HostConnectionHandle,
} from '../src/index.ts'

const HOST = '127.0.0.1:3080'
const SECRET_MARKER = 'api-was-reached'

function fakeHttpServer(routes: WebRoute[], upgrades: WebUpgradeRoute[]): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

interface Reply { status: number; body: string; headers: Record<string, string> }

function fakeResponse(): { response: ServerResponse; reply: () => Reply } {
  const state: { status?: number; headers: Record<string, string> } = { headers: {} }
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      state.headers = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
      return this
    },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return {
    response,
    reply: () => ({ status: state.status ?? 0, body: Buffer.concat(chunks).toString(), headers: state.headers }),
  }
}

interface Call {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  peer?: string
}

function incoming(call: Call): IncomingMessage {
  const method = call.method ?? 'POST'
  const chunks = call.body === undefined ? [] : [Buffer.from(JSON.stringify(call.body))]
  const request = Readable.from(chunks) as unknown as IncomingMessage
  Object.assign(request, {
    url: call.url,
    method,
    headers: { host: HOST, ...call.body === undefined ? {} : { 'content-type': 'application/json' }, ...call.headers },
    socket: { remoteAddress: call.peer ?? '127.0.0.1' },
  })
  return request
}

interface Rig {
  ctx: Context
  connection: HostConnectionHandle
  calls: string[]
  respondSeen: { callerAuthenticated: boolean; peerIsLoopback: boolean }[]
  send(call: Call): Promise<Reply>
  dispose(): Promise<void>
}

async function rig(config?: { trustedHosts?: string[] }): Promise<Rig> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  const calls: string[] = []
  const respondSeen: Rig['respondSeen'] = []
  const ok = async (name: string) => {
    calls.push(name)
    return { rpcId: 'rpc-1', result: { ok: true as const, value: { stoppedCount: 0, marker: SECRET_MARKER } } }
  }
  const apiProxy = {
    sessions: { stopAll: () => ok('session.stopAll'), list: () => ok('session.list') },
    host: { listDirectory: () => ok('host.listDirectory') },
    respond: async (_message: unknown, caller: { callerAuthenticated: boolean; peerIsLoopback: boolean }) => {
      respondSeen.push(caller)
      return caller.callerAuthenticated
        ? { accepted: true }
        : { accepted: false, reason: 'approval answers need the caller token' }
    },
  } as unknown as ApiProxy
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  ctx.provide('apiProxy', apiProxy)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    ctx,
    connection: ctx.get('connection') as HostConnectionHandle,
    calls,
    respondSeen,
    async send(call) {
      const { response, reply } = fakeResponse()
      await routes[0]!.handler(incoming(call), response)
      return reply()
    },
    dispose: () => fiber.dispose(),
  }
}

const envelope = (method: string, payload: unknown = {}) => ({
  type: 'client-request', rpcId: 'rpc-1', method, payload,
})
const post = (method: string, extra: Partial<Call> = {}): Call =>
  ({ url: `${API_PATH}/${method}`, body: envelope(method), ...extra })

/** Exchange a fresh launch code the way the browser does; returns the token to send back in the `x-dsh-token` header. */
async function login(r: Rig, host = HOST): Promise<string> {
  const code = r.connection.mintLaunchCode()
  const reply = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, headers: { host } })
  expect(reply.status).toBe(200)
  return (JSON.parse(reply.body) as { token: string }).token
}

describe('/api privileged gate (OP-270)', () => {
  it('no token: 401 with the plain-words body, and the API is never reached', async () => {
    const r = await rig()
    const reply = await r.send(post('session.stopAll'))
    expect(reply.status).toBe(401)
    expect(reply.body).toBe(CALLER_TOKEN_REQUIRED_MESSAGE)
    expect(r.calls).toEqual([])
    await r.dispose()
  })

  it('wrong token, truncated token and over-long token: 401, never a throw', async () => {
    const r = await rig()
    const value = await login(r)
    for (const bad of ['nope', value.slice(0, -1), `${value}x`, 'A'.repeat(5000), '']) {
      const reply = await r.send(post('session.stopAll', { headers: { [CALLER_TOKEN_HEADER]: bad } }))
      expect([bad.length, reply.status]).toEqual([bad.length, 401])
    }
    expect(r.calls).toEqual([])
    await r.dispose()
  })

  it('a token minted by a previous boot (another instance) is refused', async () => {
    const previous = await rig()
    const staleToken = await login(previous)
    await previous.dispose()
    const next = await rig()
    const reply = await next.send(post('session.stopAll', { headers: { [CALLER_TOKEN_HEADER]: staleToken } }))
    expect(reply.status).toBe(401)
    expect(next.calls).toEqual([])
    await next.dispose()
  })

  it('the token sent as a cookie (any name) does not authenticate: only the header counts', async () => {
    const r = await rig()
    const value = await login(r)
    for (const name of ['dsh_auth_3080', 'dsh_auth_9999', CALLER_TOKEN_HEADER]) {
      const reply = await r.send(post('session.stopAll', { headers: { cookie: `${name}=${value}` } }))
      expect([name, reply.status]).toEqual([name, 401])
    }
    expect(r.calls).toEqual([])
    await r.dispose()
  })

  it('a non-loopback peer holding a valid token is 403, not 401 and not served', async () => {
    const r = await rig({ trustedHosts: ['10.0.0.1'] })
    const token = await login(r)
    for (const peer of ['10.0.0.9', '::ffff:10.0.0.9', '203.0.113.5', '']) {
      const reply = await r.send(post('session.stopAll', { headers: { [CALLER_TOKEN_HEADER]: token }, peer }))
      expect([peer, reply.status]).toEqual([peer, 403])
    }
    // A spoofed loopback Host from a LAN peer is still 403.
    const spoof = await r.send(post('session.stopAll', { headers: { [CALLER_TOKEN_HEADER]: token, host: 'localhost' }, peer: '10.0.0.9' }))
    expect(spoof.status).toBe(403)
    expect(r.calls).toEqual([])
    await r.dispose()
  })

  it('a valid token with a cross-site Sec-Fetch-Site or a foreign Origin is 403', async () => {
    const r = await rig()
    const token = await login(r)
    const crossSite = await r.send(post('session.stopAll', { headers: { [CALLER_TOKEN_HEADER]: token, 'sec-fetch-site': 'cross-site' } }))
    expect(crossSite.status).toBe(403)
    const foreign = await r.send(post('session.stopAll', { headers: { [CALLER_TOKEN_HEADER]: token, origin: 'http://evil.example' } }))
    expect(foreign.status).toBe(403)
    expect(r.calls).toEqual([])
    await r.dispose()
  })

  it('positive path: the UI with its token succeeds on a privileged method', async () => {
    const r = await rig()
    const token = await login(r)
    const reply = await r.send(post('session.stopAll', {
      headers: { [CALLER_TOKEN_HEADER]: token, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' },
    }))
    expect(reply.status).toBe(200)
    expect(reply.body).toContain(SECRET_MARKER)
    expect(r.calls).toEqual(['session.stopAll'])
    await r.dispose()
  })

  it('every newly privileged method refuses a tokenless loopback caller with 401', async () => {
    const r = await rig()
    for (const method of [
      'org.write', 'org.writeServed', 'worktree.create', 'worktree.remove', 'worktree.lock',
      'host.createDirectory', 'session.sendAll', 'session.stopAll', 'session.stopTree',
      'workflow/save', 'workflow/run', 'workflow/approve',
      'settings.update', 'credentials.set', 'mcp/set-enabled',
    ]) {
      const reply = await r.send(post(method))
      expect([method, reply.status]).toEqual([method, 401])
    }
    await r.dispose()
  })

  it('the open methods stay open to a tokenless caller (dsh-hire, dsh-stable plain curl)', async () => {
    const r = await rig()
    for (const method of ['session.list', 'session.history', 'session.rename', 'mailbox.publish', 'mcp/status']) {
      const reply = await r.send(post(method))
      expect([method, reply.status === 401 || reply.status === 403]).toEqual([method, false])
    }
    await r.dispose()
  })

  it('session.export and host.listDirectory need the token but not loopback', async () => {
    const r = await rig({ trustedHosts: ['10.0.0.1'] })
    const lan = { host: '10.0.0.1:3080', peer: '10.0.0.9' }
    const noToken = await r.send(post('host.listDirectory', { headers: { host: lan.host }, peer: lan.peer }))
    expect(noToken.status).toBe(401)
    const exportNoToken = await r.send({
      method: 'GET', url: `${API_PATH}/session.export?sessionId=x`, headers: { host: lan.host }, peer: lan.peer,
    })
    expect(exportNoToken.status).toBe(401)
    const token = await login(r)
    const withToken = await r.send(post('host.listDirectory', { headers: { [CALLER_TOKEN_HEADER]: token }, peer: '127.0.0.1' }))
    expect(withToken.status).toBe(200)
    expect(r.calls).toEqual(['host.listDirectory'])
    await r.dispose()
  })

  it('slash-command execution and the plugin-runner panel calls need the token', async () => {
    const r = await rig({})
    const token = await login(r)
    for (const method of [
      'commands/execute', 'dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/resolveRequestRun',
      'dynamicCordisRunner/settleUserRun', 'dynamicCordisRunner/undefineFromPanel', 'dynamicCordisRunner/stopFromPanel',
    ]) {
      const refused = await r.send(post(method))
      expect([method, refused.status]).toEqual([method, 401])
      const allowed = await r.send(post(method, { headers: { [CALLER_TOKEN_HEADER]: token } }))
      // The rig has no handler behind these names (404); what matters is that the gate let it through.
      expect([method, allowed.status === 401 || allowed.status === 403]).toEqual([method, false])
    }
    await r.dispose()
  })

  it('/api/auth.relink hands a fresh single-use code only for this boot\'s relink key, from loopback', async () => {
    const r = await rig({ trustedHosts: ['10.0.0.1'] })
    const key = (r.connection as unknown as { relinkKey(): string }).relinkKey()
    const wrong = await r.send({ url: AUTH_RELINK_PATH, body: {}, headers: { [RELINK_KEY_HEADER]: 'nope' } })
    expect(wrong.status).toBe(401)
    expect(wrong.body).not.toContain(key)
    const missing = await r.send({ url: AUTH_RELINK_PATH, body: {} })
    expect(missing.status).toBe(401)
    const lan = await r.send({ url: AUTH_RELINK_PATH, body: {}, headers: { [RELINK_KEY_HEADER]: key, host: '10.0.0.1:3080' }, peer: '10.0.0.9' })
    expect(lan.status).toBe(403)
    const get = await r.send({ method: 'GET', url: AUTH_RELINK_PATH, headers: { [RELINK_KEY_HEADER]: key } })
    expect(get.status).toBe(405)
    const ok = await r.send({ url: AUTH_RELINK_PATH, body: {}, headers: { [RELINK_KEY_HEADER]: key } })
    expect(ok.status).toBe(200)
    const { code } = JSON.parse(ok.body) as { ok: boolean; code: string }
    const exchanged = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, headers: { host: HOST } })
    expect(exchanged.status).toBe(200)
    const replay = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, headers: { host: HOST } })
    expect(replay.status).toBe(401)
    await r.dispose()
  })

  it('the privileged-call refusal warns once per window and never prints a token or code', async () => {
    const r = await rig()
    const warn = vi.spyOn(r.ctx.logger, 'warn').mockImplementation(() => undefined)
    const token = await login(r)
    const code = r.connection.mintLaunchCode()
    for (let i = 0; i < 5; i += 1) {
      await r.send(post('session.stopAll', { headers: { [CALLER_TOKEN_HEADER]: `wrong-${String(i)}` } }))
    }
    await r.send({ url: AUTH_EXCHANGE_PATH, body: { code: 'not-a-code' } })
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(warn.mock.calls.length).toBeLessThan(5)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('session.stopAll')
    expect(logged).not.toContain(token)
    expect(logged).not.toContain(code)
    expect(logged).not.toContain('wrong-')
    await r.dispose()
  })
})

describe('/api/respond and founder stamp receive the authenticated fact', () => {
  const answer = { type: 'client-response', rpcId: 'rpc-approval', result: { ok: true, value: { approved: true } } }

  it('without the token the real fetch handler reports callerAuthenticated=false and the answer is refused', async () => {
    const r = await rig()
    const reply = await r.send({ url: `${API_PATH}/respond`, body: answer })
    expect(JSON.parse(reply.body)).toMatchObject({ accepted: false })
    expect(r.respondSeen).toEqual([{ callerAuthenticated: false, peerIsLoopback: true }])
    await r.dispose()
  })

  it('with the token the answer is accepted', async () => {
    const r = await rig()
    const token = await login(r)
    const reply = await r.send({ url: `${API_PATH}/respond`, body: answer, headers: { [CALLER_TOKEN_HEADER]: token } })
    expect(JSON.parse(reply.body)).toEqual({ accepted: true })
    expect(r.respondSeen).toEqual([{ callerAuthenticated: true, peerIsLoopback: true }])
    await r.dispose()
  })

  it('a LAN peer with a valid token is NOT authenticated (the token never widens who may call)', async () => {
    const r = await rig({ trustedHosts: ['10.0.0.1'] })
    const token = await login(r)
    const reply = await r.send({
      url: `${API_PATH}/respond`, body: answer, peer: '10.0.0.9',
      headers: { host: '10.0.0.1:3080', [CALLER_TOKEN_HEADER]: token },
    })
    expect(JSON.parse(reply.body)).toMatchObject({ accepted: false })
    expect(r.respondSeen).toEqual([{ callerAuthenticated: false, peerIsLoopback: false }])
    await r.dispose()
  })

  it('an unauthenticated unary call still reaches an open method with callerAuthenticated=false', async () => {
    const r = await rig()
    const reply = await r.send(post('session.list'))
    expect(reply.status).toBe(200)
    await r.dispose()
  })
})

describe('POST /api/auth.exchange', () => {
  it('a valid code returns the token once in the JSON body, uncached, and sets no cookie', async () => {
    const r = await rig()
    const code = r.connection.mintLaunchCode()
    const reply = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code } })
    expect(reply.status).toBe(200)
    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['content-type']).toBe('application/json')
    const parsed = JSON.parse(reply.body) as { ok: boolean; token: string }
    expect(Object.keys(parsed).sort()).toEqual(['ok', 'token'])
    expect(parsed.ok).toBe(true)
    expect(parsed.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(reply.body).not.toContain(code)
    await r.dispose()
  })

  it('the token is not tied to the Host port and no cookie is set for any Host', async () => {
    const r = await rig()
    const code = r.connection.mintLaunchCode()
    const reply = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, headers: { host: 'localhost:41234' } })
    expect(reply.status).toBe(200)
    expect(reply.headers['set-cookie']).toBeUndefined()
    await r.dispose()
  })

  it('a replayed code is 401 and sets no cookie', async () => {
    const r = await rig()
    const code = r.connection.mintLaunchCode()
    expect((await r.send({ url: AUTH_EXCHANGE_PATH, body: { code } })).status).toBe(200)
    const replay = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code } })
    expect(replay.status).toBe(401)
    expect(replay.body).toBe(LAUNCH_CODE_REJECTED_MESSAGE)
    expect(replay.headers['set-cookie']).toBeUndefined()
    await r.dispose()
  })

  it('an unknown, missing or non-string code is 401', async () => {
    const r = await rig()
    for (const body of [{ code: 'nope' }, {}, { code: 7 }, { code: null }, [], 'x', null]) {
      const reply = await r.send({ url: AUTH_EXCHANGE_PATH, body })
      expect([JSON.stringify(body), reply.status]).toEqual([JSON.stringify(body), 401])
    }
    await r.dispose()
  })

  it('an expired code is 401 (clock-injected TTL)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const r = await rig()
      const code = r.connection.mintLaunchCode()
      vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1)
      const reply = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code } })
      expect(reply.status).toBe(401)
      await r.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a non-loopback peer is 403 even with a valid code, and the code is not consumed', async () => {
    const r = await rig({ trustedHosts: ['10.0.0.1'] })
    const code = r.connection.mintLaunchCode()
    const lan = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, peer: '10.0.0.9', headers: { host: '10.0.0.1:3080' } })
    expect(lan.status).toBe(403)
    expect(lan.headers['set-cookie']).toBeUndefined()
    const spoof = await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, peer: '10.0.0.9', headers: { host: 'localhost' } })
    expect(spoof.status).toBe(403)
    expect((await r.send({ url: AUTH_EXCHANGE_PATH, body: { code } })).status).toBe(200)
    await r.dispose()
  })

  it('a cross-site or foreign-origin exchange is 403; GET is 405; non-JSON is 415', async () => {
    const r = await rig()
    const code = r.connection.mintLaunchCode()
    expect((await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await r.send({ method: 'GET', url: AUTH_EXCHANGE_PATH })).status).toBe(405)
    expect((await r.send({ url: AUTH_EXCHANGE_PATH, body: { code }, headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await r.send({ url: AUTH_EXCHANGE_PATH, body: { code } })).status).toBe(200)
    await r.dispose()
  })
})

describe('token confidentiality', () => {
  it('the token is absent from process.env and from every other reply surface', async () => {
    const r = await rig()
    const token = await login(r)
    expect(JSON.stringify(process.env)).not.toContain(token)
    for (const call of [
      post('session.list'),
      { method: 'GET', url: `${API_PATH}/events.mux` },
      post('session.stopAll'),
    ] as Call[]) {
      const reply = await r.send(call)
      expect(reply.body).not.toContain(token)
      expect(JSON.stringify(reply.headers)).not.toContain(token)
    }
    await r.dispose()
  })

  it('the connection plugin never taps the served index (the token cannot ride in index.html)', async () => {
    const ctx = new Context()
    const tap = vi.fn(() => () => {})
    const server = { ...fakeHttpServer([], []), tapIndex: tap }
    ctx.provide('webServer', server as unknown as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.get('connection')!.mintLaunchCode()
    expect(tap).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('the launch code is not an environment variable either', async () => {
    const r = await rig()
    const code = r.connection.mintLaunchCode()
    expect(JSON.stringify(process.env)).not.toContain(code)
    await r.dispose()
  })
})

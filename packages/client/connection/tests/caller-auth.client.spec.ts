/** Browser holder of the per-boot caller token: launch-code exchange, header, 401 handling, banner. */

import { describe, expect, it, vi } from 'vitest'
import { createCallerAuthClient, type CallerAuthEnv } from '../src/client/caller-auth.ts'
import { mountAuthBanner } from '../src/client/auth-banner.ts'
import { CALLER_TOKEN_HEADER } from '../src/caller-token-header.ts'

function fakeStorage(initial?: string) {
  const data = new Map<string, string>()
  if (initial !== undefined) data.set('dsh-caller-token', initial)
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}

function env(hash: string, fetchImpl: CallerAuthEnv['fetch'], storage = fakeStorage()) {
  const replaceState = vi.fn()
  const e: CallerAuthEnv = {
    location: { origin: 'http://127.0.0.1:3080', pathname: '/app', search: '?x=1', hash },
    history: { replaceState },
    storage,
    fetch: fetchImpl,
  }
  return { e, replaceState, storage }
}

const okToken = (token: string) => vi.fn(async () => Response.json({ ok: true, token }))

describe('createCallerAuthClient', () => {
  it('strips the launch code from the address bar, exchanges it once, and sends the token header', async () => {
    const fetchImpl = okToken('tok-1')
    const { e, replaceState, storage } = env('#dsh-boot=code-1', fetchImpl)
    const auth = createCallerAuthClient(e)
    await auth.ready
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app?x=1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('http://127.0.0.1:3080/api/auth.exchange')
    expect(JSON.parse(init.body as string)).toEqual({ code: 'code-1' })
    expect(auth.getState()).toBe('ready')
    expect(storage.data.get('dsh-caller-token')).toBe('tok-1')
    const applied = auth.applyTo({ method: 'POST' })
    expect(new Headers(applied?.headers).get(CALLER_TOKEN_HEADER)).toBe('tok-1')
  })

  it('reuses a token kept in sessionStorage across a reload (no code in the URL)', async () => {
    const fetchImpl = okToken('unused')
    const { e } = env('', fetchImpl, fakeStorage('tok-kept'))
    const auth = createCallerAuthClient(e)
    await auth.ready
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(auth.getState()).toBe('ready')
    expect(new Headers(auth.applyTo(undefined)?.headers).get(CALLER_TOKEN_HEADER)).toBe('tok-kept')
  })

  it('with no code and no stored token adds no header and stays unknown', async () => {
    const { e } = env('', okToken('x'))
    const auth = createCallerAuthClient(e)
    await auth.ready
    expect(auth.getState()).toBe('unknown')
    expect(auth.applyTo({ method: 'POST' })).toEqual({ method: 'POST' })
  })

  it('shows the host text when the exchange is refused, and sends no header', async () => {
    const { e } = env('#dsh-boot=bad', vi.fn(async () => new Response('launch code is not valid', { status: 401 })))
    const auth = createCallerAuthClient(e)
    await auth.ready
    expect(auth.getState()).toBe('rejected')
    expect(auth.getMessage()).toBe('launch code is not valid')
    expect(auth.applyTo(undefined)).toBeUndefined()
  })

  it('reports an unreachable host and a reply without a token as rejected', async () => {
    const down = createCallerAuthClient(env('#dsh-boot=c', vi.fn(async () => { throw new Error('offline') })).e)
    await down.ready
    expect(down.getState()).toBe('rejected')
    const empty = createCallerAuthClient(env('#dsh-boot=c', vi.fn(async () => Response.json({ ok: true }))).e)
    await empty.ready
    expect(empty.getState()).toBe('rejected')
    expect(empty.getMessage()).toContain('without a token')
  })

  it('survives a blocked sessionStorage', async () => {
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    const exchanged = createCallerAuthClient({ ...env('#dsh-boot=c', okToken('t')).e, storage: throwing })
    await exchanged.ready
    expect(exchanged.getState()).toBe('ready')
    const reload = createCallerAuthClient({ ...env('', okToken('t')).e, storage: throwing })
    await reload.ready
    expect(reload.getState()).toBe('unknown')
  })

  it('marks the token rejected on HTTP 401 and notifies subscribers; other statuses change nothing', async () => {
    const auth = createCallerAuthClient(env('#dsh-boot=c', okToken('t')).e)
    await auth.ready
    const listener = vi.fn()
    const off = auth.subscribe(listener)
    auth.noteResponse(new Response('x', { status: 500 }))
    expect(auth.getState()).toBe('ready')
    auth.noteResponse(new Response('x', { status: 401 }))
    expect(auth.getState()).toBe('rejected')
    expect(auth.getMessage()).toContain('Reopen dsh')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    auth.noteResponse(new Response('x', { status: 401 }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps the host\'s own refusal text when a later request also gets 401', async () => {
    const auth = createCallerAuthClient(env('#dsh-boot=bad', vi.fn(async () => new Response('launch code is not valid', { status: 401 }))).e)
    await auth.ready
    auth.noteResponse(new Response('x', { status: 401 }))
    expect(auth.getMessage()).toBe('launch code is not valid')
  })

  it('contains a throwing listener', async () => {
    const auth = createCallerAuthClient(env('#dsh-boot=c', okToken('t')).e)
    await auth.ready
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    auth.subscribe(() => { throw new Error('boom') })
    auth.noteResponse(new Response('x', { status: 401 }))
    expect(quiet).toHaveBeenCalled()
    quiet.mockRestore()
  })
})

describe('mountAuthBanner', () => {
  function fakeDoc() {
    const strips: FakeEl[] = []
    class FakeEl {
      textContent = ''
      attrs = new Map<string, string>()
      style = { cssText: '' }
      removed = false
      setAttribute(k: string, v: string) { this.attrs.set(k, v) }
      remove() { this.removed = true }
    }
    const body = { prepend: (el: FakeEl) => { strips.push(el) } }
    const doc = { body, createElement: () => new FakeEl() } as unknown as Pick<Document, 'body' | 'createElement'>
    return { doc, strips }
  }

  it('shows the reason while rejected and removes the strip on dispose', async () => {
    const auth = createCallerAuthClient(env('#dsh-boot=bad', vi.fn(async () => new Response('nope', { status: 401 }))).e)
    await auth.ready
    const { doc, strips } = fakeDoc()
    const dispose = mountAuthBanner(auth, doc)
    expect(strips).toHaveLength(1)
    expect(strips[0]?.textContent).toBe('nope')
    expect(strips[0]?.attrs.get('role')).toBe('alert')
    dispose()
    expect(strips[0]?.removed).toBe(true)
  })

  it('shows nothing while the token is fine', async () => {
    const auth = createCallerAuthClient(env('#dsh-boot=c', okToken('t')).e)
    await auth.ready
    const { doc, strips } = fakeDoc()
    mountAuthBanner(auth, doc)
    expect(strips).toHaveLength(0)
  })
})

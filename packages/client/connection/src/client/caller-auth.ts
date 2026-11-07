/**
 * Browser holder of the per-boot caller token (OP-270).
 *
 * The launcher opens `http://127.0.0.1:<port>/#dsh-boot=<one-time code>`. The fragment never
 * reaches the server. On startup this module removes the code from the address bar, trades it once
 * at `POST /api/auth.exchange` for the long-lived token, and keeps the token in memory and in
 * `sessionStorage` (per origin, so another loopback port cannot read it; never `localStorage`,
 * never the URL). Every API request then carries the token in the `x-dsh-token` header.
 */
import { API_PATH } from '../api-path.ts'
import { CALLER_TOKEN_HEADER } from '../caller-token-header.ts'

const LAUNCH_CODE_PARAM = 'dsh-boot'
const STORAGE_KEY = 'dsh-caller-token'
const AUTH_EXCHANGE_URL_PATH = `${API_PATH}/auth.exchange`

/**
 * `unknown`: no token yet and none was refused. `ready`: a token is held. `rejected`: the host
 * refused the code or the token (a token from a previous boot stops working); `message` says why.
 */
export type CallerAuthState = 'unknown' | 'ready' | 'rejected'

/** Observable view of the token state for the UI banner; never exposes the token. */
export interface CallerAuthView {
  /** Current state. */
  getState(): CallerAuthState
  /** Plain-words reason while `rejected`, else undefined. */
  getMessage(): string | undefined
  /** Subscribe to state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** Browser facilities the holder needs; injectable so tests do not need a DOM. */
export interface CallerAuthEnv {
  /** Page location (`origin`, `pathname`, `search`, `hash`). */
  readonly location: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>
  /** History API used to strip the launch code from the address bar. */
  readonly history: Pick<History, 'replaceState'>
  /** Per-origin session storage, or undefined when the browser refuses it. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined
  /** Network fetch used for the one exchange request. */
  readonly fetch: typeof fetch
}

/** Holder of the caller token and its state. */
export interface CallerAuthClient extends CallerAuthView {
  /** Settles after the launch code (if any) was exchanged; never rejects. */
  readonly ready: Promise<void>
  /**
   * Add the token header to a request init.
   * @param init - the caller's request init.
   * @returns the same init with `x-dsh-token` set when a token is held.
   */
  applyTo(init: RequestInit | undefined): RequestInit | undefined
  /**
   * Record the outcome of an API response: a 401 means the token is missing or from another boot.
   * @param response - the response of a request sent through {@link applyTo}.
   * @returns nothing; the state changes when the status is 401.
   */
  noteResponse(response: Response): void
}

const STALE_TOKEN_MESSAGE =
  'This page has no valid access token (a token from a previous start stops working). Reopen dsh from the launcher link.'

/**
 * Create the holder and start the launch-code exchange.
 * @param env - browser facilities.
 * @returns the holder; `ready` settles once the exchange (if any) finished.
 */
export function createCallerAuthClient(env: CallerAuthEnv): CallerAuthClient {
  let token: string | undefined
  let state: CallerAuthState = 'unknown'
  let message: string | undefined
  const listeners = new Set<() => void>()
  const publish = (nextState: CallerAuthState, nextMessage?: string): void => {
    if (state === nextState && message === nextMessage) return
    state = nextState
    message = nextMessage
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[client-connection] caller-auth listener threw:', error)
      }
    }
  }
  const readStored = (): string | undefined => {
    try {
      return env.storage?.getItem(STORAGE_KEY) ?? undefined
    } catch {
      // sessionStorage can throw (blocked site data); the in-memory token still works.
      return undefined
    }
  }
  const writeStored = (value: string): void => {
    try {
      env.storage?.setItem(STORAGE_KEY, value)
    } catch {
      // sessionStorage can throw (quota or blocked site data); a reload then needs a new launcher link.
    }
  }
  const exchange = async (code: string): Promise<void> => {
    let response: Response
    try {
      response = await env.fetch(new URL(AUTH_EXCHANGE_URL_PATH, env.location.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    } catch {
      publish('rejected', 'Could not reach the host to start this session. Reopen dsh from the launcher link.')
      return
    }
    if (!response.ok) {
      publish('rejected', await response.text())
      return
    }
    const body: unknown = await response.json()
    const value = typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined
    if (typeof value !== 'string' || value === '') {
      publish('rejected', 'The host answered the launch link without a token. Reopen dsh from the launcher link.')
      return
    }
    token = value
    writeStored(value)
    publish('ready')
  }
  const start = async (): Promise<void> => {
    const code = new URLSearchParams(env.location.hash.replace(/^#/, '')).get(LAUNCH_CODE_PARAM)
    if (code === null || code === '') {
      const stored = readStored()
      if (stored !== undefined && stored !== '') {
        token = stored
        publish('ready')
      }
      return
    }
    // The code is single-use: strip it from the address bar before any network step.
    env.history.replaceState(null, '', `${env.location.pathname}${env.location.search}`)
    await exchange(code)
  }
  const ready = start().catch((error: unknown) => {
    console.error('[client-connection] launch-code exchange failed:', error)
    publish('rejected', 'Could not start this session. Reopen dsh from the launcher link.')
  })
  return {
    ready,
    getState: () => state,
    getMessage: () => message,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    applyTo(init) {
      if (token === undefined) return init
      const headers = new Headers(init?.headers)
      headers.set(CALLER_TOKEN_HEADER, token)
      return { ...init, headers }
    },
    noteResponse(response) {
      if (response.status === 401) publish('rejected', STALE_TOKEN_MESSAGE)
    },
  }
}

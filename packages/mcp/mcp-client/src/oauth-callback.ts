/**
 * Shared OAuth loopback-redirect capture: one `http.Server` bound to
 * `127.0.0.1:<port>` that answers exactly `/callback` and resolves with the
 * authorization code. Extracted from `auth-cli.ts` so the manual consent CLI
 * and the Host's `authorize-start` flow (`@deepseek-ai/dsh-mcp-status`'s
 * status-registry service, which imports this package's own public export)
 * share one listener implementation instead of two independently-drifting copies.
 *
 * The CLI calls this with no `expectedState` (its original behavior,
 * unchanged); the Host path passes the per-flow state it generated so a
 * stray or replayed request on the shared port can never be attributed to
 * the wrong flow.
 *
 * @module @deepseek-ai/dsh-mcp-client/oauth-callback
 */

import { createServer } from 'node:http'

/**
 * Thrown by {@link startAuthorizationCallbackListener}'s `code` promise when
 * no consent callback arrived within `timeoutMs`. A distinct class (rather
 * than matching the generic `Error`'s message text) so a caller — the Host's
 * `authorize-start` flow (`@deepseek-ai/dsh-mcp-status`'s status-registry
 * service) — can tell "the user
 * never finished" apart from any other capture failure and report the two
 * differently.
 */
export class ConsentTimeoutError extends Error {}

/** Options for {@link captureAuthorizationCode}. */
export interface CaptureAuthorizationCodeOptions {
  /**
   * Expected OAuth `state` parameter for this flow. When provided, a
   * callback whose `state` is missing or does not match gets a 400 and its
   * code is never consumed — but the overall capture stays pending rather
   * than failing, so one stray, replayed, or forged request on the shared
   * listener cannot abort the real flow before the legitimate browser
   * redirect arrives. This is the anti-CSRF check the manual CLI's single,
   * human-driven flow does not need, but a Host-initiated flow does, since
   * the loopback port is one shared listener rather than one per flow.
   * Omit to accept any state (the CLI's original behavior).
   */
  expectedState?: string
}

/** A started loopback listener, split into its bind outcome and its eventual capture. */
export interface AuthorizationCallbackListener {
  /**
   * Settles as soon as the TCP bind itself resolves: rejects immediately
   * (e.g. `EADDRINUSE` from a concurrent `dsh-mcp-client-auth` run on the
   * same port) without waiting for any browser round trip. A caller that
   * must not report success before the listener can actually receive the
   * redirect awaits this before telling anyone the flow started.
   */
  bound: Promise<void>
  /** Resolves with the authorization code from the callback, or rejects (bind failure, state-exhausted timeout, or an error redirect). */
  code: Promise<string>
}

/**
 * Start a loopback listener for the authorization-server redirect, without
 * waiting for either the bind or the callback.
 * @param port - the port advertised as the redirect URI's port.
 * @param timeoutMs - how long to wait for the browser round trip once bound.
 * @param options - optional state verification; see {@link CaptureAuthorizationCodeOptions}.
 * @returns the bind and capture promises; see {@link AuthorizationCallbackListener}.
 */
export function startAuthorizationCallbackListener(
  port: number,
  timeoutMs: number,
  options: CaptureAuthorizationCodeOptions = {},
): AuthorizationCallbackListener {
  const { expectedState } = options
  const captured: PromiseWithResolvers<string> = Promise.withResolvers()
  const bound: PromiseWithResolvers<void> = Promise.withResolvers()
  const server = createServer((request, response) => {
    /* v8 ignore next -- request.url is always defined on a server 'request' event; optional only on the shared client type */
    const incoming = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (incoming.pathname !== '/callback') {
      response.writeHead(404).end()
      return
    }
    if (expectedState !== undefined && incoming.searchParams.get('state') !== expectedState) {
      // 400 this ONE request without settling `captured` — a stray, replayed,
      // or forged callback must not be able to abort the real pending flow
      // before the legitimate browser redirect arrives; the listener keeps
      // waiting (bounded by the same timeout) for a request whose state
      // actually matches.
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end('Authorization failed: state mismatch — this callback does not belong to the pending flow.\n')
      return
    }
    const error = incoming.searchParams.get('error')
    const code = incoming.searchParams.get('code')
    response.writeHead(200, { 'content-type': 'text/plain' })
    if (code !== null) {
      response.end('Authorization complete. You may close this window.\n')
    } else {
      response.end(`Authorization failed: ${error ?? 'missing code'}${incoming.searchParams.get('error_description') ? ` (${incoming.searchParams.get('error_description')})` : ''}\n`)
    }
    response.end()
    if (code !== null) {
      captured.resolve(code)
    } else {
      captured.reject(new Error(`authorization server redirected with error: ${error ?? 'missing code'}`))
    }
  })
  const timer = setTimeout(() => {
    captured.reject(new ConsentTimeoutError(`no consent callback within ${timeoutMs}ms — rerun the command to get a fresh login URL`))
  }, timeoutMs)
  timer.unref()
  server.on('error', (error) => {
    const bindError = new Error([
      `cannot listen on 127.0.0.1:${port} for the consent redirect (${String(error)})`,
      '— free the port or pass --redirect-port on BOTH this command and the plugin config',
    ].join(' '))
    // Settling an already-settled PromiseWithResolvers is a no-op, so this is
    // safe whether the error preempts a successful bind (EADDRINUSE on
    // `listen`) or arrives later from a live socket (`bound` already
    // resolved) — either way `captured` carries the one error onward.
    bound.reject(bindError)
    captured.reject(bindError)
  })
  server.on('listening', () => { bound.resolve() })
  // `.finally()`'s own returned promise adopts `captured.promise`'s rejection
  // and nobody holds a handler for it, so discarding it with `void` (as
  // before) left an independent unhandled rejection on every failure path.
  // `.then(cleanup, cleanup)` runs the same cleanup on both outcomes but
  // never itself rejects — neither handler throws — so discarding IT is
  // safe. `captured.promise` itself is returned below unchanged, so callers
  // still see the real resolution or rejection.
  const cleanup = (): void => {
    clearTimeout(timer)
    // `close()` alone only stops accepting NEW connections; it waits for
    // any already-open one to end on its own before the port is actually
    // freed — and an HTTP/1.1 keep-alive connection from the single
    // `/callback` request (or one that never arrived at all) can sit idle
    // for Node's default `keepAliveTimeout` before that happens, leaving
    // this one-shot listener's port looking busy well after this flow is
    // over. Force every connection closed immediately — nothing has a
    // reason to stay open once this listener is done either way.
    server.closeAllConnections()
    server.close()
  }
  void captured.promise.then(cleanup, cleanup)
  server.listen(port, '127.0.0.1')
  return { bound: bound.promise, code: captured.promise }
}

/**
 * Wait for the authorization-server redirect on a loopback listener —
 * {@link startAuthorizationCallbackListener} without separating the bind
 * outcome from the capture. The CLI's single, human-driven flow has nothing
 * else running concurrently to race the bind against, so it has no use for
 * `bound` on its own; `authorize-start` (`@deepseek-ai/dsh-mcp-status`'s
 * status-registry service) is the caller that does.
 * @param port - the port advertised as the redirect URI's port.
 * @param timeoutMs - how long to wait for the browser round trip.
 * @param options - optional state verification; see {@link CaptureAuthorizationCodeOptions}.
 * @returns the authorization code from the callback.
 */
export function captureAuthorizationCode(
  port: number,
  timeoutMs: number,
  options: CaptureAuthorizationCodeOptions = {},
): Promise<string> {
  const { bound, code } = startAuthorizationCallbackListener(port, timeoutMs, options)
  // `code` rejects with the same error whenever `bound` does (both settle
  // from the same `server.on('error', ...)` handler above), so this caller
  // only needs `code` — but an un-awaited `bound` rejection is still an
  // unhandled rejection in Node's eyes unless something observes it.
  bound.catch(() => {})
  return code
}

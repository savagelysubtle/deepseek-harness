/**
 * Connection supervisor: owns the MCP client/transport generations for one
 * plugin instance, keeps the harness tool registry in sync with the live
 * generation, and — when the connection drops — restarts the configured
 * server with bounded exponential backoff.
 *
 * One outage shares one attempt budget (`maxAttempts` consecutive failed
 * attempts, delays doubling from `initialDelayMs` up to `maxDelayMs`). A
 * connection that stays up past the stability window closes the outage, so
 * the next disconnect starts a fresh budget while a crash-looping server —
 * even one whose connects briefly succeed — still exhausts the cap instead of
 * restarting forever. Exhaustion unregisters the server's tools and stops;
 * disposal (including HMR) or a manual {@link ConnectionHandle.reconnectNow}
 * call are the only ways back from that state (also the way back from
 * `reconnect.enabled: false`'s own terminal `disabled` state — see
 * `./status.ts`).
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createTransport } from './transport.ts'
import { syncTools } from './tools.ts'
import type { ToolBridgeOptions, ToolDisposers } from './tools.ts'
import { CredentialsOAuthProvider } from './oauth.ts'
import { DEFAULT_OAUTH_REDIRECT_PORT } from './index.ts'
import type { Config } from './index.ts'
import type { McpServerState, McpServerStatus } from './status.ts'

/**
 * Matches one quoted absolute POSIX path (`"/a/b"` or `'/a/b'`), redacted
 * whole first so an embedded space or other character inside the quotes
 * cannot split one path into a leaked fragment.
 */
const QUOTED_DOUBLE_PATH_RE = /"(\/[^"]*)"/g
/** Same as {@link QUOTED_DOUBLE_PATH_RE}, for single-quoted paths. */
const QUOTED_SINGLE_PATH_RE = /'(\/[^']*)'/g
/**
 * Fallback pass for an absolute POSIX path that was never quoted at all.
 * Windows paths are out of scope — this package's connection errors
 * (ENOENT/EADDRINUSE/stdio spawn failures) are POSIX-shaped in this
 * deployment. Mirrors the reviewed pattern in
 * `packages/mailbox/tool-mailbox/src/tools.ts` (SWD-99 sentinel finding).
 */
const BARE_ABSOLUTE_PATH_RE = /\/(?:[^\s"'<>]+\/)*[^\s"'<>]+/g

/**
 * Redact absolute filesystem paths from connection error text before it
 * leaves the host (lastError crosses the `/api` wire to any trusted client).
 * @param text - the raw error text.
 * @returns the redacted text.
 */
function redactAbsolutePaths(text: string): string {
  return text
    .replace(QUOTED_DOUBLE_PATH_RE, '"<path>"')
    .replace(QUOTED_SINGLE_PATH_RE, '\'<path>\'')
    .replace(BARE_ABSOLUTE_PATH_RE, '<path>')
}

/**
 * Server names whose authorization-required guidance already logged this
 * process. The reconnect loop re-enters the same failed path every attempt;
 * the full consent instructions belong in the log once, not once per attempt.
 */
const AUTH_GUIDANCE_SHOWN = new Set<string>()

/**
 * Build the persisted OAuth provider for one server, or `undefined` when the
 * config carries no `auth` block. Callers fail loud before reaching here when
 * OAuth is configured without the credential service.
 * @param ctx - plugin context carrying the credential store and logger.
 * @param config - resolved transport configuration (streamable-http when auth applies).
 * @param label - diagnostic prefix naming this plugin instance.
 * @param onNeedsAuthorization - invoked on every authorization-URL event (not
 *   just the first), so the status machinery can capture the current
 *   `consentUrl` and flip to `needs-authorization` even on a later retry
 *   whose guidance log is suppressed by {@link AUTH_GUIDANCE_SHOWN}.
 * @returns the provider, or `undefined` for unauthenticated servers.
 */
function resolveAuthProvider(
  ctx: Context,
  config: Config,
  label: string,
  onNeedsAuthorization: (authorizationUrl: URL) => void,
): CredentialsOAuthProvider | undefined {
  if (config.transport !== 'streamable-http' || config.auth === undefined) return undefined
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    // Unreachable through apply() (it fails loud first); kept at the operation
    // so direct startConnection callers get the same named diagnostic.
    throw new Error(`${label}: auth.oauth requires the credential-reference service — mount @deepseek-ai/dsh-credentials-local`)
  }
  const provider = CredentialsOAuthProvider.create({
    serverName: config.serverName,
    serverUrl: new URL(config.url),
    ...(config.auth.scope === undefined ? {} : { scope: config.auth.scope }),
    ...(config.auth.clientId === undefined ? {} : { staticClientId: config.auth.clientId }),
    store: credentials,
    // Hosts never capture the consent redirect; both host and CLI advertise
    // the same fixed loopback URL so dynamic client registration matches
    // whichever process consents first.
    redirectUri: `http://127.0.0.1:${config.auth.redirectPort ?? DEFAULT_OAUTH_REDIRECT_PORT}/callback`,
    onAuthorizationUrl(authorizationUrl) {
      onNeedsAuthorization(authorizationUrl)
      if (AUTH_GUIDANCE_SHOWN.has(config.serverName)) return
      AUTH_GUIDANCE_SHOWN.add(config.serverName)
      ctx.logger.error(
        `${label}: human consent required to authorize MCP access. Open Settings > Tools and click Authorize, or run: dsh-mcp-client-auth --server-name ${config.serverName}`,
      )
    },
  })
  return provider
}

/** Automatic reconnect policy for one MCP server connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good (default 10). */
  maxAttempts?: number
}

/** Defaults shared by the Config schema and {@link resolveReconnectPolicy}. */
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

// The SDK's stdio transport owns two two-second termination grace periods.
// Keep one additional second for the process-close event that proves the old
// generation is gone; timing out fails closed instead of overlapping children.
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/** Fully resolved reconnect policy captured at plugin load. */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/**
 * The one explicit resolve step from raw reconnect config to the policy the
 * supervisor runs. Programmatic construction may bypass Schemastery
 * normalization, so every default and bound is re-judged here — misconfiguration
 * fails the plugin instance at load.
 *
 * @param config - Raw `reconnect` config; omission uses the defaults.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved policy.
 */
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  /* jscpd:ignore-start — domain-specific delay validation parallels llm retry-policy; not extractable */
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`)
  }
  /* jscpd:ignore-end */
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/** Result from the initial connection attempt, for startup-await semantics. */
export interface ConnectionOutcome {
  /** If the initial connection or tool sync failed, the error; otherwise absent. */
  error?: unknown
}

/** Handle for one plugin instance's supervised connection. */
export interface ConnectionHandle {
  /**
   * Settles when the first connection attempt completes (success or failure).
   * The supervisor enters its reconnect loop regardless; the caller decides
   * whether a failed startup is fatal via `failOnStartupError`.
   */
  ready: Promise<ConnectionOutcome>
  /**
   * Stop reconnection, close the live client, wait for the in-flight attempt
   * and queued tool syncs to quiesce, then unregister every tool this server
   * still owns.
   */
  dispose(): Promise<void>
  /** Current point-in-time status; see {@link McpServerStatus}. */
  status(): McpServerStatus
  /**
   * Force one reconnect attempt now, bypassing backoff. A loud no-op unless
   * the current state is `gave-up` or `disabled` (see the module doc on
   * `status.ts` for why those are the only two states this ever recovers
   * from), and rate-limited to one accepted call per server per
   * {@link MANUAL_RECONNECT_MIN_INTERVAL_MS}.
   */
  reconnectNow(): void
  /** Subscribe to every status transition. @returns an unsubscribe function. */
  onStatusChange(callback: (status: McpServerStatus) => void): () => void
  /** The OAuth provider for this server, reused by `authorize-start`; `undefined` for unauthenticated servers. */
  readonly authProvider: CredentialsOAuthProvider | undefined
  /**
   * Internal-only peek at the most recently captured consent URL — NEVER part
   * of {@link McpServerStatus} (SWD-164 sentinel finding: a leaked consent URL
   * carries the CSRF `state` and lets whoever opens it complete the pending
   * flow, so it must never cross the `/api` wire to any client, privileged or
   * not). `authorize-start` (`@deepseek-ai/dsh-mcp-status`'s status-registry
   * service) is the only caller: it triggers the capture via `sdkAuth`, then reads it back here in
   * the same synchronous turn to hand the URL to the ONE caller who asked for
   * it, over the privileged RPC response rather than the public status poll.
   * `undefined` whenever no consent URL is currently pending.
   */
  peekConsentUrl(): string | undefined
  /**
   * Internal recovery hook for `authorize-start`'s own completion handler
   * (`@deepseek-ai/dsh-mcp-status`'s status-registry service): force one immediate attempt after a
   * fresh grant, regardless of current state (even `connecting` mid-backoff
   * wait, or still `needs-authorization`) and without `reconnectNow`'s
   * rate limit or state guard — this is the deterministic continuation of
   * the SAME flow a human just completed, not a repeated manual action to
   * throttle. A no-op while a generation is already live (`connected` or
   * actively connecting) to avoid ever running two generations at once;
   * that in-flight attempt will pick up the fresh grant on its own next
   * retry if it is currently failing on the stale one.
   */
  forceReconnectAfterAuthorization(): void
  /**
   * Report that this server's pending authorization flow failed or timed
   * out, without touching `state` — the row stays `needs-authorization` so
   * the user can click Authorize again — exactly like any other connection
   * failure recorded through {@link McpServerStatus.lastError}.
   * `authorize-start`'s background consent capture
   * (`@deepseek-ai/dsh-mcp-status`'s status-registry service) is the only caller: `authorize-start`
   * itself already rejects on an up-front failure, but a failure or the
   * 5-minute consent timeout AFTER it has already returned the URL to the
   * client would otherwise only ever reach a server log — this is what
   * turns it into a visible `mcp/status-changed` on the row (via the same
   * `onStatusChange` subscription `register()` already wires up). A no-op
   * once disposed, like every other post-dispose status write.
   */
  reportAuthorizationFailure(message: string): void
  /**
   * Mark a consent flow as pending for this server: clears any armed
   * reconnect timer and suppresses every future {@link scheduleReconnect}
   * call (so no automatic retry can run `generation.connect()`, and
   * therefore cannot run the MCP SDK's own 401-triggered `auth()` step
   * through this handle's `authProvider`) until {@link endAuthorization} is
   * called. `authorize-start`
   * (`@deepseek-ai/dsh-mcp-status`'s status-registry service) calls this
   * right before its own `sdkAuth` call — the fix for the SWD-164 pilot
   * race, where a reconnect attempt firing moments after the Authorize
   * click regenerated the PKCE verifier/state out from under the user's
   * in-flight consent code. A no-op once disposed.
   */
  beginAuthorization(): void
  /**
   * End the pending-authorization window opened by {@link beginAuthorization}
   * and let automatic reconnection resume normally. Does not itself schedule
   * anything: on a successful consent exchange the caller's own
   * `finally` follows this with {@link forceReconnectAfterAuthorization}; on
   * failure or timeout, the next real disconnect (there is none pending,
   * since none could fire while suppressed) simply schedules through
   * `scheduleReconnect` again next time one happens. A no-op once disposed.
   */
  endAuthorization(): void
  /**
   * True while a reconnect attempt is between `generation.connect()` and
   * the end of its initial tool sync — including any time the MCP SDK
   * spends running its own `auth()` step through `authProvider` on a 401.
   * `authorize-start` checks this BEFORE starting its own consent flow: the
   * opposite direction of the race {@link beginAuthorization} guards
   * against, where a reconnect attempt is already using the provider when
   * the user clicks Authorize.
   */
  isReconnectAttemptInFlight(): boolean
}

/** Floor between accepted manual {@link ConnectionHandle.reconnectNow} calls, per server. */
export const MANUAL_RECONNECT_MIN_INTERVAL_MS = 10_000

/**
 * Start the supervised connection for one MCP server and keep it alive per
 * the reconnect policy.
 *
 * @param ctx - Cordis context providing the `tools` registry and logger.
 * @param config - Resolved plugin config selecting the transport and server identity.
 * @param policy - Resolved reconnect policy from {@link resolveReconnectPolicy}.
 * @returns Handle with a `ready` promise for startup-await and a `dispose` for teardown.
 */
export function startConnection(ctx: Context, config: Config, policy: ResolvedReconnectPolicy): ConnectionHandle {
  const label = `mcp-client(${config.serverName})`
  const opts: ToolBridgeOptions = {
    registrationFailure: 'contain',
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  }
  // The initial sync uses 'throw' when failOnStartupError is configured, so
  // a registration conflict propagates to the startup-await path. Re-syncs
  // and reconnect syncs always contain conflicts.
  const startupOpts: ToolBridgeOptions = config.failOnStartupError
    ? { ...opts, registrationFailure: 'throw' }
    : opts

  let disposed = false
  /** Current generation: the connecting or connected client; undefined during backoff waits and after final failure. */
  let client: Client | undefined
  /** Close signal paired with {@link client}; captured by dispose before current ownership is cleared. */
  let clientClosed: Promise<void> | undefined
  /** Live tool registrations owned by this server; only {@link enqueueSync} and dispose swap it. */
  let disposers: ToolDisposers = new Map()
  let reconnectTimer: NodeJS.Timeout | undefined
  /** Consecutive failed connection attempts within the current outage. */
  let failedAttempts = 0
  /** When the current generation finished connect + initial sync; undefined while down. */
  let connectedAt: number | undefined
  /** The real error from the first connection attempt, for startup-await diagnostics. */
  let firstAttemptError: unknown
  /**
   * True for the duration of one pending `authorize-start` consent flow
   * (`beginAuthorization`..`endAuthorization`): suppresses
   * {@link scheduleReconnect} entirely, so no automatic retry can run
   * `generation.connect()` — and therefore the MCP SDK's own 401-triggered
   * `auth()` step through this same persisted `authProvider` — while a
   * fresh PKCE verifier/state is saved and the user's browser tab is
   * mid-flight completing it (SWD-164 pilot finding: an armed backoff
   * timer that fired 17ms after the Authorize click re-ran that SDK auth
   * step, regenerating the verifier/state out from under the pending
   * consent code and failing it with "PKCE verification failed").
   */
  let authorizationPending = false
  /**
   * Set by {@link scheduleReconnect}'s `authorizationPending` guard when it
   * drops a disconnect that happened WHILE a consent flow was pending —
   * e.g. a live, `connected` generation closing mid-flow — rather than
   * silently losing that disconnect forever (reviewer finding, SWD-164
   * round 5: without this, `endAuthorization` on a FAILED/timed-out flow
   * left the row stuck reporting a stale `connected` status with no client,
   * no armed timer, and no way back short of a plugin reload, since
   * `reconnectNow`'s own state guard only accepts `gave-up`/`disabled`).
   * `endAuthorization` consumes this flag on the failure path by calling
   * `scheduleReconnect` itself once suppression lifts, exactly as if the
   * dropped disconnect were happening now; the success path clears it too,
   * since `forceReconnectAfterAuthorization` already reconnects without it.
   */
  let disconnectDroppedDuringAuthorization = false
  /**
   * True for the duration of one `connectGeneration` call (`generation.connect()`
   * through its initial sync), including the window the MCP SDK may spend
   * running its own 401-triggered `auth()` step through `authProvider`.
   * `authorize-start` checks this BEFORE starting its own consent flow — the
   * opposite direction of the race {@link authorizationPending} guards
   * against, where a reconnect attempt is already using the provider when
   * the user clicks Authorize.
   */
  let attemptInFlight = false

  // ---- Status machinery ----
  /** Current lifecycle state exposed through {@link ConnectionHandle.status}. */
  let state: McpServerState = 'connecting'
  /** Redacted text of the most recent connection error; cleared on a successful connect. */
  let lastErrorText: string | undefined
  /** Pending OAuth consent URL; present only while `state` is `needs-authorization`. */
  let consentUrl: string | undefined
  /** Timestamp of the last manual {@link ConnectionHandle.reconnectNow} call this supervisor accepted. */
  let lastManualReconnectAt = 0
  const statusListeners = new Set<(status: McpServerStatus) => void>()

  function currentStatus(): McpServerStatus {
    // `failedAttempts` counts the outage-starting disconnect itself as one
    // slot before any retry runs, so it reads one higher than the give-up
    // decision's own "N consecutive failed reconnect attempts" the instant
    // give-up fires (failedAttempts === policy.maxAttempts + 1 at that
    // point, never more). Cap the reported figure so the UI and the log
    // agree on the same number (maxAttempts) instead of being off by one.
    const attempts = state === 'connected' || state === 'disabled'
      ? 0
      : Math.min(failedAttempts, policy.maxAttempts)
    return {
      serverName: config.serverName,
      state,
      attempts,
      maxAttempts: policy.maxAttempts,
      ...(lastErrorText === undefined ? {} : { lastError: lastErrorText }),
    }
  }

  function notifyStatusChange(): void {
    const snapshot = currentStatus()
    for (const listener of statusListeners) {
      try { listener(snapshot) } catch (error) { ctx.logger.error(error) }
    }
  }

  /** Pure state transition: clears `lastError` on reaching `connected`, clears `consentUrl` on leaving `needs-authorization`. */
  function setState(next: McpServerState): void {
    state = next
    if (next === 'connected') lastErrorText = undefined
    if (next !== 'needs-authorization') consentUrl = undefined
    notifyStatusChange()
  }

  /** Record the latest connection error without changing `state` (a retry may still be scheduled). */
  function recordError(message: string): void {
    lastErrorText = redactAbsolutePaths(message)
    notifyStatusChange()
  }

  /** Fires on every authorization-URL event (not just the first — {@link AUTH_GUIDANCE_SHOWN} gates the log, not this). */
  function onNeedsAuthorization(authorizationUrl: URL): void {
    if (disposed) return
    consentUrl = authorizationUrl.toString()
    setState('needs-authorization')
  }

  // Built once per plugin instance: it closes over the credential store and
  // the server identity, and every generation shares its persisted state.
  const authProvider = resolveAuthProvider(ctx, config, label, onNeedsAuthorization)

  /** A generation may act only while it is the current one on a live plugin. */
  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  /**
   * Serializes every syncTools call — initial syncs and notification re-syncs
   * across all generations — so two syncs can never interleave their
   * dispose-previous/register-next swap (which would double-dispose one
   * generation and leak another).
   */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueueSync(generation: Client, syncOpts: ToolBridgeOptions = opts): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      disposers = await syncTools(generation, ctx, syncOpts, disposers)
    })
    // The chain tail must survive a failed sync; the enqueuing caller owns reporting.
    syncChain = run.catch(() => {})
    return run
  }

  /** One disconnect decision per generation: the isCurrent guard makes racing close/error signals idempotent. */
  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = undefined
    clientClosed = undefined
    scheduleReconnect()
  }

  /** Wait for the transport-owned close signal without letting a broken transport wedge teardown forever. */
  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(false) }, GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      void closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    // A pending authorize-start consent flow owns the provider right now —
    // never arm (or leave armed) a timer that would run a competing
    // `generation.connect()` attempt. `beginAuthorization` already cleared
    // whatever was armed at the moment it was called; this keeps every
    // LATER disconnect during the same window from re-arming one. Not
    // silently lost, though (reviewer finding, SWD-164 round 5): a disconnect
    // THIS call is dropping is recorded via `disconnectDroppedDuringAuthorization`
    // so `endAuthorization`'s failure path can replay it once suppression lifts
    // — otherwise a `connected` row that drops mid-flow would stay reporting
    // stale `connected` status forever, with no client and no armed timer.
    if (authorizationPending) {
      disconnectDroppedDuringAuthorization = true
      return
    }
    const lostEstablishedConnection = connectedAt !== undefined
    if (!policy.enabled) {
      const message = lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect'
      ctx.logger.error(`${label}: ${message}`)
      setState('disabled')
      return
    }
    // A connection that stayed up past the stability window (= maxDelayMs, the
    // longest backoff spacing) ended the previous outage: start a fresh budget.
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      // Enqueue the give-up disposal so it cannot race an in-flight sync's
      // phase-2 swap (which checks isCurrent inside the queue).
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      })
      ctx.logger.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
      setState('gave-up')
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    ctx.logger.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    // A server that was `connected` and just dropped stays reported as
    // `connected` (attempts 0) through the whole backoff wait unless this
    // transitions state explicitly — `generationDown` only calls
    // `scheduleReconnect`, it never itself changes `state`. Guarded against
    // `needs-authorization`: an `UnauthorizedError` attempt already ran
    // `onNeedsAuthorization` → `setState('needs-authorization')` earlier in
    // THIS SAME failed attempt before falling through to here, and that
    // state (with its internally-captured consent URL) must survive the
    // backoff wait, not get clobbered back to `connecting` one line later.
    // `setState` notifies for us, so this replaces the bare
    // `notifyStatusChange()` this branch used before.
    if (state !== 'needs-authorization') setState('connecting')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      settling = connectGeneration(false)
    }, delayMs)
    // An armed reconnect timer must never hold the process open on its own.
    reconnectTimer.unref()
  }

  /**
   * One connection attempt: fresh transport + client (the MCP SDK binds a
   * Protocol to one transport for life), connect, then queue the initial tool
   * sync. The startup flag belongs to the attempt rather than the shared sync
   * queue, so an early notification cannot consume strict startup semantics.
   * Every failure funnels through {@link generationDown}; success arms the
   * onclose-driven disconnect path. Never rejects.
   *
   * @param startup - Whether this is the plugin's activation attempt.
   */
  async function connectGeneration(startup: boolean): Promise<void> {
    attemptInFlight = true
    try {
      await runConnectAttempt(startup)
    } finally {
      attemptInFlight = false
    }
  }

  /**
   * The actual attempt body, split out so {@link connectGeneration} can
   * bracket it with {@link attemptInFlight} regardless of which of its
   * several return points fires.
   */
  async function runConnectAttempt(startup: boolean): Promise<void> {
    const generation = new Client(
      { name: 'dsh-mcp-client', version: '0.0.1' },
      { capabilities: {} },
    )
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    let attemptSettled = false
    let closeObserved = false
    const hasClosed = (): boolean => closeObserved
    client = generation
    clientClosed = closed.promise
    generation.onclose = () => {
      closeObserved = true
      closed.resolve()
      // A failed connect owns its close barrier in the catch path below. An
      // established generation can transition down directly from this signal.
      if (attemptSettled) generationDown(generation)
    }
    // Registered before connect so a list change during the initial sync is
    // queued behind it rather than dropped.
    generation.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (!isCurrent(generation)) return
        ctx.logger.info(`${label}: tool list changed, re-syncing`)
        try {
          await enqueueSync(generation)
        } catch (error) {
          // Fetch-phase failure: the previous generation is still registered
          // and `disposers` still owns it — keep serving the last good list.
          if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
        }
      },
    )
    try {
      await generation.connect(createTransport(config, authProvider))
      if (hasClosed()) {
        attemptSettled = true
        generationDown(generation)
        return
      }
      await enqueueSync(generation, startup ? startupOpts : opts)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      // Disposal clears current ownership before it closes the generation, so
      // only a live supervisor reports an attempt failure. An authorization
      // failure already logged its consent guidance through the provider's
      // onAuthorizationUrl hook — repeating it per attempt would only spam.
      if (isCurrent(generation) && !(error instanceof UnauthorizedError)) {
        ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`)
        recordError(String(error))
      }
      try { await generation.close() } catch { /* transport already gone */ }
      const quiesced = hasClosed() || await waitForClose(closed.promise)
      attemptSettled = true
      if (!isCurrent(generation)) return
      if (!quiesced) {
        client = undefined
        clientClosed = undefined
        ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`)
        // No automatic retry follows this path (unlike the ordinary give-up
        // budget exhaustion) — report it the same way so a human has a
        // single, consistent "it's stuck, here's the button" state rather
        // than a status frozen on "connecting" forever.
        recordError('failed generation did not close in time — reconnect stopped to avoid overlapping server processes')
        setState('gave-up')
        return
      }
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (hasClosed()) {
      generationDown(generation)
      return
    }
    if (!isCurrent(generation)) return
    connectedAt = Date.now()
    setState('connected')
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
  }

  /** The in-flight (or last settled) connection attempt; dispose awaits it for quiescence. */
  let settling = connectGeneration(true)

  // The ready promise settles when the first attempt finishes (regardless of
  // success). If the first attempt fails and reconnect is enabled, the
  // supervisor is already scheduling a retry — ready just reports the outcome.
  const ready: Promise<ConnectionOutcome> = settling.then(() => {
    // After settling: if client is set the initial connect+sync succeeded.
    // If not, the supervisor either scheduled a retry (error logged) or gave
    // up (error logged). Either way the outcome is reported with the real error.
    // Note: settling.then() is a microtask; stdio onclose is a macrotask — so
    // a server that crashes AFTER a successful initial sync cannot flip client
    // to undefined before this continuation runs.
    if (client !== undefined) return {}
    /* v8 ignore next -- defensive: firstAttemptError is always set when connect/sync fails */
    return { error: firstAttemptError ?? new Error(`${label}: initial connection failed`) }
  })

  return {
    ready,
    async dispose(): Promise<void> {
      disposed = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const current = client
      const currentClosed = clientClosed
      client = undefined
      clientClosed = undefined
      if (current !== undefined) {
        try { await current.close() } catch { /* transport already gone */ }
        if (currentClosed !== undefined && !await waitForClose(currentClosed)) {
          ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal — server shutdown may be incomplete`)
        }
      }
      // Quiesce, don't just request it: the in-flight attempt enqueues its
      // sync before settling, so awaiting both leaves `disposers` final.
      await settling
      await syncChain
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
    status: currentStatus,
    peekConsentUrl(): string | undefined {
      return consentUrl
    },
    reconnectNow(): void {
      if (disposed) {
        ctx.logger.warn(`${label}: reconnectNow ignored — plugin instance is disposed`)
        return
      }
      if (state !== 'gave-up' && state !== 'disabled') {
        ctx.logger.warn(`${label}: reconnectNow ignored — state is "${state}", not gave-up or disabled`)
        return
      }
      const now = Date.now()
      if (now - lastManualReconnectAt < MANUAL_RECONNECT_MIN_INTERVAL_MS) {
        ctx.logger.warn(`${label}: reconnectNow ignored — a manual reconnect was already accepted within the last ${MANUAL_RECONNECT_MIN_INTERVAL_MS}ms`)
        return
      }
      lastManualReconnectAt = now
      // A manual nudge is at least as strong evidence of a fresh start as
      // the stability-window reset below: start the next outage's budget
      // at attempt 1, never carrying over the exhausted count that caused
      // `gave-up`, and clear any armed automatic retry so this attempt is
      // never doubled.
      //
      // This guard is provably unreachable: scheduleReconnect's only two
      // branches that set `state` to 'gave-up' or 'disabled' (the gate just
      // above) never arm `reconnectTimer` on their way there, and the ONE
      // place that does arm it (scheduleReconnect's retry branch) always
      // sets `state` to 'connecting' (or leaves it 'needs-authorization'),
      // never 'gave-up'/'disabled' — and the timer's own setTimeout callback
      // clears `reconnectTimer` to undefined before ever calling
      // connectGeneration again. So by the time the gate above lets
      // execution reach here, `reconnectTimer` is always undefined.
      // Unreachable; kept only because dispose() and
      // forceReconnectAfterAuthorization() share this exact clear-and-null
      // idiom and this one stays symmetric with them.
      /* v8 ignore next 4 -- see proof above */
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      failedAttempts = 0
      connectedAt = undefined
      setState('connecting')
      settling = connectGeneration(false)
    },
    onStatusChange(callback: (status: McpServerStatus) => void): () => void {
      statusListeners.add(callback)
      return () => { statusListeners.delete(callback) }
    },
    authProvider,
    forceReconnectAfterAuthorization(): void {
      if (disposed || client !== undefined) return
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      failedAttempts = 0
      connectedAt = undefined
      // This success path owns the recovery itself — a disconnect
      // scheduleReconnect dropped while suppressed would otherwise still be
      // replayed by endAuthorization() right after this returns (see its
      // own doc); clearing it here too keeps that replay from ever being
      // live simultaneously with this call's own fresh generation.
      disconnectDroppedDuringAuthorization = false
      setState('connecting')
      settling = connectGeneration(false)
    },
    reportAuthorizationFailure(message: string): void {
      if (disposed) return
      recordError(message)
    },
    beginAuthorization(): void {
      if (disposed) return
      authorizationPending = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
    },
    endAuthorization(): void {
      if (disposed) return
      authorizationPending = false
      if (!disconnectDroppedDuringAuthorization) return
      disconnectDroppedDuringAuthorization = false
      // This guard's TRUE branch (a generation already live) is unreachable:
      // the only path that can set `client` while this flag could still be
      // true is forceReconnectAfterAuthorization, and it clears the flag
      // itself before returning — so by the time any caller reaches this
      // line with the flag still true, no generation has started yet and
      // `client` is still undefined. Kept as a defensive second guard
      // (rather than an assertion) for any future caller sequence, not as a
      // branch meant to be exercised.
      /* v8 ignore next -- see proof above */
      if (client !== undefined) return
      // Replay the disconnect scheduleReconnect dropped while suppressed,
      // exactly as if it were happening now (reviewer finding, SWD-164 round 5).
      scheduleReconnect()
    },
    isReconnectAttemptInFlight(): boolean {
      return attemptInFlight
    },
  }
}

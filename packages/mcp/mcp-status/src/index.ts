/**
 * Live Remote projection of every active mcp-client connection's status, plus
 * the two actions a Settings panel needs beyond read-only status: starting
 * (or resuming) an OAuth consent flow, and manually retrying a server that
 * gave up or has reconnect disabled.
 *
 * Mounted PERMANENTLY, once, alongside the other host services in
 * `packages/bundle/web-app/cordis.patch.yml` — never lazily from inside an
 * mcp-client instance's own activation. That used to be this service's own
 * mount path (`ensureStatusRegistry`, `root.plugin()` the first time any
 * mcp-client instance activated); it was fully correct at the Cordis fiber
 * level (root-scoped, survived any one instance's disposal) but WRONG at the
 * typert-loader level: `packages/typert/loader/src/index.ts` registers and
 * withdraws a package's strict Typert manifest keyed to a LOADER ENTRY, and
 * this service had none of its own — it rode on whichever
 * `@deepseek-ai/dsh-mcp-client` entry happened to trigger its mount. Disabling
 * the LAST live mcp-client server therefore withdrew `mcp/set-enabled`'s
 * strict registration too, and `packages/api/gateway/src/index.ts`'s
 * strict/SRC-fallback latch is one-way: once a strict registration for an
 * endpoint has ever existed, SRC fallback is permanently forbidden for that
 * endpoint, even though this (still-alive) service could have answered it
 * (SWD-164 round 5, defect 2).
 *
 * The fix is this package's existence: `@deepseek-ai/dsh-mcp-status` carries
 * its OWN permanent Loader entry, so typert-loader's registration is keyed
 * to an entry that never unmounts — entirely decoupled from any individual
 * mcp-client server's lifecycle. mcp-client itself keeps only a root-scoped
 * handle store (`@deepseek-ai/dsh-mcp-client/src/handle-store.ts`) that every
 * instance registers into UNCONDITIONALLY, whether or not this package is
 * mounted anywhere — a headless or embedded host with no Remote surface
 * behaves identically, minus the surface itself.
 *
 * `disabled` (the connection supervisor's `reconnect.enabled: false` state,
 * `@deepseek-ai/dsh-mcp-client/status`) and "this plugin mount is disabled"
 * (the Loader's `entry.disabled`, toggled here by `set-enabled`) are
 * deliberately independent concepts sharing an unfortunate word: a mount the
 * Loader never activates has no live `ConnectionHandle` at all, so `list()`
 * synthesizes its row instead — straight off the same `cordis.patch.yml`
 * `set-enabled` edits, as `state: 'disabled'`, `attempts: 0`, no live
 * handle — so a disabled server never vanishes from the panel with no way
 * back. `set-enabled` therefore only ever *disables a currently-listed
 * server going forward* (after the next Loader reload) or *re-enables one
 * that is reporting `disabled` from the patch file because it was
 * previously disabled* — it never needs to read the handle store to do its
 * job, only the patch file.
 *
 * @module @deepseek-ai/dsh-mcp-status
 */

import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import {
  buildNextMcpPatches,
  defaultPatchPath,
  listMcpHandles,
  locateMcpMount,
  readMcpPatchEntries,
  redactAbsolutePaths,
  registerMcpHandle,
  subscribeMcpHandles,
  RECONNECT_DEFAULTS,
  SERVER_NAME_PATTERN,
  ConsentTimeoutError,
  startAuthorizationCallbackListener,
} from '@deepseek-ai/dsh-mcp-client'
import type { Config, ConnectionHandle, RegisterMcpHandleOptions } from '@deepseek-ai/dsh-mcp-client'
import type { McpServerStatus } from '@deepseek-ai/dsh-mcp-client/status'
import type { McpAuthorizeStartResult } from './status.ts'

export type { McpAuthorizeStartResult } from './status.ts'
export {
  MCP_AUTHORIZE_START_ENDPOINT,
  MCP_AUTHORIZE_START_METHOD,
  MCP_PRIVILEGED_ENDPOINTS,
  MCP_RECONNECT_ENDPOINT,
  MCP_RECONNECT_METHOD,
  MCP_SET_ENABLED_ENDPOINT,
  MCP_SET_ENABLED_METHOD,
  MCP_STATUS_CHANGED_EVENT,
  MCP_STATUS_ENDPOINT,
  MCP_STATUS_METHOD,
  MCP_STATUS_NAMESPACE,
} from './status.ts'
export type { McpServerState, McpServerStatus } from '@deepseek-ai/dsh-mcp-client/status'

/**
 * Bound on waiting for the browser round trip after `authorize-start` hands
 * the client a consent URL. Fixed (not caller-supplied — the RPC has no
 * timeout parameter) and well under the ceiling
 * `auth-cli.ts`'s own `--timeout-ms` validates against
 * (`NODE_TIMER_MAX_MS`); sized the same as that CLI's documented default.
 */
export const HOST_CONSENT_TIMEOUT_MS = 300_000

/**
 * Bound on {@link McpStatusRegistryService.authorizeStart}'s own reachability
 * probe (see its doc) — generous enough for a slow but live server, short
 * enough that a dead one fails the RPC fast rather than stalling the click.
 */
const AUTHORIZE_REACHABILITY_PROBE_TIMEOUT_MS = 5_000

/** Bound on disambiguating backup-filename suffixes, mirroring `org-served-roster.ts`. */
const MAX_BACKUP_FILENAME_ATTEMPTS = 100

/**
 * Write a timestamped backup of the patch file's previous bytes, never
 * silently destroying an existing backup. Parameterized copy of
 * `backupOrgServedRosterBytes` in `@deepseek-ai/dsh-host-apiproxy`'s
 * `org-served-roster.ts` — same collision-safe protocol, applied to this
 * independent file. Kept local to `setEnabled`'s own write path rather than
 * `@deepseek-ai/dsh-mcp-client`'s handle-store, which already exports the
 * read-side helpers this method composes with this one.
 * @param path - the patch file's absolute path.
 * @param currentBytes - the previous content to preserve.
 * @returns the backup file's path.
 */
async function backupPatchBytes(path: string, currentBytes: Buffer): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${path}.bak-${stamp}`
  for (let attempt = 0; attempt < MAX_BACKUP_FILENAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${String(attempt)}`
    let handle: import('node:fs/promises').FileHandle | undefined
    try {
      handle = await open(candidate, 'wx')
      await handle.writeFile(currentBytes)
      await handle.sync()
      return candidate
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
      throw new Error(`cordis patch file "${path}" could not be backed up before set-enabled: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await handle?.close()
    }
  }
  throw new Error(`cordis patch file "${path}" has no free backup filename after ${String(MAX_BACKUP_FILENAME_ATTEMPTS)} same-millisecond attempts`)
}

/**
 * Content token for the patch file's bytes, mirroring `handle-store.ts`'s own
 * helper — see that module's doc for why `setEnabled` hashes its own reads
 * rather than taking a caller-supplied token.
 */
function hashMcpPatchBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Options for {@link McpStatusRegistryService}; the `patchPath` override exists for tests only. */
export interface McpStatusRegistryOptions {
  /**
   * Absolute path to the `cordis.patch.yml` `set-enabled` patches. Defaults
   * to `@deepseek-ai/dsh-mcp-client`'s `defaultPatchPath` — the running
   * profile's own patch file, resolved from `ctx.baseUrl`, never a
   * hardcoded profile name.
   */
  patchPath?: string
}

/**
 * Remote-only service exposing every active mcp-client connection's status
 * and the two actions beyond read-only status: `authorize-start` and
 * `reconnect`, plus the Loader-mount `set-enabled` toggle. See the module
 * doc above for why `set-enabled` never reads the handle store.
 */
export class McpStatusRegistryService extends TypertRemoteService {
  /** `undefined` when this host has no profile loader to resolve a default from. */
  private readonly patchPath: string | undefined
  private readonly registerOptions: RegisterMcpHandleOptions
  /**
   * serverName of the one in-flight `authorize-start` consent flow, if any —
   * the shared loopback listener is single-flight, not per-server.
   */
  private pendingFlow: string | undefined

  constructor(ctx: Context, options: McpStatusRegistryOptions = {}) {
    super(ctx, 'mcpStatus', { namespace: 'mcp' })
    this.patchPath = options.patchPath ?? defaultPatchPath(ctx)
    this.registerOptions = this.patchPath === undefined ? {} : { patchPath: this.patchPath }
    // Forward every status transition the handle store sees — a live
    // connection's own transitions and the final synthesized transition on
    // deregistration — as a real `mcp/status-changed` emit. This is the one
    // place that call happens: the store itself only ever hands back a plain
    // `McpServerStatus` object, never touching the Cordis `Events` augmentation
    // (declared in THIS package's `./status.ts`, which `./handle-store.ts`
    // must not import — see that module's doc).
    this.ctx.effect(
      () => subscribeMcpHandles(ctx, (status) => { this.ctx.emit('mcp/status-changed', status) }),
      'mcp-status.statusForwarding',
    )
  }

  /**
   * Register one mcp-client instance's live connection with
   * `@deepseek-ai/dsh-mcp-client`'s handle store, using this service's own
   * resolved `patchPath` for the deregister decision. Exists for tests only
   * — production registration (`@deepseek-ai/dsh-mcp-client/src/index.ts`'s
   * `apply()`) calls `registerMcpHandle` directly and unconditionally,
   * never through this service, since a host may have no
   * `@deepseek-ai/dsh-mcp-status` mount at all.
   * @param config - the resolved plugin config this handle belongs to.
   * @param handle - the live supervisor handle.
   * @returns an unregister function; call it from the instance's own disposal.
   */
  register(config: Config, handle: ConnectionHandle): () => Promise<void> {
    return registerMcpHandle(this.ctx, config, handle, this.registerOptions)
  }

  /**
   * List every registered server's current status, plus a synthesized
   * `disabled` row (attempts 0, no live handle) for every OTHER
   * `@deepseek-ai/dsh-mcp-client` mount the profile's `cordis.patch.yml`
   * marks `disabled: true` — without this, a server the Tools panel just
   * disabled would vanish from the list entirely (the Loader never
   * activates a disabled mount, so it has no live `ConnectionHandle`) and
   * the panel would have no way to show a re-enable action for it.
   *
   * On a failed patch-file read (`undefined`, already `warn`ed inside
   * `readMcpPatchEntries`), this degrades to live rows only — no
   * synthesized `disabled` row is fabricated from a read that never
   * completed.
   * @returns every registered or patch-disabled server's current status.
   */
  @Remote('status')
  async list(): Promise<McpServerStatus[]> {
    const live = [...listMcpHandles(this.ctx).values()].map(entry => entry.handle.status())
    const liveNames = new Set(live.map(status => status.serverName))
    const patchEntries = await readMcpPatchEntries(this.ctx, this.patchPath)
    const disabledFromPatch: McpServerStatus[] = []
    for (const [serverName, entry] of patchEntries ?? []) {
      if (!entry.disabled || liveNames.has(serverName)) continue
      disabledFromPatch.push({
        serverName,
        state: 'disabled',
        attempts: 0,
        maxAttempts: RECONNECT_DEFAULTS.maxAttempts,
      })
    }
    return [...live, ...disabledFromPatch]
  }

  /**
   * Begin (or resume) the OAuth consent flow for one server: fetch a fresh
   * authorization URL from the same persisted provider the connection
   * supervisor uses, bind the shared loopback listener to the state that URL
   * carries, and — only once the bind itself has actually succeeded — return
   * the URL; the exchange and the resulting reconnect run in the background
   * after this resolves.
   * @param serverName - the server to authorize.
   * @returns the consent URL to open.
   * @throws when the server is unknown, has no OAuth configured, is already
   *   authorized, a consent flow is already pending for ANY server (the
   *   shared listener is single-flight, not per-server), the server is not
   *   reachable right now, or the loopback port could not be bound (e.g. a
   *   concurrent `dsh-mcp-client-auth` run already holds it) — reported
   *   immediately rather than only surfacing once the unreachable listener's
   *   timeout eventually elapses.
   */
  @Remote('authorize-start')
  async authorizeStart(serverName: string): Promise<McpAuthorizeStartResult> {
    const entry = listMcpHandles(this.ctx).get(serverName)
    if (entry === undefined) throw new Error(`mcp authorize-start: unknown server "${serverName}"`)
    const { handle, config } = entry
    if (handle.authProvider === undefined || config.transport !== 'streamable-http') {
      throw new Error(`mcp authorize-start: server "${serverName}" has no OAuth configured`)
    }
    if (this.pendingFlow !== undefined) {
      throw new Error(
        `mcp authorize-start: a consent flow is already pending for "${this.pendingFlow}" — `
        + 'only one loopback listener is available at a time; wait for it to finish or time out before starting another',
      )
    }
    // Reserve the shared listener slot synchronously, before any await, so
    // two concurrent calls can never both pass the check above.
    this.pendingFlow = serverName
    try {
      // Probe the server itself before trusting the SDK's own consent-URL
      // synthesis: `auth()` builds the authorization URL from (possibly
      // cached) OAuth discovery metadata, and its own discovery fetches
      // treat a connection failure the same as a browser CORS failure (both
      // surface as `TypeError` — Node's fetch gives a down server the exact
      // same error shape a cross-origin block gets in a browser) and fall
      // back to building a URL anyway rather than throwing. So a fully dead
      // server still reaches `peekConsentUrl()` with something to return
      // (SWD-164 pilot finding) unless THIS call checks reachability itself
      // — a plain request to the server's own URL; ANY response at all —
      // including a redirect, a 401/404/405, whatever — proves the
      // connection succeeded, so `redirect: 'manual'` stops `fetch` itself
      // from chasing a 3xx (and potentially throwing on ITS target) and
      // treats the redirect response as reachability too. Only a
      // network-level failure or the probe's own timeout rejects.
      try {
        await fetch(config.url, {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(AUTHORIZE_REACHABILITY_PROBE_TIMEOUT_MS),
        })
      } catch (error) {
        throw new Error(`mcp authorize-start: server "${serverName}" is not reachable: ${redactAbsolutePaths(String(error))}`)
      }
      const result = await sdkAuth(handle.authProvider, { serverUrl: config.url })
      if (result === 'AUTHORIZED') {
        throw new Error(`mcp authorize-start: server "${serverName}" is already authorized — try Reconnect instead of Authorize`)
      }
      // Internal-only: NEVER put this on McpServerStatus — the URL carries
      // the CSRF `state`, so leaking it over the public status poll would let
      // anyone who opens it complete THIS flow (SWD-164 sentinel finding).
      const consentUrl = handle.peekConsentUrl()
      // This whole branch is unreachable: a REDIRECT result always ran
      // through `onAuthorizationUrl` first, which sets `consentUrl` before
      // `sdkAuth` returns — kept only as a named diagnostic in case that SDK
      // invariant ever changes, rather than an `as string`/`!` cast below.
      /* v8 ignore next 3 -- see proof above */
      if (consentUrl === undefined) {
        throw new Error(`mcp authorize-start: server "${serverName}" did not produce a consent URL`)
      }
      // `?? undefined` right-hand side is unreachable: `CredentialsOAuthProvider.state()`
      // (oauth.ts) always returns a fresh non-empty random token, and the MCP SDK's
      // `auth()` always embeds that exact value as the `state` query parameter on the
      // authorization URL it builds — so `searchParams.get('state')` is never null for
      // any consent URL this method ever reads.
      /* v8 ignore next -- see proof above */
      const expectedState = new URL(consentUrl).searchParams.get('state') ?? undefined
      const port = Number(new URL(handle.authProvider.redirectUrl).port)
      // `exactOptionalPropertyTypes` rejects `{ expectedState: undefined }` —
      // omit the key entirely rather than set it to `undefined`. The `{}`
      // arm is unreachable (`expectedState` is never undefined; see the
      // proof just above), kept only to satisfy that strictness rule.
      const listener = startAuthorizationCallbackListener(
        port,
        HOST_CONSENT_TIMEOUT_MS,
        /* v8 ignore next -- see proof above */
        expectedState === undefined ? {} : { expectedState },
      )
      // `code` rejects with the same error as `bound` on a bind failure (both
      // settle from the listener's one `server.on('error', ...)` handler); if
      // the `await listener.bound` below throws, `code` is never otherwise
      // observed and its rejection would be unhandled.
      listener.code.catch(() => {})
      try {
        // Bind before promising the client anything: a port already held by
        // a concurrent `dsh-mcp-client-auth` run must fail THIS call now, not
        // leave a dead consent URL that silently never completes.
        await listener.bound
      } catch (error) {
        throw new Error(`mcp authorize-start: could not start the consent listener: ${redactAbsolutePaths(String(error))}`)
      }
      // The capture itself still runs in the background: this RPC returns
      // the URL as soon as the listener is actually live so the client can
      // open it synchronously on the user's click (never awaiting before
      // `window.open`); completion or timeout releases the slot.
      void this.runConsentCapture(serverName, handle, listener.code)
      return { consentUrl }
    } catch (error) {
      this.pendingFlow = undefined
      throw error
    }
  }

  /** Background half of {@link authorizeStart}: wait for the callback, exchange the code, reconnect, release the slot. */
  private async runConsentCapture(
    serverName: string,
    handle: ConnectionHandle,
    code: Promise<string>,
  ): Promise<void> {
    try {
      const authorizationCode = await code
      /* v8 ignore next -- authProvider is captured non-undefined by the caller
       * before this runs; TypeScript cannot see that across the async boundary */
      if (handle.authProvider === undefined) return
      const entry = listMcpHandles(this.ctx).get(serverName)
      const serverUrl = entry?.config.transport === 'streamable-http' ? entry.config.url : undefined
      if (serverUrl === undefined) return
      const result = await sdkAuth(handle.authProvider, { serverUrl, authorizationCode })
      /* v8 ignore next 3 -- SDK 1.29.0 authInternal always returns AUTHORIZED or throws given an
       * authorizationCode (auth.js ~262-271) — same proof already relied on in auth-cli.ts's
       * identical guard right after its own sdkAuth(..., { authorizationCode }) call */
      if (result !== 'AUTHORIZED') {
        throw new Error('token exchange did not complete')
      }
      handle.forceReconnectAfterAuthorization()
    } catch (error) {
      this.ctx.logger.error(`mcp authorize-start(${serverName}): consent flow failed: ${redactAbsolutePaths(String(error))}`)
      // `authorize-start` already returned the consent URL by the time any
      // of this runs, so the only way the user ever learns the flow did not
      // finish is through the row itself (SWD-164 pilot finding: previously
      // this was logged here and nowhere else — the 5-minute consent
      // timeout was silent on the client). A timeout gets its own plain-
      // English message; any other exchange failure reports the (redacted)
      // real error, same as every other connection failure's `lastError`.
      const message = error instanceof ConsentTimeoutError
        ? 'Authorization timed out after 5 minutes — try again'
        : redactAbsolutePaths(String(error))
      handle.reportAuthorizationFailure(message)
    } finally {
      this.pendingFlow = undefined
    }
  }

  /**
   * Manually retry a server now. A thin wrapper over
   * `ConnectionHandle.reconnectNow` — every guard (state, rate limit) lives
   * there so the same rule applies whether this RPC or a test calls it
   * directly.
   * @param serverName - the server to retry.
   * @throws when the server is unknown.
   */
  @Remote('reconnect')
  reconnect(serverName: string): void {
    const entry = listMcpHandles(this.ctx).get(serverName)
    if (entry === undefined) throw new Error(`mcp reconnect: unknown server "${serverName}"`)
    entry.handle.reconnectNow()
  }

  /**
   * Persist one plugin mount's enabled flag via an atomic `cordis.patch.yml`
   * read-modify-write (the `org-served-roster.ts` pattern): read current
   * bytes (hashed as a compare-before-write token), locate the mount,
   * validate, build the next document, re-parse and self-validate it,
   * re-read and re-hash the file to confirm nothing else wrote to it since
   * the first read, write a timestamped backup, then temp-file + fsync +
   * atomic rename over the original. The Loader's existing file-watch/HMR
   * picks the change up; this method never touches `ctx.loader` itself.
   * @param serverName - the mount's `config.serverName` to toggle; validated
   *   against `SERVER_NAME_PATTERN` and must match exactly one mount's
   *   `config.serverName` in the patch file — never its (opaque) `id`.
   * @param enabled - the proposed enablement.
   * @throws when `serverName` fails the pattern, this host has no profile
   *   file to resolve a patch path from, no mount or more than one mount has
   *   that `config.serverName` in the patch file (set-enabled never inserts
   *   one, and never guesses among several), the file changed between the
   *   initial read and the write (retry), or any I/O, parse, or structural
   *   step fails.
   */
  @Remote('set-enabled')
  async setEnabled(serverName: string, enabled: boolean): Promise<void> {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      throw new Error(`mcp set-enabled: "${serverName}" is not a valid server name`)
    }
    if (this.patchPath === undefined) {
      throw new Error('mcp set-enabled: this host has no profile file to edit')
    }
    let currentBytes: Buffer
    try {
      currentBytes = await readFile(this.patchPath)
    } catch (error: unknown) {
      throw new Error(`mcp set-enabled: cordis patch file could not be read: ${redactAbsolutePaths(error instanceof Error ? error.message : String(error))}`)
    }
    const readToken = hashMcpPatchBytes(currentBytes)
    let patches: unknown
    try {
      patches = parseYaml(currentBytes.toString('utf8'))
    } catch (error: unknown) {
      // `: String(error)` is unreachable: see the identical proof on
      // `readMcpPatchEntries`'s own YAML-parse catch (handle-store.ts) — the
      // `yaml` package's `parse()` only ever throws `Error` subclasses.
      /* v8 ignore next -- see proof above */
      throw new Error(`mcp set-enabled: cordis patch file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(patches)) {
      throw new Error('mcp set-enabled: cordis patch file does not contain a top-level list')
    }
    const lookup = locateMcpMount(patches, serverName)
    if (lookup.kind === 'not-found') {
      throw new Error(`mcp set-enabled: no mount with serverName "${serverName}" exists in the cordis patch file — set-enabled never creates a new mount`)
    }
    if (lookup.kind === 'ambiguous') {
      throw new Error(`mcp set-enabled: ${String(lookup.count)} mounts have serverName "${serverName}" in the cordis patch file — refusing to guess which one to toggle`)
    }
    const location = lookup.location
    const nextPatches = buildNextMcpPatches(patches, location, enabled)
    const nextText = stringifyYaml(nextPatches, { indentSeq: false, singleQuote: true })

    // Self-validate through the same reader before anything touches disk.
    const reparsed: unknown = parseYaml(nextText)
    // `: undefined` arm is unreachable: `nextPatches` is always a plain
    // array (buildNextMcpPatches's return type), and stringifying an array
    // with the `yaml` package then re-parsing the result always yields an
    // array back — `reparsed` is never anything else here.
    /* v8 ignore next -- see proof above */
    const rereadLookup = Array.isArray(reparsed) ? locateMcpMount(reparsed, serverName) : undefined
    const rereadEnabled = rereadLookup !== undefined && rereadLookup.kind === 'found'
      && rereadLookup.location.entry.disabled === !enabled
    // Unreachable: `buildNextMcpPatches` always writes an explicit
    // `disabled: !enabled` onto exactly the entry `locateMcpMount` matched,
    // and re-locating that same, unreordered document always finds the same
    // entry with that same boolean faithfully round-tripped through the
    // `yaml` package — `rereadEnabled` is always true here. Kept as a named
    // diagnostic in case a future refactor of either helper breaks that.
    /* v8 ignore next 3 -- see proof above */
    if (!rereadEnabled) {
      throw new Error(`mcp set-enabled: produced document failed self-validation for mount "${serverName}"`)
    }

    // Compare-before-write: re-read right before the rename and refuse
    // loudly rather than clobber a write that landed between our initial
    // read above and this point (another `set-enabled` call, a manual edit,
    // or the Loader's own HMR file-watch rewriting the file).
    let recheckBytes: Buffer
    try {
      recheckBytes = await readFile(this.patchPath)
    } catch (error: unknown) {
      throw new Error(`mcp set-enabled: cordis patch file could not be re-read for the concurrency check: ${redactAbsolutePaths(error instanceof Error ? error.message : String(error))}`)
    }
    if (hashMcpPatchBytes(recheckBytes) !== readToken) {
      throw new Error('mcp set-enabled: cordis patch file changed since it was read — retry')
    }

    await backupPatchBytes(this.patchPath, currentBytes)

    const tempPath = `${this.patchPath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const handle = await open(tempPath, 'w')
      try {
        await handle.writeFile(nextText, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tempPath, this.patchPath)
    } catch (error: unknown) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw new Error(`mcp set-enabled: cordis patch file could not be written atomically: ${redactAbsolutePaths(error instanceof Error ? error.message : String(error))}`)
    }
  }
}

export default McpStatusRegistryService

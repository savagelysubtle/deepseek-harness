/**
 * Live Remote projection of every active mcp-client connection's status, plus
 * the two actions a Settings panel needs beyond read-only status: starting
 * (or resuming) an OAuth consent flow, and manually retrying a server that
 * gave up or has reconnect disabled. Mounted lazily, once per `ctx.root`, the
 * first time any mcp-client plugin instance activates ({@link
 * ensureStatusRegistry}) — mirrors the `activeServerNames` dedup already in
 * `index.ts`, with no new `cordis.yml` entry of its own.
 *
 * `disabled` (the connection supervisor's `reconnect.enabled: false` state,
 * `./status.ts`) and "this plugin mount is disabled" (the Loader's
 * `entry.disabled`, toggled here by `set-enabled`) are deliberately
 * independent concepts sharing an unfortunate word: a mount the Loader never
 * activates has no live `ConnectionHandle` at all, so it never appears in
 * `list()`. `set-enabled` therefore only ever *disables a currently-listed
 * server going forward* (after the next Loader reload) or *re-enables one
 * that is not currently listed because it was previously disabled* — it
 * never needs to read this registry to do its job, only the patch file.
 *
 * @module @deepseek-ai/dsh-mcp-client/status-registry
 */

import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { startAuthorizationCallbackListener } from './oauth-callback.ts'
import type { ConnectionHandle } from './connection.ts'
import { SERVER_NAME_PATTERN } from './index.ts'
import type { Config } from './index.ts'
import type { McpAuthorizeStartResult, McpServerStatus } from './status.ts'

export type { McpAuthorizeStartResult } from './status.ts'

// The `mcp/status-changed` Cordis Events augmentation lives in the client-safe
// `./status.ts` (exported as the package's `./status` subpath), matching the
// house convention (see e.g. `dsh-credentials/types`) of keeping an event's
// `declare module` merge in the type-only file consumers import for the
// forwarding-allowlist shape gate in `packages/api/remotes/src/index.ts`.

/**
 * Bound on waiting for the browser round trip after `authorize-start` hands
 * the client a consent URL. Fixed (not caller-supplied — the RPC has no
 * timeout parameter) and well under the ceiling
 * `auth-cli.ts`'s own `--timeout-ms` validates against
 * (`NODE_TIMER_MAX_MS`); sized the same as that CLI's documented default.
 */
export const HOST_CONSENT_TIMEOUT_MS = 300_000

/**
 * Default profile whose `cordis.patch.yml` `set-enabled` patches. Mirrors
 * `DEFAULT_ORG_PROFILE_NAME` in `@deepseek-ai/dsh-host-apiproxy`'s
 * `api-proxy.ts` — the SAME disclosed limitation ("the active profile is not
 * recoverable at runtime anywhere in this host today"), restated here rather
 * than imported (depending on the whole Host apiproxy package for one string
 * would invert this package's place in the dependency graph). A deployment
 * running any OTHER profile needs the `patchPath` constructor option below,
 * or `set-enabled` will patch the wrong profile's file. **Flagged for
 * reviewer/sentinel attention** — this is the same gap the plan's own
 * write-up called out for the Enable/Disable surface generally.
 */
const DEFAULT_PROFILE_NAME = 'web-stable'

/** Patch-file entry name set-enabled's cordis.patch.yml mutation uses for one plugin mount's YAML-level disable flag. */
const PATCH_PATCH_FILENAME = 'cordis.patch.yml'

/** Bound on disambiguating backup-filename suffixes, mirroring `org-served-roster.ts`. */
const MAX_BACKUP_FILENAME_ATTEMPTS = 100

function defaultPatchPath(): string {
  return join(dshHomePath('profiles', DEFAULT_PROFILE_NAME), PATCH_PATCH_FILENAME)
}

/** One registered mcp-client instance's live state. */
interface RegisteredServer {
  readonly config: Config
  readonly handle: ConnectionHandle
  readonly unsubscribe: () => void
}

/** Options for {@link McpStatusRegistryService}; the `patchPath` override exists for tests only. */
export interface McpStatusRegistryOptions {
  /** Absolute path to the `cordis.patch.yml` `set-enabled` patches. Defaults to {@link defaultPatchPath}. */
  patchPath?: string
}

/**
 * Matches one quoted absolute POSIX path, redacted whole first — see
 * `connection.ts`'s identical pair for why quoted paths go first.
 */
const QUOTED_DOUBLE_PATH_RE = /"(\/[^"]*)"/g
const QUOTED_SINGLE_PATH_RE = /'(\/[^']*)'/g
const BARE_ABSOLUTE_PATH_RE = /\/(?:[^\s"'<>]+\/)*[^\s"'<>]+/g

/** Redact absolute filesystem paths before an error reaches a log line or a thrown message that could cross the wire. */
function redactAbsolutePaths(text: string): string {
  return text
    .replace(QUOTED_DOUBLE_PATH_RE, '"<path>"')
    .replace(QUOTED_SINGLE_PATH_RE, '\'<path>\'')
    .replace(BARE_ABSOLUTE_PATH_RE, '<path>')
}

/**
 * Content token for the patch file's bytes — the compare-before-write half
 * of `setEnabled`'s read-modify-write, mirroring `org-served-roster.ts`'s
 * `hashOrgServedRosterBytes`/`expectedToken` pattern but self-contained: this
 * RPC takes no caller-supplied token (`set-enabled(serverName, enabled)` is a
 * toggle, not an edit-after-read UI flow), so `setEnabled` hashes its own
 * initial read and re-hashes a fresh read immediately before the rename,
 * refusing instead of clobbering a write that landed in between.
 * @param bytes - the file content to hash.
 * @returns a hex digest naming exactly these bytes.
 */
function hashMcpPatchBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Write a timestamped backup of the patch file's previous bytes, never
 * silently destroying an existing backup. Parameterized copy of
 * `backupOrgServedRosterBytes` in `@deepseek-ai/dsh-host-apiproxy`'s
 * `org-served-roster.ts` — same collision-safe protocol, applied to this
 * independent file.
 * @param path - the patch file's absolute path.
 * @param currentBytes - the previous content to preserve.
 * @returns the backup file's path.
 */
async function backupPatchBytes(path: string, currentBytes: Buffer): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${path}.bak-${stamp}`
  for (let attempt = 0; attempt < MAX_BACKUP_FILENAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${String(attempt)}`
    let handle: FileHandle | undefined
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

/** One mount entry's position inside a parsed `cordis.patch.yml` top-level list, flat or nested one level under a group's `insert`. */
interface McpMountLocation {
  readonly topIndex: number
  readonly insertIndex?: number
  readonly entry: Readonly<Record<string, unknown>>
}

/**
 * Locate a mount by `id === serverName`, either a flat top-level entry (the
 * `- id: hmr` / `disabled: true` shape this deployment's own patch files
 * already use) or nested one level inside a group's `insert` list (the shape
 * `org-served-roster.ts`'s mounts use). Never creates — a caller that finds
 * nothing here must fail loud rather than insert a new mount.
 * @param patches - the parsed top-level patch list.
 * @param serverName - the mount id to find.
 * @returns the mount's position, or `undefined` if no entry matches.
 */
function locateMcpMount(patches: readonly unknown[], serverName: string): McpMountLocation | undefined {
  for (const [topIndex, patch] of patches.entries()) {
    if (typeof patch !== 'object' || patch === null) continue
    const record = patch as Record<string, unknown>
    if (record.id === serverName) return { topIndex, entry: record }
    const insert = record.insert
    if (!Array.isArray(insert)) continue
    for (const [insertIndex, nested] of insert.entries()) {
      if (typeof nested !== 'object' || nested === null) continue
      if ((nested as Record<string, unknown>).id === serverName) {
        return { topIndex, insertIndex, entry: nested as Record<string, unknown> }
      }
    }
  }
  return undefined
}

/**
 * Build the next patch document with minimal new objects, writing an
 * explicit `disabled: true|false` onto exactly the matched entry — always
 * explicit (never omitted on enable) so the written file is unambiguous on
 * a re-read regardless of what Cordis treats as the key's absent default.
 * @param patches - the parsed top-level patch list.
 * @param location - the matched mount's position, from {@link locateMcpMount}.
 * @param enabled - the proposed enablement.
 * @returns the next top-level patch list.
 */
function buildNextMcpPatches(patches: readonly unknown[], location: McpMountLocation, enabled: boolean): unknown[] {
  const next = [...patches]
  if (location.insertIndex === undefined) {
    next[location.topIndex] = { ...location.entry, disabled: !enabled }
    return next
  }
  const currentTop = next[location.topIndex] as Record<string, unknown>
  const currentInsert = currentTop.insert as unknown[]
  const nextInsert = [...currentInsert]
  nextInsert[location.insertIndex] = { ...location.entry, disabled: !enabled }
  next[location.topIndex] = { ...currentTop, insert: nextInsert }
  return next
}

/** Lazily-mounted-once-per-root registry singletons; dedup mirrors `activeServerNames` in `index.ts`. */
const registries = new WeakMap<Context, Promise<McpStatusRegistryService>>()

/**
 * Get (or lazily mount) the one {@link McpStatusRegistryService} for this
 * app. The first mcp-client instance to activate wins the mount; every
 * later instance (including a later HMR reload of an earlier one) reuses
 * it. Mounted on `ctx.root` specifically — not the calling instance's own
 * `ctx` — so disposing one server's plugin instance never tears down the
 * shared registry every other server's status still depends on.
 * @param ctx - any mcp-client instance's plugin context.
 * @param options - test-only override for {@link McpStatusRegistryOptions.patchPath}.
 * @returns the live registry service.
 */
export function ensureStatusRegistry(ctx: Context, options: McpStatusRegistryOptions = {}): Promise<McpStatusRegistryService> {
  const root = ctx.root
  let pending = registries.get(root)
  if (pending === undefined) {
    pending = (async () => {
      const fiber = root.plugin(McpStatusRegistryService, options)
      await fiber
      return root.get('mcpStatus') as McpStatusRegistryService
    })()
    registries.set(root, pending)
  }
  return pending
}

/**
 * Remote-only service exposing every active mcp-client connection's status
 * and the two actions beyond read-only status: `authorize-start` and
 * `reconnect`, plus the Loader-mount `set-enabled` toggle. See the module
 * doc above for why `set-enabled` never reads this registry's own
 * `handles` map.
 */
export class McpStatusRegistryService extends TypertRemoteService {
  private readonly handles = new Map<string, RegisteredServer>()
  private readonly patchPath: string
  /**
   * serverName of the one in-flight `authorize-start` consent flow, if any —
   * the shared loopback listener is single-flight, not per-server.
   */
  private pendingFlow: string | undefined

  constructor(ctx: Context, options: McpStatusRegistryOptions = {}) {
    super(ctx, 'mcpStatus', { namespace: 'mcp' })
    this.patchPath = options.patchPath ?? defaultPatchPath()
  }

  /**
   * Register one mcp-client instance's live connection for the duration of
   * its activation. Re-emits every status transition as `mcp/status-changed`,
   * forwarded to clients verbatim per `packages/api/remotes/src/remote-events.ts`'s
   * allowlist.
   * @param config - the resolved plugin config this handle belongs to.
   * @param handle - the live supervisor handle.
   * @returns an unregister function; call it from the instance's own disposal.
   */
  register(config: Config, handle: ConnectionHandle): () => void {
    const unsubscribe = handle.onStatusChange((status) => {
      this.ctx.emit('mcp/status-changed', status)
    })
    this.handles.set(config.serverName, { config, handle, unsubscribe })
    return () => {
      unsubscribe()
      // Only drop the map entry if it is still THIS registration — an HMR
      // reload can register the replacement before the old instance's
      // disposer runs.
      if (this.handles.get(config.serverName)?.handle === handle) {
        this.handles.delete(config.serverName)
      }
    }
  }

  /**
   * List every registered server's current status.
   * @returns every registered server's current status, in registration order.
   */
  @Remote('status')
  list(): McpServerStatus[] {
    return [...this.handles.values()].map(entry => entry.handle.status())
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
   *   shared listener is single-flight, not per-server), or the loopback
   *   port could not be bound (e.g. a concurrent `dsh-mcp-client-auth` run
   *   already holds it) — reported immediately rather than only surfacing
   *   once the unreachable listener's timeout eventually elapses.
   */
  @Remote('authorize-start')
  async authorizeStart(serverName: string): Promise<McpAuthorizeStartResult> {
    const entry = this.handles.get(serverName)
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
      const result = await sdkAuth(handle.authProvider, { serverUrl: config.url })
      if (result === 'AUTHORIZED') {
        throw new Error(`mcp authorize-start: server "${serverName}" is already authorized — try Reconnect instead of Authorize`)
      }
      // Internal-only: NEVER put this on McpServerStatus — the URL carries
      // the CSRF `state`, so leaking it over the public status poll would let
      // anyone who opens it complete THIS flow (SWD-164 sentinel finding).
      const consentUrl = handle.peekConsentUrl()
      if (consentUrl === undefined) {
        /* v8 ignore next -- defensive: a REDIRECT result always ran through
         * onAuthorizationUrl first, which sets consentUrl before sdkAuth returns */
        throw new Error(`mcp authorize-start: server "${serverName}" did not produce a consent URL`)
      }
      const expectedState = new URL(consentUrl).searchParams.get('state') ?? undefined
      const port = Number(new URL(handle.authProvider.redirectUrl).port)
      // `exactOptionalPropertyTypes` rejects `{ expectedState: undefined }` —
      // omit the key entirely rather than set it to `undefined`.
      const listener = startAuthorizationCallbackListener(
        port,
        HOST_CONSENT_TIMEOUT_MS,
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
      const entry = this.handles.get(serverName)
      const serverUrl = entry?.config.transport === 'streamable-http' ? entry.config.url : undefined
      if (serverUrl === undefined) return
      const result = await sdkAuth(handle.authProvider, { serverUrl, authorizationCode })
      if (result !== 'AUTHORIZED') {
        throw new Error('token exchange did not complete')
      }
      handle.forceReconnectAfterAuthorization()
    } catch (error) {
      this.ctx.logger.error(`mcp authorize-start(${serverName}): consent flow failed: ${redactAbsolutePaths(String(error))}`)
    } finally {
      this.pendingFlow = undefined
    }
  }

  /**
   * Manually retry a server now. A thin wrapper over
   * {@link ConnectionHandle.reconnectNow} — every guard (state, rate limit)
   * lives there so the same rule applies whether this RPC or a test calls
   * it directly.
   * @param serverName - the server to retry.
   * @throws when the server is unknown.
   */
  @Remote('reconnect')
  reconnect(serverName: string): void {
    const entry = this.handles.get(serverName)
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
   * @param serverName - the mount id to toggle; validated against
   *   {@link SERVER_NAME_PATTERN} and must already exist in the patch file.
   * @param enabled - the proposed enablement.
   * @throws when `serverName` fails the pattern, no mount with that id
   *   exists in the patch file (set-enabled never inserts one), the file
   *   changed between the initial read and the write (retry), or any I/O,
   *   parse, or structural step fails.
   */
  @Remote('set-enabled')
  async setEnabled(serverName: string, enabled: boolean): Promise<void> {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      throw new Error(`mcp set-enabled: "${serverName}" is not a valid server name`)
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
      throw new Error(`mcp set-enabled: cordis patch file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(patches)) {
      throw new Error('mcp set-enabled: cordis patch file does not contain a top-level list')
    }
    const location = locateMcpMount(patches, serverName)
    if (location === undefined) {
      throw new Error(`mcp set-enabled: no mount with id "${serverName}" exists in the cordis patch file — set-enabled never creates a new mount`)
    }
    const nextPatches = buildNextMcpPatches(patches, location, enabled)
    const nextText = stringifyYaml(nextPatches, { indentSeq: false, singleQuote: true })

    // Self-validate through the same reader before anything touches disk.
    const reparsed: unknown = parseYaml(nextText)
    const rereadLocation = Array.isArray(reparsed) ? locateMcpMount(reparsed, serverName) : undefined
    const rereadEnabled = rereadLocation !== undefined && rereadLocation.entry.disabled === !enabled
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

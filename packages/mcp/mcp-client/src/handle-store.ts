/**
 * Root-scoped registry of every active mcp-client connection's handle, plus
 * the `cordis.patch.yml` profile-file helpers `set-enabled`-shaped consumers
 * need. Lives in this package (not the Remote-facing status service, which
 * now lives in `@deepseek-ai/dsh-mcp-status` — see that package's README for
 * why) because every mcp-client instance must be able to register its handle
 * here UNCONDITIONALLY, whether or not anything is mounted to read it back:
 * a headless or embedded host with `@deepseek-ai/dsh-mcp-status` absent from
 * its `cordis.patch.yml` must behave identically to one where it is present,
 * minus the Remote surface itself (SWD-164 round 5, defect 2 — see the
 * module doc on `@deepseek-ai/dsh-mcp-status`'s own status-registry module
 * for the full defect history: the OLD design mounted the Remote service
 * lazily, from inside an mcp-client instance's own activation, which left its
 * typert manifest registration tied to that triggering instance's Loader
 * entry rather than to a stable entry of its own).
 *
 * `registerMcpHandle` is the only write path (called unconditionally from
 * `index.ts#apply`); `listMcpHandles` and `subscribeMcpHandles` are the two
 * read paths `@deepseek-ai/dsh-mcp-status`'s service uses — a pull for
 * `status`/`list()`, a push for `mcp/status-changed`. Neither read path
 * requires `@deepseek-ai/dsh-mcp-status` to exist: an unregistered-listener
 * store is simply never read.
 *
 * @module @deepseek-ai/dsh-mcp-client/handle-store
 */

import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import type { Document, ScalarTag } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { SERVER_NAME_PATTERN } from './index.ts'
import type { Config } from './index.ts'
import { RECONNECT_DEFAULTS } from './connection.ts'
import type { ConnectionHandle } from './connection.ts'
import type { McpServerStatus } from './status.ts'

/** Patch-file entry name `set-enabled`'s `cordis.patch.yml` mutation uses for one plugin mount's YAML-level disable flag. */
const PATCH_PATCH_FILENAME = 'cordis.patch.yml'

/** The `name` field a `cordis.patch.yml` entry carries for an mcp-client mount, e.g. `examples/mcp-memory/engram.cordis.yml`. */
const MCP_CLIENT_PACKAGE_NAME = '@deepseek-ai/dsh-mcp-client'

/** Bound on disambiguating backup-filename suffixes, mirroring `org-served-roster.ts`. */
const MAX_BACKUP_FILENAME_ATTEMPTS = 100

/**
 * `ScalarTag` preserving the boot loader's own `!!js` dialect
 * (`tag:yaml.org,2002:js` — `vendor/include/src/index.ts`'s `JsExpr`) through
 * a `yaml`-package parse/stringify round trip. Profiles use this tag for
 * token-header expressions (e.g. `Authorization: !!js '`Bearer
 * ${process.env.TOKEN}`'`); the `yaml` package's default (core) schema has no
 * entry for it at all, so a bare `parseDocument`/`parse()` call resolves it
 * with a `TAG_RESOLVE_FAILED` warning and silently degrades the scalar to a
 * plain untagged string — on the very next `stringify()`, that string loses
 * the `!!js` tag for good (SWD-169's root cause).
 *
 * This is a plain `ScalarTag` OBJECT, not a `Tag` class instance — the `yaml`
 * package's own `Tag` export is a class for a different purpose (collection
 * tags with a `nodeClass`); a scalar custom tag is just an object matching
 * this shape (`node_modules/yaml/dist/schema/types.d.ts`'s `ScalarTag`
 * interface) passed through `customTags`.
 *
 * `identify: () => false` is deliberate: this tag must never CLAIM a value
 * that was not already explicitly tagged `!!js` in the source text — unlike
 * a real custom type, there is no distinct in-memory representation to
 * identify by here; `resolve` hands back the scalar's raw string completely
 * unmodified, so every `toJS()`/`toJSON()` consumer of a `!!js`-tagged node
 * sees exactly the plain string it always did. No `default` (always
 * `false`: this tag is never chosen for an UNtagged scalar) and no custom
 * `stringify` are needed — the `yaml` package's own default scalar
 * stringifier already re-emits a node's explicit `.tag` once that `.tag`
 * actually survives parsing, which is the one thing registering this tag
 * changes. Verified empirically (SWD-170 investigation) against the real
 * `web-stable` profile's own
 * `Authorization: !!js '`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`'`
 * line: parsing with this tag registered and re-`toString`ing with NO edit
 * at all reproduces the file byte-for-byte — tag, quoting, comments, key
 * order, and the trailing newline all included — and the `TAG_RESOLVE_FAILED`
 * warning that previously fired on every read no longer does.
 */
export const JS_EXPR_SCALAR_TAG: ScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  identify: () => false,
  default: false,
  resolve: (value: string) => value,
}

/** Every custom tag {@link parsePatchDocument} registers beyond the `yaml` package's core schema. */
export const PATCH_CUSTOM_TAGS: readonly ScalarTag[] = [JS_EXPR_SCALAR_TAG]

/**
 * Parse `text` into a CST-backed `yaml` `Document` rather than a plain JS
 * value: a `Document`'s `toString()` preserves every comment, blank line,
 * key order, and quoting style the source carries, and — with
 * {@link PATCH_CUSTOM_TAGS} registered — its explicit tags too, where a
 * plain `parse()`/`stringify()` round trip discards all of that on the very
 * first write (SWD-169/SWD-170). `set-enabled` edits the returned `Document`
 * in place (`doc.setIn(path, value)`) and re-serializes IT, rather than
 * rebuilding a fresh plain-object document from scratch the way the old
 * `buildNextMcpPatches` did.
 * @param text - the patch file's current bytes, decoded as UTF-8.
 * @returns the parsed document. Never throws itself (`parseDocument` never
 *   does) — see {@link parsePatchFile} for the caller-facing helper that
 *   turns a parse problem into a thrown `Error`, from whichever of the two
 *   different stages actually detects it.
 */
export function parsePatchDocument(text: string): Document.Parsed {
  return parseDocument(text, { customTags: [...PATCH_CUSTOM_TAGS] })
}

/** {@link parsePatchFile}'s result: the editable document alongside its already-resolved plain-JS form. */
export interface ParsedPatchFile {
  /** The CST-backed document — edit this (`doc.setIn(...)`) and `doc.toString(...)` it for a lossless rewrite. */
  readonly doc: Document.Parsed
  /** `doc.toJS()`, already computed — the same plain value {@link locateMcpMount}/`collectMcpPatchEntries` expect. */
  readonly patches: unknown
}

/**
 * Parse `text` and eagerly resolve it to its plain-JS form in one call,
 * throwing the FIRST problem either stage finds: `doc.errors[0]` for a
 * composer-level problem (a duplicate key, a bad indent, an unknown tag with
 * no custom resolution, ...), or whatever `doc.toJS()` itself throws for a
 * problem that only surfaces at JS-conversion time (an unresolved alias is
 * the only one in practice — the `yaml` package resolves aliases lazily,
 * during `toJS()`, not during compose). Every existing caller of this
 * module's old `parse()`-based read relied on a single try/catch around one
 * call that could fail either way; this preserves that shape while also
 * handing back the editable {@link Document} `set-enabled` needs.
 * @param text - the patch file's current bytes, decoded as UTF-8.
 * @returns the parsed document and its plain-JS form.
 * @throws the first parse or resolution problem, always an `Error` instance
 *   (the `yaml` package never throws anything else from either stage).
 */
export function parsePatchFile(text: string): ParsedPatchFile {
  const doc = parsePatchDocument(text)
  const [firstError] = doc.errors
  if (firstError !== undefined) throw firstError
  return { doc, patches: doc.toJS() }
}

/**
 * Resolve the running profile's own `cordis.patch.yml` — never a hardcoded
 * profile name (SWD-164 pilot finding: `set-enabled`/`list()` previously
 * assumed `web-stable` and ENOENT'd under any other profile).
 *
 * `ctx.baseUrl` is the one place the active profile's directory is actually
 * known at runtime: `@deepseek-ai/dsh-app-boot`'s `boot()` sets it once, on
 * the root context, to `file://<profile dir>/` (see
 * `packages/boot/app-boot/src/profile.ts`'s module doc — "The Loader's
 * `baseUrl` is the profile directory"), and every plugin context inherits
 * the root's own property through the Cordis context prototype chain. That
 * is the SAME directory `loadProfile`'s `Profile.patchPath` and
 * `apps/cli/src/profile-boot.ts`'s `watchUserPatches` already read and write
 * for the live user patch layer — this reuses that resolution rather than
 * re-deriving it.
 * @param ctx - any context in the live plugin tree; `ctx.root.baseUrl` is read.
 * @returns the absolute patch-file path, or `undefined` when `ctx.root.baseUrl`
 *   is unset — a bare `Context` with no `@deepseek-ai/dsh-app-boot` profile
 *   loader mounted (an e2e harness, an embedded host, a unit test). Every
 *   mcp-client instance must still be able to mount in that case — the
 *   deregister notifier below simply emits nothing, and a Remote consumer
 *   reading this store (`@deepseek-ai/dsh-mcp-status`) degrades the same way
 *   it would on an unreadable file. A `warn` fires here once per call.
 */
export function defaultPatchPath(ctx: Context): string | undefined {
  const baseUrl = ctx.root.baseUrl
  if (baseUrl === undefined) {
    ctx.logger.warn(
      'mcp status: cannot resolve the default cordis.patch.yml path — ctx.baseUrl is unset '
      + '(no profile loader mounted on this context tree) — set-enabled and the disabled-row '
      + 'listing are unavailable on this host; pass patchPath explicitly to enable them',
    )
    return undefined
  }
  return join(fileURLToPath(baseUrl), PATCH_PATCH_FILENAME)
}

/** One registered mcp-client instance's live state, as stored per-root. */
export interface McpHandleEntry {
  readonly config: Config
  readonly handle: ConnectionHandle
}

/**
 * Matches one quoted absolute POSIX path, redacted whole first — see
 * `connection.ts`'s identical pair for why quoted paths go first.
 */
const QUOTED_DOUBLE_PATH_RE = /"(\/[^"]*)"/g
const QUOTED_SINGLE_PATH_RE = /'(\/[^']*)'/g
const BARE_ABSOLUTE_PATH_RE = /\/(?:[^\s"'<>]+\/)*[^\s"'<>]+/g

/**
 * Redact absolute filesystem paths before an error reaches a log line or a
 * thrown message that could cross the wire.
 * @param text - the raw error text.
 * @returns the redacted text.
 */
export function redactAbsolutePaths(text: string): string {
  return text
    .replace(QUOTED_DOUBLE_PATH_RE, '"<path>"')
    .replace(QUOTED_SINGLE_PATH_RE, '\'<path>\'')
    .replace(BARE_ABSOLUTE_PATH_RE, '<path>')
}

/**
 * Content token for the patch file's bytes — the compare-before-write half
 * of `set-enabled`'s read-modify-write, mirroring `org-served-roster.ts`'s
 * `hashOrgServedRosterBytes`/`expectedToken` pattern but self-contained: this
 * RPC takes no caller-supplied token (`set-enabled(serverName, enabled)` is a
 * toggle, not an edit-after-read UI flow), so the caller hashes its own
 * initial read and re-hashes a fresh read immediately before the rename,
 * refusing instead of clobbering a write that landed in between.
 * @param bytes - the file content to hash.
 * @returns a hex digest naming exactly these bytes.
 */
export function hashMcpPatchBytes(bytes: Uint8Array): string {
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
export async function backupPatchBytes(path: string, currentBytes: Buffer): Promise<string> {
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
export interface McpMountLocation {
  readonly topIndex: number
  readonly insertIndex?: number
  readonly entry: Readonly<Record<string, unknown>>
}

/**
 * Outcome of {@link locateMcpMount}: exactly one matching mount, none, or
 * more than one. `set-enabled` rejects both the empty and the ambiguous case
 * rather than ever silently guessing among several matches.
 */
export type McpMountLookup =
  | { readonly kind: 'found'; readonly location: McpMountLocation }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'ambiguous'; readonly count: number }

/**
 * Locate the `@deepseek-ai/dsh-mcp-client` mount whose `config.serverName`
 * equals the requested name — never `id`, which is opaque (SWD-164 pilot
 * finding: the live profile's own mounts follow `id === 'mcp-' +
 * config.serverName`, but that is this deployment's convention, not a
 * contract this matching logic may assume). Matches either a flat top-level
 * entry or one nested a level inside a group's `insert` list (the shape
 * `org-served-roster.ts`'s mounts use). Never creates — a caller that gets
 * `'not-found'` here must fail loud rather than insert a new mount.
 * @param patches - the parsed top-level patch list.
 * @param serverName - the mount's `config.serverName` to find.
 * @returns `'found'` with the single match's position, `'not-found'` with
 *   none, or `'ambiguous'` with how many matched.
 */
export function locateMcpMount(patches: readonly unknown[], serverName: string): McpMountLookup {
  let found: McpMountLocation | undefined
  let count = 0
  const visit = (topIndex: number, insertIndex: number | undefined, entry: Record<string, unknown>): void => {
    if (entry.name !== MCP_CLIENT_PACKAGE_NAME) return
    const config = entry.config
    if (typeof config !== 'object' || config === null) return
    if ((config as Record<string, unknown>).serverName !== serverName) return
    count += 1
    found = insertIndex === undefined ? { topIndex, entry } : { topIndex, insertIndex, entry }
  }
  for (const [topIndex, patch] of patches.entries()) {
    if (typeof patch !== 'object' || patch === null) continue
    const record = patch as Record<string, unknown>
    visit(topIndex, undefined, record)
    const insert = record.insert
    if (!Array.isArray(insert)) continue
    for (const [insertIndex, nested] of insert.entries()) {
      if (typeof nested !== 'object' || nested === null) continue
      visit(topIndex, insertIndex, nested as Record<string, unknown>)
    }
  }
  // `found === undefined` and `count === 0` are the same condition (`found`
  // is only ever assigned inside the same branch that increments `count`),
  // but checking `found` directly — instead of `count === 0` — is what lets
  // TypeScript narrow `found` to `McpMountLocation` below with no assertion.
  if (found === undefined) return { kind: 'not-found' }
  if (count > 1) return { kind: 'ambiguous', count }
  return { kind: 'found', location: found }
}

/**
 * One `@deepseek-ai/dsh-mcp-client` mount found in a parsed
 * `cordis.patch.yml`, keyed by `config.serverName` — never `id`, which is
 * opaque (same lookup {@link locateMcpMount} performs).
 */
export interface McpPatchEntry {
  readonly disabled: boolean
}

/**
 * Collect every `@deepseek-ai/dsh-mcp-client` mount in a parsed
 * `cordis.patch.yml` document, flat or nested one level under a group's
 * `insert` (the same two shapes {@link locateMcpMount} accepts), keyed by
 * `config.serverName`. An entry whose `config.serverName` fails {@link
 * SERVER_NAME_PATTERN}, or is missing/not a string, is skipped rather than
 * surfaced — the same validation `set-enabled` applies to its `serverName`
 * parameter before ever touching this file. Two entries sharing one
 * `config.serverName` is `set-enabled`'s "ambiguous" case, not this
 * read-only collector's — the later one simply wins the map slot here;
 * `list()`'s disabled-row synthesis tolerates that.
 * @param patches - the parsed top-level patch list.
 * @returns every valid mcp-client mount's `config.serverName` and `disabled` flag.
 */
function collectMcpPatchEntries(patches: readonly unknown[]): Map<string, McpPatchEntry> {
  const entries = new Map<string, McpPatchEntry>()
  const visit = (record: Record<string, unknown>): void => {
    if (record.name !== MCP_CLIENT_PACKAGE_NAME) return
    const config = record.config
    if (typeof config !== 'object' || config === null) return
    const serverName = (config as Record<string, unknown>).serverName
    if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) return
    entries.set(serverName, { disabled: record.disabled === true })
  }
  for (const patch of patches) {
    if (typeof patch !== 'object' || patch === null) continue
    const record = patch as Record<string, unknown>
    visit(record)
    const insert = record.insert
    if (!Array.isArray(insert)) continue
    for (const nested of insert) {
      if (typeof nested !== 'object' || nested === null) continue
      visit(nested as Record<string, unknown>)
    }
  }
  return entries
}

/**
 * Read and parse the patch file into its mcp-client mount entries, tolerating
 * a missing or malformed file by returning an empty map. Used by `list()`
 * (an absent file means no extra disabled rows to synthesize) and {@link
 * registerMcpHandle}'s deregister notifier (an absent or unreadable file
 * means "assume removed" rather than throwing out of a disposal path) —
 * `set-enabled` keeps its own strict read, since it is the one path that
 * must fail loud on this file.
 *
 * A missing file (`ENOENT`) is the ordinary case for a deployment with no
 * `cordis.patch.yml` at all and stays silent, returning the (genuinely)
 * empty map. A file that exists but fails to read, fails to parse, or
 * parses to something other than a top-level list, is NOT ordinary — it
 * means `set-enabled`'s own reads would also be failing — so that case logs
 * one `warn` (redacted path, reason) and returns `undefined` rather than an
 * empty map: an empty map would read as "no disabled mounts, nothing named
 * here", which callers must NOT treat the same as "the read failed and we
 * have no idea." `list()` degrades to live rows only; the deregister
 * notifier emits nothing (the warn already told the operator something is
 * wrong, and guessing `removed: true` from a failed read would be a false
 * report, not a graceful degradation).
 * @param ctx - plugin context, for the one-shot `warn` on a non-ENOENT failure.
 * @param patchPath - absolute path to the `cordis.patch.yml` to read; `undefined`
 *   when this host has no profile file to resolve one from ({@link defaultPatchPath}
 *   already warned once at construction) — treated exactly like an unreadable file
 *   (returns `undefined`), never like a missing-but-nameable file (which would
 *   return the empty map): callers must degrade the same way for both.
 * @returns every valid mcp-client mount's id and `disabled` flag; an empty map for a
 *   missing file or a genuinely empty list; `undefined` if there is no path to read,
 *   or the read or parse failed.
 */
export async function readMcpPatchEntries(
  ctx: Context,
  patchPath: string | undefined,
): Promise<Map<string, McpPatchEntry> | undefined> {
  if (patchPath === undefined) return undefined
  let bytes: Buffer
  try {
    bytes = await readFile(patchPath)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map()
    ctx.logger.warn(`mcp status: cordis patch file could not be read: ${redactAbsolutePaths(error instanceof Error ? error.message : String(error))}`)
    return undefined
  }
  let patches: unknown
  try {
    patches = parsePatchFile(bytes.toString('utf8')).patches
  } catch (error: unknown) {
    // `: String(error)` is unreachable: `parsePatchFile` only ever throws
    // `doc.errors[0]` (a `YAMLParseError` and its siblings) or whatever
    // `doc.toJS()` itself throws for a problem that only surfaces at JS-
    // conversion time (an unresolved alias, in practice) — both are always
    // `Error` instances, never a non-Error throw.
    /* v8 ignore next -- see proof above */
    ctx.logger.warn(`mcp status: cordis patch file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (!Array.isArray(patches)) {
    ctx.logger.warn('mcp status: cordis patch file does not contain a top-level list')
    return undefined
  }
  return collectMcpPatchEntries(patches)
}

/** Per-root live handle maps; dedup mirrors `activeServerNames` in `index.ts`. */
const stores = new WeakMap<Context, Map<string, McpHandleEntry>>()

/** Per-root subscriber sets for {@link subscribeMcpHandles}. */
const subscribers = new WeakMap<Context, Set<(status: McpServerStatus) => void>>()

function storeFor(root: Context): Map<string, McpHandleEntry> {
  let store = stores.get(root)
  if (store === undefined) {
    store = new Map()
    stores.set(root, store)
  }
  return store
}

function subscribersFor(root: Context): Set<(status: McpServerStatus) => void> {
  let set = subscribers.get(root)
  if (set === undefined) {
    set = new Set()
    subscribers.set(root, set)
  }
  return set
}

function notify(root: Context, status: McpServerStatus): void {
  for (const listener of subscribersFor(root)) listener(status)
}

/**
 * Current snapshot of every registered mcp-client instance on this `ctx`'s
 * root, keyed by `serverName`. Read fresh on every call — no caching beyond
 * the store itself — so a consumer (`@deepseek-ai/dsh-mcp-status`'s `list()`)
 * always sees the live set.
 * @param ctx - any context in the live plugin tree.
 * @returns the live per-root handle map; never mutate the returned map directly.
 */
export function listMcpHandles(ctx: Context): ReadonlyMap<string, McpHandleEntry> {
  return storeFor(ctx.root)
}

/**
 * Subscribe to every status change forwarded for any handle registered on
 * this `ctx`'s root — both a live connection's own transitions and the final
 * synthesized transition {@link registerMcpHandle}'s unregister emits on
 * deregistration. One subscription covers every current and future handle on
 * this root; there is no per-handle subscription to manage.
 * @param ctx - any context in the live plugin tree.
 * @param listener - called with each forwarded status.
 * @returns an unsubscribe function.
 */
export function subscribeMcpHandles(ctx: Context, listener: (status: McpServerStatus) => void): () => void {
  const set = subscribersFor(ctx.root)
  set.add(listener)
  return () => { set.delete(listener) }
}

/** Options for {@link registerMcpHandle}; `patchPath` exists for tests only. */
export interface RegisterMcpHandleOptions {
  /** Absolute path to the `cordis.patch.yml` read for the deregister decision below. Defaults to {@link defaultPatchPath}. */
  patchPath?: string
}

/**
 * Register one mcp-client instance's live connection for the duration of its
 * activation — unconditional: this never checks whether anything is mounted
 * to read the store back, so a host with no `@deepseek-ai/dsh-mcp-status`
 * mount behaves identically to one with it, minus the Remote surface.
 * Forwards every status transition (including the final deregister-time one
 * below) to {@link subscribeMcpHandles}'s listeners; it is that subscriber's
 * job — not this module's — to decide whether and how to publish it (e.g. as
 * a Cordis `mcp/status-changed` emit), since that event's own `declare
 * module` augmentation lives in the consuming package, not here.
 * @param ctx - the registering instance's own plugin context.
 * @param config - the resolved plugin config this handle belongs to.
 * @param handle - the live supervisor handle.
 * @param options - test-only {@link RegisterMcpHandleOptions.patchPath} override.
 * @returns an unregister function; call it from the instance's own disposal — it
 *   may run async work, which Cordis's effect disposal awaits.
 */
export function registerMcpHandle(
  ctx: Context,
  config: Config,
  handle: ConnectionHandle,
  options: RegisterMcpHandleOptions = {},
): () => Promise<void> {
  const root = ctx.root
  const store = storeFor(root)
  const unsubscribeStatus = handle.onStatusChange((status) => { notify(root, status) })
  store.set(config.serverName, { config, handle })
  return async () => {
    unsubscribeStatus()
    // Fast path only: if a replacement has ALREADY registered under this
    // serverName (the loader registered-then-disposed, in that order), the
    // map entry is already superseded and owned by that replacement —
    // nothing to decide or emit here. This is an optimization, never the
    // sole decision mechanism: when the loader disposes-then-registers
    // instead, this check sees `handle === this one` even though the
    // dispose is real, and must NOT short-circuit on that basis alone — see
    // below.
    if (store.get(config.serverName)?.handle !== handle) return
    // The identity check above cannot tell "ordinary reload, replacement not
    // registered yet" apart from "real removal/disable" — both leave this
    // handle as the current map entry at this instant. The profile patch
    // file is the source of truth at THIS moment, so re-read it fresh rather
    // than trusting registration order:
    //   - mount absent from the patch file -> really gone -> `removed: true`
    //   - mount present and disabled -> the Loader disabled it -> 'disabled'
    //   - mount present and enabled -> an ordinary reload; the replacement
    //     handle is on its way and will report its own status once it
    //     registers (startConnection's initial connect is async, so that
    //     report lands after this closure returns) — forward nothing now.
    // A failed read (`undefined`, not an empty map) means the file's actual
    // state is unknown, not that the mount is absent — the warn already
    // fired inside readMcpPatchEntries, so forward nothing rather than guess
    // `removed: true` from a read that never completed.
    store.delete(config.serverName)
    const patchEntries = await readMcpPatchEntries(ctx, options.patchPath ?? defaultPatchPath(ctx))
    if (patchEntries === undefined) return
    const patchEntry = patchEntries.get(config.serverName)
    if (patchEntry === undefined) {
      notify(root, { ...handle.status(), removed: true })
    } else if (patchEntry.disabled) {
      notify(root, {
        serverName: config.serverName,
        state: 'disabled',
        attempts: 0,
        maxAttempts: RECONNECT_DEFAULTS.maxAttempts,
      })
    }
  }
}

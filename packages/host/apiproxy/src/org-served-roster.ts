/**
 * Server-side WRITE support for the two "served roster" lists a profile's
 * `cordis.patch.yml` patch layer mounts: `mailbox-bridge` and `tool-mailbox`.
 * `findOrgMountAddresses` is the ONE locate function both the read side
 * (api-proxy.ts's `org.get`, via {@link readOrgProfilePatchesWithToken}) and
 * the write side ({@link writeOrgServedRoster}) use to find a mount inside
 * the parsed patch document — one scan, one notion of "recognised shape",
 * never two independently-drifting readers of the same file.
 *
 * WHY BOTH LISTS MATTER, and why a write always replaces both together: the
 * tool-mailbox roster decides whether a message TO a seat is ever accepted;
 * the mailbox-bridge roster decides whether that stored message is ever
 * COLLECTED and delivered. A seat present on one list but not the other
 * means a send can succeed, the message gets stored, and nothing ever
 * delivers it — silently, with no error on either side. That silent mail
 * loss is exactly the defect SWD-118's roster-drift alarm (see
 * `@deepseek-ai/dsh-mailbox/roster`) exists to catch on the READ side; this
 * module is the WRITE-side half of removing it: one address list on the
 * wire, both mount entries updated in one atomic rename, so a caller can
 * never produce the split by construction — except when it deliberately
 * chooses to (`acknowledgeSplit`), because the two rosters might already
 * disagree before this write ever runs and the caller needs a way to fix
 * that rather than being permanently locked out by their own drift.
 *
 * @module @deepseek-ai/dsh-apiproxy/org-served-roster
 */

import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { diffRosters, parseMailboxAddress, type RosterDrift } from '@deepseek-ai/dsh-mailbox'
import type { OrgRosterResult } from './api/index.ts'

/**
 * Extract one mount's `config.addresses` from a parsed `cordis.patch.yml`
 * document: the top-level patch list's `insert` entries, matched by `id`.
 * Reads the entry's OWN declared config rather than simulating cordis's full
 * patch-application semantics (an id-targeted override elsewhere in the
 * list could in principle further patch the same entry's config) — out of
 * scope for a read-only reporter, and every mount this deployment serves is
 * declared whole in one `insert`.
 *
 * Relocated verbatim from api-proxy.ts (no behaviour change): both the read
 * path (`org.get`) and the write path ({@link writeOrgServedRoster}) share
 * this one function so a broken or unrecognised mount shape reports the
 * SAME reason wherever it is read from.
 * @param patches - the parsed top-level patch list (or any other parsed YAML value).
 * @param mountId - the mount `id` to locate (`mailbox-bridge` or `tool-mailbox`).
 * @returns the mount's served addresses, or a named reason none could be read.
 */
export function findOrgMountAddresses(patches: unknown, mountId: string): OrgRosterResult {
  if (!Array.isArray(patches)) {
    return { ok: false, reason: 'profile patch file does not contain a top-level list' }
  }
  for (const patch of patches) {
    if (typeof patch !== 'object' || patch === null) continue
    const insert = (patch as Record<string, unknown>).insert
    if (!Array.isArray(insert)) continue
    for (const entry of insert) {
      if (typeof entry !== 'object' || entry === null) continue
      if ((entry as Record<string, unknown>).id !== mountId) continue
      const config = (entry as Record<string, unknown>).config
      const addresses = typeof config === 'object' && config !== null
        ? (config as Record<string, unknown>).addresses
        : undefined
      if (!Array.isArray(addresses) || addresses.some(address => typeof address !== 'string')) {
        return { ok: false, reason: `profile mount "${mountId}" config.addresses is not a list of strings` }
      }
      return { ok: true, addresses: addresses as string[] }
    }
  }
  return { ok: false, reason: `profile patch file has no mount of the recognised shape with id "${mountId}"` }
}

/**
 * The served-roster file's content token: sha256 hex of raw bytes, exactly
 * as read or about to be written. Its OWN hashing function — never reused
 * with, or conflated with, {@link hashOrgRegistryBytes} in
 * `@deepseek-ai/dsh-mailbox`: the registry and this profile patch file are
 * two independent documents, each with its own optimistic-concurrency
 * guard, and a token that could validate against either file would make it
 * possible to accept a write against the wrong one.
 * @param bytes - the file's raw bytes, exactly as read or about to be written.
 * @returns the sha256 hex digest.
 */
export function hashOrgServedRosterBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read and parse the profile patch file at `path`, also returning its
 * content token (see {@link hashOrgServedRosterBytes}) — the read side of
 * the optimistic-concurrency guard {@link writeOrgServedRoster} enforces. A
 * caller planning a write reads with this so the token it later sends back
 * is provably the hash of the exact bytes it read.
 * @param path - the profile patch file's absolute path.
 * @returns the parsed patch document and its content token, or a named read/parse failure.
 */
export async function readOrgProfilePatchesWithToken(
  path: string,
): Promise<{ ok: true; patches: unknown; token: string } | { ok: false; reason: string }> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `profile patch file "${path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  let patches: unknown
  try {
    patches = parseYaml(bytes.toString('utf8'))
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `profile patch file "${path}" is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, patches, token: hashOrgServedRosterBytes(bytes) }
}

/**
 * A write refused because the profile patch file changed since its token
 * was read: another writer landed first. The caller must re-read and
 * re-apply rather than treat the write as malformed — same shape-of-intent
 * as `OrgRegistryConflictError` in `@deepseek-ai/dsh-mailbox`, keyed on this
 * file's own independent token.
 */
export class OrgServedRosterConflictError extends Error {
  /** The token the write expected (the caller's last-read hash). */
  readonly expectedToken: string
  /** The token the file actually holds right now. */
  readonly actualToken: string

  /**
   * @param path - the profile patch file path whose write was refused.
   * @param expectedToken - the token the caller sent.
   * @param actualToken - the token now on disk.
   */
  constructor(path: string, expectedToken: string, actualToken: string) {
    super(`profile patch file "${path}" changed since it was read (expected token ${expectedToken}, now ${actualToken}); re-read and retry`)
    this.name = 'OrgServedRosterConflictError'
    this.expectedToken = expectedToken
    this.actualToken = actualToken
  }
}

/**
 * The write failed for a reason that has nothing to do with the proposed
 * address list's content: the current file could not be read or parsed for
 * the concurrency check, either mount is missing or malformed, no free
 * backup filename could be found, or the atomic temp-write/fsync/rename
 * failed. This is retry-the-same-write territory — never "fix your
 * content", which is what a plain validation `Error` from
 * {@link writeOrgServedRoster}'s own address validation means, and never
 * "re-read and retry", which is what {@link OrgServedRosterConflictError}
 * means. Mirrors `OrgRegistryWriteError`'s three-way distinction.
 */
export class OrgServedRosterWriteError extends Error {
  /**
   * @param path - the profile patch file path the write was attempted against.
   * @param reason - what step failed, for the message text.
   * @param cause - the underlying error.
   */
  constructor(path: string, reason: string, cause: unknown) {
    super(`profile patch file "${path}" ${reason}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'OrgServedRosterWriteError'
  }
}

/**
 * The write was refused because the two served rosters (`mailbox-bridge`
 * and `tool-mailbox`) currently disagree with each other, and the caller
 * did not pass `acknowledgeSplit`. Refusing here — before the proposed
 * address list is even validated, and before anything touches disk — means
 * a write can never silently paper over a pre-existing split by replacing
 * one side and leaving stale drift on the other unexamined: the caller must
 * see the split and explicitly choose to proceed.
 */
export class OrgServedRosterSplitError extends Error {
  /** Addresses only `mailbox-bridge` currently serves. */
  readonly onlyMailboxBridge: readonly string[]
  /** Addresses only `tool-mailbox` currently serves. */
  readonly onlyToolMailbox: readonly string[]

  /**
   * @param path - the profile patch file path whose write was refused.
   * @param drift - the computed disagreement between the two current rosters.
   */
  constructor(path: string, drift: RosterDrift) {
    super(
      `profile patch file "${path}" mailbox-bridge and tool-mailbox served rosters currently disagree — `
      + `only mailbox-bridge serves: [${drift.onlyFirst.join(', ')}]; only tool-mailbox serves: [${drift.onlySecond.join(', ')}]. `
      + 'Pass acknowledgeSplit to write anyway.',
    )
    this.name = 'OrgServedRosterSplitError'
    this.onlyMailboxBridge = drift.onlyFirst
    this.onlyToolMailbox = drift.onlySecond
  }
}

/** Bound on disambiguating suffixes {@link backupOrgServedRosterBytes} tries before giving up loudly. */
const MAX_BACKUP_FILENAME_ATTEMPTS = 100

/**
 * Write a timestamped backup of the profile patch file's previous bytes,
 * next to the file, without ever silently destroying an existing backup.
 * Parameterised copy of `backupOrgRegistryBytes` in
 * `@deepseek-ai/dsh-mailbox/org-registry` — same collision-safe protocol,
 * applied to this independent file.
 * @param expanded - the profile patch file's absolute path.
 * @param currentBytes - the previous content to preserve.
 * @returns the backup file's path.
 * @throws {OrgServedRosterWriteError} when the backup cannot be written, or no free filename is found within the attempt bound.
 */
async function backupOrgServedRosterBytes(expanded: string, currentBytes: Buffer): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${expanded}.bak-${stamp}`
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
      throw new OrgServedRosterWriteError(expanded, 'could not write a backup of its previous content', error)
    } finally {
      await handle?.close()
    }
  }
  throw new OrgServedRosterWriteError(
    expanded,
    `could not find a free backup filename after ${String(MAX_BACKUP_FILENAME_ATTEMPTS)} same-millisecond attempts`,
    new Error('backup filename space exhausted'),
  )
}

/**
 * Validate every proposed address against the mailbox address grammar and
 * reject duplicates. Plain `Error` — this is the "fix your content" branch,
 * distinct from {@link OrgServedRosterWriteError}'s "retry unchanged".
 * @param addresses - the proposed served-address list.
 * @throws when an address fails the grammar, or the same address appears twice.
 */
function validateProposedServedAddresses(addresses: readonly string[]): void {
  const seen = new Set<string>()
  for (const address of addresses) {
    parseMailboxAddress(address)
    if (seen.has(address)) throw new Error(`duplicate served address ${JSON.stringify(address)}`)
    seen.add(address)
  }
}

/** One mount entry's position inside a parsed `cordis.patch.yml` top-level list, for {@link buildNextServedRosterPatches}. */
interface OrgMountLocation {
  /** Index into the top-level patch list. */
  readonly topIndex: number
  /** Index into that entry's `insert` list. */
  readonly insertIndex: number
  /** The matched entry itself (for a minimal `{ ...entry }` copy). */
  readonly entry: Readonly<Record<string, unknown>>
}

/**
 * Positional counterpart to {@link findOrgMountAddresses}: locates WHERE a
 * mount lives (which top-level entry, which position in its `insert` list)
 * rather than just its addresses, so {@link buildNextServedRosterPatches}
 * can replace exactly that one item. Never called before
 * {@link findOrgMountAddresses} has already confirmed the mount exists in
 * the recognised shape, so a caller reaching `undefined` here indicates an
 * internal inconsistency, not a normal outcome.
 * @param patches - the parsed top-level patch list.
 * @param mountId - the mount `id` to locate.
 * @returns the mount's position, or undefined if no entry matches.
 */
function locateOrgMountEntryForWrite(patches: readonly unknown[], mountId: string): OrgMountLocation | undefined {
  // Iterated via `.entries()` (never indexed access `patches[i]`) to match
  // findOrgMountAddresses' own `for (const entry of insert)` shape: indexed
  // access on an Array.isArray-narrowed `unknown[]` types as `any` (a
  // standing TS lib quirk — `Array.isArray`'s guard narrows to `any[]`), and
  // the `for...of` form is what keeps this lint-clean without a cast.
  for (const [topIndex, patch] of patches.entries()) {
    if (typeof patch !== 'object' || patch === null) continue
    const insert = (patch as Record<string, unknown>).insert
    if (!Array.isArray(insert)) continue
    for (const [insertIndex, entry] of insert.entries()) {
      if (typeof entry !== 'object' || entry === null) continue
      if ((entry as Record<string, unknown>).id !== mountId) continue
      return { topIndex, insertIndex, entry: entry as Record<string, unknown> }
    }
  }
  return undefined
}

/**
 * Build the next patch document with minimal new objects: shallow-copy the
 * top-level list, and for each of the two mounts, shallow-copy only the one
 * top-level entry it lives in and only its `insert` list, replacing only
 * that one matched item with `{ ...item, config: { ...item.config,
 * addresses: [...addresses] } }`. Every untouched top-level entry, and every
 * untouched sibling inside a touched entry's `insert` list, keeps its exact
 * object identity into the stringifier — the real file's structure has both
 * mounts sharing one top-level entry alongside `mailbox` and
 * `mailbox-local`, so this naturally makes exactly one new top-level object
 * and one new `insert` array holding both replacements; a deployment where
 * the two mounts happened to live in separate top-level entries would
 * instead get two new top-level objects, one per mount, which is equally
 * minimal for that shape.
 * @param patches - the parsed top-level patch list (already confirmed to contain both mounts).
 * @param mountIds - the two mount ids to replace, in caller-defined order.
 * @param addresses - the single address list both mounts receive.
 * @returns the next top-level patch list.
 */
export function buildNextServedRosterPatches(
  patches: readonly unknown[],
  mountIds: readonly [string, string],
  addresses: readonly string[],
): unknown[] {
  const next = [...patches]
  for (const mountId of mountIds) {
    const location = locateOrgMountEntryForWrite(next, mountId)
    // Unreachable in practice: findOrgMountAddresses already confirmed both
    // mounts exist in the recognised shape before this function is called.
    if (location === undefined) {
      throw new Error(`internal: mount "${mountId}" vanished between validation and rebuild`)
    }
    const { topIndex, insertIndex, entry } = location
    const currentTop = next[topIndex] as Record<string, unknown>
    const currentInsert = currentTop.insert as unknown[]
    const nextInsert = [...currentInsert]
    const currentConfig = entry.config
    nextInsert[insertIndex] = {
      ...entry,
      config: {
        ...typeof currentConfig === 'object' && currentConfig !== null ? currentConfig : {},
        addresses: [...addresses],
      },
    }
    next[topIndex] = { ...currentTop, insert: nextInsert }
  }
  return next
}

/**
 * Replace BOTH served-roster mounts' `config.addresses` with the same list,
 * in one atomic write — the fix for the silent-mail-loss defect described
 * in this module's header: a seat present on one served list but not the
 * other. Never touches the org registry document; that is `org.write`'s own
 * separate scope (see org.ts).
 *
 * Order of operations, each one refusing before the next runs:
 *   1. Read current bytes, hash, compare to `expectedToken` — refuses
 *      {@link OrgServedRosterConflictError} on mismatch, file untouched.
 *   2. Parse; locate both mounts via {@link findOrgMountAddresses}. Either
 *      mount missing, or its current `config.addresses` not a list of
 *      strings, refuses {@link OrgServedRosterWriteError} — an
 *      environmental precondition the caller cannot fix by changing the
 *      proposed content.
 *   3. Compare the two mounts' CURRENT lists (before anything the caller
 *      proposed is even considered). If they already disagree and
 *      `acknowledgeSplit` is false, refuses
 *      {@link OrgServedRosterSplitError} naming both sides — file
 *      untouched.
 *   4. Validate every proposed address (grammar + duplicates) — refuses a
 *      plain `Error`, the "fix your content" branch.
 *   5. Build the next document ({@link buildNextServedRosterPatches}).
 *   6. Serialise with `stringifyYaml(next, { indentSeq: false, singleQuote: true })` — the same
 *      pinned option `writeOrgRegistry` uses, required for a byte-stable
 *      round trip of this file's real shape.
 *   7. Re-parse the produced text and re-run {@link findOrgMountAddresses}
 *      for BOTH mounts, asserting each returns exactly `addresses` —
 *      validating through the same parser readers use, before the file is
 *      ever touched.
 *   8. Timestamped backup of the previous bytes
 *      ({@link backupOrgServedRosterBytes}).
 *   9. Temp file + fsync + atomic rename over `patchPath`.
 * @param patchPath - the profile's `cordis.patch.yml` absolute path.
 * @param mountIds - the two served-roster mount ids, `[mailbox-bridge id, tool-mailbox id]`.
 * @param addresses - the proposed served-address list, applied to both mounts identically.
 * @param expectedToken - the token the caller last read (from {@link readOrgProfilePatchesWithToken}).
 * @param acknowledgeSplit - when true, proceeds even if the two mounts' CURRENT lists disagree with each other.
 * @returns the written addresses and the file's new content token.
 * @throws {OrgServedRosterConflictError} when the file's current token does not match `expectedToken`.
 * @throws {OrgServedRosterSplitError} when the two mounts' current lists disagree and `acknowledgeSplit` is false.
 * @throws {OrgServedRosterWriteError} for any I/O, parse, or structural failure unrelated to the proposed content.
 * @throws a plain `Error` when a proposed address fails the grammar or duplicates another.
 */
export async function writeOrgServedRoster(
  patchPath: string,
  mountIds: readonly [string, string],
  addresses: readonly string[],
  expectedToken: string,
  acknowledgeSplit = false,
): Promise<{ addresses: readonly string[]; token: string }> {
  const [bridgeMountId, toolMountId] = mountIds

  // 1. Read + hash + compare.
  let currentBytes: Buffer
  try {
    currentBytes = await readFile(patchPath)
  } catch (error: unknown) {
    throw new OrgServedRosterWriteError(patchPath, 'could not be read for the concurrency check', error)
  }
  const actualToken = hashOrgServedRosterBytes(currentBytes)
  if (actualToken !== expectedToken) throw new OrgServedRosterConflictError(patchPath, expectedToken, actualToken)

  // Parse.
  let patches: unknown
  try {
    patches = parseYaml(currentBytes.toString('utf8'))
  } catch (error: unknown) {
    throw new OrgServedRosterWriteError(patchPath, 'is not valid YAML', error)
  }

  // 2. Locate both mounts; read their CURRENT addresses.
  const currentBridge = findOrgMountAddresses(patches, bridgeMountId)
  if (!currentBridge.ok) {
    throw new OrgServedRosterWriteError(patchPath, `mount "${bridgeMountId}" could not be read`, new Error(currentBridge.reason))
  }
  const currentTool = findOrgMountAddresses(patches, toolMountId)
  if (!currentTool.ok) {
    throw new OrgServedRosterWriteError(patchPath, `mount "${toolMountId}" could not be read`, new Error(currentTool.reason))
  }

  // 3. Split check — before content validation, before anything touches disk.
  const drift = diffRosters(currentBridge.addresses, currentTool.addresses)
  if (!acknowledgeSplit && (drift.onlyFirst.length > 0 || drift.onlySecond.length > 0)) {
    throw new OrgServedRosterSplitError(patchPath, drift)
  }

  // 4. Validate proposed content — "fix your content" branch.
  validateProposedServedAddresses(addresses)

  // 5. Build next document with minimal new objects.
  const nextPatches = buildNextServedRosterPatches(patches as unknown[], mountIds, addresses)

  // 6. Serialise. BOTH options are pinned, and both were established against
  // the REAL profile file rather than a fixture: without `indentSeq: false`
  // every sequence in the document re-indents, and without `singleQuote: true`
  // every quoted string flips from the single quotes a hand-editor writes to
  // double quotes -- 10 lines of the real file, none of them the two lists
  // this write is supposed to touch. A save that reformats parts of the file
  // nobody asked to change makes the next hand-diff unreadable, on a document
  // whose whole purpose is being read by a person.
  const nextText = stringifyYaml(nextPatches, { indentSeq: false, singleQuote: true })

  // 7. Re-parse and re-validate through the same reader both mounts use.
  const reparsed: unknown = parseYaml(nextText)
  for (const mountId of mountIds) {
    const reread = findOrgMountAddresses(reparsed, mountId)
    const matches = reread.ok
      && reread.addresses.length === addresses.length
      && reread.addresses.every((value, index) => value === addresses[index])
    if (!matches) {
      throw new OrgServedRosterWriteError(
        patchPath,
        `produced document failed self-validation for mount "${mountId}"`,
        new Error(reread.ok ? 'addresses mismatch after rebuild' : reread.reason),
      )
    }
  }

  // 8. Timestamped backup.
  await backupOrgServedRosterBytes(patchPath, currentBytes)

  // 9. Temp file + fsync + atomic rename.
  const tempPath = `${patchPath}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(tempPath, 'w')
    try {
      await handle.writeFile(nextText, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, patchPath)
  } catch (error: unknown) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw new OrgServedRosterWriteError(patchPath, 'could not be written atomically', error)
  }

  // 10. Report.
  return { addresses, token: hashOrgServedRosterBytes(Buffer.from(nextText, 'utf8')) }
}

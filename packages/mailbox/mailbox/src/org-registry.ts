/**
 * The org registry: the machine-readable roster and topology behind mailbox
 * addressing — seats with their workspaces, undirected edges between seats
 * that may exchange mail directly, and the call-up exception. The loader,
 * the sending tool, and the host's wake path read *a* registry and enforce
 * whatever graph it describes; none of them name seats from any particular
 * deployment, so a second project ships by writing a new registry file,
 * never new code.
 *
 * Validation fails loud at parse with the offending key named: an org chart
 * that only exists as prose gets drift of exactly the kind this file exists
 * to prevent.
 *
 * @module @deepseek-ai/dsh-mailbox/org-registry
 */

import { createHash, randomBytes } from 'node:crypto'
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { MAILBOX_SEGMENT_PATTERN_SOURCE } from './address.ts'

const SEGMENT_PATTERN = new RegExp(MAILBOX_SEGMENT_PATTERN_SOURCE)

/**
 * A seat's tool restriction, mirroring the shape of the tool-restriction
 * primitive in `@deepseek-ai/dsh-tools` (`RestrictOptions`). Declared locally
 * rather than imported: this package parses the roster, it does not depend
 * on the tools package, and TypeScript's structural typing lines the two up
 * for free where they actually meet — in the caller that applies this to a
 * live tool set.
 */
export interface OrgRegistrySeatTools {
  /** Tool names to keep; all others are hidden. */
  readonly allow?: readonly string[]
  /** Tool names to hide; everything else stays. */
  readonly deny?: readonly string[]
}

/** One seat's roster entry: where it runs. Its name is its mailbox address. */
export interface OrgRegistrySeat {
  /**
   * Workspace the seat's runs execute in: an absolute path, or a path
   * relative to the registry's {@link OrgRegistry.baseDir}.
   */
  readonly cwd: string
  /** Marks a department head; documentation metadata, not enforcement data. */
  readonly lead?: boolean
  /**
   * The seat's durable session id, recorded at first hire.
   *
   * Identity is DERIVED once and then RECORDED — after that this field is
   * authoritative and the name is only a label. That is what lets a rename
   * carry the conversation: the id never moves when the name does. Without it,
   * identity is `sha256(name)` and renaming orphans the log.
   *
   * Absent for a seat that has never run; callers derive from the name to
   * bootstrap and record the result.
   */
  readonly sessionId?: string
  /** Marks a throwaway seat; an edge may never cross the test boundary. */
  readonly test?: boolean
  /** Restricts which tools the seat's agent may use; absent means unrestricted. */
  readonly tools?: OrgRegistrySeatTools
}

/** One undirected edge: both directions are implied unless a later rule excepts them. */
export type OrgRegistryEdge = readonly [from: string, to: string]

/** The parsed, validated registry. */
export interface OrgRegistry {
  /** Absolute base every relative seat `cwd` resolves against. */
  readonly baseDir: string
  /** Roster keyed by seat name; seat names are mailbox addresses. */
  readonly seats: Readonly<Record<string, OrgRegistrySeat>>
  /** Undirected seat-to-seat edges that permit direct mail. */
  readonly edges: readonly OrgRegistryEdge[]
  /** Seats that may message ANY seat regardless of edges. */
  readonly callUp: readonly string[]
}

/** Options adjusting host-specific resolution during parse. */
export interface OrgRegistryParseOptions {
  /** Home directory a leading `~` expands against; defaults to the process user's home. */
  readonly home?: string
}

/**
 * Expand a leading `~` (bare or path-prefixed) against the given home.
 * @param path - the raw path text.
 * @param home - the home directory to expand against.
 * @returns the expanded path, or the input unchanged when it has no `~` prefix.
 */
function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/**
 * Parse and validate one org registry document. Structural mistakes — an
 * unknown edge endpoint, a seat name outside the address grammar, a missing
 * `baseDir` — fail here rather than at first use, naming the key at fault.
 * @param text - the YAML document text.
 * @param options - host-specific resolution options.
 * @returns the validated registry.
 * @throws when the document is not a registry of the required shape.
 */
export function parseOrgRegistry(text: string, options: OrgRegistryParseOptions = {}): OrgRegistry {
  const home = options.home ?? homedir()
  let document: unknown
  try {
    document = parseYaml(text)
  } catch (error: unknown) {
    throw new Error(`org registry is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  assertObject(document, 'the document')
  assertNonEmptyString(document.baseDir, 'baseDir')

  const seatsField = document.seats
  assertObject(seatsField, 'seats')
  const seatNames = Object.keys(seatsField)
  if (seatNames.length === 0) throw new Error('org registry field "seats" must list at least one seat')
  const seats: Record<string, OrgRegistrySeat> = {}
  for (const name of seatNames) {
    if (!SEGMENT_PATTERN.test(name)) {
      throw new Error(`org registry seat ${JSON.stringify(name)}: names must match ${MAILBOX_SEGMENT_PATTERN_SOURCE} (seat names are mailbox addresses)`)
    }
    const seat: unknown = seatsField[name]
    assertObject(seat, `seats.${name}`)
    assertNonEmptyString(seat.cwd, `seats.${name}.cwd`)
    if (seat.lead !== undefined && typeof seat.lead !== 'boolean') {
      throw new Error(`org registry field seats.${name}.lead must be a boolean when present`)
    }
    if (seat.sessionId !== undefined) assertNonEmptyString(seat.sessionId, `seats.${name}.sessionId`)
    if (seat.test !== undefined && typeof seat.test !== 'boolean') {
      throw new Error(`org registry field seats.${name}.test must be a boolean when present`)
    }
    const tools = seat.tools === undefined ? undefined : parseSeatTools(seat.tools, name)
    seats[name] = {
      cwd: expandTilde(seat.cwd, home),
      ...seat.lead === undefined ? {} : { lead: seat.lead },
      ...seat.sessionId === undefined ? {} : { sessionId: seat.sessionId },
      ...seat.test === undefined ? {} : { test: seat.test },
      ...tools === undefined ? {} : { tools },
    }
  }

  const edges: OrgRegistryEdge[] = []
  if (document.edges !== undefined) {
    if (!Array.isArray(document.edges)) throw new Error('org registry field "edges" must be a list of [from, to] pairs')
    for (const [index, edge] of document.edges.entries()) {
      if (!Array.isArray(edge) || edge.length !== 2 || edge.some(endpoint => typeof endpoint !== 'string')) {
        throw new Error(`org registry edges[${index}] must be a [from, to] pair of seat names`)
      }
      const [from, to] = edge as [string, string]
      if (!(from in seats)) throw new Error(`org registry edges[${index}] names unknown seat ${JSON.stringify(from)}`)
      if (!(to in seats)) throw new Error(`org registry edges[${index}] names unknown seat ${JSON.stringify(to)}`)
      if (from === to) throw new Error(`org registry edges[${index}] connects seat ${JSON.stringify(from)} to itself; edges are for distinct seats`)
      edges.push([from, to])
    }
  }

  const callUp: string[] = []
  if (document.callUp !== undefined) {
    if (!Array.isArray(document.callUp) || document.callUp.some(name => typeof name !== 'string')) {
      throw new Error('org registry field "callUp" must be a list of seat names')
    }
    for (const name of document.callUp) {
      if (!(name in seats)) throw new Error(`org registry callUp names unknown seat ${JSON.stringify(name)}`)
      callUp.push(name)
    }
  }

  return {
    baseDir: resolve(expandTilde(document.baseDir, home)),
    seats,
    edges,
    callUp,
  }
}

/**
 * Read and parse one registry file.
 * @param path - the registry file path; a leading `~` expands against the user's home.
 * @param options - host-specific resolution options.
 * @returns the validated registry.
 * @throws when the file is unreadable or its content fails validation.
 */
export async function loadOrgRegistry(path: string, options: OrgRegistryParseOptions = {}): Promise<OrgRegistry> {
  const expanded = expandTilde(path, options.home ?? homedir())
  const text = await readFile(expanded, 'utf8')
  return parseOrgRegistry(text, options)
}

/**
 * Compute the optimistic-concurrency token for a registry file's exact
 * bytes: sha256 hex of what is (or is about to be) on disk. The write guard
 * keys on file CONTENT, not a stored revision counter — the founder edits
 * this file by hand, and a hand edit never bumps a counter, so a
 * counter-based guard would let a write silently clobber him. Exported so a
 * caller already holding the bytes (a write's own new content, say) never
 * has to re-read the file just to learn its token.
 * @param bytes - the file's raw bytes, exactly as read or about to be written.
 * @returns the sha256 hex digest.
 */
export function hashOrgRegistryBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read, validate, and hash one registry file in a single pass — the read
 * side of the optimistic-concurrency guard {@link writeOrgRegistry} enforces.
 * A caller planning a write reads with this (never {@link loadOrgRegistry})
 * so the token it later sends back is provably the hash of the exact bytes
 * it validated against.
 * @param path - the registry file path; a leading `~` expands against the user's home.
 * @param options - host-specific resolution options.
 * @returns the validated registry and its content token.
 * @throws when the file is unreadable or its content fails validation.
 */
export async function loadOrgRegistryWithToken(
  path: string, options: OrgRegistryParseOptions = {},
): Promise<{ registry: OrgRegistry; token: string }> {
  const expanded = expandTilde(path, options.home ?? homedir())
  const bytes = await readFile(expanded)
  return { registry: parseOrgRegistry(bytes.toString('utf8'), options), token: hashOrgRegistryBytes(bytes) }
}

/**
 * A write refused because the registry file changed since its token was
 * read: another writer — most often the founder's own hand edit — landed
 * first. The caller must re-read and re-apply rather than treat the write as
 * malformed; see {@link hashOrgRegistryBytes} on why the guard keys on
 * content rather than a revision counter.
 */
export class OrgRegistryConflictError extends Error {
  /** The token the write expected (the caller's last-read hash). */
  readonly expectedToken: string
  /** The token the file actually holds right now. */
  readonly actualToken: string

  /**
   * @param path - the registry file path whose write was refused.
   * @param expectedToken - the token the caller sent.
   * @param actualToken - the token now on disk.
   */
  constructor(path: string, expectedToken: string, actualToken: string) {
    super(`org registry at "${path}" changed since it was read (expected token ${expectedToken}, now ${actualToken}); re-read and retry`)
    this.name = 'OrgRegistryConflictError'
    this.expectedToken = expectedToken
    this.actualToken = actualToken
  }
}

/**
 * Replace the whole registry document, refusing when the file has changed
 * since `expectedToken` was read, or when the proposed document fails
 * validation. Never writes a registry that cannot be read back: the
 * proposed document is serialized and run through {@link parseOrgRegistry} —
 * the SAME parser every reader uses — before anything on disk is touched.
 *
 * Serialization uses `indentSeq: false`: a round-trip of the real registry's
 * shape is byte-identical only with that option set (see the fixture
 * round-trip test in this package's tests) — without it, the whole `edges`
 * block reformats on the very first write.
 *
 * The write itself is atomic — a temp file in the same directory, fsync,
 * then rename over the target — so a crash mid-write can never leave a
 * truncated registry, and the file's previous content is preserved as a
 * timestamped sibling backup before the rename.
 * @param path - the registry file path; a leading `~` expands against the user's home.
 * @param document - the complete proposed registry document (the `baseDir`/`seats`/`edges`/`callUp` shape a hand-edited file has).
 * @param expectedToken - the token the caller last read (from {@link loadOrgRegistryWithToken}).
 * @param options - host-specific resolution options.
 * @returns the newly written registry, parsed, and its new content token.
 * @throws {OrgRegistryConflictError} when the file's current token does not match `expectedToken`.
 * @throws when the current file cannot be read, the proposed document fails validation, or the write itself fails.
 */
export async function writeOrgRegistry(
  path: string,
  document: object,
  expectedToken: string,
  options: OrgRegistryParseOptions = {},
): Promise<{ registry: OrgRegistry; token: string }> {
  const expanded = expandTilde(path, options.home ?? homedir())

  let currentBytes: Buffer
  try {
    currentBytes = await readFile(expanded)
  } catch (error: unknown) {
    throw new Error(`org registry at "${expanded}" could not be read for the concurrency check: ${error instanceof Error ? error.message : String(error)}`)
  }
  const actualToken = hashOrgRegistryBytes(currentBytes)
  if (actualToken !== expectedToken) throw new OrgRegistryConflictError(expanded, expectedToken, actualToken)

  const proposedText = stringifyYaml(document, { indentSeq: false })
  // Validate against the exact parser every reader uses; a document that
  // fails here is refused before anything on disk is touched.
  const registry = parseOrgRegistry(proposedText, options)

  const backupPath = `${expanded}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await writeFile(backupPath, currentBytes)

  const tempPath = `${expanded}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(tempPath, 'w')
    try {
      await handle.writeFile(proposedText, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, expanded)
  } catch (error: unknown) {
    await rm(tempPath, { force: true })
    throw error
  }

  return { registry, token: hashOrgRegistryBytes(Buffer.from(proposedText, 'utf8')) }
}

/**
 * Whether one seat may send mail to another under the registry's topology:
 * an undirected edge between them, or the sender holding call-up.
 * @param registry - the parsed registry.
 * @param fromSeat - the sender's seat name.
 * @param toSeat - the recipient's seat name.
 * @returns whether the direct send is permitted.
 * @throws when either seat name is not in the roster (a caller bug, not topology).
 */
export function orgRegistryAllows(registry: OrgRegistry, fromSeat: string, toSeat: string): boolean {
  knownSeat(registry, fromSeat)
  knownSeat(registry, toSeat)
  if (registry.callUp.includes(fromSeat)) return true
  return registry.edges.some(([a, b]) => (a === fromSeat && b === toSeat) || (a === toSeat && b === fromSeat))
}

/**
 * Find the shortest edge path between two seats, for refusals that name the
 * route a blocked sender should take instead.
 * @param registry - the parsed registry.
 * @param fromSeat - the sender's seat name.
 * @param toSeat - the recipient's seat name.
 * @returns the full seat path `[from, …, to]`, or undefined when no edge path connects them.
 */
export function findOrgRegistryRoute(registry: OrgRegistry, fromSeat: string, toSeat: string): readonly string[] | undefined {
  knownSeat(registry, fromSeat)
  knownSeat(registry, toSeat)
  const adjacency = new Map<string, string[]>()
  for (const [a, b] of registry.edges) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b])
    adjacency.set(b, [...(adjacency.get(b) ?? []), a])
  }
  const visited = new Set<string>([fromSeat])
  let frontier: string[][] = [[fromSeat]]
  while (frontier.length > 0) {
    const next: string[][] = []
    for (const path of frontier) {
      // Paths always carry their origin, so the endpoint fallback is unreachable.
      const last = path[path.length - 1] ?? fromSeat
      for (const neighbor of adjacency.get(last) ?? []) {
        if (visited.has(neighbor)) continue
        const extended = [...path, neighbor]
        if (neighbor === toSeat) return extended
        visited.add(neighbor)
        next.push(extended)
      }
    }
    frontier = next
  }
  return undefined
}

/**
 * Resolve one seat's workspace to an absolute path.
 * @param registry - the parsed registry.
 * @param seatName - the seat whose workspace to resolve.
 * @returns the absolute workspace path; a tilde cwd was already expanded at parse.
 * @throws when the seat name is not in the roster.
 */
export function resolveSeatCwd(registry: OrgRegistry, seatName: string): string {
  const seat = knownSeat(registry, seatName)
  // resolve, not join: a seat cwd that is already absolute replaces baseDir.
  return resolve(registry.baseDir, seat.cwd)
}

/**
 * Resolve the durable session id a seat's conversation lives under.
 *
 * **Recorded beats derived.** When the registry carries a `sessionId`, that is
 * the answer, unconditionally — it is what makes a rename carry the seat's
 * conversation instead of orphaning it. Derivation is only the bootstrap for a
 * seat that has never run; the caller is expected to record the derived id back
 * into the registry so the next resolution reads it rather than recomputing it.
 *
 * The distinction matters because deriving from the name makes the NAME the
 * identity: rename it and the id moves, the log is orphaned, and the lock no
 * longer guards the file being written.
 * @param registry - the parsed registry.
 * @param seatName - the seat under lookup.
 * @param derive - bootstrap derivation for a seat with no recorded id.
 * @returns the recorded id when present, otherwise the derived one.
 * @throws when the name is unknown to the roster.
 */
export function resolveSeatSessionId(
  registry: OrgRegistry,
  seatName: string,
  derive: (name: string) => string,
): string {
  const seat = knownSeat(registry, seatName)
  return seat.sessionId ?? derive(seatName)
}

/**
 * Whether a seat's identity is already pinned in the registry.
 *
 * A caller that provisions a seat uses this to decide whether it must record the
 * id it just used — an unpinned seat is one rename away from losing its log.
 * @param registry - the parsed registry.
 * @param seatName - the seat under lookup.
 * @returns whether a `sessionId` is recorded for that seat.
 * @throws when the name is unknown to the roster.
 */
export function isSeatIdentityPinned(registry: OrgRegistry, seatName: string): boolean {
  return knownSeat(registry, seatName).sessionId !== undefined
}

/**
 * Look up one roster seat, failing loud with the roster named.
 * @param registry - the parsed registry.
 * @param seatName - the name under judgment.
 * @returns the seat entry.
 * @throws when the name is unknown.
 */
function knownSeat(registry: OrgRegistry, seatName: string): OrgRegistrySeat {
  const seat = registry.seats[seatName]
  if (seat === undefined) {
    throw new Error(`org registry has no seat ${JSON.stringify(seatName)} (roster: ${Object.keys(registry.seats).join(', ')})`)
  }
  return seat
}

/**
 * Assert a value is a non-null object.
 * @param value - the value under judgment.
 * @param label - the field label, for the error message.
 */
function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`org registry field "${label}" must be a mapping`)
  }
}

/**
 * Assert a value is a non-empty string.
 * @param value - the value under judgment.
 * @param label - the field label, for the error message.
 */
function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`org registry field "${label}" must be a non-empty string`)
  }
}

/**
 * Validate and shape one seat's `tools` field. Tool NAMES are not checked
 * against any real tool set here — this layer has no idea what tools exist,
 * and a name that is momentarily unavailable (a server down) is a legitimate
 * runtime situation handled elsewhere, not a reason to refuse the whole
 * registry.
 * @param value - the raw `tools` value from the parsed document.
 * @param seatName - the owning seat, for error messages a human can act on.
 * @returns the validated tool restriction.
 * @throws when the shape is malformed, when neither `allow` nor `deny` is
 *   given, or when a given `allow`/`deny` is present but empty.
 */
function parseSeatTools(value: unknown, seatName: string): OrgRegistrySeatTools {
  assertObject(value, `seats.${seatName}.tools`)
  if (value.allow !== undefined) assertStringArray(value.allow, `seats.${seatName}.tools.allow`)
  if (value.deny !== undefined) assertStringArray(value.deny, `seats.${seatName}.tools.deny`)
  if (value.allow === undefined && value.deny === undefined) {
    throw new Error(`org registry field seats.${seatName}.tools must include "allow" and/or "deny" (an empty tools rule is meaningless)`)
  }
  // A PRESENT but empty list reads like an oversight (a typo'd name list that
  // silently resolved to nothing), yet parses cleanly and leaves the seat
  // with zero tools — the same "meaningless as configuration" problem the
  // whole-field guard above catches, just one level deeper. Reject it here
  // too, rather than letting it through to become a muted seat nobody
  // configured on purpose.
  if (value.allow !== undefined && value.allow.length === 0) {
    throw new Error(`org registry field seats.${seatName}.tools.allow must not be an empty list (an empty tools rule is meaningless)`)
  }
  if (value.deny !== undefined && value.deny.length === 0) {
    throw new Error(`org registry field seats.${seatName}.tools.deny must not be an empty list (an empty tools rule is meaningless)`)
  }
  return {
    ...value.allow === undefined ? {} : { allow: value.allow },
    ...value.deny === undefined ? {} : { deny: value.deny },
  }
}

/**
 * Assert a value is an array of non-empty strings.
 * @param value - the value under judgment.
 * @param label - the field label, for the error message.
 */
function assertStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`org registry field "${label}" must be a list of non-empty strings`)
  }
}

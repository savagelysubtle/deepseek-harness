/**
 * The org registry: the machine-readable roster and topology behind mailbox
 * addressing — seats with their workspaces and namespaces, undirected edges
 * between seats that may exchange mail directly, and the call-up exception.
 * The loader, the sending tool, and the seat-runner daemon read *a* registry
 * and enforce whatever graph it describes; none of them name seats from any
 * particular deployment, so a second project ships by writing a new registry
 * file, never new code.
 *
 * Validation fails loud at parse with the offending key named: an org chart
 * that only exists as prose gets drift of exactly the kind this file exists
 * to prevent.
 *
 * @module @deepseek-ai/dsh-mailbox/org-registry
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { MAILBOX_SEGMENT_PATTERN_SOURCE } from './address.ts'

const SEGMENT_PATTERN = new RegExp(MAILBOX_SEGMENT_PATTERN_SOURCE)

/** One seat's roster entry: where it runs and which mailbox namespace it answers. */
export interface OrgRegistrySeat {
  /**
   * Workspace the seat's runs execute in: an absolute path, or a path
   * relative to the registry's {@link OrgRegistry.baseDir}.
   */
  readonly cwd: string
  /** Namespace half of the seat's mailbox address (`<namespace>:<name>`). */
  readonly namespace: string
  /** Marks a department head; documentation metadata, not enforcement data. */
  readonly lead?: boolean
}

/** One undirected edge: both directions are implied unless a later rule excepts them. */
export type OrgRegistryEdge = readonly [from: string, to: string]

/** The parsed, validated registry. */
export interface OrgRegistry {
  /** Absolute base every relative seat `cwd` resolves against. */
  readonly baseDir: string
  /** Roster keyed by seat name; names are address name halves. */
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
      throw new Error(`org registry seat ${JSON.stringify(name)}: names must match ${MAILBOX_SEGMENT_PATTERN_SOURCE} (they are mailbox address name halves)`)
    }
    const seat: unknown = seatsField[name]
    assertObject(seat, `seats.${name}`)
    assertNonEmptyString(seat.cwd, `seats.${name}.cwd`)
    assertNonEmptyString(seat.namespace, `seats.${name}.namespace`)
    if (!SEGMENT_PATTERN.test(seat.namespace)) {
      throw new Error(`org registry seats.${name}.namespace ${JSON.stringify(seat.namespace)}: must match ${MAILBOX_SEGMENT_PATTERN_SOURCE}`)
    }
    if (seat.lead !== undefined && typeof seat.lead !== 'boolean') {
      throw new Error(`org registry field seats.${name}.lead must be a boolean when present`)
    }
    seats[name] = seat.lead === undefined
      ? { cwd: expandTilde(seat.cwd, home), namespace: seat.namespace }
      : { cwd: expandTilde(seat.cwd, home), namespace: seat.namespace, lead: seat.lead }
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

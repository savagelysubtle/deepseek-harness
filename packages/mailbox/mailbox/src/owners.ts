/**
 * Seat territories (OP-115): pure glob matcher, owner lookup and overlap scan
 * over the org registry `owns` lists. Advisory and read-only: no enforcement.
 */
import { readdirSync, statSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { OrgRegistry } from './org-registry.ts'
import { resolveSeatCwd } from './org-registry.ts'

/** Regex metacharacters that must be backslash-escaped when copied into a RegExp source. */
const REGEX_META = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}', '/'])

/**
 * Escape one literal glob character for inclusion in a RegExp source.
 * @param c - the single character to copy.
 * @returns the character, escaped when it is a regex metacharacter.
 */
function escapeLiteral(c: string): string {
  return REGEX_META.has(c) ? `\\${c}` : c
}

/**
 * Compile an absolute, already-normalised glob pattern into an anchored RegExp. A double star
 * that is a whole path segment matches any depth including zero segments (a pattern with a
 * double-star segment between `a` and `b` matches both `a/b` and `a/x/y/b`); a trailing
 * double-star segment matches anything below its parent but not the parent itself. A double
 * star elsewhere inside a segment is `.*`, `*` is any run of non-`/` characters, `?` is exactly
 * one non-`/` character and everything else is literal.
 * @param pattern - the absolute glob pattern to compile.
 * @returns the compiled regular expression, anchored with `^` and `$`.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern.charAt(i)
    if (c === '*') {
      let stars = i + 1
      while (pattern.charAt(stars) === '*') stars++
      const double = stars - i >= 2
      const wholeSegment = (i === 0 || pattern.charAt(i - 1) === '/') && (stars === pattern.length || pattern.charAt(stars) === '/')
      if (double && wholeSegment) {
        if (stars === pattern.length) {
          source += '.+'
        } else {
          source += '(?:[^/]+/)*'
          stars++
        }
        i = stars
        continue
      }
      source += double ? '.*' : '[^/]*'
      i = stars
      continue
    }
    if (c === '?') {
      source += '[^/]'
      i++
      continue
    }
    source += escapeLiteral(c)
    i++
  }
  return new RegExp(`^${source}$`)
}

/**
 * Report whether a pattern contains glob characters.
 * @param pattern - the pattern to inspect.
 * @returns true when the pattern contains `*` or `?`.
 */
export function hasGlobChars(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?')
}

/**
 * Strip trailing slashes from a path, keeping the root `/` intact.
 * @param value - the path to clean up.
 * @returns the path without trailing slashes; never empty.
 */
function stripTrailingSlashes(value: string): string {
  let out = value
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out.length === 0 ? '/' : out
}

/**
 * Turn one seat `owns` entry into an absolute, normalised pattern.
 * @param pattern - the raw entry, absolute or relative to the seat's cwd; glob characters are preserved.
 * @param cwd - the seat's resolved working directory, joined onto relative entries.
 * @returns the absolute pattern, without a trailing slash except for the root `/`.
 */
export function normalizeAbsolutePattern(pattern: string, cwd: string): string {
  const joined = isAbsolute(pattern) ? pattern : resolve(cwd, pattern)
  return stripTrailingSlashes(joined)
}

/**
 * Decide whether one absolute pattern owns one absolute path: a glob-free pattern owns the path
 * itself and everything below it (a `/` pattern owns everything), a glob pattern owns the path
 * when its compiled matcher accepts it.
 * @param absPattern - absolute, already-normalised pattern, glob or plain.
 * @param absPath - absolute, normalised path without a trailing slash.
 * @returns true when the pattern covers the path.
 */
export function patternMatches(absPattern: string, absPath: string): boolean {
  if (!hasGlobChars(absPattern)) {
    if (absPattern === '/') return true
    return absPath === absPattern || absPath.startsWith(`${absPattern}/`)
  }
  return globToRegExp(absPattern).test(absPath)
}

/** One seat's slice of the tree: its mailbox name plus the absolute patterns it owns. */
export interface SeatTerritory {
  /** Seat name (its mailbox address). */
  readonly seat: string
  /** Absolute `owns` patterns, normalised. */
  readonly patterns: readonly string[]
}

/** The territories a registry declares, plus the seats that could not be used. */
export interface TerritoryTable {
  /** One entry per seat that declares `owns`, ordered by seat name. */
  readonly territories: readonly SeatTerritory[]
  /** Seats marked invalid, sorted; skipped everywhere. */
  readonly quarantined: readonly string[]
}

/**
 * Build the seat territory table from an org registry: seats are iterated in alphabetical
 * order, an invalid seat is quarantined and skipped, a seat without `owns` is skipped
 * silently, and every other seat contributes its `owns` entries resolved against its cwd.
 * @param registry - the parsed org registry.
 * @returns territories sorted by seat name and the sorted quarantined seat names.
 */
export function buildTerritories(registry: OrgRegistry): TerritoryTable {
  const territories: SeatTerritory[] = []
  const quarantined: string[] = []
  for (const name of Object.keys(registry.seats).sort()) {
    const seat = registry.seats[name]
    if (seat === undefined) continue
    if (seat.invalid !== undefined) {
      quarantined.push(name)
      continue
    }
    const owns = seat.owns
    if (owns === undefined) continue
    const cwd = resolveSeatCwd(registry, name)
    territories.push({ seat: name, patterns: owns.map(pattern => normalizeAbsolutePattern(pattern, cwd)) })
  }
  return { territories, quarantined: quarantined.sort() }
}

/** Result of asking who owns one path. */
export interface OwnerLookup {
  /** The queried path, stripped of trailing slashes. */
  readonly path: string
  /** Seat names with at least one matching pattern, sorted. */
  readonly owners: readonly string[]
  /** Quarantined seats skipped during the lookup, sorted. */
  readonly quarantined: readonly string[]
}

/**
 * Find the seats whose territories cover one absolute path.
 * @param registry - the parsed org registry.
 * @param absPath - absolute path to query; trailing slashes are stripped except for the root.
 * @returns the sorted owners and the skipped quarantined seats.
 */
export function findOwners(registry: OrgRegistry, absPath: string): OwnerLookup {
  const path = stripTrailingSlashes(absPath)
  const table = buildTerritories(registry)
  const owners = table.territories
    .filter(territory => territory.patterns.some(pattern => patternMatches(pattern, path)))
    .map(territory => territory.seat)
    .sort()
  return { path, owners, quarantined: table.quarantined }
}

/**
 * Format the shared footnote for skipped quarantined seats.
 * @param quarantined - the skipped seat names, sorted.
 * @returns e.g. `Note: skipped quarantined seat(s): a, b.`
 */
function quarantineNote(quarantined: readonly string[]): string {
  return `Note: skipped quarantined seat(s): ${quarantined.join(', ')}.`
}

/**
 * Format an owner lookup as one line, plus an optional quarantine note.
 * @param lookup - the lookup result to render.
 * @returns `<path>: owned by <seat>` for one owner, `<path>: unowned` for none and
 *   `<path>: doubly owned by <seats>` (this wording for two and for more owners, names joined
 *   with ', '), then the quarantine note when seats were skipped; joined by '\n', no trailing newline.
 */
export function formatOwnerLookup(lookup: OwnerLookup): string {
  const lines: string[] = []
  if (lookup.owners.length === 0) lines.push(`${lookup.path}: unowned`)
  else if (lookup.owners.length === 1) lines.push(`${lookup.path}: owned by ${lookup.owners[0]}`)
  else lines.push(`${lookup.path}: doubly owned by ${lookup.owners.join(', ')}`)
  if (lookup.quarantined.length > 0) lines.push(quarantineNote(lookup.quarantined))
  return lines.join('\n')
}

/** File-visit budget the overlap scan enforces across all seats and patterns. */
export const DEFAULT_MAX_SCAN_FILES = 200000

/** One seat pair that shares at least one owned path. */
export interface OverlapPair {
  /** First seat name; sorts before `b`. */
  readonly a: string
  /** Second seat name; sorts after `a`. */
  readonly b: string
  /** Number of paths both seats' patterns match. */
  readonly count: number
  /** Up to 3 example shared paths, in sorted order. */
  readonly examples: readonly string[]
}

/** Result of scanning the tree for territory overlaps. */
export interface OverlapReport {
  /** True when the scan stopped at the file limit and may be incomplete. */
  readonly capped: boolean
  /** File paths visited across all seats and patterns. */
  readonly scannedFiles: number
  /** Paths matched by at least two seats' territories. */
  readonly overlappingPaths: number
  /** Seat pairs with shared paths, sorted by `a` then `b`. */
  readonly pairs: readonly OverlapPair[]
  /** Seats that declare an `owns` list. */
  readonly seatsWithTerritory: number
  /** Quarantined seats skipped, sorted. */
  readonly quarantined: readonly string[]
}

/**
 * Compute the glob-free leading directory of one pattern.
 * @param pattern - absolute pattern.
 * @returns the leading segments before the first segment carrying glob characters; the whole
 *   pattern when it has none, and `/` when that leaves nothing.
 */
function staticPrefix(pattern: string): string {
  const kept: string[] = []
  for (const segment of pattern.split('/')) {
    if (hasGlobChars(segment)) break
    kept.push(segment)
  }
  const joined = kept.join('/')
  return joined === '' ? '/' : joined
}

/**
 * Keep a path among a pair's examples when it is one of the smallest three seen so far.
 * @param examples - the current examples, sorted, mutated in place.
 * @param path - the newly shared path.
 */
function recordExample(examples: string[], path: string): void {
  const third = examples[2]
  if (third !== undefined && path >= third) return
  if (examples.length === 3) examples.pop()
  examples.push(path)
  examples.sort()
}

/**
 * Visit every file below one glob-free prefix, iteratively. A prefix that is itself a file
 * counts as one file entry; directories named `node_modules` or `.git` are skipped, symlinks
 * count as file entries and are never descended into, and unreadable or missing directories
 * are ignored.
 * @param prefix - absolute directory or file path without glob characters.
 * @param visit - callback per file path; return false to stop the whole walk.
 * @returns false when the walk was stopped early, true otherwise.
 */
function walkFiles(prefix: string, visit: (path: string) => boolean): boolean {
  let info: Stats
  try {
    info = statSync(prefix)
  } catch {
    return true
  }
  if (info.isFile()) return visit(prefix)
  if (!info.isDirectory()) return true
  const stack: string[] = [prefix]
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        stack.push(path)
      } else if (!visit(path)) {
        return false
      }
    }
  }
  return true
}

/**
 * Scan the tree for paths covered by more than one seat's territory. Synchronous: for every
 * territory pattern the scan walks the pattern's glob-free static prefix, counting each visited
 * file into a counter shared across all seats and patterns; when the counter would exceed the
 * limit the whole scan stops and the report is marked capped.
 * @param registry - the parsed org registry.
 * @param options - scan options; `maxFiles` caps visited paths, default {@link DEFAULT_MAX_SCAN_FILES}.
 * @returns the overlap report computed over the paths seen.
 */
export function findOverlaps(registry: OrgRegistry, options: { readonly maxFiles?: number } = {}): OverlapReport {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_SCAN_FILES
  const table = buildTerritories(registry)
  const pathSeats = new Map<string, Set<string>>()
  let scannedFiles = 0
  let capped = false as boolean
  for (const territory of table.territories) {
    for (const pattern of territory.patterns) {
      if (!walkFiles(staticPrefix(pattern), (path) => {
        if (scannedFiles >= maxFiles) {
          capped = true
          return false
        }
        scannedFiles++
        if (patternMatches(pattern, path)) {
          const seats = pathSeats.get(path)
          if (seats === undefined) pathSeats.set(path, new Set([territory.seat]))
          else seats.add(territory.seat)
        }
        return true
      })) break
    }
    if (capped) break
  }
  const pairMap = new Map<string, { a: string; b: string; count: number; examples: string[] }>()
  let overlappingPaths = 0
  for (const [path, seats] of pathSeats) {
    if (seats.size < 2) continue
    overlappingPaths++
    const names = [...seats].sort()
    for (const [i, first] of names.entries()) {
      for (const second of names.slice(i + 1)) {
        const key = `${first}\u0000${second}`
        let pair = pairMap.get(key)
        if (pair === undefined) {
          pair = { a: first, b: second, count: 0, examples: [] }
          pairMap.set(key, pair)
        }
        pair.count++
        recordExample(pair.examples, path)
      }
    }
  }
  const sorted = [...pairMap.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))
  return {
    capped,
    scannedFiles,
    overlappingPaths,
    pairs: sorted.map(([, pair]) => ({ a: pair.a, b: pair.b, count: pair.count, examples: [...pair.examples] })),
    seatsWithTerritory: table.territories.length,
    quarantined: table.quarantined,
  }
}

/**
 * Render an overlap report as plain text lines.
 * @param report - the report to render.
 * @returns a capped banner when capped, then the overlap summary with one line per pair, the
 *   empty-registry note when no seat declares an owns list, and the quarantine note when
 *   seats were skipped; lines joined by '\n', no trailing newline.
 */
export function formatOverlapReport(report: OverlapReport): string {
  const lines: string[] = []
  if (report.capped) lines.push(`The scan was capped after ${report.scannedFiles} files; the result below may be incomplete.`)
  if (report.overlappingPaths === 0) {
    lines.push('No overlaps: no path is owned by more than one seat.')
  } else {
    lines.push(`${report.overlappingPaths} path(s) are owned by more than one seat.`)
    for (const pair of report.pairs) lines.push(`${pair.a} and ${pair.b}: ${pair.count} shared paths, e.g. ${pair.examples.join(', ')}`)
  }
  if (report.seatsWithTerritory === 0) lines.push('No seat declares an owns list yet, so there are no territories to compare.')
  if (report.quarantined.length > 0) lines.push(quarantineNote(report.quarantined))
  return lines.join('\n')
}

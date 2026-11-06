/**
 * Seat territories (OP-115 step 3): the pure glob matcher, owner lookup and
 * overlap scan, against a real temp-dir tree with three seats of which
 * exactly two overlap.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTerritories,
  findOverlaps,
  findOwners,
  formatOverlapReport,
  formatOwnerLookup,
  globToRegExp,
  hasGlobChars,
  normalizeAbsolutePattern,
  parseOrgRegistry,
  patternMatches,
} from '../src/index.ts'

describe('glob matcher', () => {
  it('detects glob characters', () => {
    expect(hasGlobChars('/a/b')).toBe(false)
    expect(hasGlobChars('/a/*.ts')).toBe(true)
    expect(hasGlobChars('/a/?')).toBe(true)
  })

  it('** spans any depth, including zero segments', () => {
    expect(patternMatches('/r/a/**/b', '/r/a/b')).toBe(true)
    expect(patternMatches('/r/a/**/b', '/r/a/x/y/b')).toBe(true)
    expect(patternMatches('/r/a/**/b', '/r/a/x/y/c')).toBe(false)
    expect(patternMatches('/r/a/**', '/r/a/x')).toBe(true)
    expect(patternMatches('/r/a/**', '/r/a/x/y/z.ts')).toBe(true)
    expect(patternMatches('/r/a/**', '/r/a')).toBe(false)
    expect(patternMatches('/r/a/**', '/r/ab/x')).toBe(false)
  })

  it('* never crosses a slash', () => {
    expect(patternMatches('/r/src/*.ts', '/r/src/a.ts')).toBe(true)
    expect(patternMatches('/r/src/*.ts', '/r/src/deep/a.ts')).toBe(false)
    expect(patternMatches('/r/src/*.ts', '/r/src/a.tsx')).toBe(false)
  })

  it('? matches exactly one non-slash character', () => {
    expect(patternMatches('/r/f?.md', '/r/fa.md')).toBe(true)
    expect(patternMatches('/r/f?.md', '/r/f.md')).toBe(false)
    expect(patternMatches('/r/f?.md', '/r/fab.md')).toBe(false)
    expect(patternMatches('/r/f?.md', '/r/f/.md')).toBe(false)
  })

  it('treats every other character literally, including regex metacharacters', () => {
    expect(patternMatches('/r/a.b/*', '/r/a.b/x')).toBe(true)
    expect(patternMatches('/r/a.b/*', '/r/aXb/x')).toBe(false)
    expect(patternMatches('/r/(x)+/*', '/r/(x)+/y')).toBe(true)
    expect(globToRegExp('/r/[a]*').test('/r/[a]z')).toBe(true)
    expect(globToRegExp('/r/[a]*').test('/r/az')).toBe(false)
  })

  it('a pattern without glob characters owns the path and everything below it', () => {
    expect(patternMatches('/r/notes', '/r/notes')).toBe(true)
    expect(patternMatches('/r/notes', '/r/notes/a/b.txt')).toBe(true)
    expect(patternMatches('/r/notes', '/r/notes2/a.md')).toBe(false)
    expect(patternMatches('/r/notes', '/r/doc')).toBe(false)
  })

  it('normalises relative against the cwd, keeps absolute as is, and drops trailing slashes', () => {
    expect(normalizeAbsolutePattern('src/**', '/w/seat')).toBe('/w/seat/src/**')
    expect(normalizeAbsolutePattern('./src/../lib/*.ts', '/w/seat')).toBe('/w/seat/lib/*.ts')
    expect(normalizeAbsolutePattern('/mnt/Dev/Coding/x/**', '/w/seat')).toBe('/mnt/Dev/Coding/x/**')
    expect(normalizeAbsolutePattern('notes/', '/w/seat')).toBe('/w/seat/notes')
    // The trailing-slash form still owns the directory and below.
    expect(patternMatches(normalizeAbsolutePattern('notes/', '/w/seat'), '/w/seat/notes/a.txt')).toBe(true)
  })
})

describe('owner lookup and overlap scan (three seats, two overlap)', () => {
  let roots: string[] = []

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots = []
  })

  function touch(file: string): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'x')
  }

  /** alpha owns src/**, beta owns src/shared/** and notes, gamma owns lib/*.ts; delta has no owns; eve is quarantined. */
  function fixture(): { root: string; registry: ReturnType<typeof parseOrgRegistry> } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-owners-'))
    roots.push(root)
    for (const file of ['src/a.ts', 'src/shared/s1.ts', 'src/shared/s2.ts', 'src/shared/deep/s3.ts', 'notes/readme.txt',
      'lib/x.ts', 'lib/y.js', 'lib/sub/z.ts', 'src/node_modules/skip.ts', 'src/.git/skip.ts']) touch(join(root, file))
    symlinkSync(join(root, 'src'), join(root, 'src', 'loop'))
    const text = [
      `baseDir: ${root}`,
      'seats:',
      '  alpha: { cwd: ., owns: ["src/**"] }',
      '  beta: { cwd: ., owns: ["src/shared/**", "notes/"] }',
      '  gamma: { cwd: ., owns: ["lib/*.ts"] }',
      '  delta: { cwd: . }',
      '  eve: { cwd: ., driver: claude-code, owns: ["src/**"], colour: red }',
      'edges: []',
      'callUp: []',
    ].join('\n')
    return { root, registry: parseOrgRegistry(text) }
  }

  it('skips seats without owns silently and quarantined seats with a note', () => {
    const { registry } = fixture()
    const table = buildTerritories(registry)
    expect(table.territories.map(t => t.seat)).toEqual(['alpha', 'beta', 'gamma'])
    expect(table.quarantined).toEqual(['eve'])
  })

  it('answers owned, unowned and doubly owned paths in plain words', () => {
    const { root, registry } = fixture()
    expect(formatOwnerLookup(findOwners(registry, join(root, 'lib/x.ts')))).toBe(`${join(root, 'lib/x.ts')}: owned by gamma\nNote: skipped quarantined seat(s): eve.`)
    expect(formatOwnerLookup(findOwners(registry, join(root, 'src/a.ts')))).toContain(`${join(root, 'src/a.ts')}: owned by alpha`)
    expect(formatOwnerLookup(findOwners(registry, join(root, 'lib/y.js')))).toContain(`${join(root, 'lib/y.js')}: unowned`)
    expect(formatOwnerLookup(findOwners(registry, join(root, 'does/not/exist.txt')))).toContain('does/not/exist.txt: unowned')
    const shared = findOwners(registry, join(root, 'src/shared/s1.ts'))
    expect(shared.owners).toEqual(['alpha', 'beta'])
    expect(formatOwnerLookup(shared).split('\n')[0]).toBe(`${join(root, 'src/shared/s1.ts')}: doubly owned by alpha, beta`)
    // A trailing slash on the asked path changes nothing.
    expect(findOwners(registry, `${join(root, 'notes')}/`).owners).toEqual(['beta'])
  })

  it('--overlaps lists exactly the one overlapping pair', () => {
    const { root, registry } = fixture()
    const report = findOverlaps(registry)
    expect(report.capped).toBe(false)
    expect(report.seatsWithTerritory).toBe(3)
    // Shared: the directory src/shared/deep, the file below it, and src/shared/s1.ts and s2.ts (src/shared itself is beta-only).
    expect(report.overlappingPaths).toBe(4)
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]).toMatchObject({ a: 'alpha', b: 'beta', count: 4 })
    expect(report.pairs[0]?.examples).toEqual([
      join(root, 'src/shared/deep'), join(root, 'src/shared/deep/s3.ts'), join(root, 'src/shared/s1.ts'),
    ])
    const text = formatOverlapReport(report)
    expect(text.split('\n')[0]).toBe('4 path(s) are owned by more than one seat.')
    expect(text).toContain(`alpha and beta: 4 shared paths, e.g. ${join(root, 'src/shared/deep')}`)
    expect(text).toContain('Note: skipped quarantined seat(s): eve.')
    expect(text).not.toContain('gamma')
  })

  it('reports no overlaps in plain words when territories are disjoint', () => {
    const { root } = fixture()
    const registry = parseOrgRegistry(`baseDir: ${root}\nseats:\n  a: { cwd: ., owns: ["lib/**"] }\n  b: { cwd: ., owns: ["notes"] }\n`)
    const report = findOverlaps(registry)
    expect(report.overlappingPaths).toBe(0)
    expect(formatOverlapReport(report)).toBe('No overlaps: no path is owned by more than one seat.')
  })

  it('says so when no seat declares territory', () => {
    const registry = parseOrgRegistry('baseDir: /p\nseats:\n  a: { cwd: a }\n')
    const text = formatOverlapReport(findOverlaps(registry))
    expect(text).toContain('No seat declares an owns list yet')
    expect(text).toContain('No overlaps: no path is owned by more than one seat.')
  })

  it('stops at the file cap and says the scan was capped', () => {
    const { registry } = fixture()
    const report = findOverlaps(registry, { maxFiles: 2 })
    expect(report.capped).toBe(true)
    expect(formatOverlapReport(report).split('\n')[0]).toMatch(/^The scan was capped after \d+ paths; the result below may be incomplete\.$/)
  })

  it('skips node_modules and .git and does not follow symlinks', () => {
    const { root, registry } = fixture()
    const report = findOverlaps(registry)
    const all = report.pairs.flatMap(pair => pair.examples)
    expect(all.some(path => path.includes('node_modules') || path.includes('/.git/'))).toBe(false)
    expect(report.scannedPaths).toBeLessThan(40)
    expect(findOwners(registry, join(root, 'src/node_modules/skip.ts')).owners).toEqual(['alpha'])
  })

  it('lists a directory that the owner lookup calls doubly owned, empty directories included', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-owners-'))
    roots.push(root)
    mkdirSync(join(root, 'a/x'), { recursive: true })
    mkdirSync(join(root, 'a/y'), { recursive: true })
    touch(join(root, 'a/f.txt'))
    const registry = parseOrgRegistry(`baseDir: ${root}\nseats:\n  A: { cwd: ., owns: ["a/*"] }\n  B: { cwd: ., owns: ["a/x"] }\n`)
    expect(findOwners(registry, join(root, 'a/x')).owners).toEqual(['A', 'B'])
    const report = findOverlaps(registry)
    expect(report.overlappingPaths).toBe(1)
    expect(report.pairs).toEqual([{ a: 'A', b: 'B', count: 1, examples: [join(root, 'a/x')] }])
  })

  it('does not make a seat overlap itself through two of its own patterns', () => {
    const { root } = fixture()
    const registry = parseOrgRegistry(
      `baseDir: ${root}\nseats:\n  alpha: { cwd: ., owns: ["src/**", "src/*.ts"] }\n  beta: { cwd: ., owns: ["src/shared/**"] }\n`,
    )
    const report = findOverlaps(registry)
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]).toMatchObject({ a: 'alpha', b: 'beta', count: 4 })
    // Two patterns of one seat reach the same paths: they are counted once against the cap.
    const alphaOnly = parseOrgRegistry(`baseDir: ${root}\nseats:\n  alpha: { cwd: ., owns: ["src/**", "src/**"] }\n`)
    const once = parseOrgRegistry(`baseDir: ${root}\nseats:\n  alpha: { cwd: ., owns: ["src/**"] }\n`)
    expect(findOverlaps(alphaOnly).scannedPaths).toBe(findOverlaps(once).scannedPaths)
    expect(findOverlaps(alphaOnly).overlappingPaths).toBe(0)
  })
})

describe('glob compiler resists catastrophic backtracking', () => {
  const deep = `/r/${Array.from({ length: 31 }, (_, i) => `d${i}`).join('/')}/nomatch.txt`

  it('collapses consecutive whole-segment ** into a single group', () => {
    expect(globToRegExp('/r/**/**/**/x').source).toBe(globToRegExp('/r/**/x').source)
    expect(globToRegExp('/r/**/**').source).toBe(globToRegExp('/r/**').source)
    expect(globToRegExp('/r/a**/**/x').source).not.toBe(globToRegExp('/r/a**/x').source)
  })

  it('answers fast for 14+ consecutive **/ against a deep non-matching path', () => {
    const pattern = `/r/${'**/'.repeat(16)}x`
    const started = performance.now()
    expect(patternMatches(pattern, deep)).toBe(false)
    expect(patternMatches(pattern, `${deep.replace('nomatch.txt', '')}x`)).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('answers fast for alternating */**/ shapes and runs of *', () => {
    const started = performance.now()
    expect(patternMatches(`/r/${'*/**/'.repeat(8)}x`, deep)).toBe(false)
    expect(patternMatches(`/r/${'*a'.repeat(10)}b`, `/r/${'a'.repeat(60)}`)).toBe(false)
    expect(patternMatches('/r/*****/**/*****/x', deep)).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('the backtracking-free matcher agrees with the compiled regex on ordinary shapes', () => {
    const patterns = ['/r/a/**/b', '/r/a/**', '/r/**/x', '/r/src/*.ts', '/r/f?.md', '/r/a**b/c', '/r/**/m/**/x']
    const paths = ['/r/a/b', '/r/a/x/y/b', '/r/a', '/r/a/x', '/r/x', '/r/q/x', '/r/src/a.ts', '/r/src/d/a.ts', '/r/fa.md', '/r/f.md',
      '/r/aXb/c', '/r/a/q/b/c', '/r/m/x', '/r/a/m/b/m/x']
    for (const pattern of patterns) {
      for (const path of paths) expect(patternMatches(pattern, path), `${pattern} vs ${path}`).toBe(globToRegExp(pattern).test(path))
    }
  })

  it('stays fast on a long path with many wildcards', () => {
    const started = performance.now()
    expect(patternMatches(`/r/${'*a'.repeat(12)}*b`, `/r/${'a'.repeat(3000)}`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

/**
 * SWD-118 roster-drift alarm: the pure comparison and message-formatting
 * logic (`diffRosters`, `unknownServedSeats`, the two warning formatters) and
 * the registry-load classification (`loadRegistrySeatNames`) that each
 * mount's mount-time check is built from.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  diffRosters, loadRegistrySeatNames, rosterDriftWarning, unknownServedSeats, unknownServedSeatsWarning,
} from '../src/roster.ts'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function writeRegistry(seats: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-roster-registry-'))
  dirs.push(dir)
  const path = join(dir, 'registry.yml')
  const rows = seats.map(seat => `  ${seat}: { cwd: ${seat} }`).join('\n')
  writeFileSync(path, `baseDir: ${dir}\nseats:\n${rows}\n`, 'utf8')
  return path
}

describe('diffRosters', () => {
  it('reports no drift when two rosters are identical', () => {
    expect(diffRosters(['alice', 'bob'], ['bob', 'alice'])).toEqual({ onlyFirst: [], onlySecond: [] })
  })

  it('names what each side has that the other lacks, sorted', () => {
    expect(diffRosters(['alice', 'zeta', 'bob'], ['bob', 'carol'])).toEqual({
      onlyFirst: ['alice', 'zeta'],
      onlySecond: ['carol'],
    })
  })

  it('treats an empty roster as a legitimate side of the comparison', () => {
    expect(diffRosters([], ['alice'])).toEqual({ onlyFirst: [], onlySecond: ['alice'] })
  })
})

describe('rosterDriftWarning', () => {
  it('names both mount ids and the specific seats each side is missing, never a bare "rosters differ"', () => {
    const text = rosterDriftWarning('mailbox-bridge', 'tool-mailbox', { onlyFirst: ['ghost'], onlySecond: ['batman'] })
    expect(text).toContain('"mailbox-bridge"')
    expect(text).toContain('"tool-mailbox"')
    expect(text).toContain('ghost')
    expect(text).toContain('batman')
    expect(text).not.toMatch(/rosters differ/i)
  })
})

describe('unknownServedSeats', () => {
  it('returns nothing when every served name is known', () => {
    expect(unknownServedSeats(['alice', 'bob'], new Set(['alice', 'bob', 'carol']))).toEqual([])
  })

  it('names served addresses the registry does not know, sorted', () => {
    expect(unknownServedSeats(['zeta', 'alice', 'ghost'], new Set(['alice']))).toEqual(['ghost', 'zeta'])
  })
})

describe('unknownServedSeatsWarning', () => {
  it('names the mount id and every unknown seat', () => {
    const text = unknownServedSeatsWarning('tool-mailbox', ['ghost', 'phantom'])
    expect(text).toContain('"tool-mailbox"')
    expect(text).toContain('ghost')
    expect(text).toContain('phantom')
  })

  it('uses singular phrasing for exactly one unknown name', () => {
    expect(unknownServedSeatsWarning('mailbox-bridge', ['ghost'])).toContain('a name')
  })
})

describe('loadRegistrySeatNames', () => {
  it('loads the seat names of a valid registry', async () => {
    const path = writeRegistry(['alice', 'bob'])
    const outcome = await loadRegistrySeatNames(path)
    expect(outcome.kind).toBe('loaded')
    if (outcome.kind === 'loaded') expect(outcome.seatNames).toEqual(new Set(['alice', 'bob']))
  })

  it('classifies a missing registry file as "missing", never as an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roster-missing-'))
    dirs.push(dir)
    const outcome = await loadRegistrySeatNames(join(dir, 'nonexistent-registry.yml'))
    expect(outcome).toEqual({ kind: 'missing' })
  })

  it('classifies a present-but-broken registry as "unavailable", never as "nothing is wrong"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roster-broken-'))
    dirs.push(dir)
    const path = join(dir, 'registry.yml')
    writeFileSync(path, 'baseDir: [unclosed\n', 'utf8')
    const outcome = await loadRegistrySeatNames(path)
    expect(outcome.kind).toBe('unavailable')
    if (outcome.kind === 'unavailable') expect(outcome.error).toBeInstanceOf(Error)
  })
})

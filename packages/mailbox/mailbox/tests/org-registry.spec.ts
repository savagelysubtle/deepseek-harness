/** Org registry: parse validation, topology queries, route finding, and cwd resolution. */

import { describe, expect, it } from 'vitest'
import {
  findOrgRegistryRoute,
  formatMailboxAddress,
  orgRegistryAllows,
  parseMailboxAddress,
  parseOrgRegistry,
  resolveSeatCwd,
} from '../src/index.ts'

const VALID = `
baseDir: /projects
seats:
  lead-a: { cwd: project-a, lead: true }
  peer-a: { cwd: project-a }
  lead-b: { cwd: ~/other/project-b, lead: true }
  peer-b: { cwd: project-b }
edges:
  - [lead-a, lead-b]
  - [lead-a, peer-a]
  - [lead-b, peer-b]
callUp: [lead-a]
`

describe('parseOrgRegistry', () => {
  it('parses a valid registry with defaults for absent edges and callUp', () => {
    const registry = parseOrgRegistry('baseDir: /projects\nseats:\n  solo: { cwd: one }\n')
    expect(registry.baseDir).toBe('/projects')
    expect(registry.seats.solo).toEqual({ cwd: 'one' })
    expect(registry.edges).toEqual([])
    expect(registry.callUp).toEqual([])
  })

  it('expands a leading ~ in baseDir against the given home', () => {
    const registry = parseOrgRegistry('baseDir: ~/work\nseats:\n  solo: { cwd: one }\n', { home: '/home/test' })
    expect(registry.baseDir).toBe('/home/test/work')
  })

  it('keeps seat names inside the mailbox address grammar', () => {
    for (const name of Object.keys(parseOrgRegistry(VALID).seats)) {
      expect(formatMailboxAddress(name)).toBe(parseMailboxAddress(formatMailboxAddress(name)))
    }
  })

  it.each([
    ['seats: {}', 'must list at least one seat'],
    ['seats:\n  solo: {}', 'seats.solo.cwd'],
    ['seats:\n  solo: { cwd: one }\nbaseDir: "  "', 'baseDir'],
    ['seats:\n  "bad seat": { cwd: one }', 'names must match'],
    ['seats:\n  solo: { cwd: one, lead: "yes" }\nbaseDir: /p', 'seats.solo.lead'],
  ])('rejects %j loudly naming the field', (_document, message) => {
    const document = _document.includes('baseDir') ? _document : `${_document}\nbaseDir: /projects`
    expect(() => parseOrgRegistry(document)).toThrow(message)
  })

  it('rejects edges naming unknown seats, self-edges, and malformed pairs', () => {
    const base = 'baseDir: /projects\nseats:\n  a: { cwd: one }\n  b: { cwd: two }\n'
    expect(() => parseOrgRegistry(`${base}edges:\n  - [a, ghost]\n`)).toThrow('unknown seat "ghost"')
    expect(() => parseOrgRegistry(`${base}edges:\n  - [a, a]\n`)).toThrow('connects seat "a" to itself')
    expect(() => parseOrgRegistry(`${base}edges:\n  - [a]\n`)).toThrow('[from, to] pair')
    expect(() => parseOrgRegistry(`${base}edges:\n  - a-b\n`)).toThrow('[from, to] pair')
  })

  it('rejects callUp naming unknown seats and invalid YAML', () => {
    const base = 'baseDir: /projects\nseats:\n  a: { cwd: one }\n'
    expect(() => parseOrgRegistry(`${base}callUp: [ghost]\n`)).toThrow('unknown seat "ghost"')
    expect(() => parseOrgRegistry('baseDir: [/projects]\nseats:\n  a: { cwd: one }\n')).toThrow('baseDir')
    expect(() => parseOrgRegistry('baseDir: [unclosed\n')).toThrow('not valid YAML')
  })
})

describe('orgRegistryAllows', () => {
  const registry = parseOrgRegistry(VALID)

  it('allows an edge in the listed direction', () => {
    expect(orgRegistryAllows(registry, 'lead-a', 'lead-b')).toBe(true)
  })

  it('allows an edge against the listed direction (undirected)', () => {
    expect(orgRegistryAllows(registry, 'peer-b', 'lead-b')).toBe(true)
  })

  it('allows any destination for a callUp seat', () => {
    expect(orgRegistryAllows(registry, 'lead-a', 'peer-b')).toBe(true)
  })

  it('refuses an unconnected pair without call-up', () => {
    expect(orgRegistryAllows(registry, 'peer-a', 'peer-b')).toBe(false)
  })

  it('throws on unknown seat names', () => {
    expect(() => orgRegistryAllows(registry, 'ghost', 'lead-a')).toThrow('no seat "ghost"')
  })
})

describe('findOrgRegistryRoute', () => {
  const registry = parseOrgRegistry(VALID)

  it('returns the full shortest path including both endpoints', () => {
    expect(findOrgRegistryRoute(registry, 'peer-a', 'peer-b')).toEqual(['peer-a', 'lead-a', 'lead-b', 'peer-b'])
  })

  it('returns a two-seat path for a direct edge', () => {
    expect(findOrgRegistryRoute(registry, 'lead-a', 'peer-a')).toEqual(['lead-a', 'peer-a'])
  })

  it('returns undefined for an unreachable seat', () => {
    const isolated = parseOrgRegistry('baseDir: /projects\nseats:\n  a: { cwd: one }\n  b: { cwd: two }\n')
    expect(findOrgRegistryRoute(isolated, 'a', 'b')).toBeUndefined()
  })
})

describe('resolveSeatCwd', () => {
  const registry = parseOrgRegistry(VALID, { home: '/home/test' })

  it('joins a relative seat cwd against baseDir', () => {
    expect(resolveSeatCwd(registry, 'lead-a')).toBe('/projects/project-a')
  })

  it('expands a tilde cwd against the parse-time home', () => {
    expect(resolveSeatCwd(registry, 'lead-b')).toBe('/home/test/other/project-b')
  })

  it('throws on an unknown seat', () => {
    expect(() => resolveSeatCwd(registry, 'ghost')).toThrow('no seat "ghost"')
  })
})

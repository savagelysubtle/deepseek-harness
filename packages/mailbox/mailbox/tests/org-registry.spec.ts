/**
 * Org registry: parse validation, topology queries, route finding, cwd
 * resolution, and the write-side primitives (content hashing, atomic
 * whole-document replace with optimistic concurrency, and the YAML
 * round-trip stability the write depends on).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import {
  findOrgRegistryRoute,
  formatMailboxAddress,
  hashOrgRegistryBytes,
  loadOrgRegistryWithToken,
  orgRegistryAllows,
  OrgRegistryConflictError,
  OrgRegistryWriteError,
  parseMailboxAddress,
  parseOrgRegistry,
  isSeatIdentityPinned,
  resolveSeatCwd,
  resolveSeatSessionId,
  writeOrgRegistry,
  yamlErrorFirstLine,
} from '../src/index.ts'
import type { OrgRegistrySeat } from '../src/index.ts'

// Controls for the node:fs/promises mock below, used only by the defect-fix
// tests in 'loadOrgRegistryWithToken and writeOrgRegistry' that must inject a
// filesystem failure no real temp-dir setup can trigger deterministically
// (an EEXIST on every backup attempt; a rename failure whose cleanup also
// fails). Every other test in this file uses the real filesystem untouched —
// the mock below delegates to the real implementation unless a control flag
// is set, and every test that sets one resets it in a `finally`.
const fsControl = vi.hoisted(() => ({
  forceBackupEexist: false,
  forceBackupOtherError: false,
  forceRenameFailure: false,
  forceRmFailure: false,
  forceReadFileNonError: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>): ReturnType<typeof actual.readFile> {
      if (fsControl.forceReadFileNonError) throw 'not an Error instance'
      return actual.readFile(...args)
    },
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      const [path, flags] = args
      if (fsControl.forceBackupEexist && flags === 'wx' && typeof path === 'string' && path.includes('.bak-')) {
        const error = new Error(`EEXIST: file already exists, open '${path}'`) as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      if (fsControl.forceBackupOtherError && flags === 'wx' && typeof path === 'string' && path.includes('.bak-')) {
        throw new Error('simulated backup open failure: permission denied')
      }
      return actual.open(...args)
    },
    async rename(...args: Parameters<typeof actual.rename>): ReturnType<typeof actual.rename> {
      if (fsControl.forceRenameFailure) throw new Error('simulated rename failure: disk full')
      return actual.rename(...args)
    },
    async rm(...args: Parameters<typeof actual.rm>): ReturnType<typeof actual.rm> {
      if (fsControl.forceRmFailure) throw new Error('simulated cleanup failure: permission denied')
      return actual.rm(...args)
    },
  }
})

// Controls for the 'yaml' mock below, used only by the one test that must
// inject a thrown value which is NOT an `Error` instance — the installed
// `yaml` parser only ever throws real `YAMLParseError`s (an `Error`
// subclass), so no malformed-YAML fixture can reach that branch. Every
// other test in this file uses the real parser untouched.
const yamlControl = vi.hoisted(() => ({ forceNonErrorParseThrow: false }))

vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>()
  return {
    ...actual,
    parse(...args: Parameters<typeof actual.parse>): ReturnType<typeof actual.parse> {
      if (yamlControl.forceNonErrorParseThrow) throw 'not an Error instance'
      return actual.parse(...args)
    },
  }
})

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

  it('expands a BARE ~ (no trailing path) to the home directory itself', () => {
    // Quoted: a bare, unquoted `~` is YAML's null literal, not the character.
    const registry = parseOrgRegistry('baseDir: /projects\nseats:\n  solo: { cwd: "~" }\n', { home: '/home/test' })
    expect(registry.seats.solo).toEqual({ cwd: '/home/test' })
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
    ['seats:\n  solo: { cwd: one, test: "yes" }\nbaseDir: /p', 'seats.solo.test'],
    ['seats:\n  solo: { cwd: one }\nbaseDir: /p\nedges: not-a-list', 'edges'],
    ['seats:\n  solo: { cwd: one }\nbaseDir: /p\ncallUp: not-a-list', 'callUp'],
    ['seats:\n  solo: { cwd: one }\nbaseDir: /p\ncallUp: [1]', 'callUp'],
    ['seats:\n  solo: { cwd: one, tools: "everything" }', 'seats.solo.tools'],
    ['seats:\n  solo: { cwd: one, tools: [] }', 'seats.solo.tools'],
    ['seats:\n  solo: { cwd: one, tools: {} }', 'seats.solo.tools'],
    ['seats:\n  solo: { cwd: one, tools: { allow: "bash" } }', 'seats.solo.tools.allow'],
    ['seats:\n  solo: { cwd: one, tools: { allow: [""] } }', 'seats.solo.tools.allow'],
    ['seats:\n  solo: { cwd: one, tools: { allow: [bash, 1] } }', 'seats.solo.tools.allow'],
    ['seats:\n  solo: { cwd: one, tools: { deny: "bash" } }', 'seats.solo.tools.deny'],
    ['seats:\n  solo: { cwd: one, tools: { deny: [""] } }', 'seats.solo.tools.deny'],
    // A PRESENT but empty allow/deny list parses cleanly and silently leaves
    // the seat with zero tools — the same "meaningless as configuration"
    // problem the whole-field guard above catches, one level deeper. Reject
    // it here too, naming both the seat and the specific empty field.
    ['seats:\n  solo: { cwd: one, tools: { allow: [] } }', 'seats.solo.tools.allow'],
    ['seats:\n  solo: { cwd: one, tools: { deny: [] } }', 'seats.solo.tools.deny'],
  ])('rejects %j loudly naming the field', (_document, message) => {
    const document = _document.includes('baseDir') ? _document : `${_document}\nbaseDir: /projects`
    expect(() => parseOrgRegistry(document)).toThrow(message)
  })

  it('rejects a malformed seat department, naming seats.<name>.department', () => {
    const base = 'baseDir: /p\nseats:\n  tt-alpha: { cwd: one, department: '
    const bad: [string, string][] = [
      ['""', 'must be a non-empty string'],
      ['"   "', 'must be a non-empty string'],
      ['7', 'must be a non-empty string'],
      [JSON.stringify('x'.repeat(49)), 'at most 48 characters'],
      [JSON.stringify('Be\u0007ta'), 'must not contain control characters'],
    ]
    for (const [value, wording] of bad) {
      expect(() => parseOrgRegistry(`${base}${value} }\n`)).toThrow('seats.tt-alpha.department')
      expect(() => parseOrgRegistry(`${base}${value} }\n`)).toThrow(wording)
    }
  })

  it('keeps a valid seat department, trimmed, and omits the field when absent', () => {
    const registry = parseOrgRegistry(
      'baseDir: /p\nseats:\n  tt-alpha: { cwd: one, department: Beta }\n  tt-bravo: { cwd: two, department: " Beta " }\n'
      + '  tt-charlie: { cwd: three, department: ' + JSON.stringify('x'.repeat(48)) + ' }\n  tt-delta: { cwd: four }\n',
    )
    expect(registry.seats['tt-alpha']?.department).toBe('Beta')
    expect(registry.seats['tt-bravo']?.department).toBe('Beta')
    expect(registry.seats['tt-charlie']?.department).toBe('x'.repeat(48))
    expect('department' in (registry.seats['tt-delta'] as object)).toBe(false)
  })

  it('rejects edges naming unknown seats, self-edges, and malformed pairs', () => {
    const base = 'baseDir: /projects\nseats:\n  a: { cwd: one }\n  b: { cwd: two }\n'
    expect(() => parseOrgRegistry(`${base}edges:\n  - [a, ghost]\n`)).toThrow('unknown seat "ghost"')
    expect(() => parseOrgRegistry(`${base}edges:\n  - [ghost, a]\n`)).toThrow('unknown seat "ghost"')
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

  it('wraps a non-Error value thrown by the YAML parser in a real Error naming it not valid YAML', () => {
    yamlControl.forceNonErrorParseThrow = true
    try {
      expect(() => parseOrgRegistry('irrelevant')).toThrow('org registry is not valid YAML: not an Error instance')
    } finally {
      yamlControl.forceNonErrorParseThrow = false
    }
  })
})

describe('YAML parse failures never leak the code frame (OP-212)', () => {
  const DUPLICATE_KEY = 'baseDir: /projects\nseats:\n  a: { cwd: one }\napiToken: sk-SECRET-VALUE-1\napiToken: sk-SECRET-VALUE-2\n'

  it('keeps only the first yaml message line when a duplicate key is parsed', () => {
    let caught: unknown
    try {
      parseOrgRegistry(DUPLICATE_KEY)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('org registry is not valid YAML')
    expect(message).toContain('line')
    expect(message).not.toContain('\n')
    expect(message).not.toContain('apiToken')
    expect(message).not.toContain('sk-SECRET')
  })

  it('does not emit a yaml warning (with the source line) for an unknown tag', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      const registry = parseOrgRegistry('baseDir: /projects\nseats:\n  a: { cwd: one }\napiToken: !sk-SECRET-TAG value\n')
      expect(registry.baseDir).toBe('/projects')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('yamlErrorFirstLine trims an Error message to its first line and stringifies a non-Error', () => {
    expect(yamlErrorFirstLine(new Error('first\n  frame line\n  second'))).toBe('first')
    expect(yamlErrorFirstLine('plain value')).toBe('plain value')
    expect(yamlErrorFirstLine('first\rframe SECRET')).toBe('first')
    expect(yamlErrorFirstLine(new Error('first\r\nframe SECRET'))).toBe('first')
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

  it('refuses a sender that matches an edge endpoint when the destination does not match that same edge', () => {
    // 'lead-b' is the "from" end of the [lead-b, peer-b] edge, but 'peer-a'
    // is not its "to" end — the sender-side match alone must not satisfy it.
    expect(orgRegistryAllows(registry, 'lead-b', 'peer-a')).toBe(false)
  })

  it('refuses a recipient that matches an edge endpoint when the sender does not match that same edge', () => {
    // 'lead-b' is the "to" end of the [lead-b, peer-b] edge (reversed), but
    // 'peer-a' is not its "from" end — the recipient-side match alone must
    // not satisfy it.
    expect(orgRegistryAllows(registry, 'peer-a', 'lead-b')).toBe(false)
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

describe('seat identity — recorded beats derived', () => {
  const derive = (name: string): string => `derived-${name}`

  it('returns the recorded sessionId when the registry pins one', () => {
    const registry = parseOrgRegistry(
      'baseDir: /projects\nseats:\n  robin: { cwd: a, sessionId: named-pinned }\nedges: []\n',
      {},
    )
    expect(resolveSeatSessionId(registry, 'robin', derive)).toBe('named-pinned')
    expect(isSeatIdentityPinned(registry, 'robin')).toBe(true)
  })

  it('derives as a bootstrap when no id is recorded yet', () => {
    const registry = parseOrgRegistry('baseDir: /projects\nseats:\n  robin: { cwd: a }\nedges: []\n', {})
    expect(resolveSeatSessionId(registry, 'robin', derive)).toBe('derived-robin')
    expect(isSeatIdentityPinned(registry, 'robin')).toBe(false)
  })

  it('keeps the same identity after a rename — the seat carries its conversation', () => {
    // The whole point: the label moves, the id does not. Deriving from the name
    // would return a different id here and orphan the log.
    const before = parseOrgRegistry(
      'baseDir: /projects\nseats:\n  robin: { cwd: a, sessionId: named-stable }\nedges: []\n',
      {},
    )
    const after = parseOrgRegistry(
      'baseDir: /projects\nseats:\n  nightwing: { cwd: a, sessionId: named-stable }\nedges: []\n',
      {},
    )
    expect(resolveSeatSessionId(after, 'nightwing', derive))
      .toBe(resolveSeatSessionId(before, 'robin', derive))
  })

  it('rejects a blank recorded sessionId rather than treating it as absent', () => {
    expect(() => parseOrgRegistry(
      'baseDir: /projects\nseats:\n  robin: { cwd: a, sessionId: "" }\nedges: []\n', {},
    )).toThrow(/seats\.robin\.sessionId/)
  })

  it('carries the test flag through parsing', () => {
    const registry = parseOrgRegistry(
      'baseDir: /projects\nseats:\n  tt-ping: { cwd: a, test: true }\nedges: []\n', {},
    )
    expect(registry.seats['tt-ping']?.test).toBe(true)
  })
})

describe('seats.tools', () => {
  it('parses an allow rule onto the seat', () => {
    const registry = parseOrgRegistry(
      'baseDir: /projects\nseats:\n  robin: { cwd: a, tools: { allow: [bash, read] } }\n', {},
    )
    expect(registry.seats.robin?.tools).toEqual({ allow: ['bash', 'read'] })
  })

  it('parses a deny rule onto the seat', () => {
    const registry = parseOrgRegistry(
      'baseDir: /projects\nseats:\n  robin: { cwd: a, tools: { deny: [bash] } }\n', {},
    )
    expect(registry.seats.robin?.tools).toEqual({ deny: ['bash'] })
  })

  it('parses allow and deny together', () => {
    const registry = parseOrgRegistry(
      'baseDir: /projects\nseats:\n  robin: { cwd: a, tools: { allow: [bash, read], deny: [write] } }\n', {},
    )
    expect(registry.seats.robin?.tools).toEqual({ allow: ['bash', 'read'], deny: ['write'] })
  })

  it('leaves a seat with no tools field exactly as it parses today — the no-op default', () => {
    const registry = parseOrgRegistry('baseDir: /projects\nseats:\n  solo: { cwd: one }\n')
    expect(registry.seats.solo).toEqual({ cwd: 'one' })
    expect('tools' in (registry.seats.solo as object)).toBe(false)
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

// A realistic multi-seat, multi-edge registry in the EXACT shape
// `indentSeq: false` produces (top-level sequence items align with their own
// key, not indented under it — verified empirically against this repo's
// installed `yaml` version before writing this fixture). This is written by
// hand rather than generated, so the test can actually fail the way a real
// regression would: if a future edit drops `indentSeq: false` from the write
// path, re-stringifying this fixture reformats the whole `edges`/`callUp`
// blocks and the byte-identical assertion below catches it.
const ROUND_TRIP_FIXTURE = `baseDir: /home/steve/dsh/org
seats:
  alfred:
    cwd: deepseek-harness
    lead: true
  batman:
    cwd: deepseek-harness
  robin:
    cwd: deepseek-harness
    sessionId: named-robin
  tt-ping:
    cwd: deepseek-harness
    test: true
  yoda:
    cwd: deepseek-harness
    lead: true
    tools:
      allow:
      - bash
      - read
edges:
- - alfred
  - batman
- - alfred
  - robin
- - yoda
  - tt-ping
callUp:
- alfred
- yoda
`

describe('YAML round-trip stability (indentSeq: false)', () => {
  // The established fact writeOrgRegistry relies on: reading the real
  // registry's shape and re-stringifying it is byte-identical ONLY with
  // `indentSeq: false`. Without it the whole edges/callUp block reformats —
  // pure whitespace churn on every single write. This is the regression
  // guard the brief asked for: it can never silently regress unnoticed.
  it('reproduces the fixture exactly via parse + stringify(..., { indentSeq: false })', () => {
    expect(stringifyYaml(parseYaml(ROUND_TRIP_FIXTURE), { indentSeq: false })).toBe(ROUND_TRIP_FIXTURE)
  })

  it('reproduces the fixture exactly via parseDocument(...).toString({ indentSeq: false })', () => {
    expect(parseDocument(ROUND_TRIP_FIXTURE).toString({ indentSeq: false })).toBe(ROUND_TRIP_FIXTURE)
  })

  it('is NOT byte-identical without the option — proves the option is load-bearing, not incidental', () => {
    expect(stringifyYaml(parseYaml(ROUND_TRIP_FIXTURE))).not.toBe(ROUND_TRIP_FIXTURE)
  })
})

describe('hashOrgRegistryBytes', () => {
  it('computes sha256 hex of the exact bytes given (pinned vectors)', () => {
    expect(hashOrgRegistryBytes(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(hashOrgRegistryBytes(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('changes when the bytes change and repeats for identical bytes', () => {
    const a = hashOrgRegistryBytes(Buffer.from('one'))
    const b = hashOrgRegistryBytes(Buffer.from('two'))
    const aAgain = hashOrgRegistryBytes(Buffer.from('one'))
    expect(a).not.toBe(b)
    expect(a).toBe(aAgain)
  })
})

describe('loadOrgRegistryWithToken and writeOrgRegistry', () => {
  let dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  function tempRegistryDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-org-registry-write-'))
    dirs.push(dir)
    return dir
  }

  /** A minimal valid registry document, written under `dir` with default fields for `seats`. */
  function seedRegistry(dir: string, seats: Record<string, { cwd?: string }> = { solo: {} }): string {
    const path = join(dir, 'registry.yml')
    const document = {
      baseDir: dir,
      seats: Object.fromEntries(Object.entries(seats).map(([name, seat]) => [name, { cwd: seat.cwd ?? '.' }])),
      edges: [],
      callUp: [],
    }
    writeFileSync(path, stringifyYaml(document, { indentSeq: false }))
    return path
  }

  it('reads, validates, and hashes a real file in one pass, matching hashOrgRegistryBytes of its raw bytes', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const { registry, token } = await loadOrgRegistryWithToken(path)
    expect(Object.keys(registry.seats)).toEqual(['alfred'])
    expect(token).toBe(hashOrgRegistryBytes(readFileSync(path)))
  })

  it('round-trips every seat department through write and re-read', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { 'tt-alpha': {} })
    const before = await loadOrgRegistryWithToken(path)
    await writeOrgRegistry(path, {
      baseDir: dir,
      seats: {
        'tt-alpha': { cwd: '.', department: 'Gotham' },
        'tt-bravo': { cwd: '.', department: 'Temple' },
        'tt-charlie': { cwd: '.' },
      },
      edges: [],
      callUp: [],
    }, before.token)
    const after = await loadOrgRegistryWithToken(path)
    expect(after.registry.seats['tt-alpha']?.department).toBe('Gotham')
    expect(after.registry.seats['tt-bravo']?.department).toBe('Temple')
    expect('department' in (after.registry.seats['tt-charlie'] as object)).toBe(false)
  })

  it('writes a valid document and returns a new token that differs from the one it replaced', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const before = await loadOrgRegistryWithToken(path)
    const nextDocument = {
      baseDir: dir,
      seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } },
      edges: [['alfred', 'batman']],
      callUp: [],
    }
    const result = await writeOrgRegistry(path, nextDocument, before.token)
    expect(result.token).not.toBe(before.token)
    expect(Object.keys(result.registry.seats).sort()).toEqual(['alfred', 'batman'])
    // The file on disk actually changed, and re-reading it agrees with the write's own report.
    const after = await loadOrgRegistryWithToken(path)
    expect(after.token).toBe(result.token)
    expect(Object.keys(after.registry.seats).sort()).toEqual(['alfred', 'batman'])
  })

  it('refuses with OrgRegistryConflictError when expectedToken no longer matches the file, and writes nothing', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const originalBytes = readFileSync(path)
    const staleToken = 'not-the-real-token'
    const nextDocument = { baseDir: dir, seats: { alfred: { cwd: '.' } }, edges: [], callUp: [] }
    let caught: unknown
    try {
      await writeOrgRegistry(path, nextDocument, staleToken)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OrgRegistryConflictError)
    const conflict = caught as InstanceType<typeof OrgRegistryConflictError>
    expect(conflict.expectedToken).toBe(staleToken)
    expect(conflict.actualToken).toBe(hashOrgRegistryBytes(originalBytes))
    // Never touched — same bytes, no temp file, no backup.
    expect(readFileSync(path)).toEqual(originalBytes)
    expect(readdirSync(dir)).toEqual(['registry.yml'])
  })

  it('refuses an invalid document (reusing the parser\'s own message) and writes nothing', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const originalBytes = readFileSync(path)
    const { token } = await loadOrgRegistryWithToken(path)
    const invalidDocument = {
      baseDir: dir,
      seats: { alfred: { cwd: '.' } },
      edges: [['alfred', 'ghost']],
      callUp: [],
    }
    await expect(writeOrgRegistry(path, invalidDocument, token)).rejects.toThrow('unknown seat "ghost"')
    expect(readFileSync(path)).toEqual(originalBytes)
    expect(readdirSync(dir)).toEqual(['registry.yml'])
  })

  it('takes a timestamped backup of the previous content before replacing it', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const originalBytes = readFileSync(path)
    const { token } = await loadOrgRegistryWithToken(path)
    const nextDocument = { baseDir: dir, seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } }, edges: [], callUp: [] }
    await writeOrgRegistry(path, nextDocument, token)
    const entries = readdirSync(dir)
    const backups = entries.filter(name => name.startsWith('registry.yml.bak-'))
    expect(backups).toHaveLength(1)
    const backupName = backups[0]
    if (backupName === undefined) throw new Error('unreachable')
    expect(readFileSync(join(dir, backupName))).toEqual(originalBytes)
  })

  it('serializes the written document with indentSeq: false (matches the fixture round-trip shape)', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const { token } = await loadOrgRegistryWithToken(path)
    const nextDocument = {
      baseDir: dir,
      seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } },
      edges: [['alfred', 'batman']],
      callUp: ['alfred'],
    }
    await writeOrgRegistry(path, nextDocument, token)
    const written = readFileSync(path, 'utf8')
    expect(written).toBe(stringifyYaml(nextDocument, { indentSeq: false }))
  })

  it('throws OrgRegistryWriteError — never a plain validation Error, never OrgRegistryConflictError — for an I/O failure unrelated to document content', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const { token } = await loadOrgRegistryWithToken(path)
    // The file vanishes between the caller's read and its write — nothing to
    // do with the proposed document, which is perfectly valid.
    rmSync(path)
    const validDocument = { baseDir: dir, seats: { alfred: { cwd: '.' } }, edges: [], callUp: [] }
    let caught: unknown
    try {
      await writeOrgRegistry(path, validDocument, token)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OrgRegistryWriteError)
    expect(caught).not.toBeInstanceOf(OrgRegistryConflictError)
    expect((caught as Error).message).toContain('could not be read for the concurrency check')
    // A caller distinguishing on instanceof/code must be told "retry this
    // same document," never "fix your content" — the document was fine.
  })

  it('wraps a non-Error cause in the write-time concurrency-check read failure message', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const { token } = await loadOrgRegistryWithToken(path)
    const validDocument = { baseDir: dir, seats: { alfred: { cwd: '.' } }, edges: [], callUp: [] }

    fsControl.forceReadFileNonError = true
    let caught: unknown
    try {
      await writeOrgRegistry(path, validDocument, token)
    } catch (error: unknown) {
      caught = error
    } finally {
      fsControl.forceReadFileNonError = false
    }
    expect(caught).toBeInstanceOf(OrgRegistryWriteError)
    expect((caught as Error).message).toContain('could not be read for the concurrency check')
    expect((caught as Error).message).toContain('not an Error instance')
  })

  it('throws OrgRegistryWriteError immediately, without retrying filenames, on a non-EEXIST backup failure', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const originalBytes = readFileSync(path)
    const { token } = await loadOrgRegistryWithToken(path)
    const nextDocument = { baseDir: dir, seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } }, edges: [], callUp: [] }

    fsControl.forceBackupOtherError = true
    let caught: unknown
    try {
      await writeOrgRegistry(path, nextDocument, token)
    } catch (error: unknown) {
      caught = error
    } finally {
      fsControl.forceBackupOtherError = false
    }
    expect(caught).toBeInstanceOf(OrgRegistryWriteError)
    const message = (caught as Error).message
    expect(message).toContain('could not write a backup of its previous content')
    expect(message).toContain('simulated backup open failure')
    // Refused on the first attempt — never fell through to treat the
    // unrelated failure as an EEXIST collision to retry past.
    expect(readFileSync(path)).toEqual(originalBytes)
    expect(readdirSync(dir)).toEqual(['registry.yml'])
  })

  it('never silently destroys a previous backup when two writes land in the same millisecond timestamp — it disambiguates instead', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const originalBytes = readFileSync(path)
    const { token: token1 } = await loadOrgRegistryWithToken(path)

    const isoSpy = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-01-01T00:00:00.000Z')
    try {
      const docA = { baseDir: dir, seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } }, edges: [], callUp: [] }
      const first = await writeOrgRegistry(path, docA, token1)
      const afterFirstBytes = readFileSync(path)

      const docB = { baseDir: dir, seats: { alfred: { cwd: '.' }, batman: { cwd: '.' }, robin: { cwd: '.' } }, edges: [], callUp: [] }
      await writeOrgRegistry(path, docB, first.token)

      const backups = readdirSync(dir).filter(name => name.startsWith('registry.yml.bak-'))
      // Two writes, two backups — never one overwriting the other, even
      // though both computed the identical millisecond-granular timestamp.
      expect(backups).toHaveLength(2)
      expect(new Set(backups).size).toBe(2)

      const withoutSuffix = backups.find(name => !name.endsWith('-1'))
      const withSuffix = backups.find(name => name.endsWith('-1'))
      if (withoutSuffix === undefined || withSuffix === undefined) throw new Error('unreachable')
      // The first write's backup preserves the ORIGINAL content untouched...
      expect(readFileSync(join(dir, withoutSuffix))).toEqual(originalBytes)
      // ...and the second write's backup preserves what was on disk just
      // before IT ran (the first write's output), not a clobbered original.
      expect(readFileSync(join(dir, withSuffix))).toEqual(afterFirstBytes)
    } finally {
      isoSpy.mockRestore()
    }
  })

  it('throws OrgRegistryWriteError loudly, never proceeding without a backup, when no free backup filename can be found', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const originalBytes = readFileSync(path)
    const { token } = await loadOrgRegistryWithToken(path)
    const nextDocument = { baseDir: dir, seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } }, edges: [], callUp: [] }

    fsControl.forceBackupEexist = true
    let caught: unknown
    try {
      await writeOrgRegistry(path, nextDocument, token)
    } catch (error: unknown) {
      caught = error
    } finally {
      fsControl.forceBackupEexist = false
    }
    expect(caught).toBeInstanceOf(OrgRegistryWriteError)
    expect((caught as Error).message).toMatch(/could not find a free backup filename/)
    // Refused loudly before ever reaching the atomic write — the source file
    // is exactly as it was, no partial or backup-less write landed.
    expect(readFileSync(path)).toEqual(originalBytes)
    expect(readdirSync(dir)).toEqual(['registry.yml'])
  })

  it('never lets a cleanup failure after a failed atomic write mask the original write error', async () => {
    const dir = tempRegistryDir()
    const path = seedRegistry(dir, { alfred: {} })
    const { token } = await loadOrgRegistryWithToken(path)
    const nextDocument = { baseDir: dir, seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } }, edges: [], callUp: [] }

    fsControl.forceRenameFailure = true
    fsControl.forceRmFailure = true
    try {
      let caught: unknown
      try {
        await writeOrgRegistry(path, nextDocument, token)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(OrgRegistryWriteError)
      const message = (caught as Error).message
      // The rename failure — the actual reason the write failed — must be
      // what the caller sees...
      expect(message).toContain('simulated rename failure')
      // ...never masked by the unrelated failure of the best-effort temp-file
      // cleanup that ran afterward.
      expect(message).not.toContain('simulated cleanup failure')
    } finally {
      fsControl.forceRenameFailure = false
      fsControl.forceRmFailure = false
    }
  })
})

describe('seat driver fields and quarantine (OP #292 S3)', () => {
  let dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  /** A temp dir that is provably under the OS temp root, never the live ~/.dsh. */
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-org-registry-driver-'))
    expect(dir.startsWith(tmpdir())).toBe(true)
    dirs.push(dir)
    return dir
  }

  /** Block-style registry text (the live registry's style) with the given extra seat YAML. */
  function blockRegistry(extraSeats: string): string {
    return [
      'baseDir: /projects',
      'seats:',
      '  alfred:',
      '    cwd: alfred',
      '    department: ops',
      '    sessionId: named-alfred',
      '  batman:',
      '    cwd: batman',
      '    test: true',
      extraSeats,
      'edges:',
      '  - [alfred, batman]',
      'callUp: []',
      '',
    ].join('\n')
  }

  const CC_ROW = [
    '  claudie:',
    '    cwd: claudie',
    '    driver: claude-code',
    '    sessionId: named-claudie',
    '    admit_from: [alfred]',
    '    admit_sender_classes: [seat]',
  ].join('\n')

  function seatOf(text: string, name: string, strictSeats?: boolean): OrgRegistrySeat {
    const seat = parseOrgRegistry(text, strictSeats === undefined ? {} : { strictSeats }).seats[name]
    if (seat === undefined) throw new Error(`no seat ${name}`)
    return seat
  }

  it('parses a registry without any driver field to exactly the pre-change objects', () => {
    const registry = parseOrgRegistry(blockRegistry(''))
    expect(registry).toEqual({
      baseDir: '/projects',
      seats: {
        alfred: { cwd: 'alfred', department: 'ops', sessionId: 'named-alfred' },
        batman: { cwd: 'batman', test: true },
      },
      edges: [['alfred', 'batman']],
      callUp: [],
    })
    expect(Object.keys(registry.seats.alfred ?? {})).toEqual(['cwd', 'sessionId', 'department'])
    expect(parseOrgRegistry(VALID).seats['lead-a']).toEqual({ cwd: 'project-a', lead: true })
  })

  it('still drops unknown keys on a default seat, as before', () => {
    expect(seatOf('baseDir: /p\nseats:\n  solo: { cwd: one, colour: red }\n', 'solo')).toEqual({ cwd: 'one' })
  })

  it('accepts a claude-code row carrying only driver and admission fields (block style)', () => {
    const seat = seatOf(blockRegistry(CC_ROW), 'claudie', true)
    expect(seat).toEqual({
      cwd: 'claudie',
      sessionId: 'named-claudie',
      driver: 'claude-code',
      admit_from: ['alfred'],
      admit_sender_classes: ['seat'],
    })
    expect(seat.invalid).toBeUndefined()
  })

  it('accepts the same row in flow style', () => {
    const text = 'baseDir: /p\nseats:\n  alfred: { cwd: a }\n  claudie: { cwd: c, driver: claude-code, admit_from: [alfred], admit_sender_classes: [seat, unverified] }\n'
    expect(seatOf(text, 'claudie', true)).toEqual({
      cwd: 'c', driver: 'claude-code', admit_from: ['alfred'], admit_sender_classes: ['seat', 'unverified'],
    })
  })

  it('accepts an explicit driver: default row and keeps it', () => {
    expect(seatOf('baseDir: /p\nseats:\n  solo: { cwd: one, driver: default }\n', 'solo', true)).toEqual({ cwd: 'one', driver: 'default' })
  })

  it('parses an empty admit_from as nobody (kept as an empty list, not dropped)', () => {
    const text = 'baseDir: /p\nseats:\n  alfred: { cwd: a }\n  claudie: { cwd: c, driver: claude-code, admit_from: [] }\n'
    const seat = seatOf(text, 'claudie', true)
    expect(seat.admit_from).toEqual([])
    expect(seat.invalid).toBeUndefined()
  })

  const QUARANTINE_CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['a claude_code block', '    claude_code: { model: haiku }', 'claude_code belongs in host config'],
    ['model', '    model: haiku', 'model belongs in host config'],
    ['effort', '    effort: high', 'effort belongs in host config'],
    ['role', '    role: mail-only', 'role belongs in host config'],
    ['claude_path', '    claude_path: /usr/bin/claude', 'claude_path belongs in host config'],
    ['claude_path_sha256', '    claude_path_sha256: abc', 'claude_path_sha256 belongs in host config'],
    ['fable_ok', '    fable_ok: true', 'fable_ok belongs in host config'],
    ['call_window_ms', '    call_window_ms: 1000', 'call_window_ms belongs in host config'],
    ['max_turns', '    max_turns: 3', 'max_turns belongs in host config'],
    ['max_budget_usd', '    max_budget_usd: 1', 'max_budget_usd belongs in host config'],
    ['an unknown key', '    colour: red', 'unknown key "colour" on a claude-code seat'],
    ['an unknown class', '    admit_sender_classes: [seat, guest]', 'admit_sender_classes entry "guest" is not one of seat, unverified'],
    ['a non-list admit_sender_classes', '    admit_sender_classes: seat', 'admit_sender_classes must be a list of sender classes'],
    ['a non-list admit_from', '    admit_from: alfred', 'admit_from must be a list of seat names'],
    ['a blank admit_from entry', '    admit_from: [alfred, " "]', 'admit_from must be a list of seat names'],
    ['an admit_from naming a non-seat', '    admit_from: [ghost]', 'admit_from names "ghost", which is not a roster seat'],
    ['an unknown driver', '    driver: codex', 'driver "codex" is not one of default, claude-code'],
  ]

  describe.each(QUARANTINE_CASES)('a row with %s', (_label, extraLine, reason) => {
    // Rows set exactly one bad thing; the unknown-driver and bad admit_* cases
    // replace the matching line from the base row rather than duplicating a key.
    function rowWith(): string {
      const key = extraLine.trim().split(':')[0] ?? ''
      const lines = CC_ROW.split('\n').filter(line => !line.trim().startsWith(`${key}:`))
      return [...lines, extraLine].join('\n')
    }

    it('quarantines only that seat, drops its driver fields and keeps the others valid', () => {
      const registry = parseOrgRegistry(blockRegistry(rowWith()))
      const seat = registry.seats.claudie
      expect(seat?.invalid).toBe(reason)
      expect(seat?.driver).toBeUndefined()
      expect(seat?.admit_from).toBeUndefined()
      expect(seat?.admit_sender_classes).toBeUndefined()
      expect(seat?.cwd).toBe('claudie')
      expect(registry.seats.alfred).toEqual({ cwd: 'alfred', department: 'ops', sessionId: 'named-alfred' })
      expect(registry.seats.batman).toEqual({ cwd: 'batman', test: true })
    })

    it('throws under strictSeats, naming the seat and the reason', () => {
      expect(() => parseOrgRegistry(blockRegistry(rowWith()), { strictSeats: true })).toThrow(
        `org registry seat "claudie" is invalid: ${reason}`,
      )
    })
  })

  it('quarantines admit_from and admit_sender_classes on a default seat', () => {
    for (const [line, key] of [['admit_from: [alfred]', 'admit_from'], ['admit_sender_classes: [seat]', 'admit_sender_classes']] as const) {
      const text = `baseDir: /p\nseats:\n  alfred: { cwd: a }\n  solo: { cwd: one, ${line} }\n`
      expect(seatOf(text, 'solo').invalid).toBe(`${key} requires driver "claude-code"`)
      expect(() => parseOrgRegistry(text, { strictSeats: true })).toThrow(`${key} requires driver "claude-code"`)
    }
  })

  it('quarantines a cost or trust key on a default seat too', () => {
    expect(seatOf('baseDir: /p\nseats:\n  solo: { cwd: one, claude_path: /x }\n', 'solo').invalid).toBe(
      'claude_path belongs in host config',
    )
  })

  it('quarantines both rows when two seats share a sessionId and one is claude-code (A2)', () => {
    const text = [
      'baseDir: /p',
      'seats:',
      '  alfred: { cwd: a, sessionId: shared-1 }',
      '  claudie: { cwd: c, driver: claude-code, sessionId: shared-1, admit_from: [alfred] }',
      '  other: { cwd: o, sessionId: unique-1 }',
      '',
    ].join('\n')
    const registry = parseOrgRegistry(text)
    expect(registry.seats.alfred?.invalid).toBe('sessionId shared with seat claudie')
    expect(registry.seats.claudie?.invalid).toBe('sessionId shared with seat alfred')
    expect(registry.seats.claudie?.driver).toBeUndefined()
    expect(registry.seats.other).toEqual({ cwd: 'o', sessionId: 'unique-1' })
    expect(() => parseOrgRegistry(text, { strictSeats: true })).toThrow('sessionId shared with seat')
  })

  it('leaves two default seats that share a sessionId exactly as before', () => {
    const registry = parseOrgRegistry('baseDir: /p\nseats:\n  a: { cwd: a, sessionId: s }\n  b: { cwd: b, sessionId: s }\n')
    expect(registry.seats.a?.invalid).toBeUndefined()
    expect(registry.seats.b?.invalid).toBeUndefined()
  })

  describe('writeOrgRegistry', () => {
    it('refuses a document whose claude-code row would be quarantined, before touching the file', async () => {
      const dir = tempDir()
      const path = join(dir, 'registry.yml')
      writeFileSync(path, blockRegistry(''))
      const { token } = await loadOrgRegistryWithToken(path)
      const before = readFileSync(path, 'utf8')
      const document = parseYaml(blockRegistry(CC_ROW)) as { seats: Record<string, Record<string, unknown>> }
      const claudie = document.seats.claudie
      if (claudie === undefined) throw new Error('fixture lost claudie')
      claudie.claude_path = '/usr/bin/claude'
      await expect(writeOrgRegistry(path, document, token)).rejects.toThrow('claude_path belongs in host config')
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(readdirSync(dir).filter(name => name.includes('.bak-'))).toEqual([])
    })

    it('writes a valid claude-code row and reads it back with its fields', async () => {
      const dir = tempDir()
      const path = join(dir, 'registry.yml')
      writeFileSync(path, blockRegistry(''))
      const { token } = await loadOrgRegistryWithToken(path)
      const { registry } = await writeOrgRegistry(path, parseYaml(blockRegistry(CC_ROW)) as object, token)
      expect(registry.seats.claudie?.driver).toBe('claude-code')
      const reread = (await loadOrgRegistryWithToken(path)).registry
      expect(reread.seats.claudie).toEqual({
        cwd: 'claudie', sessionId: 'named-claudie', driver: 'claude-code', admit_from: ['alfred'], admit_sender_classes: ['seat'],
      })
    })

    it('round-trips a block-style registry with a claude-code row byte-identically', () => {
      const text = [
        'baseDir: /projects',
        'seats:',
        '  alfred:',
        '    cwd: alfred',
        '  claudie:',
        '    cwd: claudie',
        '    driver: claude-code',
        '    admit_from:',
        '    - alfred',
        '    admit_sender_classes:',
        '    - seat',
        'edges:',
        '- - alfred',
        '  - claudie',
        'callUp: []',
        '',
      ].join('\n')
      expect(stringifyYaml(parseYaml(text), { indentSeq: false })).toBe(text)
      expect(parseOrgRegistry(text, { strictSeats: true }).seats.claudie?.admit_from).toEqual(['alfred'])
    })
  })
})

describe('seat owns (OP-115 advisory territory)', () => {
  const PLAIN = 'baseDir: /p\nseats:\n  alfred: { cwd: a }\n  batman: { cwd: b }\n'

  function ownsRegistry(ownsYaml: string, driver = ''): string {
    return `baseDir: /p\nseats:\n  alfred: { cwd: a }\n  batman: { cwd: b${driver}, owns: ${ownsYaml} }\n`
  }

  it('parses owns and keeps the list in order, trimmed', () => {
    const registry = parseOrgRegistry(ownsRegistry('["src/**", " docs/*.md ", "/mnt/Dev/Coding/x/**"]'))
    expect(registry.seats.batman?.owns).toEqual(['src/**', 'docs/*.md', '/mnt/Dev/Coding/x/**'])
  })

  it('a registry without owns parses to exactly the pre-change objects (no owns key)', () => {
    const registry = parseOrgRegistry(PLAIN)
    expect(registry).toEqual({
      baseDir: '/p',
      seats: { alfred: { cwd: 'a' }, batman: { cwd: 'b' } },
      edges: [],
      callUp: [],
    })
    expect('owns' in (registry.seats.batman as object)).toBe(false)
  })

  it('does NOT quarantine a claude-code seat carrying owns, even under strict parsing', () => {
    const text = ownsRegistry('["src/**"]', ', driver: claude-code')
    for (const strictSeats of [false, true]) {
      const seat = parseOrgRegistry(text, { strictSeats }).seats.batman
      expect(seat?.invalid).toBeUndefined()
      expect(seat?.driver).toBe('claude-code')
      expect(seat?.owns).toEqual(['src/**'])
    }
  })

  const BAD_CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['an empty string entry', '[""]', 'must be a list of non-empty strings'],
    ['a whitespace-only entry', '["  "]', 'must be a list of non-empty strings'],
    ['a non-string entry', '[3]', 'must be a list of non-empty strings'],
    ['a scalar instead of a list', '"src/**"', 'must be a list of non-empty strings'],
    ['a mapping instead of a list', '{ a: 1 }', 'must be a list of non-empty strings'],
    ['an empty list', '[]', 'must not be an empty list'],
    ['a leading .. segment', '["../x/**"]', 'must not contain a ".." segment'],
    ['an inner .. segment', '["a/../b"]', 'must not contain a ".." segment'],
    ['a .. segment in an absolute path', '["/mnt/Dev/Coding/../etc/**"]', 'must not contain a ".." segment'],
    ['an absolute path outside /mnt/Dev/Coding', '["/etc/**"]', 'is absolute and outside /mnt/Dev/Coding'],
    ['a sibling-prefixed absolute path', '["/mnt/Dev/CodingX/**"]', 'is absolute and outside /mnt/Dev/Coding'],
  ]

  it.each(BAD_CASES)('rejects %s with a visible message naming the seat and field', (_name, ownsYaml, message) => {
    expect(() => parseOrgRegistry(ownsRegistry(ownsYaml))).toThrow(message)
    expect(() => parseOrgRegistry(ownsRegistry(ownsYaml))).toThrow('seats.batman.owns')
    // Same on a claude-code seat: a bad pattern is a hard error, not a silent quarantine.
    expect(() => parseOrgRegistry(ownsRegistry(ownsYaml, ', driver: claude-code'))).toThrow(message)
  })

  it('accepts the absolute root itself and a nested absolute path', () => {
    expect(parseOrgRegistry(ownsRegistry('["/mnt/Dev/Coding", "/mnt/Dev/Coding/a/b/*.ts"]')).seats.batman?.owns)
      .toEqual(['/mnt/Dev/Coding', '/mnt/Dev/Coding/a/b/*.ts'])
  })

  it('round-trips through YAML parse -> stringify -> parse unchanged', () => {
    const text = ownsRegistry('["src/**", "docs/*.md"]')
    const first = parseOrgRegistry(text)
    const rewritten = stringifyYaml(
      { baseDir: first.baseDir, seats: first.seats, edges: first.edges, callUp: first.callUp },
      { indentSeq: false },
    )
    expect(parseOrgRegistry(rewritten)).toEqual(first)
    expect(stringifyYaml(parseYaml(rewritten), { indentSeq: false })).toBe(rewritten)
  })

  it('writeOrgRegistry keeps owns on disk and a re-read returns it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-org-owns-'))
    try {
      const path = join(dir, 'registry.yml')
      writeFileSync(path, stringifyYaml({ baseDir: dir, seats: { alfred: { cwd: '.' } } }, { indentSeq: false }))
      const before = await loadOrgRegistryWithToken(path)
      await writeOrgRegistry(path, {
        baseDir: dir,
        seats: { alfred: { cwd: '.', owns: ['src/**'] }, claudie: { cwd: '.', driver: 'claude-code', owns: ['/mnt/Dev/Coding/x/**'] } },
        edges: [],
        callUp: [],
      }, before.token)
      const after = await loadOrgRegistryWithToken(path)
      expect(after.registry.seats.alfred?.owns).toEqual(['src/**'])
      expect(after.registry.seats.claudie?.owns).toEqual(['/mnt/Dev/Coding/x/**'])
      expect(after.registry.seats.claudie?.invalid).toBeUndefined()
      expect(readFileSync(path, 'utf8')).toContain('owns:')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

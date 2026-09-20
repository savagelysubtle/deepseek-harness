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
} from '../src/index.ts'

// Controls for the node:fs/promises mock below, used only by the defect-fix
// tests in 'loadOrgRegistryWithToken and writeOrgRegistry' that must inject a
// filesystem failure no real temp-dir setup can trigger deterministically
// (an EEXIST on every backup attempt; a rename failure whose cleanup also
// fails). Every other test in this file uses the real filesystem untouched —
// the mock below delegates to the real implementation unless a control flag
// is set, and every test that sets one resets it in a `finally`.
const fsControl = vi.hoisted(() => ({
  forceBackupEexist: false,
  forceRenameFailure: false,
  forceRmFailure: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      const [path, flags] = args
      if (fsControl.forceBackupEexist && flags === 'wx' && typeof path === 'string' && path.includes('.bak-')) {
        const error = new Error(`EEXIST: file already exists, open '${path}'`) as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
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

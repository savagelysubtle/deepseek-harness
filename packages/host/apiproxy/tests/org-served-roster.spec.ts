/**
 * Server-side WRITE support for the two served-roster mounts
 * (`mailbox-bridge`, `tool-mailbox`) inside a profile's `cordis.patch.yml`:
 * content-token concurrency, the split-agreement guard, both-or-neither
 * replacement, YAML round-trip stability, and the atomic write's backup and
 * failure paths. Fixtures are a SYNTHETIC document reproducing the real
 * file's structure (7 top-level entries, one shared `insert` list holding
 * `mailbox`/`mailbox-local`/`mailbox-bridge`/`tool-mailbox`) with PLACEHOLDER
 * seat names — never the operator's real roster — over real tmp
 * directories, since both methods touch the filesystem directly.
 */

import {
  mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  buildNextServedRosterPatches,
  findOrgMountAddresses,
  hashOrgServedRosterBytes,
  OrgServedRosterConflictError,
  OrgServedRosterSplitError,
  OrgServedRosterWriteError,
  readOrgProfilePatchesWithToken,
  writeOrgServedRoster,
} from '../src/org-served-roster.ts'

// Controls for the node:fs/promises mock below, used only by the
// rename-failure test, which needs a filesystem failure no real temp-dir
// setup can trigger deterministically. Every other test in this file uses
// the real filesystem untouched — same precedent as
// packages/mailbox/mailbox/tests/org-registry.spec.ts.
const fsControl = vi.hoisted(() => ({ forceRenameFailure: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rename(...args: Parameters<typeof actual.rename>): ReturnType<typeof actual.rename> {
      if (fsControl.forceRenameFailure) throw new Error('simulated rename failure: disk full')
      return actual.rename(...args)
    },
  }
})

const MOUNT_IDS: readonly [string, string] = ['mailbox-bridge', 'tool-mailbox']

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-served-roster-'))
  dirs.push(dir)
  return dir
}

/** One filler top-level mcp-client mount entry — real-shaped, contentless. */
function fillerMcpEntry(id: string): unknown {
  return { insert: [{ id, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: id, transport: 'stdio', command: 'true' } }] }
}

/**
 * A synthetic document reproducing the REAL profile patch file's structure:
 * 7 top-level entries, with `mailbox`/`mailbox-local`/`mailbox-bridge`/
 * `tool-mailbox` sharing the LAST entry's `insert` list — but placeholder
 * seat names, never the operator's real roster.
 */
function realShapedPatches(bridgeAddresses: readonly string[], toolAddresses: readonly string[]): unknown[] {
  return [
    fillerMcpEntry('mcp-fixture-one'),
    fillerMcpEntry('mcp-fixture-two'),
    fillerMcpEntry('mcp-fixture-three'),
    fillerMcpEntry('mcp-fixture-four'),
    fillerMcpEntry('mcp-fixture-five'),
    fillerMcpEntry('mcp-fixture-six'),
    {
      insert: [
        { id: 'mailbox', name: '@deepseek-ai/dsh-mailbox', config: { defaultProvider: 'local' } },
        { id: 'mailbox-local', name: '@deepseek-ai/dsh-mailbox-local' },
        {
          id: 'mailbox-bridge',
          name: '@deepseek-ai/dsh-mailbox-bridge',
          config: {
            addresses: [...bridgeAddresses],
            pollIntervalMs: 5000,
            residencyIdleMs: 600000,
            admitFrom: ['operator'],
          },
        },
        {
          id: 'tool-mailbox',
          name: '@deepseek-ai/dsh-tool-mailbox',
          config: { addresses: [...toolAddresses] },
        },
      ],
    },
  ]
}

/** Writes a real-shaped `cordis.patch.yml` under `dir`; defaults both mounts to the same list (agreeing). */
function writeProfile(
  dir: string,
  bridgeAddresses: readonly string[],
  toolAddresses: readonly string[] = bridgeAddresses,
): string {
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, stringifyYaml(realShapedPatches(bridgeAddresses, toolAddresses), { indentSeq: false, singleQuote: true }))
  return path
}

async function currentToken(path: string): Promise<string> {
  const read = await readOrgProfilePatchesWithToken(path)
  if (!read.ok) throw new Error(`unreachable: fixture profile at ${path} unreadable: ${read.reason}`)
  return read.token
}

/**
 * Splits raw YAML text into one block per top-level list item, at each
 * column-0 `- ` dash — used to compare ACTUAL BYTES of unrelated top-level
 * patch entries before/after a write, rather than their parsed structure
 * (which would miss a silent reformat that preserves parsed meaning).
 */
function splitByColumnZeroDash(text: string): string[] {
  return splitByDashAt(text, /^- /gm)
}

/** Same idea one nesting level down: a two-space-indented nested list's items. */
function splitByTwoSpaceDash(text: string): string[] {
  return splitByDashAt(text, /^ {2}- /gm)
}

function splitByDashAt(text: string, marker: RegExp): string[] {
  const starts: number[] = []
  for (const match of text.matchAll(marker)) starts.push(match.index)
  starts.push(text.length)
  const blocks: string[] = []
  for (let index = 0; index < starts.length - 1; index++) {
    const start = starts[index]
    const end = starts[index + 1]
    if (start === undefined || end === undefined) continue
    blocks.push(text.slice(start, end))
  }
  return blocks
}

/**
 * Blanks out one mount item's `addresses:` list (the only field a served-
 * roster write is allowed to change) so the rest of the item's raw bytes —
 * every other key, in its original order and formatting — can be compared
 * directly.
 */
function withAddressesBlanked(itemText: string): string {
  return itemText.replace(/addresses:\n(?: {6}- .*\n)+/, 'addresses:\n<<REDACTED>>\n')
}

// A hand-verified fixture in the EXACT shape `stringifyYaml(doc, {
// indentSeq: false, singleQuote: true })` produces for this repo's `yaml`
// version, AND in the style the REAL profile file is hand-authored in:
// single-quoted package names. That detail is the whole point. This fixture
// was originally written with DOUBLE quotes -- the serializer's own default
// output -- which made the round-trip assertion below pass trivially and
// unable to fail. The real file uses single quotes, so the first save through
// the board reformatted 10 of its lines, none of them the addresses the write
// was meant to touch. Build this fixture in the serializer's output style
// again and the test goes back to proving nothing.
// (confirmed empirically before writing this fixture, same precedent as
// ROUND_TRIP_FIXTURE in packages/mailbox/mailbox/tests/org-registry.spec.ts)
// — written by hand rather than generated at test time, so the round-trip
// assertion below can actually fail the way a real regression would: if a
// future edit drops `indentSeq: false` from the write path, re-stringifying
// this fixture reformats the whole `addresses`/`admitFrom` blocks and the
// byte-identical assertion catches it.
const ROUND_TRIP_FIXTURE = `- insert:
  - id: mcp-fixture-one
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: mcp-fixture-one
      transport: stdio
      command: 'true'
- insert:
  - id: mcp-fixture-two
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: mcp-fixture-two
      transport: stdio
      command: 'true'
- insert:
  - id: mcp-fixture-three
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: mcp-fixture-three
      transport: stdio
      command: 'true'
- insert:
  - id: mcp-fixture-four
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: mcp-fixture-four
      transport: stdio
      command: 'true'
- insert:
  - id: mcp-fixture-five
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: mcp-fixture-five
      transport: stdio
      command: 'true'
- insert:
  - id: mcp-fixture-six
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: mcp-fixture-six
      transport: stdio
      command: 'true'
- insert:
  - id: mailbox
    name: '@deepseek-ai/dsh-mailbox'
    config:
      defaultProvider: local
  - id: mailbox-local
    name: '@deepseek-ai/dsh-mailbox-local'
  - id: mailbox-bridge
    name: '@deepseek-ai/dsh-mailbox-bridge'
    config:
      addresses:
      - seat-alpha
      - seat-bravo
      - seat-charlie
      pollIntervalMs: 5000
      residencyIdleMs: 600000
      admitFrom:
      - operator
  - id: tool-mailbox
    name: '@deepseek-ai/dsh-tool-mailbox'
    config:
      addresses:
      - seat-alpha
      - seat-bravo
      - seat-charlie
`

describe('YAML round-trip stability (indentSeq: false, singleQuote: true)', () => {
  it('reproduces the fixture exactly via parse + stringify with both pinned options', () => {
    expect(stringifyYaml(parseYaml(ROUND_TRIP_FIXTURE), { indentSeq: false, singleQuote: true })).toBe(ROUND_TRIP_FIXTURE)
  })

  it('is NOT byte-identical without the options — proves they are load-bearing, not incidental', () => {
    expect(stringifyYaml(parseYaml(ROUND_TRIP_FIXTURE))).not.toBe(ROUND_TRIP_FIXTURE)
  })

  it('is NOT byte-identical with indentSeq alone — the quote style is its own guarantee', () => {
    // Dropping `singleQuote` reformats every quoted string in the document.
    // Nothing else in the suite covers this: it is invisible unless the
    // fixture is authored the way a person writes the file.
    expect(stringifyYaml(parseYaml(ROUND_TRIP_FIXTURE), { indentSeq: false })).not.toBe(ROUND_TRIP_FIXTURE)
  })

  it('is NOT byte-identical with singleQuote alone — the sequence indent is its own guarantee too', () => {
    expect(stringifyYaml(parseYaml(ROUND_TRIP_FIXTURE), { singleQuote: true })).not.toBe(ROUND_TRIP_FIXTURE)
  })

  it('writeOrgServedRoster itself serializes with both pinned options, matching the fixture round-trip shape', async () => {
    const dir = tempDir()
    const path = join(dir, 'cordis.patch.yml')
    writeFileSync(path, ROUND_TRIP_FIXTURE)
    const token = await currentToken(path)
    // Propose the SAME addresses already on disk — a pure round trip, so the
    // only source of textual drift possible is the serializer option itself.
    await writeOrgServedRoster(path, MOUNT_IDS, ['seat-alpha', 'seat-bravo', 'seat-charlie'], token)
    expect(readFileSync(path, 'utf8')).toBe(ROUND_TRIP_FIXTURE)
  })
})

describe('hashOrgServedRosterBytes', () => {
  it('computes sha256 hex of the exact bytes given (pinned vectors, matching hashOrgRegistryBytes\' own)', () => {
    expect(hashOrgServedRosterBytes(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(hashOrgServedRosterBytes(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('changes when the bytes change and repeats for identical bytes', () => {
    const a = hashOrgServedRosterBytes(Buffer.from('one'))
    const b = hashOrgServedRosterBytes(Buffer.from('two'))
    const aAgain = hashOrgServedRosterBytes(Buffer.from('one'))
    expect(a).not.toBe(b)
    expect(a).toBe(aAgain)
  })
})

describe('readOrgProfilePatchesWithToken', () => {
  it('reads, parses, and hashes a real file in one pass, matching hashOrgServedRosterBytes of its raw bytes', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const read = await readOrgProfilePatchesWithToken(path)
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.token).toBe(hashOrgServedRosterBytes(readFileSync(path)))
    expect(findOrgMountAddresses(read.patches, 'mailbox-bridge')).toEqual({ ok: true, addresses: ['seat-a'] })
  })

  it('reports an unreadable file as a named failure', async () => {
    const missing = join(tempDir(), 'does-not-exist.yml')
    const read = await readOrgProfilePatchesWithToken(missing)
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.reason).toContain(missing)
  })
})

describe('buildNextServedRosterPatches', () => {
  // The direct, unshadowed guard for the both-or-neither invariant. The
  // end-to-end test in the `writeOrgServedRoster` describe block below
  // exercises the same invariant, but writeOrgServedRoster's own
  // unconditional step-7 self-validation (re-parse + re-check both mounts
  // before the file is ever touched) would already intercept a regression
  // here before that end-to-end test could observe one — so THIS test is
  // where the invariant is actually pinned, at the level nothing shadows.
  it('given a document and a proposed list, BOTH mount entries come back carrying exactly that list', () => {
    const patches = realShapedPatches(['a'], ['a'])
    const next = buildNextServedRosterPatches(patches, MOUNT_IDS, ['x', 'y', 'z'])
    expect(findOrgMountAddresses(next, 'mailbox-bridge')).toEqual({ ok: true, addresses: ['x', 'y', 'z'] })
    expect(findOrgMountAddresses(next, 'tool-mailbox')).toEqual({ ok: true, addresses: ['x', 'y', 'z'] })
  })
})

describe('writeOrgServedRoster', () => {
  // NOTE: this is defence in depth, not the primary guard for this
  // invariant — the unconditional step-7 self-validation inside
  // writeOrgServedRoster (re-parse + re-run findOrgMountAddresses for BOTH
  // mounts before the file is ever touched) would already intercept a
  // both-or-neither regression before it reached disk, so this end-to-end
  // test alone can never actually fire on one. The primary, unshadowed
  // guard for buildNextServedRosterPatches's own contract is the direct
  // unit test below, in the `buildNextServedRosterPatches` describe block.
  it('replaces BOTH mounts with the same proposed list (both-or-neither)', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const token = await currentToken(path)

    const result = await writeOrgServedRoster(path, MOUNT_IDS, ['a', 'b'], token)
    expect(result.addresses).toEqual(['a', 'b'])
    expect(result.token).not.toBe(token)

    const reread = await readOrgProfilePatchesWithToken(path)
    if (!reread.ok) throw new Error('unreachable')
    expect(findOrgMountAddresses(reread.patches, 'mailbox-bridge')).toEqual({ ok: true, addresses: ['a', 'b'] })
    expect(findOrgMountAddresses(reread.patches, 'tool-mailbox')).toEqual({ ok: true, addresses: ['a', 'b'] })
  })

  it('refuses OrgServedRosterConflictError when expectedToken no longer matches the file, and leaves bytes and mtime unchanged', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const originalBytes = readFileSync(path)
    const originalMtimeMs = statSync(path).mtimeMs
    const staleToken = 'stale-token-not-the-real-hash'

    let caught: unknown
    try {
      await writeOrgServedRoster(path, MOUNT_IDS, ['a'], staleToken)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OrgServedRosterConflictError)
    const conflict = caught as InstanceType<typeof OrgServedRosterConflictError>
    expect(conflict.expectedToken).toBe(staleToken)
    expect(conflict.actualToken).toBe(hashOrgServedRosterBytes(originalBytes))

    expect(readFileSync(path)).toEqual(originalBytes)
    expect(statSync(path).mtimeMs).toBe(originalMtimeMs)
    // Never even attempted a backup.
    expect(readdirSync(dir)).toEqual(['cordis.patch.yml'])
  })

  it('refuses OrgServedRosterWriteError — never a plain Error — when a mount is entirely missing', async () => {
    const dir = tempDir()
    const path = join(dir, 'cordis.patch.yml')
    // Only tool-mailbox present; mailbox-bridge absent from the whole document.
    writeFileSync(path, stringifyYaml([{ insert: [{ id: 'tool-mailbox', config: { addresses: ['a'] } }] }], { indentSeq: false }))
    const token = await currentToken(path)

    let caught: unknown
    try {
      await writeOrgServedRoster(path, MOUNT_IDS, ['a'], token)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OrgServedRosterWriteError)
    expect((caught as Error).message).toContain('mailbox-bridge')
    expect(readFileSync(path, 'utf8')).toBe(stringifyYaml([{ insert: [{ id: 'tool-mailbox', config: { addresses: ['a'] } }] }], { indentSeq: false }))
  })

  it('refuses OrgServedRosterWriteError — never a plain Error — when a mount\'s current addresses is malformed', async () => {
    const dir = tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const malformed = [
      { insert: [{ id: 'mailbox-bridge', config: { addresses: 'not-a-list' } }] },
      { insert: [{ id: 'tool-mailbox', config: { addresses: ['a'] } }] },
    ]
    writeFileSync(path, stringifyYaml(malformed, { indentSeq: false }))
    const token = await currentToken(path)

    let caught: unknown
    try {
      await writeOrgServedRoster(path, MOUNT_IDS, ['a'], token)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OrgServedRosterWriteError)
    expect((caught as Error).message).toContain('mailbox-bridge')
    expect(readFileSync(path, 'utf8')).toBe(stringifyYaml(malformed, { indentSeq: false }))
  })

  it('refuses a plain Error — never OrgServedRosterWriteError — for an invalid proposed address, and leaves the file untouched', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const originalBytes = readFileSync(path)
    const token = await currentToken(path)

    let caught: unknown
    try {
      await writeOrgServedRoster(path, MOUNT_IDS, ['not a valid address!'], token)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(OrgServedRosterWriteError)
    expect(caught).not.toBeInstanceOf(OrgServedRosterConflictError)
    expect(caught).not.toBeInstanceOf(OrgServedRosterSplitError)
    expect(readFileSync(path)).toEqual(originalBytes)
  })

  it('refuses a plain Error for a duplicate proposed address, and leaves the file untouched', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const originalBytes = readFileSync(path)
    const token = await currentToken(path)

    let caught: unknown
    try {
      await writeOrgServedRoster(path, MOUNT_IDS, ['a', 'b', 'a'], token)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(OrgServedRosterWriteError)
    expect((caught as Error).message).toContain('duplicate')
    expect(readFileSync(path)).toEqual(originalBytes)
  })

  it('refuses OrgServedRosterSplitError, naming both sides, when the two mounts already disagree and acknowledgeSplit is omitted — file unchanged', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['a', 'b'], ['a'])
    const originalBytes = readFileSync(path)
    const token = await currentToken(path)

    let caught: unknown
    try {
      await writeOrgServedRoster(path, MOUNT_IDS, ['c'], token)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OrgServedRosterSplitError)
    const split = caught as InstanceType<typeof OrgServedRosterSplitError>
    expect(split.onlyMailboxBridge).toEqual(['b'])
    expect(split.onlyToolMailbox).toEqual([])
    expect(readFileSync(path)).toEqual(originalBytes)
  })

  it('succeeds with acknowledgeSplit: true on the same disagreeing fixture, reconciling both mounts onto the proposed list', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['a', 'b'], ['a'])
    const token = await currentToken(path)

    const result = await writeOrgServedRoster(path, MOUNT_IDS, ['c'], token, true)
    expect(result.addresses).toEqual(['c'])

    const reread = await readOrgProfilePatchesWithToken(path)
    if (!reread.ok) throw new Error('unreachable')
    expect(findOrgMountAddresses(reread.patches, 'mailbox-bridge')).toEqual({ ok: true, addresses: ['c'] })
    expect(findOrgMountAddresses(reread.patches, 'tool-mailbox')).toEqual({ ok: true, addresses: ['c'] })
  })

  it('succeeds with acknowledgeSplit omitted when the two mounts already agree — no friction on the common path', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['a', 'b'])
    const token = await currentToken(path)

    const result = await writeOrgServedRoster(path, MOUNT_IDS, ['a', 'b', 'c'], token)
    expect(result.addresses).toEqual(['a', 'b', 'c'])
  })

  it('leaves every unrelated top-level entry, and every unrelated key of the touched entry, byte-identical before and after', async () => {
    // Deliberately RAW STRING comparisons throughout this test, never
    // parse+toEqual: a parsed-structure comparison passes even when an
    // untouched region gets silently reformatted (reordered keys, different
    // quote style, different indentation) as long as its parsed MEANING is
    // unchanged — which is exactly the defect class this whole feature
    // exists to eliminate, so this test has to look at the same bytes a
    // hand-edit or a git diff would see, not what the parser makes of them.
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const before = readFileSync(path, 'utf8')
    const token = await currentToken(path)

    await writeOrgServedRoster(path, MOUNT_IDS, ['seat-a', 'seat-b'], token)

    const after = readFileSync(path, 'utf8')

    // Top-level patch entries always start their dash at column 0 in this
    // serializer's output (indentSeq only affects NESTED sequences), so
    // splitting on that boundary reliably yields one raw-text block per
    // top-level entry, in order.
    const beforeTop = splitByColumnZeroDash(before)
    const afterTop = splitByColumnZeroDash(after)
    expect(beforeTop).toHaveLength(7)
    expect(afterTop).toHaveLength(7)

    // The six filler top-level entries: raw bytes, not parsed structure.
    for (let index = 0; index < 6; index++) {
      expect(afterTop[index]).toBe(beforeTop[index])
    }

    // Inside the touched (7th) entry, split its nested `insert` list the
    // same way (its items' dash sits at column 2 under `indentSeq: false`).
    const beforeMounts = splitByTwoSpaceDash(beforeTop[6] ?? '')
    const afterMounts = splitByTwoSpaceDash(afterTop[6] ?? '')
    expect(beforeMounts).toHaveLength(4)
    expect(afterMounts).toHaveLength(4)

    // mailbox, mailbox-local: entirely untouched, raw bytes identical.
    expect(afterMounts[0]).toBe(beforeMounts[0])
    expect(afterMounts[1]).toBe(beforeMounts[1])

    // mailbox-bridge, tool-mailbox: byte-identical EXCEPT their `addresses`
    // block — blank that one region out on both sides and compare the raw
    // bytes of everything else (pollIntervalMs, residencyIdleMs, admitFrom
    // for the bridge; the rest of each item's own keys).
    expect(withAddressesBlanked(afterMounts[2] ?? '')).toBe(withAddressesBlanked(beforeMounts[2] ?? ''))
    expect(withAddressesBlanked(afterMounts[3] ?? '')).toBe(withAddressesBlanked(beforeMounts[3] ?? ''))

    // And confirm the blanking isn't hiding a no-op: the addresses actually moved.
    expect(afterMounts[2]).toContain('- seat-b')
    expect(afterMounts[3]).toContain('- seat-b')
  })

  it('takes a timestamped backup of the previous content before a successful write', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const originalBytes = readFileSync(path)
    const token = await currentToken(path)

    await writeOrgServedRoster(path, MOUNT_IDS, ['seat-a', 'seat-b'], token)

    const backups = readdirSync(dir).filter(name => name.startsWith('cordis.patch.yml.bak-'))
    expect(backups).toHaveLength(1)
    const backupName = backups[0]
    if (backupName === undefined) throw new Error('unreachable')
    expect(readFileSync(join(dir, backupName))).toEqual(originalBytes)
  })

  it('never silently destroys a previous backup when two writes land in the same millisecond timestamp — it disambiguates instead', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const originalBytes = readFileSync(path)
    const token1 = await currentToken(path)

    const isoSpy = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-01-01T00:00:00.000Z')
    try {
      const first = await writeOrgServedRoster(path, MOUNT_IDS, ['seat-a', 'seat-b'], token1)
      const afterFirstBytes = readFileSync(path)

      await writeOrgServedRoster(path, MOUNT_IDS, ['seat-a', 'seat-b', 'seat-c'], first.token)

      const backups = readdirSync(dir).filter(name => name.startsWith('cordis.patch.yml.bak-'))
      // Two writes, two backups — never one overwriting the other, even
      // though both computed the identical millisecond-granular timestamp.
      expect(backups).toHaveLength(2)
      expect(new Set(backups).size).toBe(2)

      const withoutSuffix = backups.find(name => !name.endsWith('-1'))
      const withSuffix = backups.find(name => name.endsWith('-1'))
      if (withoutSuffix === undefined || withSuffix === undefined) throw new Error('unreachable')
      expect(readFileSync(join(dir, withoutSuffix))).toEqual(originalBytes)
      expect(readFileSync(join(dir, withSuffix))).toEqual(afterFirstBytes)
    } finally {
      isoSpy.mockRestore()
    }
  })

  it('refuses OrgServedRosterWriteError — never a plain Error — for a mocked rename failure unrelated to document content', async () => {
    const dir = tempDir()
    const path = writeProfile(dir, ['seat-a'])
    const originalBytes = readFileSync(path)
    const token = await currentToken(path)

    fsControl.forceRenameFailure = true
    let caught: unknown
    try {
      await writeOrgServedRoster(path, MOUNT_IDS, ['seat-a', 'seat-b'], token)
    } catch (error: unknown) {
      caught = error
    } finally {
      fsControl.forceRenameFailure = false
    }
    expect(caught).toBeInstanceOf(OrgServedRosterWriteError)
    expect(caught).not.toBeInstanceOf(OrgServedRosterConflictError)
    expect((caught as Error).message).toContain('simulated rename failure')
    // The target file itself is untouched (the rename that would have
    // replaced it never completed) — only the temp file attempt and the
    // backup it already made exist alongside it.
    expect(readFileSync(path)).toEqual(originalBytes)
  })
})

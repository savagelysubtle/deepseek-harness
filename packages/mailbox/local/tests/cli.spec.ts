/**
 * The `dsh-mailbox` CLI surface: publish/drain round-trips through the shared
 * owner-only open path, `--peek` non-consumption, loud schema-version and
 * grammar rejections, POSIX first-writer modes, and machine-readable output.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import { openMailboxDatabase, SCHEMA_VERSION, SqliteMailboxStore } from '../src/sqlite.ts'
import * as cli from '../src/cli.ts'

// Lets exactly one in-process test read a deterministic "piped stdin" body
// through the real `readFileSync(0, ...)` call site, instead of the real fd
// 0 (whose content under a test runner is environment-dependent and may
// hang) — same `...actual` passthrough pattern as subprocess-local's
// spawn.spec.ts.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) {
      if (path === 0) return '{"piped":"in-process"}'
      return actual.readFileSync(path, options as never)
    },
  }
})

const TARGET = formatMailboxAddress('target')

let dirs: string[] = []
const originalStdout = cli.internals.stdout

afterEach(() => {
  cli.internals.stdout = originalStdout
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-cli-'))
  dirs.push(dir)
  process.env.DSH_HOME = dir
  return dir
}

/** Run one CLI invocation in-process, capturing stdout lines. */
async function run(argv: readonly string[]): Promise<string> {
  let captured = ''
  cli.internals.stdout = { write: (chunk: string) => { captured += chunk; return true } }
  const code = await cli.runMailboxCli([...argv])
  expect(code).toBe(0)
  return captured
}

describe('dsh-mailbox send/inbox round-trip', () => {
  it('delivers a sent message and consumes it on a plain inbox drain', async () => {
    const dir = tempDir()
    const payloadFile = join(dir, 'payload.json')
    writeFileSync(payloadFile, '{"op":"field-report","detail":"harness web boot dead"}')
    await run(['send', '--to', String(TARGET), '--from', 'claude-code', '--type', 'field-report',
      '--subject', 'outage', '--trace-id', 't-1', '--payload-file', payloadFile])

    const peeked = JSON.parse(await run(['inbox', '--address', String(TARGET), '--peek', '--json'])) as Array<{
      messageId: string
      from: string
      type?: string
      subject?: string
      payload?: unknown
      traceId?: string
    }>
    expect(peeked).toHaveLength(1)
    const first = peeked[0]
    expect(first).toMatchObject({
      from: 'guest:claude-code', type: 'field-report', subject: 'outage', traceId: 't-1',
      payload: { op: 'field-report', detail: 'harness web boot dead' },
    })

    // Peek settled back to pending, so the consuming drain still sees it…
    const drained = JSON.parse(await run(['inbox', '--address', String(TARGET), '--json'])) as Array<{ messageId: string }>
    expect(drained.map(entry => entry.messageId)).toEqual([first?.messageId])
    // …and afterwards the queue is empty.
    const again = JSON.parse(await run(['inbox', '--address', String(TARGET), '--json'])) as unknown[]
    expect(again).toEqual([])
  })

  it('renders human-readable blocks without --json including an empty mailbox', async () => {
    await run(['send', '--to', String(TARGET), '--from', 'gemini'])
    const out = await run(['inbox', '--address', String(TARGET)])
    expect(out).toContain('from guest:gemini')
    const empty = await run(['inbox', '--address', String(TARGET)])
    expect(empty).toContain('(empty)')
  })

  it('projects a store-published blocking mark onto json inbox entries alone', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'marked.db')
    const store = new SqliteMailboxStore(openMailboxDatabase(dbPath))
    await store.publish({ to: TARGET, from: 'sc:chair', blocking: true })
    await store.publish({ to: TARGET, from: 'sc:ally', subject: 'fyi' })
    store.close()

    const drained = JSON.parse(await run(['inbox', '--address', String(TARGET), '--db', dbPath, '--json'])) as Array<{
      messageId: string
      from: string
      blocking?: true
      subject?: string
    }>
    expect(drained.map(entry => entry.from)).toEqual(['sc:chair', 'sc:ally'])
    expect(drained[0]?.blocking).toBe(true)
    expect(drained[1]).not.toHaveProperty('blocking')
  })

  it('renders type, subject, and both string and object payloads in human-readable blocks', async () => {
    const dir = tempDir()
    await run(['send', '--to', String(TARGET), '--from', 'gemini', '--type', 'note', '--subject', 'status'])
    expect(await run(['inbox', '--address', String(TARGET)])).toContain('from guest:gemini type note subject status')

    const stringPayloadFile = join(dir, 'string-payload.json')
    writeFileSync(stringPayloadFile, JSON.stringify('plain text payload'))
    await run(['send', '--to', String(TARGET), '--from', 'gemini', '--payload-file', stringPayloadFile])
    expect(await run(['inbox', '--address', String(TARGET)])).toContain('plain text payload')

    const objectPayloadFile = join(dir, 'object-payload.json')
    writeFileSync(objectPayloadFile, JSON.stringify({ a: 1 }))
    await run(['send', '--to', String(TARGET), '--from', 'gemini', '--payload-file', objectPayloadFile])
    expect(await run(['inbox', '--address', String(TARGET)])).toContain(JSON.stringify({ a: 1 }, null, 2))
  })

  it('reports the send confirmation as JSON when --json is set', async () => {
    tempDir()
    const out = await run(['send', '--to', String(TARGET), '--from', 'claude-code', '--json'])
    expect(JSON.parse(out)).toEqual({ stored: true, to: String(TARGET) })
  })

  it('reads a piped payload from stdin in-process, through the real fd-0 read site', async () => {
    tempDir()
    await run(['send', '--to', String(TARGET), '--from', 'claude-code', '--payload-stdin'])
    const drained = JSON.parse(await run(['inbox', '--address', String(TARGET), '--json'])) as Array<{ payload?: unknown }>
    expect(drained[0]?.payload).toEqual({ piped: 'in-process' })
  })

  it('accepts an explicit --limit, bounding the inbox batch', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'limited.db')
    await run(['send', '--to', String(TARGET), '--from', 'a', '--db', dbPath])
    await run(['send', '--to', String(TARGET), '--from', 'b', '--db', dbPath])
    const drained = JSON.parse(await run(['inbox', '--address', String(TARGET), '--db', dbPath, '--limit', '1', '--json'])) as Array<{ from: string }>
    expect(drained).toHaveLength(1)
    expect(drained[0]?.from).toBe('guest:a')
  })
})

describe('dsh-mailbox failure paths', () => {
  it('rejects a database stamped by another schema version loud', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'foreign.db')
    const foreign = openMailboxDatabase(dbPath)
    foreign.prepare('UPDATE mailbox_meta SET value = ?').run(String(SCHEMA_VERSION + 1))
    foreign.close()
    await expect(cli.runMailboxCli(['send', '--to', String(TARGET), '--from', 'claude-code', '--db', dbPath]))
      .rejects.toThrow(`incompatible with this build (${SCHEMA_VERSION})`)
  })

  it('rejects malformed addresses before any write', async () => {
    tempDir()
    await expect(cli.runMailboxCli(['send', '--to', 'no separator', '--from', 'claude-code']))
      .rejects.toThrow(/invalid mailbox address/)
  })

  it('refuses both payload sources together and unknown flags', async () => {
    tempDir()
    await expect(cli.runMailboxCli(['send', '--to', String(TARGET), '--from', 'c', '--payload-file', 'x.json', '--payload-stdin']))
      .rejects.toThrow(/not both/)
    await expect(cli.runMailboxCli(['inbox', '--wat'])).rejects.toThrow(/unknown argument/)
  })

  it('creates a missing database owner-only when the CLI is the first writer (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const dir = tempDir()
    const nested = join(dir, 'a', 'b', 'mailbox.db')
    await cli.runMailboxCli(['send', '--to', String(TARGET), '--from', 'claude-code', '--db', nested])
    expect(existsSync(nested)).toBe(true)
    expect(statSync(nested).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'a')).mode & 0o777).toBe(0o700)
  })

  it('accepts piped stdin payloads through the real bin entry (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'q.db')
    execFileSync(
      process.execPath,
      ['--import', 'tsx/esm', join(import.meta.dirname, '../src/cli.ts'), 'send',
        '--to', String(TARGET), '--from', 'gemini', '--payload-stdin', '--db', dbPath],
      { input: '{"piped": true}', env: { ...process.env, DSH_HOME: dir }, encoding: 'utf8' },
    )
    const drained = JSON.parse(await run(['inbox', '--address', String(TARGET), '--db', dbPath, '--json'])) as Array<{ payload?: unknown }>
    expect(drained[0]?.payload).toEqual({ piped: true })
  })

  it('runs the real bin through a SYMLINKED path — resolution must not depend on the invoked spelling (POSIX)', { skip: process.platform === 'win32' }, async () => {
    // The regression: `import.meta.url` is fully resolved while
    // `process.argv[1]` carries the symlink, so an unresolved comparison
    // never matched, the guard stayed false, and the process exited 0 having
    // run nothing. The store row below proves the send actually happened.
    const dir = tempDir()
    const dbPath = join(dir, 'q.db')
    const linkPath = join(dir, 'dsh-mailbox.ts')
    symlinkSync(join(import.meta.dirname, '../src/cli.ts'), linkPath)
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx/esm', linkPath, 'send', '--to', String(TARGET), '--from', 'gemini', '--db', dbPath],
      { env: { ...process.env, DSH_HOME: dir }, encoding: 'utf8' },
    )
    expect(stdout).toContain('stored for')
    const drained = JSON.parse(await run(['inbox', '--address', String(TARGET), '--db', dbPath, '--json'])) as Array<{ from?: string }>
    expect(drained[0]?.from).toBe('guest:gemini')
  })

  it('leaves no db litter behind for pure validation failures', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'never.db')
    await expect(cli.runMailboxCli(['send', '--to', String(TARGET), '--from', 'claude-code', '--payload-file', join(dir, 'missing.json'), '--db', dbPath]))
      .rejects.toThrow()
    expect(existsSync(dbPath)).toBe(false)
  })

  it('rejects an unrecognized subcommand with the usage message', async () => {
    tempDir()
    await expect(cli.runMailboxCli(['bogus'])).rejects.toThrow(/usage: dsh-mailbox <send\|inbox>/)
  })

  it('breaks the flag-parsing loop cleanly on a stray undefined argv slot, then fails on the resulting missing flag', async () => {
    tempDir()
    // Violates the `readonly string[]` contract deliberately — the argv-safety
    // guard this exercises only matters if a caller's array genuinely has a
    // hole or an explicit `undefined` entry, which TS cannot express as input.
    await expect(cli.runMailboxCli(['send', undefined as unknown as string]))
      .rejects.toThrow(/missing required flag --to/)
  })

  it('rejects a value-flag with nothing after it, and a value-flag whose "value" is itself another flag', async () => {
    tempDir()
    await expect(cli.runMailboxCli(['send', '--to'])).rejects.toThrow(/missing value for --to/)
    await expect(cli.runMailboxCli(['send', '--to', '--from', 'claude-code']))
      .rejects.toThrow(/missing value for --to/)
  })

  it('rejects a non-positive or non-integer --limit, naming the raw value received', async () => {
    tempDir()
    await expect(cli.runMailboxCli(['inbox', '--address', String(TARGET), '--limit', '0']))
      .rejects.toThrow(/--limit must be a positive integer, received "0"/)
    await expect(cli.runMailboxCli(['inbox', '--address', String(TARGET), '--limit', 'nope']))
      .rejects.toThrow(/--limit must be a positive integer, received "nope"/)
  })

  it('fails loud instead of forging an id when a claimed lease carries none (toEntry)', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'no-id.db')
    await run(['send', '--to', String(TARGET), '--from', 'claude-code', '--db', dbPath])
    vi.spyOn(SqliteMailboxStore.prototype, 'claim').mockResolvedValueOnce([{
      message: { to: TARGET, from: 'ghost', sentAt: Date.now() },
      leaseRef: 'fake-ref' as never,
      claimedAt: Date.now(),
    }])
    await expect(cli.runMailboxCli(['inbox', '--address', String(TARGET), '--db', dbPath]))
      .rejects.toThrow(/claimed message from "ghost" has no provider id/)
  })
})

describe('bin entry resolution', () => {
  /** The CLI module's URL, the second argument the bin guard passes. */
  const entryUrl = pathToFileURL(join(import.meta.dirname, '../src/cli.ts')).href

  it('matches the entry by direct path and through a symlink (POSIX)', { skip: process.platform === 'win32' }, () => {
    const dir = tempDir()
    const direct = join(import.meta.dirname, '../src/cli.ts')
    expect(cli.isEntryInvocation(direct, entryUrl)).toBe(true)
    // The invoked spelling resolves to the same file, so it matches — the
    // case the unresolved URL comparison silently failed on.
    const linkPath = join(dir, 'alias.ts')
    symlinkSync(direct, linkPath)
    expect(cli.isEntryInvocation(linkPath, entryUrl)).toBe(true)
  })

  it('answers false for another module and for a missing file without throwing', () => {
    const dir = tempDir()
    // This spec is a real, existing file that is not the entry module.
    expect(cli.isEntryInvocation(join(import.meta.dirname, 'cli.spec.ts'), entryUrl)).toBe(false)
    expect(cli.isEntryInvocation(join(dir, 'missing.ts'), entryUrl)).toBe(false)
  })
})

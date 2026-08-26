/**
 * The `dsh-mailbox` CLI surface: publish/drain round-trips through the shared
 * owner-only open path, `--peek` non-consumption, loud schema-version and
 * grammar rejections, POSIX first-writer modes, and machine-readable output.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import { openMailboxDatabase, SCHEMA_VERSION } from '../src/sqlite.ts'
import * as cli from '../src/cli.ts'

const TARGET = formatMailboxAddress('sc', 'target')

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
    await run(['send', '--to', String(TARGET), '--from', 'guest:claude-code', '--type', 'field-report',
      '--subject', 'outage', '--trace-id', 't-1', '--payload-file', payloadFile])

    const peeked = JSON.parse(await run(['inbox', '--address', String(TARGET), '--peek', '--json'])) as Array<{
      messageId: string; from: string; type?: string; subject?: string; payload?: unknown; traceId?: string
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
    await run(['send', '--to', String(TARGET), '--from', 'guest:gemini'])
    const out = await run(['inbox', '--address', String(TARGET)])
    expect(out).toContain(`from guest:gemini`)
    const empty = await run(['inbox', '--address', String(TARGET)])
    expect(empty).toContain('(empty)')
  })
})

describe('dsh-mailbox failure paths', () => {
  it('rejects a database stamped by another schema version loud', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'foreign.db')
    const foreign = openMailboxDatabase(dbPath)
    foreign.prepare('UPDATE mailbox_meta SET value = ?').run(String(SCHEMA_VERSION + 1))
    foreign.close()
    await expect(cli.runMailboxCli(['send', '--to', String(TARGET), '--from', 'guest:claude-code', '--db', dbPath]))
      .rejects.toThrow(`incompatible with this build (${SCHEMA_VERSION})`)
  })

  it('rejects malformed addresses before any write', async () => {
    tempDir()
    await expect(cli.runMailboxCli(['send', '--to', 'no separator', '--from', 'guest:claude-code']))
      .rejects.toThrow(/invalid mailbox address/)
  })

  it('refuses both payload sources together and unknown flags', async () => {
    tempDir()
    await expect(cli.runMailboxCli(['send', '--to', String(TARGET), '--from', 'guest:c', '--payload-file', 'x.json', '--payload-stdin']))
      .rejects.toThrow(/not both/)
    await expect(cli.runMailboxCli(['inbox', '--wat'])).rejects.toThrow(/unknown argument/)
  })

  it('creates a missing database owner-only when the CLI is the first writer (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const dir = tempDir()
    const nested = join(dir, 'a', 'b', 'mailbox.db')
    await cli.runMailboxCli(['send', '--to', String(TARGET), '--from', 'guest:claude-code', '--db', nested])
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
        '--to', String(TARGET), '--from', 'guest:gemini', '--payload-stdin', '--db', dbPath],
      { input: '{"piped": true}', env: { ...process.env, DSH_HOME: dir }, encoding: 'utf8' },
    )
    const drained = JSON.parse(await run(['inbox', '--address', String(TARGET), '--db', dbPath, '--json'])) as Array<{ payload?: unknown }>
    expect(drained[0]?.payload).toEqual({ piped: true })
  })

  it('leaves no db litter behind for pure validation failures', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'never.db')
    await expect(cli.runMailboxCli(['send', '--to', String(TARGET), '--from', 'guest:claude-code', '--payload-file', join(dir, 'missing.json'), '--db', dbPath]))
      .rejects.toThrow()
    expect(existsSync(dbPath)).toBe(false)
  })
})

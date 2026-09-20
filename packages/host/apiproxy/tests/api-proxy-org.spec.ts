/**
 * org.get and org.write: the registry + served-roster read projection and
 * its computed drift, plus the registry's one host-side write primitive.
 * Each of org.get's three sources (registry, mailbox-bridge roster,
 * tool-mailbox roster) fails independently and must surface a named reason
 * rather than an empty result; drift additionally requires all three to have
 * succeeded. org.write is guarded by a content token (never a revision
 * counter — see org.ts) and validates through the same parser org.get reads
 * with before writing a byte. Fixtures are real files under a temp
 * directory — both methods touch the filesystem directly, so there is
 * nothing to fake below the RPC boundary.
 */

import { createHash } from 'node:crypto'
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { stringify as stringifyYaml } from 'yaml'
import type { ApiProxy, OrgRegistryDocument } from '../src/api/index.ts'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy, type ApiProxyDefaults } from '../src/api-proxy.ts'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** The API carrier's floor: services createApiProxy requires unconditionally (see api-proxy-jobs.spec.ts). */
async function floor(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function api(ctx: Context, overrides: Partial<ApiProxyDefaults> = {}): ApiProxy {
  return createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
    ...overrides,
  })
}

let nextRpc = 1
function request(): RpcRequest<{}> {
  return { rpcId: RpcId(`org-${String(nextRpc++)}`), payload: {} }
}

function requestWith<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`org-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): { code: string; message: string; details: unknown } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** Minimal valid registry YAML: baseDir plus a seats map, edges/callUp omitted unless given. */
function writeRegistry(
  dir: string,
  seats: Record<string, { cwd?: string; test?: boolean }>,
  extra: { edges?: [string, string][]; callUp?: string[] } = {},
): string {
  const path = join(dir, 'registry.yml')
  const document: Record<string, unknown> = {
    baseDir: dir,
    seats: Object.fromEntries(Object.entries(seats).map(([name, seat]) => [
      name,
      { cwd: seat.cwd ?? '.', ...seat.test === undefined ? {} : { test: seat.test } },
    ])),
    ...extra.edges === undefined ? {} : { edges: extra.edges },
    ...extra.callUp === undefined ? {} : { callUp: extra.callUp },
  }
  writeFileSync(path, stringifyYaml(document))
  return path
}

/** A profile directory holding a cordis.patch.yml with the named mounts (a subset, or none, for the missing-mount cases). */
function writeProfile(dir: string, mounts: { id: string; addresses: string[] }[]): void {
  const patches = mounts.map(mount => ({ insert: [{ id: mount.id, config: { addresses: mount.addresses } }] }))
  writeFileSync(join(dir, 'cordis.patch.yml'), stringifyYaml(patches))
}

describe('org.get', () => {
  it('reports a non-empty, correct drift report for a deliberately drifted registry and roster pair', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, {
      alfred: {},
      // Registered but served by neither roster.
      orphan: {},
    })
    writeProfile(profileDir, [
      // 'ghost' is served but not registered (the reverse drift direction);
      // 'alfred' is served by both; the two rosters also disagree with each
      // other over 'partial'.
      { id: 'mailbox-bridge', addresses: ['alfred', 'ghost', 'partial'] },
      { id: 'tool-mailbox', addresses: ['alfred', 'ghost'] },
    ])
    const value = expectOk(await api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir }).org.get(request()))
    expect(value.registry.ok).toBe(true)
    if (!value.registry.ok) throw new Error('unreachable')
    expect(value.registry.registry.baseDir).toBe(registryDir)
    expect(value.mailboxBridge).toEqual({ ok: true, addresses: ['alfred', 'ghost', 'partial'] })
    expect(value.toolMailbox).toEqual({ ok: true, addresses: ['alfred', 'ghost'] })
    expect(value.drift.ok).toBe(true)
    if (!value.drift.ok) throw new Error('unreachable')
    expect(value.drift.rows).toEqual([
      { seat: 'ghost', registered: false, servedByMailboxBridge: true, servedByToolMailbox: true },
      { seat: 'orphan', registered: true, servedByMailboxBridge: false, servedByToolMailbox: false },
      { seat: 'partial', registered: false, servedByMailboxBridge: true, servedByToolMailbox: false },
    ])
    // 'alfred' agrees on all three sources and must NOT appear as a drift row.
    expect(value.drift.rows.some(row => row.seat === 'alfred')).toBe(false)
  })

  it('reports a served address naming a seat absent from the registry (the reverse direction of drift)', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { known: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['known', 'unregistered-seat'] },
      { id: 'tool-mailbox', addresses: ['known', 'unregistered-seat'] },
    ])
    const value = expectOk(await api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir }).org.get(request()))
    expect(value.drift.ok).toBe(true)
    if (!value.drift.ok) throw new Error('unreachable')
    expect(value.drift.rows).toEqual([
      { seat: 'unregistered-seat', registered: false, servedByMailboxBridge: true, servedByToolMailbox: true },
    ])
  })

  it("produces a clean report against today's real shape: 24 registered, 19 served, difference = 4 test seats + 1 archive", async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const served = Array.from({ length: 19 }, (_, index) => `seat-${String(index)}`)
    const testSeats = ['tt-lead', 'tt-ping', 'tt-pong', 'tt-notitle']
    const archiveSeat = 'web-engineering-archive'
    const seats: Record<string, { test?: boolean }> = {
      ...Object.fromEntries(served.map(name => [name, {}])),
      ...Object.fromEntries(testSeats.map(name => [name, { test: true }])),
      [archiveSeat]: {},
    }
    expect(Object.keys(seats)).toHaveLength(24)
    const registryPath = writeRegistry(registryDir, seats)
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: served },
      { id: 'tool-mailbox', addresses: served },
    ])
    const value = expectOk(await api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir }).org.get(request()))
    expect(value.registry.ok).toBe(true)
    if (!value.registry.ok) throw new Error('unreachable')
    expect(Object.keys(value.registry.registry.seats)).toHaveLength(24)
    expect(value.mailboxBridge).toEqual({ ok: true, addresses: served })
    expect(value.toolMailbox).toEqual({ ok: true, addresses: served })
    expect(value.drift.ok).toBe(true)
    if (!value.drift.ok) throw new Error('unreachable')
    // Clean: the only drift is the KNOWN, deliberate serving/existing gap —
    // never collapsed away, but never mistaken for an anomaly either.
    expect(value.drift.rows.map(row => row.seat).sort()).toEqual(
      [...testSeats, archiveSeat].sort(),
    )
    for (const row of value.drift.rows) {
      expect(row.registered).toBe(true)
      expect(row.servedByMailboxBridge).toBe(false)
      expect(row.servedByToolMailbox).toBe(false)
    }
  })

  it('resolves each seat cwd to an absolute path from a real-shaped relative registry entry', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    // Real registries store cwd relative to baseDir (e.g. 'deepseek-harness'
    // for the real 'alfred' seat) — never '.'. A fixture using '.' would
    // hide a resolver that silently never ran, since resolve(baseDir, '.')
    // and baseDir itself are indistinguishable.
    const registryPath = writeRegistry(registryDir, { alfred: { cwd: 'deepseek-harness' } })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['alfred'] },
      { id: 'tool-mailbox', addresses: ['alfred'] },
    ])
    const value = expectOk(await api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir }).org.get(request()))
    expect(value.registry.ok).toBe(true)
    if (!value.registry.ok) throw new Error('unreachable')
    const alfred = value.registry.registry.seats['alfred']
    if (alfred === undefined) throw new Error('unreachable')
    expect(isAbsolute(alfred.cwd)).toBe(true)
    expect(alfred.cwd).toBe(join(registryDir, 'deepseek-harness'))
  })

  it('returns an unresolved document alongside the resolved view, so a relative seat cwd survives the read-edit-write round trip', async () => {
    // The trap this closes: a client that read the RESOLVED view, edited it,
    // and submitted that back to org.write would silently rewrite every
    // seat's relative cwd to absolute — including seats never touched. The
    // document field exists so a caller never has to build a write payload
    // from the resolved shape at all.
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    // Relative to baseDir, exactly as the founder hand-writes it — never
    // '.', which would hide a reshape that silently never ran behind
    // resolve(baseDir, '.') === baseDir.
    const registryPath = writeRegistry(registryDir, { alfred: { cwd: 'deepseek-harness' } })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['alfred'] },
      { id: 'tool-mailbox', addresses: ['alfred'] },
    ])
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir })
    const value = expectOk(await app.org.get(request()))
    expect(value.registry.ok).toBe(true)
    if (!value.registry.ok) throw new Error('unreachable')

    // The resolved view: absolute, for display.
    const resolvedAlfred = value.registry.registry.seats['alfred']
    if (resolvedAlfred === undefined) throw new Error('unreachable')
    expect(isAbsolute(resolvedAlfred.cwd)).toBe(true)
    expect(resolvedAlfred.cwd).toBe(join(registryDir, 'deepseek-harness'))

    // The unresolved document: exactly the relative string as authored, for editing.
    const documentAlfred = value.registry.document.seats['alfred']
    if (documentAlfred === undefined) throw new Error('unreachable')
    expect(documentAlfred.cwd).toBe('deepseek-harness')
    expect(value.registry.document.baseDir).toBe(registryDir)

    // The returned token is the SAME one a subsequent org.write accepts —
    // submitting the document straight back, untouched, must succeed and
    // must resolve the untouched seat's cwd fresh from the same relative
    // string rather than from an already-absolute one baked in by the read.
    const written = expectOk(await app.org.write(requestWith({
      document: value.registry.document,
      expectedToken: value.registry.token,
    })))
    expect(written.registry.seats['alfred']?.cwd).toBe(join(registryDir, 'deepseek-harness'))
  })

  it('reports the profile name the served rosters were read from, defaulting to web-stable', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const value = expectOk(await api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir }).org.get(request()))
    expect(value.profile).toBe('web-stable')
  })

  it('reports an overridden profile name verbatim, independent of where the roster bytes were actually read', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const value = expectOk(await api(await floor(), {
      orgRegistryPath: registryPath,
      orgProfileDir: profileDir,
      orgProfileName: 'web-canary',
    }).org.get(request()))
    expect(value.profile).toBe('web-canary')
  })

  it('reports an unreadable registry as its own named failure, never an empty roster', async () => {
    const profileDir = tempDir('dsh-org-profile-')
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const missingRegistryPath = join(tempDir('dsh-org-registry-'), 'does-not-exist.yml')
    const value = expectOk(await api(await floor(), {
      orgRegistryPath: missingRegistryPath,
      orgProfileDir: profileDir,
    }).org.get(request()))
    expect(value.registry.ok).toBe(false)
    if (value.registry.ok) throw new Error('unreachable')
    expect(value.registry.reason).toContain(missingRegistryPath)
    // The rosters are independent of the registry and must still be reported.
    expect(value.mailboxBridge).toEqual({ ok: true, addresses: ['a'] })
    expect(value.toolMailbox).toEqual({ ok: true, addresses: ['a'] })
    // Drift cannot run with a missing side; it must fail loud, never answer
    // an empty (falsely clean) report.
    expect(value.drift.ok).toBe(false)
    if (value.drift.ok) throw new Error('unreachable')
    expect(value.drift.reason).toContain('registry')
  })

  it('reports an unreadable profile patch file as its own named failure for BOTH rosters, never an empty list', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    // No cordis.patch.yml written at all — the profile directory exists but the file does not.
    const emptyProfileDir = tempDir('dsh-org-profile-')
    const value = expectOk(await api(await floor(), {
      orgRegistryPath: registryPath,
      orgProfileDir: emptyProfileDir,
    }).org.get(request()))
    expect(value.registry.ok).toBe(true)
    if (!value.registry.ok) throw new Error('unreachable')
    expect(value.registry.registry.baseDir).toBe(registryDir)
    expect(value.mailboxBridge.ok).toBe(false)
    expect(value.toolMailbox.ok).toBe(false)
    if (value.mailboxBridge.ok || value.toolMailbox.ok) throw new Error('unreachable')
    expect(value.mailboxBridge.reason).toContain('cordis.patch.yml')
    expect(value.toolMailbox.reason).toBe(value.mailboxBridge.reason)
    expect(value.drift.ok).toBe(false)
    if (value.drift.ok) throw new Error('unreachable')
    expect(value.drift.reason).toContain('mailbox-bridge roster')
    expect(value.drift.reason).toContain('tool-mailbox roster')
  })

  it('reports a profile missing the mailbox-bridge mount as its own named failure, naming that mount', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [{ id: 'tool-mailbox', addresses: ['a'] }])
    const value = expectOk(await api(await floor(), {
      orgRegistryPath: registryPath,
      orgProfileDir: profileDir,
    }).org.get(request()))
    expect(value.mailboxBridge.ok).toBe(false)
    if (value.mailboxBridge.ok) throw new Error('unreachable')
    expect(value.mailboxBridge.reason).toContain('mailbox-bridge')
    expect(value.toolMailbox).toEqual({ ok: true, addresses: ['a'] })
    expect(value.drift.ok).toBe(false)
  })

  it('reports a profile missing the tool-mailbox mount as its own named failure, naming that mount', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [{ id: 'mailbox-bridge', addresses: ['a'] }])
    const value = expectOk(await api(await floor(), {
      orgRegistryPath: registryPath,
      orgProfileDir: profileDir,
    }).org.get(request()))
    expect(value.toolMailbox.ok).toBe(false)
    if (value.toolMailbox.ok) throw new Error('unreachable')
    expect(value.toolMailbox.reason).toContain('tool-mailbox')
    expect(value.mailboxBridge).toEqual({ ok: true, addresses: ['a'] })
    expect(value.drift.ok).toBe(false)
  })

  it('reports a malformed mount (config.addresses not a list of strings) as a named failure, not a crash', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), stringifyYaml([
      { insert: [{ id: 'mailbox-bridge', config: { addresses: 'not-a-list' } }] },
      { insert: [{ id: 'tool-mailbox', config: { addresses: ['a'] } }] },
    ]))
    const value = expectOk(await api(await floor(), {
      orgRegistryPath: registryPath,
      orgProfileDir: profileDir,
    }).org.get(request()))
    expect(value.mailboxBridge.ok).toBe(false)
    if (value.mailboxBridge.ok) throw new Error('unreachable')
    expect(value.mailboxBridge.reason).toContain('mailbox-bridge')
    expect(value.toolMailbox).toEqual({ ok: true, addresses: ['a'] })
  })

  it('names the failure as "no mount of the recognised shape" when a mount exists under an unrecognised patch shape, never claiming it is absent', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    mkdirSync(profileDir, { recursive: true })
    // 'mailbox-bridge' genuinely exists in this file — just under 'upsert'
    // rather than the 'insert' shape this scan recognises. The reported
    // reason must not claim there is "no mount with id" (that would be
    // false); it must say the shape wasn't recognised.
    writeFileSync(join(profileDir, 'cordis.patch.yml'), stringifyYaml([
      { upsert: [{ id: 'mailbox-bridge', config: { addresses: ['a'] } }] },
      { insert: [{ id: 'tool-mailbox', config: { addresses: ['a'] } }] },
    ]))
    const value = expectOk(await api(await floor(), {
      orgRegistryPath: registryPath,
      orgProfileDir: profileDir,
    }).org.get(request()))
    expect(value.mailboxBridge.ok).toBe(false)
    if (value.mailboxBridge.ok) throw new Error('unreachable')
    expect(value.mailboxBridge.reason).toContain('recognised shape')
    expect(value.mailboxBridge.reason).not.toContain('no mount with id')
    expect(value.toolMailbox).toEqual({ ok: true, addresses: ['a'] })
  })

  it('reports a content token equal to sha256 of the file\'s exact bytes — never a revision counter', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const value = expectOk(await api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir }).org.get(request()))
    expect(value.registry.ok).toBe(true)
    if (!value.registry.ok) throw new Error('unreachable')
    const expectedToken = createHash('sha256').update(readFileSync(registryPath)).digest('hex')
    expect(value.registry.token).toBe(expectedToken)
    // A second read of the SAME unchanged bytes reports the same token —
    // proving it is a function of content, not a monotonic counter that
    // would advance on every read.
    const again = expectOk(await api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir }).org.get(request()))
    if (!again.registry.ok) throw new Error('unreachable')
    expect(again.registry.token).toBe(expectedToken)
  })

  it('reports servedRosterToken equal to sha256 of the profile patch file\'s exact bytes — a SEPARATE token from the registry\'s', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const value = expectOk(await api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir }).org.get(request()))
    const expectedServedRosterToken = createHash('sha256')
      .update(readFileSync(join(profileDir, 'cordis.patch.yml')))
      .digest('hex')
    expect(value.servedRosterToken).toEqual({ ok: true, token: expectedServedRosterToken })
    expect(value.registry.ok).toBe(true)
    if (!value.registry.ok) throw new Error('unreachable')
    // Two files, two independent tokens — never conflated.
    expect(value.servedRosterToken.ok && value.servedRosterToken.token).not.toBe(value.registry.token)
  })

  it('reports servedRosterToken as its own named failure when the profile patch file is unreadable, independent of the registry succeeding', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    const emptyProfileDir = tempDir('dsh-org-profile-')
    const value = expectOk(await api(await floor(), {
      orgRegistryPath: registryPath,
      orgProfileDir: emptyProfileDir,
    }).org.get(request()))
    expect(value.registry.ok).toBe(true)
    expect(value.servedRosterToken.ok).toBe(false)
    if (value.servedRosterToken.ok) throw new Error('unreachable')
    expect(value.servedRosterToken.reason).toContain('cordis.patch.yml')
  })
})

describe('org.write', () => {
  it('replaces the whole document and returns a new token that differs from the one it replaced', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const registryPath = writeRegistry(registryDir, { alfred: {} })
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: tempDir('dsh-org-profile-') })
    const before = expectOk(await app.org.get(request()))
    if (!before.registry.ok) throw new Error('unreachable')

    const nextDocument: OrgRegistryDocument = {
      baseDir: registryDir,
      seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } },
      edges: [['alfred', 'batman']],
      callUp: ['alfred'],
    }
    const written = expectOk(await app.org.write(requestWith({ document: nextDocument, expectedToken: before.registry.token })))
    expect(written.token).not.toBe(before.registry.token)
    expect(Object.keys(written.registry.seats).sort()).toEqual(['alfred', 'batman'])
    expect(written.registry.edges).toEqual([['alfred', 'batman']])
    expect(written.registry.callUp).toEqual(['alfred'])
    // Every seat's cwd is resolved absolute, same guarantee org.get makes.
    expect(isAbsolute(written.registry.seats['batman']?.cwd ?? '')).toBe(true)

    // A follow-up org.get sees exactly what was written.
    const after = expectOk(await app.org.get(request()))
    if (!after.registry.ok) throw new Error('unreachable')
    expect(after.registry.token).toBe(written.token)
    expect(Object.keys(after.registry.registry.seats).sort()).toEqual(['alfred', 'batman'])
  })

  it('refuses org-registry-conflict when expectedToken no longer matches the file, naming both tokens, and writes nothing', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const registryPath = writeRegistry(registryDir, { alfred: {} })
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: tempDir('dsh-org-profile-') })
    const originalBytes = readFileSync(registryPath)
    const staleToken = 'stale-token-not-the-real-hash'

    const nextDocument: OrgRegistryDocument = { baseDir: registryDir, seats: { alfred: { cwd: '.' } }, edges: [], callUp: [] }
    const error = expectErr(await app.org.write(requestWith({ document: nextDocument, expectedToken: staleToken })))
    expect(error.code).toBe('org-registry-conflict')
    expect(error.message).toContain('changed since it was read')
    expect(error.details).toEqual({
      expectedToken: staleToken,
      actualToken: createHash('sha256').update(originalBytes).digest('hex'),
    })
    // Never touched.
    expect(readFileSync(registryPath)).toEqual(originalBytes)
  })

  it('refuses org-registry-rejected for an invalid document, reusing the parser\'s own message, and writes nothing', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const registryPath = writeRegistry(registryDir, { alfred: {} })
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: tempDir('dsh-org-profile-') })
    const before = expectOk(await app.org.get(request()))
    if (!before.registry.ok) throw new Error('unreachable')
    const originalBytes = readFileSync(registryPath)

    const invalidDocument: OrgRegistryDocument = {
      baseDir: registryDir,
      seats: { alfred: { cwd: '.' } },
      edges: [['alfred', 'ghost']],
      callUp: [],
    }
    const error = expectErr(await app.org.write(requestWith({ document: invalidDocument, expectedToken: before.registry.token })))
    expect(error.code).toBe('org-registry-rejected')
    expect(error.message).toContain('unknown seat "ghost"')
    expect(readFileSync(registryPath)).toEqual(originalBytes)
  })

  it('takes a timestamped backup of the previous content next to the file before a successful write', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const registryPath = writeRegistry(registryDir, { alfred: {} })
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: tempDir('dsh-org-profile-') })
    const originalBytes = readFileSync(registryPath)
    const before = expectOk(await app.org.get(request()))
    if (!before.registry.ok) throw new Error('unreachable')

    const nextDocument: OrgRegistryDocument = { baseDir: registryDir, seats: { alfred: { cwd: '.' }, batman: { cwd: '.' } }, edges: [], callUp: [] }
    expectOk(await app.org.write(requestWith({ document: nextDocument, expectedToken: before.registry.token })))

    const backups = readdirSync(registryDir).filter(name => name.startsWith('registry.yml.bak-'))
    expect(backups).toHaveLength(1)
    const backupName = backups[0]
    if (backupName === undefined) throw new Error('unreachable')
    expect(readFileSync(join(registryDir, backupName))).toEqual(originalBytes)
  })

  it('refuses org-registry-write-failed — a distinct code from org-registry-rejected — for an I/O failure unrelated to the document', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const registryPath = writeRegistry(registryDir, { alfred: {} })
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: tempDir('dsh-org-profile-') })
    const before = expectOk(await app.org.get(request()))
    if (!before.registry.ok) throw new Error('unreachable')

    // The file vanishes between the caller's read and its write — nothing to
    // do with the proposed document, which is perfectly valid. A caller
    // seeing this code knows to retry the SAME document, the opposite
    // instruction from org-registry-rejected.
    rmSync(registryPath, { force: true })
    const validDocument: OrgRegistryDocument = { baseDir: registryDir, seats: { alfred: { cwd: '.' } }, edges: [], callUp: [] }
    const error = expectErr(await app.org.write(requestWith({ document: validDocument, expectedToken: before.registry.token })))
    expect(error.code).toBe('org-registry-write-failed')
    expect(error.code).not.toBe('org-registry-rejected')
    expect(error.message).toContain('could not be read for the concurrency check')
  })
})

describe('org.writeServed', () => {
  it('replaces BOTH served mounts with the same list, end-to-end through the real handler against a real tmp profile dir', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir })
    const before = expectOk(await app.org.get(request()))
    if (!before.servedRosterToken.ok) throw new Error('unreachable')

    const written = expectOk(await app.org.writeServed(requestWith({
      addresses: ['a', 'b'],
      expectedToken: before.servedRosterToken.token,
    })))
    expect(written.addresses).toEqual(['a', 'b'])
    expect(written.token).not.toBe(before.servedRosterToken.token)

    // A follow-up org.get sees exactly what was written, on BOTH rosters.
    const after = expectOk(await app.org.get(request()))
    expect(after.mailboxBridge).toEqual({ ok: true, addresses: ['a', 'b'] })
    expect(after.toolMailbox).toEqual({ ok: true, addresses: ['a', 'b'] })
    if (!after.servedRosterToken.ok) throw new Error('unreachable')
    expect(after.servedRosterToken.token).toBe(written.token)
    // The registry itself is untouched by a served-roster write.
    expect(after.registry).toEqual(before.registry)
  })

  it('refuses org-served-roster-conflict when expectedToken no longer matches the file, naming both tokens, and writes nothing', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir })
    const originalBytes = readFileSync(join(profileDir, 'cordis.patch.yml'))
    const staleToken = 'stale-served-roster-token-not-the-real-hash'

    const error = expectErr(await app.org.writeServed(requestWith({ addresses: ['a'], expectedToken: staleToken })))
    expect(error.code).toBe('org-served-roster-conflict')
    expect(error.message).toContain('changed since it was read')
    expect(error.details).toEqual({
      expectedToken: staleToken,
      actualToken: createHash('sha256').update(originalBytes).digest('hex'),
    })
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'))).toEqual(originalBytes)
  })

  it('refuses org-served-roster-split with POPULATED details when the two mounts already disagree and acknowledgeSplit is omitted, and writes nothing', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a', 'b'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir })
    const originalBytes = readFileSync(join(profileDir, 'cordis.patch.yml'))
    const before = expectOk(await app.org.get(request()))
    if (!before.servedRosterToken.ok) throw new Error('unreachable')

    const error = expectErr(await app.org.writeServed(requestWith({
      addresses: ['c'],
      expectedToken: before.servedRosterToken.token,
    })))
    expect(error.code).toBe('org-served-roster-split')
    // Not empty — the whole point of this refusal is to name exactly which
    // addresses are one-sided so the caller can act on it.
    expect(error.details).toEqual({ onlyMailboxBridge: ['b'], onlyToolMailbox: [] })
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'))).toEqual(originalBytes)
  })

  it('succeeds with acknowledgeSplit: true on the same disagreeing fixture, end-to-end', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a', 'b'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir })
    const before = expectOk(await app.org.get(request()))
    if (!before.servedRosterToken.ok) throw new Error('unreachable')

    const written = expectOk(await app.org.writeServed(requestWith({
      addresses: ['c'],
      expectedToken: before.servedRosterToken.token,
      acknowledgeSplit: true,
    })))
    expect(written.addresses).toEqual(['c'])

    const after = expectOk(await app.org.get(request()))
    expect(after.mailboxBridge).toEqual({ ok: true, addresses: ['c'] })
    expect(after.toolMailbox).toEqual({ ok: true, addresses: ['c'] })
  })

  it('refuses org-served-roster-rejected for an invalid proposed address, and writes nothing', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir })
    const originalBytes = readFileSync(join(profileDir, 'cordis.patch.yml'))
    const before = expectOk(await app.org.get(request()))
    if (!before.servedRosterToken.ok) throw new Error('unreachable')

    const error = expectErr(await app.org.writeServed(requestWith({
      addresses: ['not a valid address!'],
      expectedToken: before.servedRosterToken.token,
    })))
    expect(error.code).toBe('org-served-roster-rejected')
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'))).toEqual(originalBytes)
  })

  it('refuses org-served-roster-write-failed — a distinct code from org-served-roster-rejected — for an I/O failure unrelated to the proposed content', async () => {
    const registryDir = tempDir('dsh-org-registry-')
    const profileDir = tempDir('dsh-org-profile-')
    const registryPath = writeRegistry(registryDir, { a: {} })
    writeProfile(profileDir, [
      { id: 'mailbox-bridge', addresses: ['a'] },
      { id: 'tool-mailbox', addresses: ['a'] },
    ])
    const app = api(await floor(), { orgRegistryPath: registryPath, orgProfileDir: profileDir })
    const before = expectOk(await app.org.get(request()))
    if (!before.servedRosterToken.ok) throw new Error('unreachable')

    // The file vanishes between the caller's read and its write — nothing to
    // do with the proposed content, which is perfectly valid. A caller
    // seeing this code knows to retry the SAME list, the opposite
    // instruction from org-served-roster-rejected.
    rmSync(join(profileDir, 'cordis.patch.yml'), { force: true })
    const error = expectErr(await app.org.writeServed(requestWith({
      addresses: ['a'],
      expectedToken: before.servedRosterToken.token,
    })))
    expect(error.code).toBe('org-served-roster-write-failed')
    expect(error.code).not.toBe('org-served-roster-rejected')
    expect(error.message).toContain('could not be read for the concurrency check')
  })
})

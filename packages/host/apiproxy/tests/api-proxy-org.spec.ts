/**
 * org.get: the read-only registry + served-roster projection and its
 * computed drift. Each of the three sources (registry, mailbox-bridge
 * roster, tool-mailbox roster) fails independently and must surface a named
 * reason rather than an empty result; drift additionally requires all three
 * to have succeeded. Fixtures are real files under a temp directory —
 * org.get reads the filesystem directly, so there is nothing to fake below
 * the RPC boundary.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { stringify as stringifyYaml } from 'yaml'
import type { ApiProxy } from '../src/api/index.ts'
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

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
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
})

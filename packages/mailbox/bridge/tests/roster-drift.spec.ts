/**
 * SWD-118 roster-drift alarm at the bridge's own mount-time check
 * (`internals.checkRosterDrift`): condition (A) — this bridge's roster
 * disagreeing with another declared mount's — and condition (B) — this
 * bridge serving a name the org registry does not know. Exercises the
 * function directly rather than the full `apply()` mount, matching this
 * suite's existing pattern of driving `internals.*` against a real
 * `ctx.mailbox` without composing the agent/session infrastructure `apply`
 * would otherwise require.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import * as bridge from '../src/index.ts'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function writeRegistry(seats: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-roster-drift-registry-'))
  dirs.push(dir)
  const path = join(dir, 'registry.yml')
  const rows = seats.map(seat => `  ${seat}: { cwd: ${seat} }`).join('\n')
  writeFileSync(path, `baseDir: ${dir}\nseats:\n${rows}\n`, 'utf8')
  return path
}

async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MailboxRegistry, {})
  return ctx
}

function specWith(addresses: readonly string[], orgRegistryPath: string): ReturnType<typeof bridge.resolveBridgeSpec> {
  return bridge.resolveBridgeSpec({ addresses, orgRegistryPath })
}

describe('checkRosterDrift condition (A): cross-mount roster disagreement', () => {
  it('does not warn when this bridge is the only mount to have declared', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['target'])
    await bridge.internals.checkRosterDrift(ctx, specWith(['target'], registryPath))
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns naming both mount ids and the missing seats when another mount already declared a different roster', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['target', 'batman'])
    ctx.mailbox.declareRoster('tool-mailbox', ['target', 'batman'])
    warn.mockClear()
    await bridge.internals.checkRosterDrift(ctx, specWith(['target'], registryPath))
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]?.[0] as string
    expect(message).toContain('"mailbox-bridge"')
    expect(message).toContain('"tool-mailbox"')
    expect(message).toContain('batman')
  })

  it('does not warn when another mount already declared the identical roster', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['target'])
    ctx.mailbox.declareRoster('tool-mailbox', ['target'])
    warn.mockClear()
    await bridge.internals.checkRosterDrift(ctx, specWith(['target'], registryPath))
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('checkRosterDrift condition (B): served name unknown to the org registry', () => {
  it('does not warn when every served address is a known seat', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['target', 'alice'])
    await bridge.internals.checkRosterDrift(ctx, specWith(['target'], registryPath))
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns naming the mount id and the unknown seat when a served address is not in the registry', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['alice'])
    await bridge.internals.checkRosterDrift(ctx, specWith(['ghost'], registryPath))
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]?.[0] as string
    expect(message).toContain('"mailbox-bridge"')
    expect(message).toContain('ghost')
  })

  it('does not alarm on the registry-vs-roster gap: a registry seat this bridge does not serve is not a finding', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // The registry lists more seats than this bridge serves — the deliberate,
    // never-alarmed gap (test seats, an intentionally unserved archive seat).
    const registryPath = writeRegistry(['target', 'unserved-archive-seat'])
    await bridge.internals.checkRosterDrift(ctx, specWith(['target'], registryPath))
    expect(warn).not.toHaveBeenCalled()
  })

  it('no-ops, never warns, when the registry file is simply absent (the down-host bootstrap world)', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-roster-drift-missing-'))
    dirs.push(dir)
    await bridge.internals.checkRosterDrift(ctx, specWith(['target'], join(dir, 'no-such-registry.yml')))
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns that the check could not run — never silently "nothing is wrong" — when the registry exists but will not load', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-roster-drift-broken-'))
    dirs.push(dir)
    const path = join(dir, 'registry.yml')
    writeFileSync(path, 'baseDir: [unclosed\n', 'utf8')
    await bridge.internals.checkRosterDrift(ctx, specWith(['target'], path))
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]?.[0] as string
    expect(message).toContain(path)
    // The alarm names that the check itself could not run, distinct from
    // finding no drift: it must never read as a bare "nothing is wrong".
    expect(message).toMatch(/would not load/i)
    expect(message).toMatch(/could not|unresolved/i)
  })

  it('never throws even on an unreadable registry — the alarm never blocks the mount', async () => {
    const ctx = await makeCtx()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-roster-drift-broken2-'))
    dirs.push(dir)
    const path = join(dir, 'registry.yml')
    writeFileSync(path, 'baseDir: [unclosed\n', 'utf8')
    await expect(bridge.internals.checkRosterDrift(ctx, specWith(['target'], path))).resolves.toBeUndefined()
  })
})

/**
 * SWD-118 roster-drift alarm at the tool-mailbox mount's own mount-time
 * check (`checkRosterDrift`): condition (A) — this mount's roster
 * disagreeing with another declared mount's (e.g. `mailbox-bridge`'s) — and
 * condition (B) — this mount serving a name the org registry does not
 * know. Exercises `checkRosterDrift` directly, and separately confirms
 * `apply()` wires it in (declares under `addresses`, skips entirely when
 * unconfigured).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import * as tool from '../src/index.ts'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function writeRegistry(seats: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-mailbox-roster-drift-registry-'))
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

describe('checkRosterDrift condition (A): cross-mount roster disagreement', () => {
  it('does not warn when this mount is the only one to have declared', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['target'])
    await tool.checkRosterDrift(ctx, ['target'], registryPath)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns naming both mount ids and the missing seats when another mount already declared a different roster', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['target', 'batman'])
    ctx.mailbox.declareRoster('mailbox-bridge', ['target', 'batman'])
    warn.mockClear()
    await tool.checkRosterDrift(ctx, ['target'], registryPath)
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]?.[0] as string
    expect(message).toContain('"tool-mailbox"')
    expect(message).toContain('"mailbox-bridge"')
    expect(message).toContain('batman')
  })
})

describe('checkRosterDrift condition (B): served name unknown to the org registry', () => {
  it('does not warn when every served address is a known seat', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['target', 'alice'])
    await tool.checkRosterDrift(ctx, ['target'], registryPath)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns naming the mount id and the unknown seat when a served address is not in the registry', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['alice'])
    await tool.checkRosterDrift(ctx, ['ghost'], registryPath)
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]?.[0] as string
    expect(message).toContain('"tool-mailbox"')
    expect(message).toContain('ghost')
  })

  it('does not alarm on the registry-vs-roster gap: a registry seat this mount does not serve is not a finding', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const registryPath = writeRegistry(['target', 'unserved-archive-seat'])
    await tool.checkRosterDrift(ctx, ['target'], registryPath)
    expect(warn).not.toHaveBeenCalled()
  })

  it('no-ops, never warns, when the registry file is simply absent (the down-host bootstrap world)', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-mailbox-roster-drift-missing-'))
    dirs.push(dir)
    await tool.checkRosterDrift(ctx, ['target'], join(dir, 'no-such-registry.yml'))
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns that the check could not run — never silently "nothing is wrong" — when the registry exists but will not load', async () => {
    const ctx = await makeCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-mailbox-roster-drift-broken-'))
    dirs.push(dir)
    const path = join(dir, 'registry.yml')
    writeFileSync(path, 'baseDir: [unclosed\n', 'utf8')
    await tool.checkRosterDrift(ctx, ['target'], path)
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
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-mailbox-roster-drift-broken2-'))
    dirs.push(dir)
    const path = join(dir, 'registry.yml')
    writeFileSync(path, 'baseDir: [unclosed\n', 'utf8')
    await expect(tool.checkRosterDrift(ctx, ['target'], path)).resolves.toBeUndefined()
  })
})

describe('apply() wiring', () => {
  async function makeToolCtx(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MailboxRegistry, {})
    return ctx
  }

  it('declares and checks the roster when addresses is configured', async () => {
    const ctx = await makeToolCtx()
    const registryPath = writeRegistry(['target', 'batman'])
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // Another mount already declared a different roster; apply()'s own
    // condition-A declaration for 'tool-mailbox' must fire the drift warning.
    ctx.mailbox.declareRoster('mailbox-bridge', ['target', 'batman'])
    warn.mockClear()
    await ctx.plugin(tool, { addresses: ['target'], orgRegistryPath: registryPath })
    expect(warn.mock.calls.some(call => String(call[0]).includes('roster drift'))).toBe(true)
  })

  it('skips the roster-drift check entirely when addresses is absent (single-seat headless run)', async () => {
    const ctx = await makeToolCtx()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(tool, { sessionName: 'solo' })
    // The existing "no served roster" warning fires; the roster-drift
    // warning text must not, since there is no roster to check.
    expect(warn.mock.calls.some(call => String(call[0]).includes('roster drift'))).toBe(false)
  })
})

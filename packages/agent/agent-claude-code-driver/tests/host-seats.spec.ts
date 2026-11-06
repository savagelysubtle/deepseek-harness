/**
 * Host-private seat entries: the schema, the standalone and merged validation (model allowlist, fable
 * fence, role refusal, binary prefix, sender ceiling, cwd pin), and the mount-time checks.
 */

import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Driver from '../src/index.ts'
import { hostSeatStanza, mergeHostSeat, parseHostSeat } from '../src/seat-config.ts'
import { bootedContext, hostSeat, hostWorld, registryRow, trustingSource } from './host-fakes.ts'
import { cleanHostEnv, cleanTempDirs, fakeClaudeBinary, seatRow, tempDir } from './fakes.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  cleanTempDirs()
})

describe('parseHostSeat', () => {
  it('accepts a mail-only entry under an allowed prefix and fills the limit defaults', () => {
    const world = hostWorld()
    const config = parseHostSeat(hostSeat(world), 'ops', [world.prefix])
    expect(config).toMatchObject({
      model: 'haiku', role: 'mail-only', claudePath: world.binary, maxTurns: 25, maxBudgetUsd: 5, maxCallsPerWindow: 120, fableOk: false,
    })
  })

  it('parses lead and coder entries (the role is served or refused later, against the policy service) and rejects an unknown role', () => {
    const w = hostWorld()
    const prefixes = [w.prefix]
    expect(parseHostSeat(hostSeat(w, { role: 'lead' }), 'ops', prefixes).role).toBe('lead')
    expect(parseHostSeat(hostSeat(w, { role: 'coder' }), 'ops', prefixes).role).toBe('coder')
    expect(() => parseHostSeat(hostSeat(w, { role: 'boss' as never }), 'ops', prefixes)).toThrow(/role must be one of/)
  })

  it('applies the model allowlist and refuses fable unless the host entry opts in', () => {
    const world = hostWorld()
    expect(() => parseHostSeat(hostSeat(world, { model: 'best' }), 'ops', [world.prefix])).toThrow(/model "best" is not allowed/)
    expect(() => parseHostSeat(hostSeat(world, { model: 'fable' }), 'ops', [world.prefix])).toThrow(/fable seats need an explicit fable_ok: true/)
    expect(() => parseHostSeat(hostSeat(world, { model: 'Ｆable' }), 'ops', [world.prefix])).toThrow(/fable/)
    expect(parseHostSeat(hostSeat(world, { model: 'fable', fable_ok: true }), 'ops', [world.prefix])).toMatchObject({ model: 'fable', fableOk: true })
  })

  it('runs the static limit checks on the host entry', () => {
    const world = hostWorld()
    expect(() => parseHostSeat(hostSeat(world, { max_turns: 0 }), 'ops', [world.prefix])).toThrow(/max_turns must be a positive integer/)
    expect(() => parseHostSeat(hostSeat(world, { claude_path: 'claude' }), 'ops', [world.prefix])).toThrow(/claude_path must be an absolute path/)
    expect(parseHostSeat(hostSeat(world, {
      effort: 'low', max_turns: 3, max_budget_usd: 1, max_calls_per_window: 2, call_window_ms: 60_000, claude_path_sha256: 'A'.repeat(64),
    }), 'ops', [world.prefix])).toMatchObject({ effort: 'low', maxTurns: 3, maxBudgetUsd: 1, maxCallsPerWindow: 2, callWindowMs: 60_000, claudePathSha256: 'a'.repeat(64) })
  })

  it('requires the binary realpath under an allowed prefix', () => {
    const world = hostWorld()
    const elsewhere = tempDir('cc-elsewhere-')
    expect(() => parseHostSeat(hostSeat(world), 'ops', [elsewhere])).toThrow(/resolves to .* outside every claudePathPrefixes entry/)
    expect(() => parseHostSeat(hostSeat(world), 'ops', [])).toThrow(/claudePathPrefixes is empty/)
    // the prefix directory itself is not "inside" itself
    expect(() => parseHostSeat(hostSeat(world, { claude_path: world.binary }), 'ops', [world.binary])).toThrow(/outside every claudePathPrefixes/)
    expect(parseHostSeat(hostSeat(world), 'ops', [elsewhere, world.prefix])).toMatchObject({ claudePath: world.binary })
  })

  it('judges the realpath of the binary, so a link inside a prefix to a binary outside it is refused', () => {
    const world = hostWorld()
    const linkDir = tempDir('cc-link-')
    const link = join(linkDir, 'claude')
    symlinkSync(world.binary, link)
    expect(() => parseHostSeat(hostSeat(world, { claude_path: link }), 'ops', [linkDir])).toThrow(/resolves to .* outside every claudePathPrefixes/)
    expect(parseHostSeat(hostSeat(world, { claude_path: link }), 'ops', [world.prefix])).toMatchObject({ claudePath: link })
  })

  it('accepts a prefix that is itself a symlink to the real directory, and ignores a prefix that does not exist', () => {
    const world = hostWorld()
    const linkDir = tempDir('cc-prefix-')
    const prefixLink = join(linkDir, 'bin')
    symlinkSync(world.prefix, prefixLink)
    expect(parseHostSeat(hostSeat(world), 'ops', [prefixLink])).toMatchObject({ claudePath: world.binary })
    expect(() => parseHostSeat(hostSeat(world), 'ops', [join(linkDir, 'nowhere')])).toThrow(/outside every claudePathPrefixes/)
  })

  it('refuses a binary path that cannot be resolved', () => {
    const world = hostWorld()
    expect(() => parseHostSeat(hostSeat(world, { claude_path: join(world.prefix, 'missing') }), 'ops', [world.prefix])).toThrow(/cannot be resolved \(ENOENT\)/)
  })

  it('requires an absolute host cwd', () => {
    const world = hostWorld()
    expect(() => parseHostSeat(hostSeat(world, { cwd: 'relative/dir' }), 'ops', [world.prefix])).toThrow(/host cwd must be an absolute path/)
    expect(() => parseHostSeat(hostSeat(world, { cwd: '/tmp/a\0b' }), 'ops', [world.prefix])).toThrow(/host cwd must be an absolute path/)
    expect(() => parseHostSeat(hostSeat(world, { cwd: 7 as never }), 'ops', [world.prefix])).toThrow(/host cwd must be an absolute path/)
  })
})

describe('mergeHostSeat', () => {
  it('builds the configuration from the host entry when the row stays inside the ceiling and the pin', () => {
    const world = hostWorld()
    const config = mergeHostSeat(registryRow(world), hostSeat(world), [world.prefix], 'ops')
    expect(config).toMatchObject({ model: 'haiku', role: 'mail-only' })
    // a row that admits nobody is inside every ceiling
    expect(mergeHostSeat(registryRow(world, { admit_from: [] }), hostSeat(world, { admit_from_ceiling: [] }), [world.prefix], 'ops').role).toBe('mail-only')
    expect(mergeHostSeat({ driver: 'claude-code', cwd: world.cwd }, hostSeat(world), [world.prefix], 'ops').role).toBe('mail-only')
  })

  it('refuses a row whose driver is not claude-code', () => {
    const world = hostWorld()
    expect(() => mergeHostSeat(registryRow(world, { driver: 'default' }), hostSeat(world), [world.prefix], 'ops')).toThrow(/driver is "default", not "claude-code"/)
    expect(() => mergeHostSeat({ cwd: world.cwd }, hostSeat(world), [world.prefix], 'ops')).toThrow(/driver is "default", not "claude-code"/)
  })

  it('refuses admit_from beyond the founder ceiling and names the extra senders', () => {
    const world = hostWorld()
    expect(() => mergeHostSeat(registryRow(world, { admit_from: ['peer', 'web-bot', 'guest'] }), hostSeat(world), [world.prefix], 'ops'))
      .toThrow(/admit_from names "web-bot", "guest" beyond the host admit_from_ceiling \[peer\]/)
  })

  it('refuses a row cwd that differs from the host pin', () => {
    const world = hostWorld()
    expect(() => mergeHostSeat(registryRow(world, { cwd: '/somewhere/else' }), hostSeat(world), [world.prefix], 'ops'))
      .toThrow(/registry cwd "\/somewhere\/else" differs from the host cwd pin/)
  })

  it('still runs the host-only checks (fable fence, prefix) on a merge', () => {
    const world = hostWorld()
    expect(() => mergeHostSeat(registryRow(world), hostSeat(world, { model: 'fable' }), [world.prefix], 'ops')).toThrow(/fable/)
    expect(() => mergeHostSeat(registryRow(world), hostSeat(world), [tempDir()], 'ops')).toThrow(/outside every claudePathPrefixes/)
  })
})

describe('hostSeatStanza', () => {
  it('prints a host entry the founder can paste, prefilled from the row', () => {
    const text = hostSeatStanza('ops', { cwd: '/work/ops', admit_from: ['peer', 'lead'] })
    expect(text).toContain('hostSeats:')
    expect(text).toContain('  "ops":')
    expect(text).toContain('role: mail-only')
    expect(text).toContain('cwd: "/work/ops"')
    expect(text).toContain('admit_from_ceiling: ["peer", "lead"]')
    expect(hostSeatStanza('x', { cwd: '/w' })).toContain('admit_from_ceiling: []')
  })
})

describe('Config schema', () => {
  it('defaults the new fields and validates host entries', () => {
    const config = Driver.Config({ seats: {}, stateDir: 'cc' })
    expect(config.claudePathPrefixes).toEqual([])
    expect(config.hostSeats).toEqual({})
    const world = hostWorld()
    const parsed = Driver.Config({
      seats: {}, stateDir: 'cc', claudePathPrefixes: [world.prefix],
      hostSeats: { ops: { model: 'haiku', role: 'mail-only', claude_path: world.binary, cwd: world.cwd } as never },
    })
    expect(parsed.hostSeats?.['ops']).toMatchObject({ max_turns: 25, max_budget_usd: 5, admit_from_ceiling: [], fable_ok: false })
    expect(() => Driver.Config({
      seats: {}, stateDir: 'cc', hostSeats: { ops: { model: 'haiku', role: 'boss', claude_path: world.binary, cwd: world.cwd } as never },
    })).toThrow()
    expect(() => Driver.Config({
      seats: {}, stateDir: 'cc', hostSeats: { ops: { model: 'haiku', role: 'mail-only', claude_path: world.binary } as never },
    })).toThrow()
  })
})

describe('mounting host seats', () => {
  beforeEach(() => { cleanHostEnv() })

  it('attests and pins the binary of a host seat at mount, and logs nothing for a clean mount', async () => {
    const ctx = await bootedContext()
    const world = hostWorld()
    const fiber = await ctx.plugin(Driver, Driver.Config({
      seats: {}, stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: [world.prefix], hostSeats: { ops: hostSeat(world) },
    }))
    const pins = JSON.parse(readFileSync(join(world.stateDir, 'claude-code-binary-pins.json'), 'utf8')) as Record<string, string>
    expect(Object.keys(pins)).toEqual(['ops'])
    expect(pins['ops']).toMatch(/^[0-9a-f]{64}$/)
    await fiber.dispose()
  })

  it('refuses host seats without claudePathPrefixes, with a relative prefix, or listed in both seats and hostSeats', async () => {
    const world = hostWorld()
    await expect((await bootedContext()).plugin(Driver, Driver.Config({
      seats: {}, stateDir: 'claude-code', dshHome: world.dshHome, hostSeats: { ops: hostSeat(world) },
    }))).rejects.toThrow(/claudePathPrefixes is required/)
    await expect((await bootedContext()).plugin(Driver, Driver.Config({
      seats: {}, stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: ['relative/bin'], hostSeats: {},
    }))).rejects.toThrow(/claudePathPrefixes entry "relative\/bin" must be an absolute path/)
    await expect((await bootedContext()).plugin(Driver, Driver.Config({
      stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: [world.prefix],
      seats: { ops: seatRow({ claude_path: world.binary }) }, hostSeats: { ops: hostSeat(world) },
    }))).rejects.toThrow(/seat "ops" is configured in both seats and hostSeats/)
  })

  it('fails the mount on a bad host entry: fable without opt-in, binary outside the prefix', async () => {
    const world = hostWorld()
    const mount = (host: ReturnType<typeof hostSeat>, prefix = world.prefix) =>
      bootedContext().then(ctx => ctx.plugin(Driver, Driver.Config({
        seats: {}, stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: [prefix], hostSeats: { ops: host },
      })))
    await expect(mount(hostSeat(world, { model: 'fable' }))).rejects.toThrow(/fable/)
    await expect(mount(hostSeat(world), tempDir())).rejects.toThrow(/outside every claudePathPrefixes/)
  })

  it('refuses a host seat whose binary does not match its pinned sha256', async () => {
    const world = hostWorld()
    await expect((await bootedContext()).plugin(Driver, Driver.Config({
      seats: {}, stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: [world.prefix],
      hostSeats: { ops: hostSeat(world, { claude_path_sha256: '0'.repeat(64) }) },
    }))).rejects.toThrow(/claude_path_sha256 pins 0{64}; refusing to run it/)
  })

  it('refuses a swapped binary on the next start until the new hash is pinned (host seats share the pin file)', async () => {
    const world = hostWorld()
    const options = { seats: {}, stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: [world.prefix] }
    const first = await (await bootedContext()).plugin(Driver, Driver.Config({ ...options, hostSeats: { ops: hostSeat(world) } }))
    await first.dispose()
    writeFileSync(world.binary, '#!/bin/sh\necho upgraded\n', { mode: 0o700 })
    await expect((await bootedContext()).plugin(Driver, Driver.Config({ ...options, hostSeats: { ops: hostSeat(world) } })))
      .rejects.toThrow(/the claude binary changed/)
  })

  it('warns shortly after mount about a host entry no registry row routes to, and only for those', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const ctx = await bootedContext()
    const world = hostWorld()
    const other = fakeClaudeBinary()
    const warn = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => undefined)
    const source = { ...trustingSource(), hasRow: (seat: string) => (seat === 'routed' ? true : seat === 'unknown' ? undefined : false) }
    ctx.provide('claudeCodeSeatSource', source)
    const prefixes = [world.prefix, join(other, '..')]
    const fiber = await ctx.plugin(Driver, Driver.Config({
      seats: {}, stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: prefixes,
      hostSeats: { routed: hostSeat(world), orphan: hostSeat(world), unknown: hostSeat(world, { claude_path: other }) },
    }))
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(Driver.UNROUTED_CHECK_DELAY_MS)
    const text = warn.mock.calls.flat().join('\n')
    expect(text).toContain('host entry for seat "orphan" has no registry row with driver claude-code')
    expect(text).not.toContain('seat "routed"')
    expect(text).not.toContain('seat "unknown"')
    await fiber.dispose()
  })

  it('does not warn when no source is provided or the source cannot tell, and stops the timer on dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const ctx = await bootedContext()
    const world = hostWorld()
    const warn = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => undefined)
    const fiber = await ctx.plugin(Driver, Driver.Config({
      seats: {}, stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: [world.prefix], hostSeats: { ops: hostSeat(world) },
    }))
    await vi.advanceTimersByTimeAsync(Driver.UNROUTED_CHECK_DELAY_MS)
    expect(warn).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the factory gate', () => {
  it('makes a private single-query gate when none is given', async () => {
    const { ClaudeCodeSeatFactory } = await import('../src/factory.ts')
    const { SeatGate } = await import('../src/seat-agent.ts')
    const factory = new ClaudeCodeSeatFactory({
      ctx: await bootedContext(), resolveSeat: () => { throw new Error('unused') }, deps: {} as never, persistence: () => undefined,
    })
    expect(factory.seatGate).toBeInstanceOf(SeatGate)
  })
})

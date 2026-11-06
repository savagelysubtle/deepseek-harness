/**
 * The glue mounted with the real driver and a fake bridge (the row service only), in every order. The SDK
 * `query` is never reached: these specs open seats and refuse mail, they do not run a turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Driver from '@deepseek-ai/dsh-agent-claude-code-driver'
import * as Glue from '../src/index.ts'
import {
  binding, bootedContext, cleanHostEnv, cleanTempDirs, fakeBridge, fakeRows, hostSeat, mail, prefixOf, row, world,
} from './helpers.ts'
import type { World } from './helpers.ts'

beforeEach(() => { cleanHostEnv() })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  cleanTempDirs()
})

type Part = 'glue' | 'driver' | 'bridge'
const ORDERS: Part[][] = [
  ['glue', 'driver', 'bridge'], ['glue', 'bridge', 'driver'], ['driver', 'glue', 'bridge'],
  ['driver', 'bridge', 'glue'], ['bridge', 'glue', 'driver'], ['bridge', 'driver', 'glue'],
]

function driverConfig(w: World, host = hostSeat(w)) {
  return Driver.Config({ seats: {}, stateDir: 'claude-code', dshHome: w.dshHome, claudePathPrefixes: [prefixOf(w)], hostSeats: { ops: host } })
}

describe('the glue declares its shape', () => {
  it('is a plugin named for the package that needs only the agent registry and has no config', () => {
    expect(Glue.name).toBe('agent-claude-code-registry')
    expect(Glue.inject).toEqual(['agents'])
    expect('Config' in Glue).toBe(false)
  })
})

describe('mounting the glue, the driver and the bridge', () => {
  for (const order of ORDERS) {
    it(`opens a bridge-bound seat and refuses everything else when mounted ${order.join(' -> ')}`, async () => {
      const w = world()
      const rows = fakeRows({ ops: row(w) })
      const ctx = await bootedContext()
      const fibers = []
      for (const part of order) {
        if (part === 'glue') fibers.push(await ctx.plugin(Glue))
        else if (part === 'driver') fibers.push(await ctx.plugin(Driver, driverConfig(w)))
        else fibers.push(await ctx.plugin(fakeBridge(rows)))
      }
      const bound = binding('ops', row(w))
      const handle = await ctx.agents.create({
        sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: w.cwd }, agentOptions: { seatBinding: bound } as never,
      })
      expect(handle.agent.options).toEqual({ provider: 'claude-code', model: 'haiku' })
      await handle.dispose()

      // no binding: refused by the source
      await expect(ctx.agents.create({ sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: w.cwd } }))
        .rejects.toThrow(/no seat binding/)
      // stale binding: the registry moved on
      rows.table['ops'] = row(w, { admit_from: [] })
      await expect(ctx.agents.create({
        sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: w.cwd }, agentOptions: { seatBinding: bound } as never,
      })).rejects.toThrow(/stale binding/)
      for (const fiber of fibers.reverse()) await fiber.dispose()
    })
  }

  it('answers a mail through the admission hook end to end: a listed seat is queued, an unlisted sender is refused and recorded', async () => {
    const w = world()
    const rows = fakeRows({ ops: row(w) })
    const ctx = await bootedContext()
    await ctx.plugin(fakeBridge(rows))
    await ctx.plugin(Glue)
    await ctx.plugin(Driver, driverConfig(w))
    const hooks = ctx.claudeCodeMailHooks
    expect(hooks.admit?.({ seat: 'ops', from: 'peer', path: 'send', externalHops: [], tainted: false, turnTainted: false })).toEqual({ allow: true })
    const handle = await ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: w.cwd }, agentOptions: { seatBinding: binding('ops', row(w)) } as never,
    })
    handle.agent.followup(mail('intruder', 'm-1'))
    await handle.agent.whenIdle()
    const refused = handle.agent.session.events.filter(event => event.type === 'claude-code/refused')
    expect(refused).toHaveLength(1)
    expect(JSON.stringify(refused[0])).toContain('sender \\"intruder\\" is not in admit_from')
    await handle.dispose()
  })

  it('provides hooks with an admit check and no lease, so the driver keeps its own lease handling', async () => {
    const ctx = await bootedContext()
    await ctx.plugin(Glue)
    const hooks = ctx.claudeCodeMailHooks
    expect(typeof hooks.admit).toBe('function')
    expect(Object.hasOwn(hooks, 'lease')).toBe(false)
    expect('lease' in hooks).toBe(false)
    expect(Object.keys(hooks)).toEqual(['admit'])
  })

  it('mounts a lead host entry without a policy service: the role is judged at create time, not at mount (see role-gates.spec.ts in the driver)', async () => {
    const w = world()
    const ctx = await bootedContext()
    await ctx.plugin(Glue)
    await expect(ctx.plugin(Driver, driverConfig(w, hostSeat(w, { role: 'lead' })))).resolves.toBeDefined()
  })

  it('refuses a row without a host entry and prints the stanza, through the real source', async () => {
    const w = world()
    const rows = fakeRows({ newcomer: row(w) })
    const ctx = await bootedContext()
    await ctx.plugin(fakeBridge(rows))
    await ctx.plugin(Glue)
    await ctx.plugin(Driver, driverConfig(w))
    await expect(ctx.agents.create({
      sessionId: SessionId('named-newcomer'), driver: 'claude-code', meta: { cwd: w.cwd }, agentOptions: { seatBinding: binding('newcomer', row(w)) } as never,
    })).rejects.toThrow(/seat "newcomer" is routed to claude-code by the registry but has no host entry/)
  })

  it('warns once the registry is loaded about a host entry with no registry row (the glue answers hasRow)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = world()
    const ctx = await bootedContext()
    const warn = vi.spyOn(Object.getPrototypeOf(ctx.logger) as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(fakeBridge(fakeRows({})))
    await ctx.plugin(Glue)
    const fiber = await ctx.plugin(Driver, driverConfig(w))
    await vi.advanceTimersByTimeAsync(Driver.UNROUTED_CHECK_DELAY_MS)
    expect(warn.mock.calls.flat().join('\n')).toContain('host entry for seat "ops" has no registry row')
    await fiber.dispose()
    vi.useRealTimers()
  })
})

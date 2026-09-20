// @vitest-environment jsdom
/**
 * Registration acceptance on the real framework stack: the org-board entry
 * lands in the sidebar's real `sidebar.footer.action` list slot alongside
 * existing occupants, its labels follow the active locale, its injected
 * `load` routes straight through to `ctx.connection.api.org.get`, and fiber
 * disposal removes it.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as localeApply, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import type { OrgBoardFace } from '../src/client/slots.ts'
import type { ResponseValue } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Typed against the real response, so a field added to `org.get` breaks this
 * file at build time. It was two untyped inline literals until 2026-09-20,
 * which let them fall a field behind the server with nothing failing: the
 * board was reading a value these mocks had never carried, and every test
 * here still passed against a shape the server no longer sends.
 */
const ORG_GET_VALUE: ResponseValue<'org.get'> = {
  profile: 'web-stable',
  registry: {
    ok: true,
    registry: { baseDir: '/org', seats: {}, edges: [], callUp: [] },
    document: { baseDir: '/org', seats: {}, edges: [], callUp: [] },
    token: 'registry-token',
  },
  mailboxBridge: { ok: true, addresses: [] },
  toolMailbox: { ok: true, addresses: [] },
  drift: { ok: true, rows: [] },
  servedRosterToken: { ok: true, token: 'served-roster-token' },
}

afterEach(cleanup)

/** Real-stack bench: root Context + real SlotRegistry ring + the plugin fiber. */
async function bench(orgGet: (payload: unknown) => unknown) {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  // The sidebar shell's role: declare the ring and seed two existing
  // occupants (mirroring the shipped cordis-panel + org-controls entries).
  slots.register({
    name: 'root',
    children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
  }, (_p: { renderSlot?: unknown }) => null)
  slots.register(
    { name: 'sidebar.footer.action', id: 'cordis-panel' } as never,
    (() => null) as never,
  )
  slots.register(
    { name: 'sidebar.footer.action', id: 'send-all' } as never,
    (() => null) as never,
  )
  ctx.provide('connection', { api: { org: { get: orgGet }, settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  ctx.plugin({ inject: [...localeInject], apply: localeApply })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

function idsOf(slots: SlotRegistry): string[] {
  return slots.entries('sidebar.footer.action').map(e => e.options.id as string)
}

describe('plugin registration', () => {
  it('adds org-board after the existing cordis-panel and send-all entries', async () => {
    const b = await bench(vi.fn())
    expect(idsOf(b.slots)).toEqual(['cordis-panel', 'send-all', 'org-board'])
  })

  it('fiber disposal removes org-board and leaves the other entries standing', async () => {
    const b = await bench(vi.fn())
    await b.fiber.dispose()
    expect(idsOf(b.slots)).toEqual(['cordis-panel', 'send-all'])
  })

  it('routes the injected load face straight through to ctx.connection.api.org.get', async () => {
    const orgGet = vi.fn().mockResolvedValue({ result: { ok: true, value: ORG_GET_VALUE } })
    const b = await bench(orgGet)
    const entry = b.slots.entries('sidebar.footer.action').find(e => e.options.id === 'org-board')
    const face = (entry?.inject as (() => OrgBoardFace) | undefined)?.()
    await face?.load()
    expect(orgGet).toHaveBeenCalledWith({})
    expect(face?.hooks.orgBoard.getSnapshot().status).toBe('ready')
  })

  it('a reconnect re-reads a loaded board, so pre-reconnect wiring is never left on screen', async () => {
    const orgGet = vi.fn().mockResolvedValue({ result: { ok: true, value: ORG_GET_VALUE } })
    const b = await bench(orgGet)
    const entry = b.slots.entries('sidebar.footer.action').find(e => e.options.id === 'org-board')
    const face = (entry?.inject as (() => OrgBoardFace) | undefined)?.()
    await face?.load()
    expect(orgGet).toHaveBeenCalledTimes(1)

    // The listener itself is the thing under test: refreshing on reconnect is
    // only worth anything if the plugin actually subscribes, and a unit test
    // of the refresh helper alone would pass with the wiring deleted.
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(orgGet).toHaveBeenCalledTimes(2) })
  })

  it('a reconnect before the board was ever opened issues nothing', async () => {
    const orgGet = vi.fn()
    const b = await bench(orgGet)
    b.ctx.emit('connection/reset')
    expect(orgGet).not.toHaveBeenCalled()
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})

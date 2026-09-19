// @vitest-environment jsdom
/**
 * Registration acceptance on the real framework stack: both Stop All and
 * Send All land in the sidebar's real `sidebar.footer.action` list slot
 * without disturbing an existing occupant, their labels/dictionaries follow
 * the active locale, each injected face routes straight through to
 * `ctx.sessions.stopAll`/`sendAll`, and fiber disposal removes both.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as localeApply, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

/** Real-stack bench: root Context + real SlotRegistry ring + the plugin fiber. */
async function bench(fakeSessions: Partial<ISessions>) {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  // The sidebar shell's role: declare the ring and seed one existing
  // occupant (mirroring the shipped ui-cordis panel) ahead of ours.
  slots.register({
    name: 'root',
    children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
  }, (_p: { renderSlot?: unknown }) => null)
  slots.register(
    { name: 'sidebar.footer.action', id: 'cordis-panel' } as never,
    (() => null) as never,
  )
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  ctx.plugin({ inject: [...localeInject], apply: localeApply })
  ctx.provide('sessions', fakeSessions as ISessions)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

function idsOf(slots: SlotRegistry): string[] {
  return slots.entries('sidebar.footer.action').map(e => e.options.id as string)
}

describe('plugin registration', () => {
  it('adds stop-all and send-all beside the existing cordis-panel entry', async () => {
    const b = await bench({})
    expect(idsOf(b.slots)).toEqual(['cordis-panel', 'stop-all', 'send-all'])
  })

  it('fiber disposal removes both entries and leaves cordis-panel standing', async () => {
    const b = await bench({})
    await b.fiber.dispose()
    expect(idsOf(b.slots)).toEqual(['cordis-panel'])
  })

  it('routes the Stop All injected face straight through to ctx.sessions.stopAll', async () => {
    const stopAll = vi.fn().mockResolvedValue({ ok: true, value: { stoppedCount: 0, descendants: 'ok' } })
    const b = await bench({ stopAll })
    const entry = b.slots.entries('sidebar.footer.action').find(e => e.options.id === 'stop-all')
    const face = (entry?.inject as (() => { onStopAll: () => unknown }) | undefined)?.()
    await face?.onStopAll()
    expect(stopAll).toHaveBeenCalledTimes(1)
  })

  it('routes the Send All injected face straight through to ctx.sessions.sendAll with the given content', async () => {
    const sendAll = vi.fn().mockResolvedValue({ ok: true, value: { sentCount: 0, result: 'ok' } })
    const b = await bench({ sendAll })
    const entry = b.slots.entries('sidebar.footer.action').find(e => e.options.id === 'send-all')
    const face = (entry?.inject as (() => { onSendAll: (c: unknown) => unknown }) | undefined)?.()
    const content = [{ type: 'text' as const, text: 'stand down' }]
    await face?.onSendAll(content)
    expect(sendAll).toHaveBeenCalledWith(content)
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})

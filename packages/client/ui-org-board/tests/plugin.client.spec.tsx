// @vitest-environment jsdom
/**
 * Registration acceptance on the real framework stack: the org-board entry
 * lands in the sidebar's real `sidebar.footer.action` list slot alongside
 * existing occupants, its labels follow the active locale, its injected
 * `load` routes straight through to `ctx.connection.api.org.get`, and fiber
 * disposal removes it.
 */
import { useSyncExternalStore } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as localeApply, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { OrgBoardControl, type OrgBoardControlProps } from '../src/client/OrgBoardControl.tsx'
import type { OrgBoardFace } from '../src/client/slots.ts'
import type { OrgBoardState } from '../src/client/org-board-store.ts'
import { en, type OrgBoardKey } from '../src/client/locales.ts'
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

/**
 * Extends {@link ORG_GET_VALUE} (never a second untyped literal -- see its
 * own doc comment) with one fully-served registered seat, for the served-
 * toggle reachability test below: a real seat to select, a real drift
 * report agreeing it is served by both rosters, and the same
 * `servedRosterToken` the write must be guarded by.
 */
const ORG_GET_VALUE_ONE_SEAT: ResponseValue<'org.get'> = {
  ...ORG_GET_VALUE,
  registry: {
    ok: true,
    registry: { baseDir: '/org', seats: { alfred: { cwd: '/org/alfred' } }, edges: [], callUp: [] },
    document: { baseDir: '/org', seats: { alfred: { cwd: 'alfred' } }, edges: [], callUp: [] },
    token: 'registry-token',
  },
  mailboxBridge: { ok: true, addresses: ['alfred'] },
  toolMailbox: { ok: true, addresses: ['alfred'] },
}

afterEach(cleanup)

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })

/**
 * Real-stack bench: root Context + real SlotRegistry ring + the plugin
 * fiber. `orgWriteServed` defaults to an unused stub -- only the served-
 * toggle reachability test below supplies a real one, since it is the only
 * test in this file that ever calls `org.writeServed`.
 */
async function bench(orgGet: (payload: unknown) => unknown, orgWriteServed: (payload: unknown) => unknown = vi.fn()) {
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
  ctx.provide('connection', { api: { org: { get: orgGet, writeServed: orgWriteServed }, settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  ctx.plugin({ inject: [...localeInject], apply: localeApply })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

/** Minimal mustache-style interpolation over the real English dictionary (same pattern as the board's own tests). */
function translate(key: LocaleKeysOf<'orgBoard'>, params?: Record<string, unknown>): string {
  const template = en[key as OrgBoardKey] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : `{${name}}`
  })
}

/** Stubs for the two GlobalStandardProps hooks OrgBoardControl never reads. */
const useSessions = (() => {
  throw new Error('OrgBoardControl must not call useSessions')
}) as unknown as OrgBoardControlProps['useSessions']
const useWorkspaces = (() => {
  throw new Error('OrgBoardControl must not call useWorkspaces')
}) as unknown as OrgBoardControlProps['useWorkspaces']

/**
 * A REAL `useOrgBoard` selector hook bound to one plugin instance's own
 * `hooks.orgBoard` snapshot store -- the uSES bridge `web-react` normally
 * synthesizes at the slot-rendering seam, reproduced by hand here because
 * this bench renders `OrgBoardControl` directly rather than going through
 * the full slot renderer.
 * @param face - the injected face from a real `entry.inject()` call.
 * @returns a selector hook reading that face's live store.
 */
function useOrgBoardFromFace(face: OrgBoardFace): OrgBoardControlProps['useOrgBoard'] {
  return <S,>(selector: (snapshot: OrgBoardState) => S): S =>
    useSyncExternalStore(
      onChange => face.hooks.orgBoard.subscribe(onChange),
      () => selector(face.hooks.orgBoard.getSnapshot()),
    )
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

describe('served toggle reachability (SWD-134 slice 5 step 3)', () => {
  it('drives a served toggle through the real component tree (OrgBoardControl into OrgBoard) into ctx.connection.api.org.writeServed', async () => {
    // THE MANDATORY REACHABILITY TEST: slice 4 step 4 already learned this
    // lesson once -- a whole edit surface shipped wired to nothing, fully
    // green, because every test mounted OrgBoard directly with its own
    // mocks and never crossed the seam only OrgBoardControl closes. This
    // mounts OrgBoardControl (never OrgBoard directly) with the plugin's
    // OWN real injected face, so `setSeatServed` really does have to reach
    // ctx.connection.api.org.writeServed for this test to pass.
    const orgGet = vi.fn().mockResolvedValue({ result: { ok: true, value: ORG_GET_VALUE_ONE_SEAT } })
    const writeServed = vi.fn().mockResolvedValue({
      result: { ok: true, value: { addresses: [], token: 'served-roster-token-2' } },
    })
    const b = await bench(orgGet, writeServed)
    const entry = b.slots.entries('sidebar.footer.action').find(e => e.options.id === 'org-board')
    const face = (entry?.inject as (() => OrgBoardFace) | undefined)?.()
    if (face === undefined) throw new Error('org-board entry did not inject a face')

    render(
      <OrgBoardControl
        wide
        useSessions={useSessions}
        useWorkspaces={useWorkspaces}
        useOrgBoard={useOrgBoardFromFace(face)}
        load={face.load}
        addSeat={face.addSeat}
        removeSeat={face.removeSeat}
        addEdge={face.addEdge}
        removeEdge={face.removeEdge}
        setSeatTools={face.setSeatTools}
        setSeatServed={face.setSeatServed}
        t={translate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Org Board' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    // Opening the modal issued the real `load()`, through the real
    // controller, against the mocked `org.get` above -- wait for its seat.
    fireEvent.click(await screen.findByText('alfred'))
    fireEvent.click(screen.getByRole('button', { name: 'Change served status' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop serving' }))

    await vi.waitFor(() => { expect(writeServed).toHaveBeenCalledTimes(1) })
    expect(writeServed).toHaveBeenCalledWith({ addresses: [], expectedToken: 'served-roster-token', acknowledgeSplit: false })
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})

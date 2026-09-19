// @vitest-environment jsdom
/**
 * View registration acceptance on the real framework stack: the plugin fiber
 * registers Agents into a real SlotRegistry view ring behind Chat and
 * Trajectory without collapsing either, the tab label follows the active
 * locale, the view renders the current conversation's subagent tree through
 * the same renderSlot share ConversationSession drives, and fiber disposal
 * removes the tab.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { FC, ReactNode } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSnapshotStore, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps, ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as localeApply, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-agents/client'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-agents'

const SID = 's1' as SessionId

afterEach(cleanup)

function emptySessionsFixture(): SessionListState {
  return {
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

/** Real-stack bench: root Context + real SlotRegistry ring + the plugin fiber. */
async function bench() {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  // The conversation entry's role: declare the ring, then seed Chat and
  // Trajectory ahead of Agents (order 0 and 10; Agents registers at 20).
  slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  }, (_p: { renderSlot?: unknown }) => null)
  slots.register(
    { name: 'conversation.view', id: 'chat', order: 0, label: 'Chat' } as never,
    (() => <div data-testid="chat-body" />) as never,
  )
  slots.register(
    { name: 'conversation.view', id: 'trajectory', order: 10, label: 'Trajectory' } as never,
    (() => <div data-testid="trajectory-body" />) as never,
  )
  // The locale plugin backs the locale-aware view tab label ('locale' in
  // inject); its settings scope needs a connection handle and the
  // forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  ctx.plugin({ inject: [...localeInject], apply: localeApply })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber }
}

/** Tab projection twin of the render-side consumption path. */
function tabsOf(slots: SlotRegistry): ViewTab[] {
  return slots.entries('conversation.view')
    .map(e => ({ id: e.options.id!, label: resolveSlotLabel(e.options.label) ?? e.options.id! }))
}

/** Minimal outlet twin: resolve the ring entry by the `only` filter and
 * render it with the session standard kit plus the real bound locale seat, as
 * ConversationSession and the framework's locale merge do for a list-kind
 * session slot. */
function renderRing(ctx: Context, slots: SlotRegistry, sessions: SessionListState, only: string) {
  const useSessions = bindSnapshotSelector(createSnapshotStore(sessions))
  const t = (ctx.get('locale') as { bind: (ns: string) => (key: string, params?: Record<string, unknown>) => string }).bind('agents')
  const renderSlot = (): ReactNode => {
    const entry = slots.entries('conversation.view').find(e => e.options.id === only)
    if (entry === undefined) return null
    const View = entry.component as FC<ConvViewProps>
    return <View {...({ sessionId: SID, useSessions, t } as unknown as ConvViewProps)} />
  }
  return render(<>{renderSlot()}</>)
}

describe('plugin registration', () => {
  it('registers agents behind chat and trajectory on the ring', async () => {
    const b = await bench()
    expect(tabsOf(b.slots)).toEqual([
      { id: 'chat', label: 'Chat' },
      { id: 'trajectory', label: 'Trajectory' },
      { id: 'agents', label: 'Agents' },
    ])
  })

  it('fiber disposal removes the tab and leaves chat/trajectory standing', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(tabsOf(b.slots).map(v => v.id)).toEqual(['chat', 'trajectory'])
  })

  it('labels the agents tab in the active locale', async () => {
    const b = await bench()
    const labelOf = () => tabsOf(b.slots).find(tab => tab.id === 'agents')?.label
    expect(labelOf()).toBe('Agents')
    const locale = b.ctx.get('locale') as { setLocale(id: string): void }
    locale.setLocale('zh')
    expect(labelOf()).toBe('代理')
    locale.setLocale('en')
    expect(labelOf()).toBe('Agents')
  })
})

describe('rendering through the ring', () => {
  it('renders the current conversation\'s subagent tree via the standard renderSlot share', async () => {
    const b = await bench()
    renderRing(b.ctx, b.slots, {
      ids: [SID, 'child' as SessionId],
      byId: {
        [SID]: { id: SID, displayTitle: 'root', running: false, attached: true, blank: false, updatedAt: 0 },
        ['child' as SessionId]: {
          id: 'child' as SessionId, displayTitle: 'Child agent', running: true, attached: true,
          blank: false, updatedAt: 0, origin: 'subagent', parentId: SID,
        },
      },
      current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }, 'agents')
    expect(screen.getByText('Child agent')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('says nothing is running when the current conversation has no subagents', async () => {
    const b = await bench()
    renderRing(b.ctx, b.slots, emptySessionsFixture(), 'agents')
    expect(screen.getByText('No subagents are running under this conversation.')).toBeTruthy()
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})

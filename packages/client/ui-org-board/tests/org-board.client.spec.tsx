// @vitest-environment jsdom
/**
 * Component-level behavior for the hard requirement this package exists to
 * satisfy: a failure must never render as emptiness, and must never render
 * as a clean board. Covers every status branch, every one of the three
 * inner result unions failing independently, drift suppression when any
 * source it depends on failed, the zero-seat (legitimately empty, never
 * confusable with a failure) case, badges, and the detail panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ResponseValue } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { OrgBoard } from '../src/client/OrgBoard.tsx'
import type { OrgBoardState } from '../src/client/org-board-store.ts'
import { en, type OrgBoardKey } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * jsdom has no real layout engine, so React Flow's own geometry measurement
 * (ResizeObserver + getBoundingClientRect + the CSS transform it reads back
 * via DOMMatrixReadOnly) never fires and it silently skips drawing edges.
 * This is the documented jsdom stub recipe (xyflow/xyflow#377): all four
 * pieces are required together -- removing any one leaves edges undrawn.
 */
class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}
  // React Flow measures a node's DOM size from *this* callback firing, not
  // from offsetWidth/offsetHeight directly -- a no-op observe() (the usual
  // stub shape for components that only need ResizeObserver to exist) leaves
  // every node permanently "unmeasured", and an unmeasured node never gets
  // an edge drawn to it. The callback must fire ASYNCHRONOUSLY (a real
  // ResizeObserver never fires inside the same tick as observe()): React
  // Flow's own wrapper sets its `domNode` ref in a *parent* effect, which
  // React commits AFTER this node's *child* effect calls observe() --
  // firing synchronously lands the measurement before `domNode` exists, so
  // React Flow's own internal guard silently drops it.
  observe(target: Element): void {
    const rect = target.getBoundingClientRect()
    const entry: ResizeObserverEntry = { target, contentRect: rect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }
    queueMicrotask(() => { this.callback([entry], this) })
  }
  unobserve(): void {}
  disconnect(): void {}
}
class DOMMatrixReadOnlyStub {
  m22 = 1
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub)
  vi.stubGlobal('DOMMatrix', DOMMatrixReadOnlyStub)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 100 })
  HTMLElement.prototype.getBoundingClientRect = () => (
    { x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, toJSON() { return this } }
  )
})

/** Minimal mustache-style interpolation over the real English dictionary (same pattern as ui-org-controls' tests). */
function translate(key: LocaleKeysOf<'orgBoard'>, params?: Record<string, unknown>): string {
  const template = en[key as OrgBoardKey] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : `{${name}}`
  })
}

function ready(value: ResponseValue<'org.get'>): OrgBoardState {
  return { status: 'ready', error: null, value }
}

const BASE_VALUE: ResponseValue<'org.get'> = {
  profile: 'web-stable',
  registry: {
    ok: true,
    registry: {
      baseDir: '/org',
      seats: {
        alfred: { cwd: '/org/deepseek-harness', lead: true, sessionId: 'sess-alfred' },
        batman: {
          cwd: '/org/deepseek-harness', test: true, tools: { allow: ['bash'], deny: ['web'] },
        },
        robin: { cwd: '/org/deepseek-harness' },
      },
      edges: [['alfred', 'batman']],
      callUp: ['alfred'],
    },
    token: 'token-1',
  },
  mailboxBridge: { ok: true, addresses: ['alfred', 'batman', 'robin'] },
  toolMailbox: { ok: true, addresses: ['alfred', 'batman', 'robin'] },
  drift: {
    ok: true,
    rows: [
      { seat: 'robin', registered: true, servedByMailboxBridge: false, servedByToolMailbox: true },
      { seat: 'ghost', registered: false, servedByMailboxBridge: true, servedByToolMailbox: false },
    ],
  },
}

describe('OrgBoard', () => {
  it('renders only the top-level failure banner on an outer RPC error, nothing else', () => {
    const state: OrgBoardState = { status: 'error', error: 'connection lost', value: null }
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByRole('alert').textContent).toBe('Org board unavailable: connection lost')
    expect(screen.queryByText(/Profile:/)).toBeNull()
    expect(screen.queryByText('Drift (registry vs. served rosters)')).toBeNull()
  })

  it('still renders the failure banner (with an empty reason, never a crash) if error is somehow null on an error status', () => {
    const state: OrgBoardState = { status: 'error', error: null, value: null }
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByRole('alert').textContent).toBe('Org board unavailable: ')
  })

  it('shows a loading message before any response has landed (idle)', () => {
    const state: OrgBoardState = { status: 'idle', error: null, value: null }
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByText('Loading organisation…')).toBeTruthy()
  })

  it('shows a loading message while loading with no prior value', () => {
    const state: OrgBoardState = { status: 'loading', error: null, value: null }
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByText('Loading organisation…')).toBeTruthy()
  })

  it('always shows the profile once a response has landed, even when everything else failed', () => {
    const state = ready({
      profile: 'web-stable',
      registry: { ok: false, reason: 'registry.yml not found' },
      mailboxBridge: { ok: false, reason: 'patch mount absent' },
      toolMailbox: { ok: false, reason: 'patch file unreadable' },
      drift: { ok: false, reason: 'registry, mailboxBridge, toolMailbox unavailable' },
    })
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByText('Profile: web-stable')).toBeTruthy()
  })

  it('a failed registry shows the reason and renders no graph section at all (never an empty canvas)', () => {
    const state = ready({
      ...BASE_VALUE,
      registry: { ok: false, reason: 'registry.yml not found' },
      drift: { ok: false, reason: 'registry unavailable' },
    })
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByText('Registry unavailable: registry.yml not found')).toBeTruthy()
    expect(screen.queryByText(/Seats and mail permissions/)).toBeNull()
    expect(screen.getByText('Drift unavailable: registry unavailable')).toBeTruthy()
  })

  it('a failed roster shows its own reason AND suppresses the drift result rather than showing a clean one', () => {
    const state = ready({
      ...BASE_VALUE,
      mailboxBridge: { ok: false, reason: 'patch mount absent' },
      drift: { ok: false, reason: 'mailboxBridge unavailable' },
    })
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByText('Mailbox-bridge roster unavailable: patch mount absent')).toBeTruthy()
    expect(screen.getByText('Drift unavailable: mailboxBridge unavailable')).toBeTruthy()
    // Never a clean "None" / "None" drift listing when drift itself failed.
    expect(screen.queryByText('None')).toBeNull()
    // The graph still draws: registry itself succeeded, so seat identity is real data.
    expect(screen.getByText(/Seats and mail permissions/)).toBeTruthy()
  })

  it('a failed tool-mailbox roster shows its own reason', () => {
    const state = ready({
      ...BASE_VALUE,
      toolMailbox: { ok: false, reason: 'patch file unreadable' },
      drift: { ok: false, reason: 'toolMailbox unavailable' },
    })
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByText('Tool-mailbox roster unavailable: patch file unreadable')).toBeTruthy()
  })

  it('drift registered-but-unserved and served-but-unregistered rows surface with their roster detail', () => {
    render(<OrgBoard state={ready(BASE_VALUE)} t={translate} />)
    expect(screen.getByText('Registered but not served (1)')).toBeTruthy()
    expect(screen.getByText('robin — missing from: mailbox-bridge')).toBeTruthy()
    expect(screen.getByText('Served but not registered (1)')).toBeTruthy()
    expect(screen.getByText('ghost — served by: mailbox-bridge')).toBeTruthy()
  })

  it('an empty drift report shows None on both sides', () => {
    const state = ready({ ...BASE_VALUE, drift: { ok: true, rows: [] } })
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByText('Registered but not served (0)')).toBeTruthy()
    expect(screen.getByText('Served but not registered (0)')).toBeTruthy()
    expect(screen.getAllByText('None')).toHaveLength(2)
  })

  it('a registry with zero seats shows an explicit empty message, not a bare canvas', () => {
    const state = ready({
      ...BASE_VALUE,
      registry: { ok: true, registry: { baseDir: '/org', seats: {}, edges: [], callUp: [] }, token: 'token-2' },
      drift: { ok: true, rows: [] },
    })
    render(<OrgBoard state={state} t={translate} />)
    expect(screen.getByText('No seats in the registry.')).toBeTruthy()
    expect(screen.getByText(/0 seat\(s\)/)).toBeTruthy()
  })

  it('draws seat nodes with their badges and the detail hint before any selection', () => {
    render(<OrgBoard state={ready(BASE_VALUE)} t={translate} />)
    expect(screen.getByText('alfred')).toBeTruthy()
    expect(screen.getByText('batman')).toBeTruthy()
    expect(screen.getByText('robin')).toBeTruthy()
    expect(screen.getByText('Lead')).toBeTruthy()
    expect(screen.getByText('Test seat')).toBeTruthy()
    expect(screen.getByText('May mail anyone')).toBeTruthy()
    // robin has a drift row (missing from mailbox-bridge), so its node badges too.
    expect(screen.getByText('Not fully served')).toBeTruthy()
    expect(screen.getByText('Select a seat to see its details.')).toBeTruthy()
  })

  it('clicking a seat node opens its detail panel with cwd, session id, and tool lists', () => {
    render(<OrgBoard state={ready(BASE_VALUE)} t={translate} />)
    fireEvent.click(screen.getByText('batman'))
    expect(screen.getByText('/org/deepseek-harness')).toBeTruthy()
    expect(screen.getByText('No session recorded')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByText('web')).toBeTruthy()
  })

  it('a selected seat with a recorded session id shows it', () => {
    render(<OrgBoard state={ready(BASE_VALUE)} t={translate} />)
    fireEvent.click(screen.getByText('alfred'))
    expect(screen.getByText('sess-alfred')).toBeTruthy()
  })

  it('a selected seat with no tool restrictions shows one explicit line, not two', () => {
    render(<OrgBoard state={ready(BASE_VALUE)} t={translate} />)
    fireEvent.click(screen.getByText('robin'))
    expect(screen.getAllByText('No tool restrictions')).toHaveLength(1)
  })

  it('clicking the pane clears the selection back to the hint', () => {
    const { container } = render(<OrgBoard state={ready(BASE_VALUE)} t={translate} />)
    fireEvent.click(screen.getByText('alfred'))
    expect(screen.queryByText('Select a seat to see its details.')).toBeNull()
    const pane = container.querySelector('.react-flow__pane')
    expect(pane).toBeTruthy()
    fireEvent.click(pane as Element)
    expect(screen.getByText('Select a seat to see its details.')).toBeTruthy()
  })

  it('draws the undirected edge between the two registry-declared seats', async () => {
    const { container } = render(<OrgBoard state={ready(BASE_VALUE)} t={translate} />)
    // Node measurement lands on the next tick (see the ResizeObserverStub
    // note above); an edge only draws once both endpoint nodes are measured.
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
  })
})

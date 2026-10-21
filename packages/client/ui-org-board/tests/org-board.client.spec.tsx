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
import {
  act, cleanup, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react'
import type { ResponseValue } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { OrgBoard } from '../src/client/OrgBoard.tsx'
import type { OrgBoardProps } from '../src/client/OrgBoard.tsx'
import type { OrgBoardState, OrgBoardWriteNotice } from '../src/client/org-board-store.ts'
import { en, type OrgBoardKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Drop any size override a test installed, restoring jsdom's own (0) getters.
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
})

/**
 * jsdom has no real layout engine, so React Flow's own geometry measurement
 * (ResizeObserver + getBoundingClientRect + the CSS transform it reads back
 * via DOMMatrixReadOnly) never fires and it silently skips drawing edges.
 * This is the documented jsdom stub recipe (xyflow/xyflow#377): all four
 * pieces are required together -- removing any one leaves edges undrawn.
 */
/** Every live stub observer's callback, so a test can announce a container resize. */
const observerCallbacks: ResizeObserverCallback[] = []
class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) { observerCallbacks.push(callback) }
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
  observerCallbacks.length = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub)
  vi.stubGlobal('DOMMatrix', DOMMatrixReadOnlyStub)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 100 })
  HTMLElement.prototype.getBoundingClientRect = () => (
    { x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, toJSON() { return this } }
  )
  // jsdom has no `document.elementFromPoint` at all (not even a null-
  // returning stub) -- @xyflow/system's click-to-connect handle validation
  // (`isValidHandle`) calls it first and only falls back to its own
  // `data-id` handle lookup when it returns a falsy value, so this needs a
  // real (if trivial) stub rather than being left undefined.
  document.elementFromPoint = () => null
})

/**
 * Fire a hover (mouseEnter) on one seat's React Flow node wrapper. SWD-163
 * step 8 made the default edge set empty -- most of the pre-existing edge
 * tests below only need SOME edge on screen to click or to wait on as a
 * "nodes are measured" signal (see the ResizeObserverStub note above), and
 * are not themselves testing the hover/select reveal; this is how they get
 * one drawn without duplicating that logic at every call site.
 */
function hoverSeat(container: HTMLElement, name: string): void {
  const node = container.querySelector(`.react-flow__node[data-id="${name}"]`)
  fireEvent.mouseEnter(node as Element)
}

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
  return { status: 'ready', error: null, value, write: { pending: false, notice: null }, servedWrite: { pending: false, notice: null } }
}

/** A ready snapshot carrying a write-side notice (and optionally `pending`), for the notice/disabled-controls tests. */
function withNotice(value: ResponseValue<'org.get'>, notice: OrgBoardWriteNotice, pending = false): OrgBoardState {
  return { status: 'ready', error: null, value, write: { pending, notice }, servedWrite: { pending: false, notice: null } }
}

/**
 * Fresh mock verbs for one render: every `OrgBoardProps` write verb,
 * resolving to `undefined` by default. `NonNullable` because the props
 * themselves are typed optional (an interim shim for `OrgBoardControl.tsx`
 * not yet forwarding them -- see `OrgBoardProps`'s own doc comment) -- every
 * test here still exercises the REAL signature, always supplied.
 */
function verbs() {
  return {
    addSeat: vi.fn<NonNullable<OrgBoardProps['addSeat']>>().mockResolvedValue(undefined),
    removeSeat: vi.fn<NonNullable<OrgBoardProps['removeSeat']>>().mockResolvedValue(undefined),
    addEdge: vi.fn<NonNullable<OrgBoardProps['addEdge']>>().mockResolvedValue(undefined),
    removeEdge: vi.fn<NonNullable<OrgBoardProps['removeEdge']>>().mockResolvedValue(undefined),
    setSeatTools: vi.fn<NonNullable<OrgBoardProps['setSeatTools']>>().mockResolvedValue(undefined),
    setSeatServed: vi.fn<NonNullable<OrgBoardProps['setSeatServed']>>().mockResolvedValue(undefined),
  }
}

/**
 * Render `OrgBoard` with fresh mock verbs (override any subset), returning
 * the render result plus the verb mocks themselves and a `rerenderWithState`
 * helper that keeps the SAME verb mocks across a re-render -- needed for the
 * Retry test, which must observe the SAME mock across an initial submit and
 * a later re-render carrying a `write-failed` notice.
 */
function renderBoard(state: OrgBoardState, overrides: Partial<ReturnType<typeof verbs>> = {}) {
  const v = { ...verbs(), ...overrides }
  const onRefresh = vi.fn()
  const utils = render(<OrgBoard state={state} t={translate} onRefresh={onRefresh} {...v} />)
  return {
    ...utils,
    ...v,
    onRefresh,
    rerenderWithState: (next: OrgBoardState) => {
      utils.rerender(<OrgBoard state={next} t={translate} onRefresh={onRefresh} {...v} />)
    },
  }
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
    // The unresolved twin: cwds RELATIVE, exactly as a hand-edited file carries
    // them, against the resolved absolute paths above. Deliberately different
    // values -- an edit built from the resolved view would rewrite every one of
    // these to absolute, so a fixture where both shapes matched would hide the
    // very mistake these two fields exist to prevent.
    document: {
      baseDir: '/org',
      seats: {
        alfred: { cwd: 'deepseek-harness', lead: true, sessionId: 'sess-alfred' },
        batman: {
          cwd: 'deepseek-harness', test: true, tools: { allow: ['bash'], deny: ['web'] },
        },
        robin: { cwd: 'deepseek-harness' },
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
  servedRosterToken: { ok: true, token: 'served-token-1' },
}

describe('OrgBoard', () => {
  it('renders only the top-level failure banner on an outer RPC error, nothing else', () => {
    const state: OrgBoardState = { status: 'error', error: 'connection lost', value: null, write: { pending: false, notice: null }, servedWrite: { pending: false, notice: null } }
    const { onRefresh } = renderBoard(state)
    expect(screen.getByRole('alert').textContent).toBe('Org board unavailable: connection lost')
    expect(screen.queryByText(/Profile:/)).toBeNull()
    expect(screen.queryByText('Drift (registry vs. served rosters)')).toBeNull()
    // A failure must still offer the way out: Refresh lives in the board's toolbar.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Add seat' })).toBeNull()
  })

  it('still renders the failure banner (with an empty reason, never a crash) if error is somehow null on an error status', () => {
    const state: OrgBoardState = { status: 'error', error: null, value: null, write: { pending: false, notice: null }, servedWrite: { pending: false, notice: null } }
    renderBoard(state)
    expect(screen.getByRole('alert').textContent).toBe('Org board unavailable: ')
  })

  it('shows a loading message before any response has landed (idle)', () => {
    const state: OrgBoardState = { status: 'idle', error: null, value: null, write: { pending: false, notice: null }, servedWrite: { pending: false, notice: null } }
    renderBoard(state)
    expect(screen.getByText('Loading organisation…')).toBeTruthy()
  })

  it('shows a loading message while loading with no prior value', () => {
    const state: OrgBoardState = { status: 'loading', error: null, value: null, write: { pending: false, notice: null }, servedWrite: { pending: false, notice: null } }
    renderBoard(state)
    expect(screen.getByText('Loading organisation…')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' }).disabled).toBe(true)
  })

  it('always shows the profile once a response has landed, even when everything else failed', () => {
    const state = ready({
      profile: 'web-stable',
      registry: { ok: false, reason: 'registry.yml not found' },
      mailboxBridge: { ok: false, reason: 'patch mount absent' },
      toolMailbox: { ok: false, reason: 'patch file unreadable' },
      drift: { ok: false, reason: 'registry, mailboxBridge, toolMailbox unavailable' },
      servedRosterToken: { ok: false, reason: 'patch file unreadable' },
    })
    renderBoard(state)
    expect(screen.getByText('Profile: web-stable')).toBeTruthy()
  })

  it('a failed registry shows the reason and renders no graph section at all (never an empty canvas)', () => {
    const state = ready({
      ...BASE_VALUE,
      registry: { ok: false, reason: 'registry.yml not found' },
      drift: { ok: false, reason: 'registry unavailable' },
    })
    renderBoard(state)
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
    renderBoard(state)
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
    renderBoard(state)
    expect(screen.getByText('Tool-mailbox roster unavailable: patch file unreadable')).toBeTruthy()
  })

  it('drift registered-but-unserved and served-but-unregistered rows surface with their roster detail, behind the drift chip', () => {
    renderBoard(ready(BASE_VALUE))
    // Collapsed by default: the chip carries the count, the lists are not rendered.
    expect(screen.queryByText('Registered but not served (1)')).toBeNull()
    const chip = screen.getByRole('button', { name: '2 drift' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Registered but not served (1)')).toBeTruthy()
    expect(screen.getByText('robin — missing from: mailbox-bridge')).toBeTruthy()
    expect(screen.getByText('Served but not registered (1)')).toBeTruthy()
    expect(screen.getByText('ghost — served by: mailbox-bridge')).toBeTruthy()
  })

  it('clicking the drift chip again collapses the lists', () => {
    renderBoard(ready(BASE_VALUE))
    const chip = screen.getByRole('button', { name: '2 drift' })
    fireEvent.click(chip)
    expect(screen.getByText('Registered but not served (1)')).toBeTruthy()
    fireEvent.click(chip)
    expect(screen.queryByText('Registered but not served (1)')).toBeNull()
  })

  it('an empty drift report hides the chip entirely (nothing to expand)', () => {
    const state = ready({ ...BASE_VALUE, drift: { ok: true, rows: [] } })
    renderBoard(state)
    expect(screen.queryByRole('button', { name: /drift/ })).toBeNull()
    expect(screen.queryByText('Registered but not served (0)')).toBeNull()
  })

  it('a one-sided drift report shows None on the empty side', () => {
    const state = ready({
      ...BASE_VALUE,
      drift: { ok: true, rows: [{ seat: 'robin', registered: true, servedByMailboxBridge: false, servedByToolMailbox: true }] },
    })
    renderBoard(state)
    fireEvent.click(screen.getByRole('button', { name: '1 drift' }))
    expect(screen.getByText('Registered but not served (1)')).toBeTruthy()
    expect(screen.getByText('Served but not registered (0)')).toBeTruthy()
    expect(screen.getAllByText('None')).toHaveLength(1)
  })

  it('an unregistered-only drift report shows None under the registered-but-unserved side', () => {
    const state = ready({
      ...BASE_VALUE,
      drift: { ok: true, rows: [{ seat: 'ghost', registered: false, servedByMailboxBridge: true, servedByToolMailbox: false }] },
    })
    renderBoard(state)
    fireEvent.click(screen.getByRole('button', { name: '1 drift' }))
    expect(screen.getByText('Registered but not served (0)')).toBeTruthy()
    expect(screen.getByText('ghost — served by: mailbox-bridge')).toBeTruthy()
    expect(screen.getAllByText('None')).toHaveLength(1)
  })

  it('an expanded drift section disappears if a reload brings the drift down to zero', () => {
    const view = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByRole('button', { name: '2 drift' }))
    expect(screen.getByText('Registered but not served (1)')).toBeTruthy()
    view.rerenderWithState(ready({ ...BASE_VALUE, drift: { ok: true, rows: [] } }))
    expect(screen.queryByText('Registered but not served (1)')).toBeNull()
    expect(screen.queryByText(/Registered but not served/)).toBeNull()
  })

  it('a failed drift shows no chip and no lists, only its banner', () => {
    renderBoard(ready({ ...BASE_VALUE, drift: { ok: false, reason: 'mailboxBridge unavailable' } }))
    expect(screen.queryByRole('button', { name: /drift/ })).toBeNull()
    expect(screen.getByText('Drift unavailable: mailboxBridge unavailable')).toBeTruthy()
  })

  it('a registry with zero seats shows an explicit empty message, not a bare canvas', () => {
    const state = ready({
      ...BASE_VALUE,
      registry: {
        ok: true,
        registry: { baseDir: '/org', seats: {}, edges: [], callUp: [] },
        document: { baseDir: '/org', seats: {}, edges: [], callUp: [] },
        token: 'token-2',
      },
      drift: { ok: true, rows: [] },
    })
    renderBoard(state)
    expect(screen.getByText('No seats in the registry.')).toBeTruthy()
    expect(screen.getByText(/0 seat\(s\)/)).toBeTruthy()
  })

  it('draws seat nodes with their badges and no detail drawer before any selection', () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    expect(screen.getByText('alfred')).toBeTruthy()
    expect(screen.getByText('batman')).toBeTruthy()
    expect(screen.getByText('robin')).toBeTruthy()
    // Scoped to each seat's own node, not a bare screen.getByText: the
    // legend row (SWD-163 step 9) now also shows every badge label once,
    // so a bare query would find two matches for each of these.
    const alfredNode = container.querySelector('.react-flow__node[data-id="alfred"]') as HTMLElement
    const batmanNode = container.querySelector('.react-flow__node[data-id="batman"]') as HTMLElement
    const robinNode = container.querySelector('.react-flow__node[data-id="robin"]') as HTMLElement
    expect(within(alfredNode).getByText('Lead')).toBeTruthy()
    expect(within(alfredNode).getByText('May mail anyone')).toBeTruthy()
    expect(within(batmanNode).getByText('Test seat')).toBeTruthy()
    // robin has a drift row (missing from mailbox-bridge), so its node badges too.
    expect(within(robinNode).getByText('Not fully served')).toBeTruthy()
    expect(screen.queryByText('Select a seat to see its details.')).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('shows one served-status dot per seat, green-served vs not-fully-served', () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    const dots = (name: string) => within(container.querySelector(`.react-flow__node[data-id="${name}"]`) as HTMLElement).getAllByRole('img', { hidden: true })
    expect(dots('alfred').map(dot => dot.getAttribute('aria-label'))).toEqual(['served'])
    expect(dots('batman').map(dot => dot.getAttribute('aria-label'))).toEqual(['served'])
    expect(dots('robin').map(dot => dot.getAttribute('aria-label'))).toEqual(['not fully served'])
    expect(container.querySelectorAll('[role="img"][aria-label="served"]')).toHaveLength(2)
  })

  it('shows no status dot at all when drift failed (unknown is never drawn as served)', () => {
    const { container } = renderBoard(ready({ ...BASE_VALUE, drift: { ok: false, reason: 'mailboxBridge unavailable' } }))
    expect(container.querySelectorAll('.react-flow__node[data-id] [role="img"]')).toHaveLength(0)
  })

  it('clicking a seat node opens its detail panel with cwd, session id, and editable tool lists', () => {
    renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    expect(screen.getByText('/org/deepseek-harness')).toBeTruthy()
    expect(screen.getByText('No session recorded')).toBeTruthy()
    // The allow/deny lists are now editable fields (SWD-134 slice 4 step 4),
    // pre-filled from the seat's persisted tools -- not static text nodes.
    expect(screen.getByLabelText<HTMLInputElement>('Allowed tools').value).toBe('bash')
    expect(screen.getByLabelText<HTMLInputElement>('Denied tools').value).toBe('web')
  })

  it('a selected seat with a recorded session id shows it', () => {
    renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('alfred'))
    expect(screen.getByText('sess-alfred')).toBeTruthy()
  })

  it('a selected seat with no tool restrictions shows one explicit line, not two', () => {
    renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('robin'))
    expect(screen.getAllByText('No tool restrictions')).toHaveLength(1)
  })

  it('clicking the pane closes the drawer', () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('alfred'))
    expect(screen.getByRole('complementary')).toBeTruthy()
    const pane = container.querySelector('.react-flow__pane')
    expect(pane).toBeTruthy()
    fireEvent.click(pane as Element)
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('the drawer is closed by default, opens on node click, and closes with its Close button', () => {
    renderBoard(ready(BASE_VALUE))
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.click(screen.getByText('batman'))
    expect(within(screen.getByRole('complementary')).getByText('/org/deepseek-harness')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('Escape closes the drawer and does not reach the surrounding modal handler', () => {
    renderBoard(ready(BASE_VALUE))
    const outer = vi.fn()
    const outerListener = (event: KeyboardEvent) => { if (event.key === 'Escape') outer() }
    document.addEventListener('keydown', outerListener)
    fireEvent.click(screen.getByText('batman'))
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(screen.getByRole('complementary')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(outer).not.toHaveBeenCalled()
    // With no drawer open the key is left alone for the modal to use.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(outer).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', outerListener)
  })

  it('Escape is left to an open confirmation instead of closing the drawer underneath it', () => {
    renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove seat' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.getByRole('complementary')).toBeTruthy()
  })

  it('the toolbar carries the profile, Add seat and Refresh; Refresh calls the provided reload', () => {
    const { onRefresh } = renderBoard(ready(BASE_VALUE))
    expect(screen.getByText('Profile: web-stable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add seat' })).toBeTruthy()
    const refresh = screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' })
    expect(refresh.disabled).toBe(false)
    fireEvent.click(refresh)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('the toolbar filter dims non-matching seats, a clear control resets it, and an empty query dims nothing', () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    const wrapper = (name: string) => container.querySelector(`.react-flow__node[data-id="${name}"]`) as HTMLElement
    const dimmed = (name: string) => /nodeDimmed/.test(wrapper(name).className)
    expect(['alfred', 'batman', 'robin'].some(dimmed)).toBe(false)
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull()
    const input = screen.getByPlaceholderText('Filter seats')
    fireEvent.change(input, { target: { value: 'ROB' } })
    expect(dimmed('robin')).toBe(false)
    expect(dimmed('alfred')).toBe(true)
    expect(dimmed('batman')).toBe(true)
    fireEvent.change(input, { target: { value: 'lead' } })
    expect([dimmed('alfred'), dimmed('batman'), dimmed('robin')]).toEqual([false, true, true])
    fireEvent.change(input, { target: { value: 'test' } })
    expect([dimmed('alfred'), dimmed('batman'), dimmed('robin')]).toEqual([true, false, true])
    fireEvent.change(input, { target: { value: 'unserved' } })
    expect([dimmed('alfred'), dimmed('batman'), dimmed('robin')]).toEqual([true, true, false])
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect((input as HTMLInputElement).value).toBe('')
    expect(['alfred', 'batman', 'robin'].some(dimmed)).toBe(false)
  })

  it('a filter box is not offered when the registry failed', () => {
    renderBoard(ready({ ...BASE_VALUE, registry: { ok: false, reason: 'registry.yml not found' }, drift: { ok: false, reason: 'x' } }))
    expect(screen.queryByPlaceholderText('Filter seats')).toBeNull()
  })

  it('refits (without remounting) when the chart container changes size, and cancels a pending fit on unmount', async () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.fn((callback: FrameRequestCallback) => frames.push(callback))
    const cancelFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    const { container, unmount } = renderBoard(ready(BASE_VALUE))
    await waitFor(() => { expect(requestFrame).toHaveBeenCalled() })
    const flow = container.querySelector('.react-flow')
    const before = requestFrame.mock.calls.length
    // The drift panel shrinking the chart: height changes, width does not.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1284 })
    act(() => { for (const callback of observerCallbacks) callback([], {} as ResizeObserver) })
    await waitFor(() => { expect(requestFrame.mock.calls.length).toBeGreaterThan(before) })
    expect(cancelFrame).toHaveBeenCalled()
    // The latest frame runs the real fit without throwing, on the SAME instance.
    act(() => { frames.at(-1)?.(0) })
    expect(container.querySelector('.react-flow')).toBe(flow)
    unmount()
  })

  it('fits a phone-width canvas to width via the viewport instead of fitView', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 366 })
    const { container } = renderBoard(ready(BASE_VALUE))
    await waitFor(() => { expect(frames.length).toBeGreaterThan(0) })
    act(() => { frames.at(-1)?.(0) })
    expect(container.querySelector('.react-flow')).toBeTruthy()
  })

  it('renders the zoom controls', () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    expect(container.querySelector('.react-flow__controls')).toBeTruthy()
    expect(container.querySelector('.react-flow__controls-interactive')).toBeNull()
  })

  it('renders zero edges by default, even though the registry declares one (SWD-163 step 8)', async () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    // Give node measurement (see the ResizeObserverStub note above) a tick
    // to land -- an unmeasured graph would ALSO show no edges, which must
    // never be mistaken for proof of the real, filtered-to-zero default.
    await waitFor(() => { expect(container.querySelector('.react-flow__node[data-id="alfred"]')).toBeTruthy() })
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0)
  })

  it('hovering either endpoint of an edge reveals it, and un-hovering clears it again', async () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    const alfredNode = container.querySelector('.react-flow__node[data-id="alfred"]') as Element
    fireEvent.mouseEnter(alfredNode)
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    fireEvent.mouseLeave(alfredNode)
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0)

    // Undirected: the same edge also reveals from its OTHER endpoint.
    const batmanNode = container.querySelector('.react-flow__node[data-id="batman"]') as Element
    fireEvent.mouseEnter(batmanNode)
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    fireEvent.mouseLeave(batmanNode)
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0)
  })

  it('hovering a seat with no edges of its own reveals nothing', async () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    // Let measurement land first (see the zero-edges-by-default test above)
    // so a genuinely empty result here cannot be mistaken for an unmeasured graph.
    await waitFor(() => { expect(container.querySelector('.react-flow__node[data-id="robin"]')).toBeTruthy() })
    const robinNode = container.querySelector('.react-flow__node[data-id="robin"]') as Element
    fireEvent.mouseEnter(robinNode)
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0)
    fireEvent.mouseLeave(robinNode)
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0)
  })

  it('selecting an endpoint seat reveals its edge without hovering, and the edge survives an unrelated hover/un-hover elsewhere', async () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('alfred'))
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    const robinNode = container.querySelector('.react-flow__node[data-id="robin"]') as Element
    fireEvent.mouseEnter(robinNode)
    fireEvent.mouseLeave(robinNode)
    // robin has no edge of its own; alfred's selection-revealed edge is
    // unaffected either way -- re-awaited (not a synchronous check) because
    // rebuilding the nodes/edges arrays for ANY hover change, even one that
    // touches no shared edge, re-triggers React Flow's own node measurement
    // (see the ResizeObserverStub note above), which transiently un-draws
    // every edge for one microtask regardless of whether its own membership
    // in the filtered set actually changed.
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
  })

  it('shows a legend with one swatch per badge class and a note that edges show on hover/select', () => {
    renderBoard(ready(BASE_VALUE))
    // Each label already appears once as a real badge on a seat node in
    // BASE_VALUE (alfred=lead+callUp, batman=test, robin=unserved); the
    // legend adds one more occurrence of each, never replacing the node's own.
    expect(screen.getAllByText('Lead').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Test seat').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Not fully served').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('May mail anyone').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(translate('legend.edges'))).toBeTruthy()
  })
})

describe('OrgBoard write notices (SWD-134 slice 4 step 4)', () => {
  it('the four notice kinds carry genuinely distinct wording, not one generic failure message', () => {
    const messages = [
      translate('write.notice.invalid', { reason: 'x' }),
      translate('write.notice.conflict'),
      translate('write.notice.rejected', { reason: 'x' }),
      translate('write.notice.writeFailed'),
    ]
    expect(new Set(messages).size).toBe(4)
  })

  it('invalid: shows the local edit.ts refusal reason, before anything was sent, with no Retry action', () => {
    const notice: OrgBoardWriteNotice = { kind: 'invalid', message: 'seat "ghost" already exists' }
    renderBoard(withNotice(BASE_VALUE, notice))
    expect(screen.getByRole('alert').textContent).toBe(translate('write.notice.invalid', { reason: notice.message }))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('conflict: explains that a reload already replaced the view, not a refusal', () => {
    const notice: OrgBoardWriteNotice = { kind: 'conflict', message: 'expected token token-1, registry is at token-9' }
    renderBoard(withNotice(BASE_VALUE, notice))
    expect(screen.getByRole('alert').textContent).toBe(translate('write.notice.conflict'))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('rejected: shows the server refusal and says nothing was written', () => {
    const notice: OrgBoardWriteNotice = { kind: 'rejected', message: 'edge names an unknown seat "ghost"' }
    renderBoard(withNotice(BASE_VALUE, notice))
    expect(screen.getByRole('alert').textContent).toBe(translate('write.notice.rejected', { reason: notice.message }))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('write-failed: says the save did not go through and nothing changed, distinct from a rejected input', () => {
    const notice: OrgBoardWriteNotice = { kind: 'write-failed', message: 'ECONNRESET' }
    renderBoard(withNotice(BASE_VALUE, notice))
    expect(screen.getByRole('alert').textContent).toContain(translate('write.notice.writeFailed'))
  })

  it('disables the add-seat trigger, the remove-seat trigger, and the tools fields while a write is pending', () => {
    renderBoard(withNotice(BASE_VALUE, { kind: 'invalid', message: 'x' }, true))
    fireEvent.click(screen.getByText('batman'))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add seat' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove seat' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Allowed tools').disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Denied tools').disabled).toBe(true)
  })

  it('Retry on a write-failed notice resubmits the exact same payload as the edit that just failed', () => {
    const { addSeat, rerenderWithState } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByRole('button', { name: 'Add seat' }))
    fireEvent.change(screen.getByLabelText('Seat name'), { target: { value: 'lucius' } })
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/org/lucius' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addSeat).toHaveBeenCalledTimes(1)
    expect(addSeat).toHaveBeenCalledWith('lucius', '/org/lucius')

    addSeat.mockClear()
    rerenderWithState(withNotice(BASE_VALUE, { kind: 'write-failed', message: 'ECONNRESET' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(addSeat).toHaveBeenCalledTimes(1)
    expect(addSeat).toHaveBeenCalledWith('lucius', '/org/lucius')
  })
})

describe('OrgBoard add seat (SWD-134 slice 4 step 4)', () => {
  it('both fields are required: submitting blank refuses locally, with no addSeat call at all', () => {
    const { addSeat } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByRole('button', { name: 'Add seat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addSeat).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(translate('addSeat.validation.required'))
  })

  it('a name with no working directory (or vice versa) is also refused locally, with no addSeat call', () => {
    const { addSeat } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByRole('button', { name: 'Add seat' }))
    fireEvent.change(screen.getByLabelText('Seat name'), { target: { value: 'lucius' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addSeat).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(translate('addSeat.validation.required'))
  })

  it('submitting both fields filled calls addSeat with the trimmed name and cwd', () => {
    const { addSeat } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByRole('button', { name: 'Add seat' }))
    fireEvent.change(screen.getByLabelText('Seat name'), { target: { value: '  lucius  ' } })
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '  /org/lucius  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addSeat).toHaveBeenCalledTimes(1)
    expect(addSeat).toHaveBeenCalledWith('lucius', '/org/lucius')
  })
})

describe('OrgBoard remove seat (SWD-134 slice 4 step 4)', () => {
  it('names the cascaded mail-permission line(s) before the user confirms, and calls removeSeat only after confirming', () => {
    const { removeSeat } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove seat' }))
    expect(screen.getByRole('dialog', { name: 'Remove seat' })).toBeTruthy()
    expect(screen.getByText('Removing batman will also remove 1 mail-permission line(s): alfred ↔ batman.')).toBeTruthy()
    expect(removeSeat).not.toHaveBeenCalled()
    // RiskConfirmation gates its primary action on the acknowledgement checkbox.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeSeat).toHaveBeenCalledTimes(1)
    expect(removeSeat).toHaveBeenCalledWith('batman')
  })

  it('a click on a different seat in the list underneath is swallowed while the remove-seat confirmation is open (SWD-155)', () => {
    // Modal now traps focus and makes the rest of the page inert while
    // open (SWD-155), so a click on another seat in the board underneath
    // no longer reaches onNodeClick at all -- this replaces the previous
    // "moving the selection to a different seat WHILE the remove-seat
    // confirmation is open does not clobber it on confirm" regression test,
    // which exercised exactly the background-click leak this ticket closes
    // (its own comment said so: "Modal.tsx has no focus trap or inert on
    // the rest of the page ... a keyboard user can still move the board's
    // selection while this dialog is open"). That premise no longer holds.
    //
    // OrgBoard's own defence -- seatToRemove captured once at open, never
    // re-read off `selectedSeat` at confirm time -- still exists underneath
    // and is still exercised here: it is what makes `removeSeat` receive
    // the right name even though, now, selectedSeat provably never moved.
    const { removeSeat } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove seat' }))

    fireEvent.click(screen.getByText('alfred'))
    // Swallowed: the detail panel still reads batman's own data (no
    // session recorded), never alfred's -- proof onNodeClick was never
    // reached, not just that the dialog happens to still say "batman".
    expect(screen.getByText('No session recorded')).toBeTruthy()
    expect(screen.queryByText('sess-alfred')).toBeNull()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeSeat).toHaveBeenCalledTimes(1)
    expect(removeSeat).toHaveBeenCalledWith('batman')
  })

  it('names an empty cascade explicitly (none), never a silent 0-line message', () => {
    renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('robin'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove seat' }))
    expect(screen.getByText('Removing robin will also remove 0 mail-permission line(s): none.')).toBeTruthy()
  })

  it('names the may-mail-anyone (callUp) cascade too, when the removed seat is a member', () => {
    renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('alfred'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove seat' }))
    expect(screen.getByText(/alfred will also be removed from the may-mail-anyone list\./)).toBeTruthy()
  })

  it('cancelling the confirmation never calls removeSeat', () => {
    const { removeSeat } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove seat' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(removeSeat).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Remove seat' })).toBeNull()
  })

  it('Retry on a write-failed notice resubmits the exact same removeSeat payload', () => {
    const { removeSeat, rerenderWithState } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove seat' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeSeat).toHaveBeenCalledTimes(1)

    removeSeat.mockClear()
    rerenderWithState(withNotice(BASE_VALUE, { kind: 'write-failed', message: 'ECONNRESET' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(removeSeat).toHaveBeenCalledTimes(1)
    expect(removeSeat).toHaveBeenCalledWith('batman')
  })
})

describe('OrgBoard mail-permission lines (SWD-134 slice 4 step 4)', () => {
  it('onEdgeClick opens a confirmation even with elementsSelectable false, and removeEdge only fires after confirming', async () => {
    const { removeEdge, container } = renderBoard(ready(BASE_VALUE))
    // Node measurement lands on the next tick (see the ResizeObserverStub
    // note above); an edge only draws -- and becomes clickable -- once both
    // endpoint nodes are measured AND (SWD-163 step 8) one of them is
    // hovered or selected -- this test is about onEdgeClick, not the reveal
    // itself (covered separately above), so hover is just how it gets an
    // edge on screen to click.
    hoverSeat(container, 'alfred')
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    // Verified here, on the REAL @xyflow/react component (not a mock): the
    // library attaches `onClick: onEdgeClick` directly to this element
    // regardless of `isSelectable` (dist/esm/index.js's EdgeWrapper spreads
    // `onClick: onEdgeClick` onto the wrapping <g> unconditionally), so a
    // plain click fires it even though this board keeps elementsSelectable
    // false. onNodeClick's equivalent is already proven by the pre-existing
    // "clicking a seat node opens its detail panel" test above, which
    // likewise clicks a real rendered node with elementsSelectable false.
    fireEvent.click(container.querySelector('.react-flow__edge') as Element)
    expect(screen.getByRole('dialog', { name: 'Remove mail-permission line' })).toBeTruthy()
    expect(screen.getByText('Remove the mail-permission line between alfred and batman?')).toBeTruthy()
    expect(removeEdge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeEdge).toHaveBeenCalledTimes(1)
    expect(removeEdge).toHaveBeenCalledWith('alfred', 'batman')
  })

  it('clicking a source handle then a different seat\'s target handle (connect-on-click) calls addEdge', async () => {
    const { addEdge, container } = renderBoard(ready(BASE_VALUE))
    // Sync point only (see hoverSeat's own doc comment): connect-on-click
    // itself is independent of this board's own hover/select edge filter.
    hoverSeat(container, 'alfred')
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    const sourceHandle = container.querySelector('.react-flow__handle[data-nodeid="alfred"].source')
    const targetHandle = container.querySelector('.react-flow__handle[data-nodeid="robin"].target')
    expect(sourceHandle).toBeTruthy()
    expect(targetHandle).toBeTruthy()
    fireEvent.click(sourceHandle as Element)
    fireEvent.click(targetHandle as Element)
    expect(addEdge).toHaveBeenCalledWith('alfred', 'robin')
  })

  it('cancelling the mail-permission-line removal confirmation never calls removeEdge', async () => {
    const { removeEdge, container } = renderBoard(ready(BASE_VALUE))
    hoverSeat(container, 'alfred')
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    fireEvent.click(container.querySelector('.react-flow__edge') as Element)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(removeEdge).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Remove mail-permission line' })).toBeNull()
  })

  it('Retry on a write-failed notice resubmits the exact same addEdge payload', async () => {
    const { addEdge, container, rerenderWithState } = renderBoard(ready(BASE_VALUE))
    hoverSeat(container, 'alfred')
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    const sourceHandle = container.querySelector('.react-flow__handle[data-nodeid="alfred"].source')
    const targetHandle = container.querySelector('.react-flow__handle[data-nodeid="robin"].target')
    fireEvent.click(sourceHandle as Element)
    fireEvent.click(targetHandle as Element)
    expect(addEdge).toHaveBeenCalledTimes(1)

    addEdge.mockClear()
    rerenderWithState(withNotice(BASE_VALUE, { kind: 'write-failed', message: 'ECONNRESET' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(addEdge).toHaveBeenCalledTimes(1)
    expect(addEdge).toHaveBeenCalledWith('alfred', 'robin')
  })

  it('Retry on a write-failed notice resubmits the exact same removeEdge payload', async () => {
    const { removeEdge, container, rerenderWithState } = renderBoard(ready(BASE_VALUE))
    hoverSeat(container, 'alfred')
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    fireEvent.click(container.querySelector('.react-flow__edge') as Element)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeEdge).toHaveBeenCalledTimes(1)

    removeEdge.mockClear()
    rerenderWithState(withNotice(BASE_VALUE, { kind: 'write-failed', message: 'ECONNRESET' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(removeEdge).toHaveBeenCalledTimes(1)
    expect(removeEdge).toHaveBeenCalledWith('alfred', 'batman')
  })
})

describe('OrgBoard seat tools editing (SWD-134 slice 4 step 4)', () => {
  it('editing and saving the tools fields calls setSeatTools with the parsed allow/deny lists', () => {
    const { setSeatTools } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('robin'))
    fireEvent.change(screen.getByLabelText('Allowed tools'), { target: { value: 'read, write' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setSeatTools).toHaveBeenCalledTimes(1)
    expect(setSeatTools).toHaveBeenCalledWith('robin', ['read', 'write'], undefined)
  })

  it('clearing both fields to blank saves as no tools entry at all (undefined, never empty arrays)', () => {
    const { setSeatTools } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    fireEvent.change(screen.getByLabelText('Allowed tools'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Denied tools'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setSeatTools).toHaveBeenCalledWith('batman', undefined, undefined)
  })

  it('switching the selection resets the editable fields to the newly selected seat\'s own persisted lists', () => {
    renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    fireEvent.change(screen.getByLabelText('Allowed tools'), { target: { value: 'unsaved-edit' } })
    fireEvent.click(screen.getByText('robin'))
    expect(screen.getByLabelText<HTMLInputElement>('Allowed tools').value).toBe('')
    fireEvent.click(screen.getByText('batman'))
    expect(screen.getByLabelText<HTMLInputElement>('Allowed tools').value).toBe('bash')
  })

  it('Retry on a write-failed notice resubmits the exact same setSeatTools payload', () => {
    const { setSeatTools, rerenderWithState } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('robin'))
    fireEvent.change(screen.getByLabelText('Allowed tools'), { target: { value: 'read, write' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setSeatTools).toHaveBeenCalledTimes(1)

    setSeatTools.mockClear()
    rerenderWithState(withNotice(BASE_VALUE, { kind: 'write-failed', message: 'ECONNRESET' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(setSeatTools).toHaveBeenCalledTimes(1)
    expect(setSeatTools).toHaveBeenCalledWith('robin', ['read', 'write'], undefined)
  })
})

describe('OrgBoard served status toggle (SWD-134 slice 5 step 3)', () => {
  it('opens a confirmation, and confirming calls setSeatServed with the right arguments', () => {
    // No split anywhere in this state, so the write carries acknowledgeSplit: false.
    const state = ready({ ...BASE_VALUE, drift: { ok: true, rows: [] } })
    const { setSeatServed } = renderBoard(state)
    fireEvent.click(screen.getByText('batman'))
    expect(screen.queryByRole('dialog', { name: 'Change served status' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Change served status' }))
    expect(screen.getByRole('dialog', { name: 'Change served status' })).toBeTruthy()
    expect(setSeatServed).not.toHaveBeenCalled()
    // RiskConfirmation gates its primary action on the acknowledgement checkbox.
    // "Stop serving" -- distinct from SeatToolsEditor's own "Save" button,
    // which is on screen at the same time (see OrgBoard.tsx's confirmLabel comment).
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop serving' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop serving' }))
    expect(setSeatServed).toHaveBeenCalledTimes(1)
    // batman has no drift row (fully served by both), so the toggle flips it off.
    expect(setSeatServed).toHaveBeenCalledWith('batman', false, false)
  })

  it('cancelling the confirmation never calls setSeatServed', () => {
    const state = ready({ ...BASE_VALUE, drift: { ok: true, rows: [] } })
    const { setSeatServed } = renderBoard(state)
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Change served status' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(setSeatServed).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Change served status' })).toBeNull()
  })

  it('with drift.ok false, the toggle trigger carries a real disabled attribute, and clicking it anyway never calls setSeatServed or opens the confirmation', () => {
    const state = ready({
      ...BASE_VALUE,
      mailboxBridge: { ok: false, reason: 'patch mount absent' },
      drift: { ok: false, reason: 'mailboxBridge unavailable' },
    })
    const { setSeatServed } = renderBoard(state)
    fireEvent.click(screen.getByText('alfred'))
    const toggle = screen.getByRole<HTMLButtonElement>('button', { name: 'Change served status' })
    expect(toggle.disabled).toBe(true)
    fireEvent.click(toggle)
    expect(setSeatServed).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Change served status' })).toBeNull()
    // No new banner text was added for this -- the existing drift-unavailable
    // banner (already asserted by the drift-suppression tests above) is what
    // explains it.
  })

  it('with a split present while toggling a DIFFERENT seat, the confirmation names the split seat and passes acknowledgeSplit: true', () => {
    // BASE_VALUE's own drift rows already carry robin as split (mailbox-bridge
    // false, tool-mailbox true) -- toggle batman, which has no row at all.
    const { setSeatServed } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Change served status' }))
    const dialog = screen.getByRole('dialog', { name: 'Change served status' })
    expect(within(dialog).getByText(/robin/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop serving' }))
    expect(setSeatServed).toHaveBeenCalledWith('batman', false, true)
  })

  it('shows the classified served status text for the selected seat, matching the drift section', () => {
    renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('robin'))
    // robin is the split row in BASE_VALUE.
    expect(screen.getByText('Split — the two rosters disagree')).toBeTruthy()
  })

  it('renders the servedWrite split notice with the addresses named on each side', () => {
    const state: OrgBoardState = {
      status: 'ready',
      error: null,
      value: BASE_VALUE,
      write: { pending: false, notice: null },
      servedWrite: { pending: false, notice: { kind: 'split', onlyMailboxBridge: ['batman'], onlyToolMailbox: ['robin'] } },
    }
    renderBoard(state)
    expect(screen.getByRole('alert').textContent).toBe(
      translate('servedWrite.notice.split', { onlyMailboxBridge: 'batman', onlyToolMailbox: 'robin' }),
    )
  })

  it('discloses the SERVER\'s split seats, not the board\'s own reading, once a split refusal is showing', () => {
    // The server refused naming a ghost address -- served by one roster with
    // no registry seat behind it, so the board's own scan over REGISTERED
    // rows can never see it. Deriving the disclosure from the board alone
    // would show no split, resend acknowledgeSplit: false, and be refused
    // again on every retry with nothing on screen saying why.
    const state: OrgBoardState = {
      status: 'ready',
      error: null,
      value: BASE_VALUE,
      write: { pending: false, notice: null },
      servedWrite: { pending: false, notice: { kind: 'split', onlyMailboxBridge: ['ghost-address'], onlyToolMailbox: [] } },
    }
    const { setSeatServed } = renderBoard(state)
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Change served status' }))
    const dialog = screen.getByRole('dialog', { name: 'Change served status' })
    expect(within(dialog).getByText(/ghost-address/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop serving' }))
    expect(setSeatServed).toHaveBeenCalledWith('batman', false, true)
  })

  it('offers Retry on a failed served write and re-sends the identical payload', () => {
    const state: OrgBoardState = {
      status: 'ready',
      error: null,
      value: BASE_VALUE,
      write: { pending: false, notice: null },
      servedWrite: { pending: false, notice: null },
    }
    const { setSeatServed, rerenderWithState } = renderBoard(state)
    fireEvent.click(screen.getByText('batman'))
    fireEvent.click(screen.getByRole('button', { name: 'Change served status' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop serving' }))
    expect(setSeatServed).toHaveBeenCalledTimes(1)

    // The write came back failed: the banner must offer the same payload
    // again rather than making the operator redo the whole confirmation.
    rerenderWithState({
      ...state,
      servedWrite: { pending: false, notice: { kind: 'write-failed', message: 'disk full' } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(setSeatServed).toHaveBeenCalledTimes(2)
    expect(setSeatServed).toHaveBeenLastCalledWith('batman', false, true)
  })

  it('the servedWrite "invalid" notice shows the local refusal reason, distinct wording from "rejected"/"conflict"', () => {
    const state: OrgBoardState = {
      status: 'ready',
      error: null,
      value: BASE_VALUE,
      write: { pending: false, notice: null },
      servedWrite: { pending: false, notice: { kind: 'invalid', message: 'no served roster is loaded to edit' } },
    }
    renderBoard(state)
    expect(screen.getByRole('alert').textContent).toBe(
      translate('servedWrite.notice.invalid', { reason: 'no served roster is loaded to edit' }),
    )
    expect(screen.getByRole('alert').getAttribute('data-variant')).toBe('error')
  })

  it('the servedWrite "conflict" notice explains a reload already replaced the view, with a "warning" variant (not "error")', () => {
    const state: OrgBoardState = {
      status: 'ready',
      error: null,
      value: BASE_VALUE,
      write: { pending: false, notice: null },
      servedWrite: { pending: false, notice: { kind: 'conflict', message: 'served roster changed since it was read' } },
    }
    renderBoard(state)
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toBe(translate('servedWrite.notice.conflict'))
    expect(banner.getAttribute('data-variant')).toBe('warning')
  })

  it('the servedWrite "rejected" notice shows the server refusal reason', () => {
    const state: OrgBoardState = {
      status: 'ready',
      error: null,
      value: BASE_VALUE,
      write: { pending: false, notice: null },
      servedWrite: { pending: false, notice: { kind: 'rejected', message: 'invalid served address' } },
    }
    renderBoard(state)
    expect(screen.getByRole('alert').textContent).toBe(
      translate('servedWrite.notice.rejected', { reason: 'invalid served address' }),
    )
  })

  it('a split notice with an empty mailbox-bridge-only list names the empty side explicitly ("None"), not a blank', () => {
    const state: OrgBoardState = {
      status: 'ready',
      error: null,
      value: BASE_VALUE,
      write: { pending: false, notice: null },
      servedWrite: { pending: false, notice: { kind: 'split', onlyMailboxBridge: [], onlyToolMailbox: ['robin'] } },
    }
    renderBoard(state)
    expect(screen.getByRole('alert').textContent).toBe(
      translate('servedWrite.notice.split', { onlyMailboxBridge: translate('drift.unserved.empty'), onlyToolMailbox: 'robin' }),
    )
  })

  it('a seat served by neither roster shows "Not served", and toggling it offers to Serve (not Stop serving)', () => {
    const state = ready({
      ...BASE_VALUE,
      drift: {
        ok: true,
        rows: [
          { seat: 'batman', registered: true, servedByMailboxBridge: false, servedByToolMailbox: false },
        ],
      },
    })
    const { setSeatServed } = renderBoard(state)
    fireEvent.click(screen.getByText('batman'))
    expect(screen.getByText('Not served')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change served status' }))
    const dialog = screen.getByRole('dialog', { name: 'Change served status' })
    expect(within(dialog).getByRole('button', { name: 'Serve' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Serve' }))
    expect(setSeatServed).toHaveBeenCalledWith('batman', true, false)
  })
})

describe('OrgBoard pending guards on the graph (SWD-134 slice 4 step 4)', () => {
  it('a write in flight blocks a connect-on-click addEdge attempt', async () => {
    const { addEdge, container } = renderBoard(withNotice(BASE_VALUE, { kind: 'invalid', message: 'x' }, true))
    hoverSeat(container, 'alfred')
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    const sourceHandle = container.querySelector('.react-flow__handle[data-nodeid="alfred"].source')
    const targetHandle = container.querySelector('.react-flow__handle[data-nodeid="robin"].target')
    expect(sourceHandle).toBeTruthy()
    expect(targetHandle).toBeTruthy()
    fireEvent.click(sourceHandle as Element)
    fireEvent.click(targetHandle as Element)
    expect(addEdge).not.toHaveBeenCalled()
  })

  it('a write in flight blocks onEdgeClick from opening the remove-edge confirmation', async () => {
    const { removeEdge, container } = renderBoard(withNotice(BASE_VALUE, { kind: 'invalid', message: 'x' }, true))
    hoverSeat(container, 'alfred')
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    fireEvent.click(container.querySelector('.react-flow__edge') as Element)
    expect(screen.queryByRole('dialog', { name: 'Remove mail-permission line' })).toBeNull()
    expect(removeEdge).not.toHaveBeenCalled()
  })
})

describe('OrgBoard seat tools editing: non-empty deny list (SWD-134 slice 4 step 4)', () => {
  it('saving a non-empty deny list (with allow left blank) calls setSeatTools with the parsed deny list', () => {
    const { setSeatTools } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('robin'))
    fireEvent.change(screen.getByLabelText('Denied tools'), { target: { value: 'web, exec' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setSeatTools).toHaveBeenCalledWith('robin', undefined, ['web', 'exec'])
  })
})

/** BASE_VALUE with departments: alfred + batman in Ops, robin in no department. */
function withDepartments(): ResponseValue<'org.get'> {
  if (!BASE_VALUE.registry.ok) throw new Error('fixture registry must be ok')
  const { registry, document } = BASE_VALUE.registry
  return {
    ...BASE_VALUE,
    registry: {
      ...BASE_VALUE.registry,
      registry: {
        ...registry,
        seats: {
          ...registry.seats,
          alfred: { ...registry.seats.alfred!, department: 'Ops' },
          batman: { ...registry.seats.batman!, department: 'Ops' },
        },
      },
      document,
    },
  }
}

describe('OrgBoard department bands (SWD-178)', () => {
  const band = (container: HTMLElement, key: string) =>
    container.querySelector<HTMLElement>(`.react-flow__node[data-id="band:${key}"]`) as HTMLElement

  it('draws one band per department with its title and seat count, and an Unassigned band for the rest', () => {
    const { container } = renderBoard(ready(withDepartments()))
    const ops = band(container, 'dept:Ops')
    expect(within(ops).getByText('Ops')).toBeTruthy()
    expect(within(ops).getByText('2 seat(s)')).toBeTruthy()
    const unassigned = band(container, 'unassigned')
    expect(within(unassigned).getByText('Unassigned')).toBeTruthy()
    expect(within(unassigned).getByText('1 seat(s)')).toBeTruthy()
  })

  it('emits band nodes before seat nodes, behind them (zIndex -1)', () => {
    const { container } = renderBoard(ready(withDepartments()))
    const ids = [...container.querySelectorAll('.react-flow__node')].map(node => node.getAttribute('data-id'))
    expect(ids.slice(0, 2)).toEqual(['band:dept:Ops', 'band:unassigned'])
    expect(band(container, 'dept:Ops').style.zIndex).toBe('-1')
  })

  it('bands are not selectable: clicking or hovering one selects nothing and opens no drawer', async () => {
    const { container } = renderBoard(ready(withDepartments()))
    const ops = band(container, 'dept:Ops')
    fireEvent.mouseEnter(ops)
    fireEvent.click(ops)
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0)
    // The wrapper opts out of pointer events entirely, so a real click falls through to the pane.
    expect(ops.className).toMatch(/bandNode/)
  })

  it('dims a band only when a filter is active and none of its seats match', () => {
    const { container } = renderBoard(ready(withDepartments()))
    const dimmed = (key: string) => /nodeDimmed/.test(band(container, key).innerHTML)
    expect([dimmed('dept:Ops'), dimmed('unassigned')]).toEqual([false, false])
    const input = screen.getByPlaceholderText('Filter seats')
    // Matches robin only: Ops (no match) dims, Unassigned stays lit.
    fireEvent.change(input, { target: { value: 'rob' } })
    expect([dimmed('dept:Ops'), dimmed('unassigned')]).toEqual([true, false])
    // Matches batman only: one matching seat is enough to keep Ops lit.
    fireEvent.change(input, { target: { value: 'batman' } })
    expect([dimmed('dept:Ops'), dimmed('unassigned')]).toEqual([false, true])
    fireEvent.change(input, { target: { value: 'nobody-matches' } })
    expect([dimmed('dept:Ops'), dimmed('unassigned')]).toEqual([true, true])
    fireEvent.change(input, { target: { value: '' } })
    expect([dimmed('dept:Ops'), dimmed('unassigned')]).toEqual([false, false])
  })

  it('draws revealed edges above the band surfaces', async () => {
    const { container } = renderBoard(ready(withDepartments()))
    fireEvent.mouseEnter(container.querySelector('.react-flow__node[data-id="alfred"]') as Element)
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    const edgeLayer = container.querySelector('.react-flow__edge')?.closest('svg') as SVGElement
    const edgeZ = Number((edgeLayer.style.zIndex || (container.querySelector('.react-flow__edge') as SVGElement).style.zIndex))
    // No z override: lines sit at React Flow's default 0, above the bands (-1) and not above seat cards.
    expect(edgeZ).toBe(0)
    expect(edgeZ).toBeGreaterThan(Number(band(container, 'dept:Ops').style.zIndex))
  })
})

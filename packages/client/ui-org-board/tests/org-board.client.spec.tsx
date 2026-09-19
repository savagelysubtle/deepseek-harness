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
import type { OrgBoardProps } from '../src/client/OrgBoard.tsx'
import type { OrgBoardState, OrgBoardWriteNotice } from '../src/client/org-board-store.ts'
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
  // jsdom has no `document.elementFromPoint` at all (not even a null-
  // returning stub) -- @xyflow/system's click-to-connect handle validation
  // (`isValidHandle`) calls it first and only falls back to its own
  // `data-id` handle lookup when it returns a falsy value, so this needs a
  // real (if trivial) stub rather than being left undefined.
  document.elementFromPoint = () => null
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
  return { status: 'ready', error: null, value, write: { pending: false, notice: null } }
}

/** A ready snapshot carrying a write-side notice (and optionally `pending`), for the notice/disabled-controls tests. */
function withNotice(value: ResponseValue<'org.get'>, notice: OrgBoardWriteNotice, pending = false): OrgBoardState {
  return { status: 'ready', error: null, value, write: { pending, notice } }
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
  const utils = render(<OrgBoard state={state} t={translate} {...v} />)
  return {
    ...utils,
    ...v,
    rerenderWithState: (next: OrgBoardState) => {
      utils.rerender(<OrgBoard state={next} t={translate} {...v} />)
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
}

describe('OrgBoard', () => {
  it('renders only the top-level failure banner on an outer RPC error, nothing else', () => {
    const state: OrgBoardState = { status: 'error', error: 'connection lost', value: null, write: { pending: false, notice: null } }
    renderBoard(state)
    expect(screen.getByRole('alert').textContent).toBe('Org board unavailable: connection lost')
    expect(screen.queryByText(/Profile:/)).toBeNull()
    expect(screen.queryByText('Drift (registry vs. served rosters)')).toBeNull()
  })

  it('still renders the failure banner (with an empty reason, never a crash) if error is somehow null on an error status', () => {
    const state: OrgBoardState = { status: 'error', error: null, value: null, write: { pending: false, notice: null } }
    renderBoard(state)
    expect(screen.getByRole('alert').textContent).toBe('Org board unavailable: ')
  })

  it('shows a loading message before any response has landed (idle)', () => {
    const state: OrgBoardState = { status: 'idle', error: null, value: null, write: { pending: false, notice: null } }
    renderBoard(state)
    expect(screen.getByText('Loading organisation…')).toBeTruthy()
  })

  it('shows a loading message while loading with no prior value', () => {
    const state: OrgBoardState = { status: 'loading', error: null, value: null, write: { pending: false, notice: null } }
    renderBoard(state)
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

  it('drift registered-but-unserved and served-but-unregistered rows surface with their roster detail', () => {
    renderBoard(ready(BASE_VALUE))
    expect(screen.getByText('Registered but not served (1)')).toBeTruthy()
    expect(screen.getByText('robin — missing from: mailbox-bridge')).toBeTruthy()
    expect(screen.getByText('Served but not registered (1)')).toBeTruthy()
    expect(screen.getByText('ghost — served by: mailbox-bridge')).toBeTruthy()
  })

  it('an empty drift report shows None on both sides', () => {
    const state = ready({ ...BASE_VALUE, drift: { ok: true, rows: [] } })
    renderBoard(state)
    expect(screen.getByText('Registered but not served (0)')).toBeTruthy()
    expect(screen.getByText('Served but not registered (0)')).toBeTruthy()
    expect(screen.getAllByText('None')).toHaveLength(2)
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

  it('draws seat nodes with their badges and the detail hint before any selection', () => {
    renderBoard(ready(BASE_VALUE))
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

  it('clicking the pane clears the selection back to the hint', () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    fireEvent.click(screen.getByText('alfred'))
    expect(screen.queryByText('Select a seat to see its details.')).toBeNull()
    const pane = container.querySelector('.react-flow__pane')
    expect(pane).toBeTruthy()
    fireEvent.click(pane as Element)
    expect(screen.getByText('Select a seat to see its details.')).toBeTruthy()
  })

  it('draws the undirected edge between the two registry-declared seats', async () => {
    const { container } = renderBoard(ready(BASE_VALUE))
    // Node measurement lands on the next tick (see the ResizeObserverStub
    // note above); an edge only draws once both endpoint nodes are measured.
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
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
})

describe('OrgBoard mail-permission lines (SWD-134 slice 4 step 4)', () => {
  it('onEdgeClick opens a confirmation even with elementsSelectable false, and removeEdge only fires after confirming', async () => {
    const { removeEdge, container } = renderBoard(ready(BASE_VALUE))
    // Node measurement lands on the next tick (see the ResizeObserverStub
    // note above); an edge only draws -- and becomes clickable -- once both
    // endpoint nodes are measured.
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
    await waitFor(() => { expect(container.querySelector('.react-flow__edge')).toBeTruthy() })
    const sourceHandle = container.querySelector('.react-flow__handle[data-nodeid="alfred"].source')
    const targetHandle = container.querySelector('.react-flow__handle[data-nodeid="robin"].target')
    expect(sourceHandle).toBeTruthy()
    expect(targetHandle).toBeTruthy()
    fireEvent.click(sourceHandle as Element)
    fireEvent.click(targetHandle as Element)
    expect(addEdge).toHaveBeenCalledWith('alfred', 'robin')
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
})

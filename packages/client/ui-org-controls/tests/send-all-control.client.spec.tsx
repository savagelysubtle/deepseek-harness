// @vitest-environment jsdom
/**
 * Component-level behavior: the trigger disables with a visible reason when
 * there is nothing to send to, the single-step compose dialog blocks an
 * empty message and shows the reachable count before anything is sent (no
 * separate confirm screen — removed by founder ruling, see SendAllControl.tsx
 * header), and — critically — a `result: { failed }` outcome renders as a
 * failure banner rather than folding into the "sent to N" success line (the
 * founder's explicit must-surface requirement for SWD-131).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { SendAllControl, type SendAllControlProps } from '../src/client/SendAllControl.tsx'
import { en, type OrgControlsKey } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, attached: true, blank: false, updatedAt: 0, ...overrides,
})

/** Minimal mustache-style interpolation over the real English dictionary. */
function translate(key: LocaleKeysOf<'orgControls'>, params?: Record<string, unknown>): string {
  const template = en[key as OrgControlsKey] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : `{${name}}`
  })
}

/** Selector-hook stub over a fixed snapshot (no store, no subscription — a static bench is enough). */
function useSessionsFixture(state: SessionListState) {
  return <S,>(sel: (s: SessionListState) => S): S => sel(state)
}

/** SendAllControl never reads useWorkspaces; a throwing stub proves that and satisfies GlobalStandardProps. */
const useWorkspaces = (() => {
  throw new Error('SendAllControl must not call useWorkspaces')
}) as never

const TWO_ROOTS: SessionListState = {
  ids: [sid('a'), sid('b'), sid('sub')],
  byId: {
    [sid('a')]: summary('a'),
    [sid('b')]: summary('b'),
    [sid('sub')]: summary('sub', { origin: 'subagent', parentId: sid('a') }),
  },
  current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}

const NO_ROOTS: SessionListState = {
  ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}

/**
 * Two live (attached) roots plus a cold, never-attached top-level row — the
 * client mirror of the host's own "a cold top-level row with no live agent
 * must be dropped, not counted" case. A count that filtered on
 * `origin !== 'subagent'` alone (not `attached`) would report 3 here while
 * the host reaches only 2, which is exactly the promised-a-number-it-cannot-
 * deliver defect this fixture exists to catch. With the confirm step gone,
 * the compose dialog is the only screen left to prove this on.
 */
const TWO_LIVE_ONE_COLD: SessionListState = {
  ids: [sid('a'), sid('b'), sid('cold')],
  byId: {
    [sid('a')]: summary('a'),
    [sid('b')]: summary('b'),
    [sid('cold')]: summary('cold', { attached: false }),
  },
  current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}

/** Render helper: keeps every call site short — one place carries the runtime-share boilerplate. */
function renderSendAll(overrides: {
  wide?: boolean
  sessions?: SessionListState
  onSendAll?: SendAllControlProps['onSendAll']
} = {}) {
  const { wide = true, sessions = TWO_ROOTS, onSendAll = vi.fn() } = overrides
  return render(<SendAllControl
    wide={wide}
    useSessions={useSessionsFixture(sessions)}
    useWorkspaces={useWorkspaces}
    onSendAll={onSendAll}
    t={translate}
  />)
}

/** The trigger and the modal's footer Send button share the label "Send All" once the dialog is open — scope to the dialog. */
function openCompose() {
  fireEvent.click(screen.getByRole('button', { name: 'Send All' }))
  return within(screen.getByRole('dialog'))
}

describe('SendAllControl', () => {
  it('disables the trigger with a visible reason when there are no sessions to send to', () => {
    renderSendAll({ sessions: NO_ROOTS })
    const trigger = screen.getByRole('button', { name: 'Send All (no active sessions to send to)' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    // The reason must be readable on screen, not only discoverable by
    // hovering the tooltip/aria-label the assertion above already covers.
    expect(screen.getByText('No active sessions to send to.')).toBeTruthy()
  })

  it('disables Send with an empty message', () => {
    renderSendAll()
    const dialog = openCompose()
    const send = dialog.getByRole('button', { name: 'Send All' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
  })

  it('shows the reachable count in the compose dialog before anything is sent, excluding a cold (never-attached) top-level row', () => {
    const onSendAll = vi.fn().mockResolvedValue({ ok: true, value: { sentCount: 2, result: 'ok' as const } })
    renderSendAll({ sessions: TWO_LIVE_ONE_COLD, onSendAll })
    const dialog = openCompose()
    // Compose must already name the reachable count (2), not every
    // non-subagent row (3) — a promised number the cold row cannot receive,
    // and the only place left to prove it now that the confirm step is gone.
    expect(dialog.getByText('This message goes immediately to all 2 active top-level session(s), interrupting whatever any of them are doing right now. This cannot be undone.')).toBeTruthy()
    fireEvent.change(dialog.getByPlaceholderText('Type a message to send to every session…'), { target: { value: 'stand down' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Send All' }))
    expect(onSendAll).toHaveBeenCalledWith([{ type: 'text', text: 'stand down' }])
  })

  it('reports a clean success and steers the exact typed content', async () => {
    const onSendAll = vi.fn().mockResolvedValue({ ok: true, value: { sentCount: 2, result: 'ok' } })
    renderSendAll({ onSendAll })
    const dialog = openCompose()
    fireEvent.change(dialog.getByPlaceholderText('Type a message to send to every session…'), { target: { value: 'stand down' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Send All' }))
    expect(await screen.findByText('Sent to 2 session(s).')).toBeTruthy()
    expect(onSendAll).toHaveBeenCalledWith([{ type: 'text', text: 'stand down' }])
  })

  it('never folds a { failed } result into success — it surfaces as a partial-failure banner', async () => {
    const onSendAll = vi.fn().mockResolvedValue({
      ok: true,
      value: { sentCount: 1, result: { failed: 'agent "b": send refused, agent is disposed' } },
    })
    renderSendAll({ onSendAll })
    const dialog = openCompose()
    fireEvent.change(dialog.getByPlaceholderText('Type a message to send to every session…'), { target: { value: 'stand down' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Send All' }))
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Sent to 1 session(s), but some sessions did not receive it')
    expect(banner.textContent).toContain('agent "b"')
    expect(banner.getAttribute('data-variant')).toBe('partial')
  })

  it('surfaces a transport/business error rather than swallowing it', async () => {
    const onSendAll = vi.fn().mockResolvedValue({ ok: false, error: { code: 'internal', message: 'connection lost', details: {} } })
    renderSendAll({ onSendAll })
    const dialog = openCompose()
    fireEvent.change(dialog.getByPlaceholderText('Type a message to send to every session…'), { target: { value: 'stand down' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Send All' }))
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Send All failed: connection lost')
    expect(banner.getAttribute('data-variant')).toBe('error')
  })

  it('Cancel closes the dialog without sending and clears the draft on reopen', () => {
    const onSendAll = vi.fn()
    renderSendAll({ onSendAll })
    const dialog = openCompose()
    fireEvent.change(dialog.getByPlaceholderText('Type a message to send to every session…'), { target: { value: 'stand down' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onSendAll).not.toHaveBeenCalled()
    const reopened = openCompose()
    const textarea = reopened.getByPlaceholderText('Type a message to send to every session…') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
  })

  it('renders icon-only in rail mode (no wide label)', () => {
    renderSendAll({ wide: false })
    expect(screen.queryByText('Send All')).toBeNull()
  })
})

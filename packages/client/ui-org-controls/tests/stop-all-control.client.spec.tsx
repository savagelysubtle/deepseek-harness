// @vitest-environment jsdom
/**
 * Component-level behavior: the trigger disables with a visible reason when
 * nothing is running, confirms before firing, and — critically — a
 * `descendants: { failed }` outcome renders as a failure banner rather than
 * folding into the "stopped N" success line (the founder's explicit
 * must-surface requirement for SWD-130).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { StopAllControl, type StopAllControlProps } from '../src/client/StopAllControl.tsx'
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

/** StopAllControl never reads useWorkspaces; a throwing stub proves that and satisfies GlobalStandardProps. */
const useWorkspaces = (() => {
  throw new Error('StopAllControl must not call useWorkspaces')
}) as never

/**
 * StopAllControl never reads the session-scope standard kit either (it is a
 * root-wide broadcast, not a per-session action) — throwing stubs prove that
 * while satisfying the now-session-scoped `conversation.session.header.actions`
 * slot's `PropsRuntime` (SWD-162 moved this control off the sidebar foot).
 */
const useSession = (() => {
  throw new Error('StopAllControl must not call useSession')
}) as never
const useProjection = (() => {
  throw new Error('StopAllControl must not call useProjection')
}) as never
const useInput = (() => {
  throw new Error('StopAllControl must not call useInput')
}) as never
const inputActions = new Proxy({}, {
  get(): never { throw new Error('StopAllControl must not call inputActions') },
}) as never

const RUNNING_TWO: SessionListState = {
  ids: [sid('a'), sid('b'), sid('sub')],
  byId: {
    [sid('a')]: summary('a', { running: true }),
    [sid('b')]: summary('b', { running: true }),
    [sid('sub')]: summary('sub', { running: true, origin: 'subagent', parentId: sid('a') }),
  },
  current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}

const NONE_RUNNING: SessionListState = {
  ids: [sid('a')],
  byId: { [sid('a')]: summary('a', { running: false }) },
  current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}

/** Render helper: keeps every call site short — one place carries the runtime-share boilerplate. */
function renderStopAll(overrides: {
  sessions?: SessionListState
  onStopAll?: StopAllControlProps['onStopAll']
} = {}) {
  const { sessions = RUNNING_TWO, onStopAll = vi.fn() } = overrides
  return render(<StopAllControl
    sessionId={sid('current')}
    useSession={useSession}
    useProjection={useProjection}
    useInput={useInput}
    inputActions={inputActions}
    useSessions={useSessionsFixture(sessions)}
    useWorkspaces={useWorkspaces}
    onStopAll={onStopAll}
    t={translate}
  />)
}

describe('StopAllControl', () => {
  it('disables the trigger with a visible reason when nothing is running', () => {
    renderStopAll({ sessions: NONE_RUNNING })
    const trigger = screen.getByRole('button', { name: 'Stop All (no sessions are currently running)' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    // The reason must be readable on screen, not only discoverable by
    // hovering the tooltip/aria-label the assertion above already covers.
    expect(screen.getByText('No sessions are currently running.')).toBeTruthy()
  })

  it('confirms before stopping, naming the exact running count', () => {
    const onStopAll = vi.fn().mockResolvedValue({ ok: true, value: { stoppedCount: 2, descendants: 'ok' } })
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    expect(screen.getByText('This immediately stops 2 running session(s), including their subagents. This cannot be undone.')).toBeTruthy()
    expect(onStopAll).not.toHaveBeenCalled()
  })

  it('reports a clean success', async () => {
    const onStopAll = vi.fn().mockResolvedValue({ ok: true, value: { stoppedCount: 2, descendants: 'ok' } })
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    // The trigger and the confirm button share the same label ("Stop All");
    // the confirm button is the one that mounted after the trigger.
    const confirmButtons = screen.getAllByRole('button', { name: 'Stop All' })
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement)
    expect(await screen.findByText('Stopped 2 session(s).')).toBeTruthy()
  })

  it('never folds a { failed } descendants outcome into success — it surfaces as a partial-failure banner', async () => {
    const onStopAll = vi.fn().mockResolvedValue({
      ok: true,
      value: { stoppedCount: 1, descendants: { failed: 'top-disposing: agent "top-disposing": send refused, agent is disposed' } },
    })
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    const confirmButtons = screen.getAllByRole('button', { name: 'Stop All' })
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement)
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Stopped 1 session(s), but some subagents failed to stop')
    expect(banner.textContent).toContain('top-disposing')
    expect(banner.getAttribute('data-variant')).toBe('partial')
  })

  it('surfaces a transport/business error rather than swallowing it', async () => {
    const onStopAll = vi.fn().mockResolvedValue({ ok: false, error: { code: 'internal', message: 'connection lost', details: {} } })
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    const confirmButtons = screen.getAllByRole('button', { name: 'Stop All' })
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement)
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Stop All failed: connection lost')
    expect(banner.getAttribute('data-variant')).toBe('error')
  })

  it('dismisses the result banner', async () => {
    const onStopAll = vi.fn().mockResolvedValue({ ok: true, value: { stoppedCount: 2, descendants: 'ok' } })
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    const confirmButtons = screen.getAllByRole('button', { name: 'Stop All' })
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a thrown Error (promise rejection, not a { ok: false } answer) surfaces its own message', async () => {
    const onStopAll = vi.fn().mockRejectedValue(new Error('socket closed'))
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    const confirmButtons = screen.getAllByRole('button', { name: 'Stop All' })
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement)
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Stop All failed: socket closed')
    expect(banner.getAttribute('data-variant')).toBe('error')
  })

  it('a thrown non-Error rejection is stringified rather than crashing', async () => {
    const onStopAll = vi.fn().mockRejectedValue('boom')
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    const confirmButtons = screen.getAllByRole('button', { name: 'Stop All' })
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement)
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Stop All failed: boom')
  })

  it('Escape closes the confirm dialog without calling onStopAll', () => {
    const onStopAll = vi.fn()
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onStopAll).not.toHaveBeenCalled()
  })

  it('Cancel closes the confirm dialog without calling onStopAll', () => {
    const onStopAll = vi.fn()
    renderStopAll({ onStopAll })
    fireEvent.click(screen.getByRole('button', { name: 'Stop All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onStopAll).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsOpenSectionRequest, SettingsRootComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'

afterEach(cleanup)

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
  'settings.close': 'Close',
}

/** Stand-in for ModelsSection: a section body that opens a shared Modal (the
 * "Delete <provider>?" confirmation) from inside the Settings panel. */
function ModelsStandIn() {
  const [confirming, setConfirming] = useState(false)
  return (
    <div data-testid="section-models">
      <button type="button" onClick={() => { setConfirming(true) }}>Delete provider</button>
      <Modal open={confirming} onClose={() => { setConfirming(false) }} title="Delete Acme?">
        <button type="button" autoFocus onClick={() => { setConfirming(false) }}>Confirm delete</button>
      </Modal>
    </div>
  )
}

function mount({
  wide = true,
  onboardingActive = true,
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
    { id: 'agent-presets', order: 20, label: 'Agent presets' },
  ],
  steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ],
}: { wide?: boolean; onboardingActive?: boolean; rows?: Row[]; steps?: Step[] } = {}) {
  // Mutable row source standing in for the bound useSections hook; bump()
  // plays a ledger change through the same observable contract.
  let current = rows
  const listeners = new Set<() => void>()
  // Same observable shape for the settings/open-section request source;
  // fireOpenRequest() stands in for apply()'s ctx.on handler notifying it.
  let currentOpenRequest: SettingsOpenSectionRequest | undefined
  const openListeners = new Set<() => void>()
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') {
        return opts?.only === 'models'
          ? <ModelsStandIn />
          : <div data-testid={`section-${opts?.only ?? 'all'}`} />
      }
      return SEAT_CONTENT[key]
    }) as SettingsRootComponentProps['renderSlot'],
  )
  const useSessions = ((select: (state: unknown) => unknown) => select(onboardingActive
    ? { phase: 'ready', current: undefined, byId: {} }
    : {
      phase: 'ready',
      current: 'active-session',
      byId: { 'active-session': { blank: false } },
    })) as never
  const unusedHook = (() => { throw new Error('unused by SettingsRoot') }) as never
  const props: SettingsRootComponentProps = {
    useSessions,
    useWorkspaces: unusedHook,
    wide,
    useOnboardingSteps: select => select(steps),
    useSections: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(current)
    },
    useOpenRequests: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        openListeners.add(listener)
        return () => { openListeners.delete(listener) }
      }, [])
      return select(currentOpenRequest)
    },
    renderSlot,
  }
  let view = render(<SettingsRoot {...props} />)
  const bump = (next: Row[]) => {
    act(() => {
      current = next
      for (const fn of [...listeners]) fn()
    })
  }
  const fireOpenRequest = (next: SettingsOpenSectionRequest | undefined) => {
    act(() => {
      currentOpenRequest = next
      for (const fn of [...openListeners]) fn()
    })
  }
  // Unmounts the React tree and renders a fresh instance reusing the SAME
  // `props` closure — standing in for a real remount, where apply()'s
  // plugin-lifetime `currentOpenRequest` (unlike the React tree) survives
  // untouched.
  const remount = () => {
    view.unmount()
    view = render(<SettingsRoot {...props} />)
    return view
  }
  return { view, renderSlot, bump, listeners, fireOpenRequest, openListeners, remount }
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
}

describe('SettingsRoot trigger', () => {
  it('renders the trigger seat content as the accessible name (no aria-label of its own)', () => {
    const { renderSlot } = mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.hasAttribute('aria-label')).toBe(false)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: true })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings', expanded: true })).toBeTruthy()
  })

  it('hands the rail state to the trigger seat', () => {
    const { renderSlot } = mount({ wide: false })
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: false })
  })
})

describe('SettingsPanel chrome seats', () => {
  it('names the dialog via aria-labelledby pointing at the header seat node', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const titleId = dialog.getAttribute('aria-labelledby')!
    expect(titleId).toBeTruthy()
    const title = document.getElementById(titleId)!
    expect(title.textContent).toBe('Settings Title')
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
  })

  it('names the close button through the visually-hidden close seat text', () => {
    mount()
    openPanel()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.hasAttribute('aria-label')).toBe(false)
    expect(close.textContent).toContain('Close')
  })

  it('renders header actions before the shell-owned close control', () => {
    const { renderSlot } = mount()
    openPanel()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
  })
})

describe('SettingsPanel close paths', () => {
  it('closes via the header button', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via a mask click', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via document-level Escape and unhooks the listener with the panel', () => {
    mount()
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // Ignored while closed (listener removed with the panel) and non-Escape
    // keys are ignored while open.
    fireEvent.keyDown(document, { key: 'Escape' })
    openPanel()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('lands focus on the close button when the dialog opens', () => {
    mount()
    openPanel()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('SettingsPanel navigation', () => {
  it('projects rows, marks the first active, and renders only that section', () => {
    mount()
    openPanel()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('gives every section a nav glyph, distinct for the ids the shell knows', () => {
    mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'models', order: 10, label: 'Models' },
        { id: 'agent-presets', order: 20, label: 'Agent presets' },
        { id: 'plugins', order: 30, label: 'Plugins' },
        { id: 'contributed', order: 40, label: 'Contributed' },
      ],
    })
    openPanel()
    // Glyphs carry no id of their own, so the drawn paths are what tells them apart.
    const glyphs = ['General', 'Models', 'Agent presets', 'Plugins', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML)

    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    // The three ids the shell names get their own glyph; every other section —
    // including one this package never heard of — shares the gear.
    expect(new Set(glyphs.slice(0, 4)).size).toBe(4)
    expect(glyphs[4]).toBe(glyphs[0])
  })

  it('switches the rendered section on nav click', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'welcome' })
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })

    act(() => {
      (second?.[1] as { openSection: (id: string) => void }).openSection('models')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-models')).toBeTruthy()

    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { bump } = mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    openPanel()
    expect(screen.getByRole('dialog')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(c => c[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })

  it('drops the ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})

describe('SettingsRoot settings/open-section requests', () => {
  it('opens the panel and selects the requested section', () => {
    const { fireOpenRequest } = mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'tools', order: 25, label: 'Tools' },
      ],
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireOpenRequest({ section: 'tools' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tools' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-tools')).toBeTruthy()
  })

  it('a repeated request for the same section re-fires (no stale-reference guard)', () => {
    const { fireOpenRequest } = mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'tools', order: 25, label: 'Tools' },
      ],
    })
    fireOpenRequest({ section: 'tools' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireOpenRequest({ section: 'tools' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-tools')).toBeTruthy()
  })

  it('a request source reverting to undefined after being consumed is a no-op', () => {
    const { fireOpenRequest } = mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'tools', order: 25, label: 'Tools' },
      ],
    })
    fireOpenRequest({ section: 'tools' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-tools')).toBeTruthy()

    // apply() never actually resets its plugin-lifetime variable back to
    // undefined once a request has landed, but the hook's type still allows
    // it — this proves the undefined guard does not crash or reopen/reset
    // the panel when a differing-but-undefined snapshot arrives.
    fireOpenRequest(undefined)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-tools')).toBeTruthy()
  })

  it('an unknown id (already resolved to `section: undefined` by apply) opens the default section', () => {
    const { fireOpenRequest } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireOpenRequest({ section: undefined })
    expect(screen.getByRole('dialog')).toBeTruthy()
    // Falls back to the first row, same as an unregistered active id.
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('does not replay a stale request on remount (the source outlives the React tree)', () => {
    const { fireOpenRequest, remount } = mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'tools', order: 25, label: 'Tools' },
      ],
    })
    fireOpenRequest({ section: 'tools' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    // Simulates apply()'s plugin-lifetime request source surviving a React
    // remount untouched: no new event fires, so the panel must stay closed.
    remount()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('SettingsRoot through the shared Modal (OP-197)', () => {
  function openFromTrigger() {
    const trigger = screen.getByRole('button', { name: 'Settings' })
    trigger.focus()
    fireEvent.click(trigger)
    return trigger
  }

  it('renders exactly one dialog (Modal\'s) with no duplicate role/aria state of its own', () => {
    mount()
    openFromTrigger()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.hasAttribute('aria-label')).toBe(false)
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    // Portaled to body by Modal, not rendered inline next to the trigger.
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(document.querySelectorAll('[role="dialog"] [role="dialog"]')).toHaveLength(0)
  })

  it('Escape closes and returns focus to the Settings trigger, not body', () => {
    mount()
    const trigger = openFromTrigger()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('the close button restores focus to the trigger', () => {
    mount()
    const trigger = openFromTrigger()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(document.activeElement).toBe(trigger)
  })

  it('a mask click restores focus to the trigger', () => {
    mount()
    const trigger = openFromTrigger()
    const mask = screen.getByRole('dialog').parentElement?.querySelector('[aria-hidden="true"]')
    expect(mask).toBeTruthy()
    fireEvent.click(mask as Element)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('makes the page behind the panel inert and restores it on close', () => {
    const { view } = mount()
    openFromTrigger()
    expect(view.container.inert).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.container.inert).toBeFalsy()
  })

  it('traps Tab and Shift+Tab inside the panel', () => {
    mount()
    openFromTrigger()
    const dialog = screen.getByRole('dialog')
    const tabbables = Array.from(dialog.querySelectorAll<HTMLElement>('button'))
    const first = tabbables[0]!
    const last = tabbables.at(-1)!
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('a Modal opened inside Settings stacks on top: Settings goes inert, then is restored with focus back in the panel and finally on the trigger', () => {
    const { view } = mount()
    const trigger = openFromTrigger()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const deleteButton = screen.getByRole('button', { name: 'Delete provider' })
    deleteButton.focus()
    fireEvent.click(deleteButton)

    const dialogs = screen.getAllByRole('dialog', { hidden: true })
    expect(dialogs).toHaveLength(2)
    const settingsRoot = dialogs[0]!.parentElement!
    const innerRoot = dialogs[1]!.parentElement!
    expect(settingsRoot.inert).toBeFalsy()
    expect(innerRoot.inert).toBeFalsy()
    expect(view.container.inert).toBe(true)
    expect(dialogs[1]!.contains(document.activeElement)).toBe(true)

    // The inner Modal is topmost: Tab wraps inside it, not the Settings panel.
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialogs[1]!.contains(document.activeElement)).toBe(true)

    // Escape closes only the topmost (the confirmation): Settings stays open,
    // un-inert, with focus back on the control that opened the confirmation.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Delete Acme?' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
    expect(settingsRoot.inert).toBeFalsy()
    expect(document.activeElement).toBe(deleteButton)

    // A second Escape closes Settings and focus lands on the trigger.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(view.container.inert).toBeFalsy()
  })
})

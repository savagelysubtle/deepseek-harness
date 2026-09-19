// @vitest-environment jsdom
/**
 * Footer trigger + modal wiring: the trigger opens the modal, opening (re-)
 * issues `load`, the modal renders whatever the bound `useOrgBoard` snapshot
 * says, rail mode drops the label, and the Refresh button re-issues `load`
 * without a confirm step (this slice is read-only — a re-read is not a
 * mutation and needs none of Stop All's confirm-first ceremony).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { OrgBoardControl, type OrgBoardControlProps } from '../src/client/OrgBoardControl.tsx'
import type { OrgBoardState } from '../src/client/org-board-store.ts'
import { en, type OrgBoardKey } from '../src/client/locales.ts'

afterEach(cleanup)

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })

function translate(key: LocaleKeysOf<'orgBoard'>, params?: Record<string, unknown>): string {
  const template = en[key as OrgBoardKey] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : `{${name}}`
  })
}

const IDLE_STATE: OrgBoardState = {
  status: 'idle', error: null, value: null, write: { pending: false, notice: null },
}

/** GlobalStandardProps stubs OrgBoardControl never reads (org.get, not sessions/workspaces). */
const useSessions = (() => {
  throw new Error('OrgBoardControl must not call useSessions')
}) as unknown as OrgBoardControlProps['useSessions']
const useWorkspaces = (() => {
  throw new Error('OrgBoardControl must not call useWorkspaces')
}) as unknown as OrgBoardControlProps['useWorkspaces']

function renderControl(overrides: { wide?: boolean; state?: OrgBoardState } = {}) {
  const { wide = true, state = IDLE_STATE } = overrides
  const load = vi.fn<OrgBoardControlProps['load']>().mockResolvedValue(undefined)
  // OrgBoardControl itself only reads `load` (this slice is still read-only
  // UI-wise — step 4 wires the write verbs into visible controls), but its
  // props type pulls in the whole OrgBoardFace, so every verb must be
  // supplied here regardless of whether the component reads it.
  const addSeat = vi.fn<OrgBoardControlProps['addSeat']>().mockResolvedValue(undefined)
  const removeSeat = vi.fn<OrgBoardControlProps['removeSeat']>().mockResolvedValue(undefined)
  const addEdge = vi.fn<OrgBoardControlProps['addEdge']>().mockResolvedValue(undefined)
  const removeEdge = vi.fn<OrgBoardControlProps['removeEdge']>().mockResolvedValue(undefined)
  const setSeatTools = vi.fn<OrgBoardControlProps['setSeatTools']>().mockResolvedValue(undefined)
  const useOrgBoard = (<S,>(selector: (snapshot: OrgBoardState) => S): S => selector(state)) as OrgBoardControlProps['useOrgBoard']
  return {
    load,
    ...render(<OrgBoardControl
      wide={wide}
      useSessions={useSessions}
      useWorkspaces={useWorkspaces}
      useOrgBoard={useOrgBoard}
      load={load}
      addSeat={addSeat}
      removeSeat={removeSeat}
      addEdge={addEdge}
      removeEdge={removeEdge}
      setSeatTools={setSeatTools}
      t={translate}
    />),
  }
}

describe('OrgBoardControl', () => {
  it('renders wide with a visible label', () => {
    renderControl({ wide: true })
    expect(screen.getByRole('button', { name: 'Org Board' })).toBeTruthy()
    expect(screen.getByText('Org Board')).toBeTruthy()
  })

  it('renders icon-only in rail mode (no wide label)', () => {
    renderControl({ wide: false })
    expect(screen.queryByText('Org Board')).toBeNull()
    expect(screen.getByRole('button', { name: 'Org Board' })).toBeTruthy()
  })

  it('the modal is closed until the trigger is clicked', () => {
    renderControl()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('clicking the trigger opens the modal and issues load', async () => {
    const { load } = renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Org Board' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('renders the bound snapshot state inside the modal', async () => {
    renderControl({
      state: {
        status: 'error',
        error: 'connection lost',
        value: null,
        write: { pending: false, notice: null },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Org Board' }))
    expect(await screen.findByText('Org board unavailable: connection lost')).toBeTruthy()
  })

  it('the Refresh button re-issues load without a confirm step', async () => {
    const { load } = renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Org Board' }))
    await screen.findByRole('dialog')
    load.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('closing the modal and reopening it re-issues load', async () => {
    const { load } = renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Org Board' }))
    await screen.findByRole('dialog')
    load.mockClear()
    fireEvent.click(screen.getByLabelText('Close'))
    fireEvent.click(screen.getByRole('button', { name: 'Org Board' }))
    expect(load).toHaveBeenCalledTimes(1)
  })
})

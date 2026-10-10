// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { ToolsSection } from '../src/client/ToolsSection.tsx'
import type { ToolsTranslate } from '../src/client/ToolsSection.tsx'
import { McpToolsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ToolsTranslate = key => en[key]

function statusOf(serverName: string, overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return { serverName, state: 'connected', attempts: 0, maxAttempts: 10, ...overrides }
}

function bench(rows: McpServerStatus[]) {
  const status = vi.fn(() => Promise.resolve(rows))
  const controller = new McpToolsStore({ status })
  const useSnapshot = bindSnapshotSelector(controller.store)
  const authorize = vi.fn<(serverName: string) => Promise<string>>()
  const reconnect = vi.fn<(serverName: string) => Promise<void>>().mockResolvedValue(undefined)
  const setEnabled = vi.fn<(serverName: string, enabled: boolean) => Promise<void>>().mockResolvedValue(undefined)
  return { controller, useSnapshot, authorize, reconnect, setEnabled, status, t }
}

describe('ToolsSection', () => {
  it('renders nothing until the shell injects', () => {
    const view = render(<ToolsSection />)
    expect(view.container.innerHTML).toBe('')
  })

  it('renders one row per server with a plain-word state badge and the right actions', async () => {
    const rows = [
      statusOf('alpha', { state: 'connected' }),
      statusOf('beta', { state: 'connecting' }),
      statusOf('gamma', { state: 'needs-authorization' }),
      statusOf('delta', { state: 'gave-up', attempts: 3, maxAttempts: 3 }),
      statusOf('epsilon', { state: 'disabled' }),
    ]
    const bundle = bench(rows)
    render(<ToolsSection {...bundle} />)
    await waitFor(() => { expect(screen.getAllByRole('listitem')).toHaveLength(5) })

    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('Connecting')).toBeTruthy()
    expect(screen.getByText('Needs authorization')).toBeTruthy()
    expect(screen.getByText('Gave up after 3 attempts')).toBeTruthy()
    expect(screen.getByText('Disabled')).toBeTruthy()

    // Authorize: needs-authorization or gave-up only.
    expect(screen.getAllByRole('button', { name: 'Authorize' })).toHaveLength(2)
    // Reconnect: gave-up only.
    expect(screen.getAllByRole('button', { name: 'Reconnect' })).toHaveLength(1)
    // Enable/Disable toggle: Enable for the one disabled row, Disable for the rest.
    expect(screen.getAllByRole('button', { name: 'Enable' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(4)
  })

  it('shows last-error text on a row that carries one', async () => {
    const bundle = bench([statusOf('alpha', { state: 'gave-up', lastError: 'connection refused' })])
    render(<ToolsSection {...bundle} />)
    await screen.findByText('Last error: connection refused')
  })

  it('shows the empty state once loaded with no servers', async () => {
    const bundle = bench([])
    render(<ToolsSection {...bundle} />)
    await screen.findByText(en.empty)
  })

  it('shows a load failure and retries into the empty state', async () => {
    const status = vi.fn<() => Promise<McpServerStatus[]>>()
      .mockRejectedValueOnce(new Error('transport down'))
      .mockResolvedValueOnce([])
    const controller = new McpToolsStore({ status })
    const useSnapshot = bindSnapshotSelector(controller.store)
    render(
      <ToolsSection
        controller={controller}
        useSnapshot={useSnapshot}
        authorize={vi.fn()}
        reconnect={vi.fn()}
        setEnabled={vi.fn()}
        t={t}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByText(en.empty)
  })

  it('the Refresh button re-loads the roster', async () => {
    const bundle = bench([statusOf('alpha')])
    render(<ToolsSection {...bundle} />)
    await waitFor(() => { expect(bundle.status).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(bundle.status).toHaveBeenCalledTimes(2) })
  })

  it('a live mcp/status-changed push updates the matching row without a reload', async () => {
    const bundle = bench([statusOf('alpha', { state: 'connecting' })])
    render(<ToolsSection {...bundle} />)
    await screen.findByText('Connecting')
    act(() => { bundle.controller.applyStatus(statusOf('alpha', { state: 'connected' })) })
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(bundle.status).toHaveBeenCalledOnce()
  })

  describe('Authorize', () => {
    it('opens a real-handle tab synchronously, severs its opener, then navigates it once authorize-start resolves', async () => {
      const bundle = bench([statusOf('alpha', { state: 'needs-authorization' })])
      const fakeTab = { location: { href: '' }, close: vi.fn(), opener: {} } as unknown as Window
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeTab)
      const deferred = Promise.withResolvers<string>()
      bundle.authorize.mockReturnValue(deferred.promise)
      render(<ToolsSection {...bundle} />)

      const button = await screen.findByRole('button', { name: 'Authorize' })
      fireEvent.click(button)

      // 'noopener' would make window.open itself return null (per spec it
      // severs the handle, not just the opener property) — a real handle
      // needs the feature left off; the opener is severed by hand instead.
      expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank')
      expect(fakeTab.opener).toBeNull()
      expect(bundle.authorize).toHaveBeenCalledWith('alpha')
      expect(fakeTab.location.href).toBe('')

      await act(async () => { deferred.resolve('https://example.com/consent') })
      expect(fakeTab.location.href).toBe('https://example.com/consent')
      openSpy.mockRestore()
    })

    it('closes the tab and shows loud failure text when authorize-start rejects', async () => {
      const bundle = bench([statusOf('alpha', { state: 'needs-authorization' })])
      const close = vi.fn()
      const fakeTab = { location: { href: '' }, close, opener: {} } as unknown as Window
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeTab)
      const deferred = Promise.withResolvers<string>()
      bundle.authorize.mockReturnValue(deferred.promise)
      render(<ToolsSection {...bundle} />)

      fireEvent.click(await screen.findByRole('button', { name: 'Authorize' }))
      await act(async () => { deferred.reject(new Error('consent denied')) })

      expect(close).toHaveBeenCalledOnce()
      expect((await screen.findByRole('alert')).textContent).toBe('consent denied')
      openSpy.mockRestore()
    })

    it('a popup blocker (window.open returns null) shows inline failure text and never calls authorize-start', async () => {
      const bundle = bench([statusOf('alpha', { state: 'needs-authorization' })])
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Authorize' }))
      expect((await screen.findByRole('alert')).textContent).toBe(en.popupBlocked)
      expect(bundle.authorize).not.toHaveBeenCalled()
      openSpy.mockRestore()
    })
  })

  describe('Reconnect', () => {
    it('calls the endpoint for a gave-up server', async () => {
      const bundle = bench([statusOf('alpha', { state: 'gave-up' })])
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
      await waitFor(() => { expect(bundle.reconnect).toHaveBeenCalledWith('alpha') })
    })

    it('shows loud failure text when the call rejects', async () => {
      const bundle = bench([statusOf('alpha', { state: 'gave-up' })])
      bundle.reconnect.mockRejectedValueOnce(new Error('still unreachable'))
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
      expect((await screen.findByRole('alert')).textContent).toBe('still unreachable')
    })
  })

  describe('Enable/Disable toggle', () => {
    it('Disable requires acknowledgement before it calls set-enabled', async () => {
      const bundle = bench([statusOf('alpha', { state: 'connected' })])
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))

      const checkbox = await screen.findByRole('checkbox')
      const dialog = screen.getByRole('dialog')
      const confirmButton = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.disableConfirmConfirm })
      expect(confirmButton.disabled).toBe(true)
      expect(bundle.setEnabled).not.toHaveBeenCalled()

      fireEvent.click(checkbox)
      expect(confirmButton.disabled).toBe(false)
      fireEvent.click(confirmButton)
      await waitFor(() => { expect(bundle.setEnabled).toHaveBeenCalledWith('alpha', false) })
    })

    it('cancelling the Disable confirmation never calls set-enabled', async () => {
      const bundle = bench([statusOf('alpha', { state: 'connected' })])
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
      fireEvent.click(await screen.findByRole('button', { name: en.disableConfirmCancel }))
      await waitFor(() => { expect(screen.queryByRole('checkbox')).toBeNull() })
      expect(bundle.setEnabled).not.toHaveBeenCalled()
    })

    it('shows loud failure text when a confirmed Disable rejects', async () => {
      const bundle = bench([statusOf('alpha', { state: 'connected' })])
      bundle.setEnabled.mockRejectedValueOnce(new Error('patch write failed'))
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
      fireEvent.click(await screen.findByRole('checkbox'))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.disableConfirmConfirm }))
      expect((await screen.findByRole('alert')).textContent).toBe('patch write failed')
    })

    it('ignores Cancel while a confirmed Disable is still in flight', async () => {
      const bundle = bench([statusOf('alpha', { state: 'connected' })])
      let resolve: () => void = () => {}
      bundle.setEnabled.mockReturnValue(new Promise((res) => { resolve = res }))
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
      fireEvent.click(await screen.findByRole('checkbox'))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.disableConfirmConfirm }))
      await screen.findByRole('button', { name: en.disabling })

      fireEvent.click(screen.getByRole('button', { name: en.disableConfirmCancel }))
      expect(screen.getByRole('dialog')).toBeTruthy()

      await act(async () => { resolve() })
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    })

    it('Enable calls set-enabled directly, without a confirmation step', async () => {
      const bundle = bench([statusOf('alpha', { state: 'disabled' })])
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
      await waitFor(() => { expect(bundle.setEnabled).toHaveBeenCalledWith('alpha', true) })
      expect(screen.queryByRole('checkbox')).toBeNull()
    })

    it('shows loud failure text when Enable rejects', async () => {
      const bundle = bench([statusOf('alpha', { state: 'disabled' })])
      bundle.setEnabled.mockRejectedValueOnce(new Error('mount not found'))
      render(<ToolsSection {...bundle} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
      expect((await screen.findByRole('alert')).textContent).toBe('mount not found')
    })
  })
})

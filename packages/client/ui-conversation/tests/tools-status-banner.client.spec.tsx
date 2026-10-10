// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ToolsStatusBanner } from '../src/client/skeleton/ToolsStatusBanner.tsx'
import type { McpAttentionStatus } from '../src/client/mcp-status-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

function mount(servers: readonly McpAttentionStatus[]) {
  const openSettingsSection = vi.fn()
  const { rerender } = render(
    <ToolsStatusBanner servers={servers} openSettingsSection={openSettingsSection} t={makeTranslate(en)} />,
  )
  return {
    openSettingsSection,
    rerender: (next: readonly McpAttentionStatus[]) => {
      rerender(<ToolsStatusBanner servers={next} openSettingsSection={openSettingsSection} t={makeTranslate(en)} />)
    },
  }
}

describe('ToolsStatusBanner', () => {
  it('renders nothing while every server is quiet', () => {
    mount([])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('names a needs-authorization server', () => {
    mount([{ serverName: 'stripe', state: 'needs-authorization' }])
    expect(screen.getByText('Tools need attention: stripe need authorization')).toBeDefined()
  })

  it('names a gave-up server with its own clause', () => {
    mount([{ serverName: 'supabase', state: 'gave-up' }])
    expect(screen.getByText('supabase gave up reconnecting')).toBeDefined()
  })

  it('joins both clauses, each with every affected server, when both states are present', () => {
    mount([
      { serverName: 'stripe', state: 'needs-authorization' },
      { serverName: 'zeta', state: 'needs-authorization' },
      { serverName: 'supabase', state: 'gave-up' },
    ])
    expect(screen.getByText(
      'Tools need attention: stripe, zeta need authorization supabase gave up reconnecting',
    )).toBeDefined()
  })

  it('calls the settings-open mechanism with "tools" when its link is clicked', () => {
    const { openSettingsSection } = mount([{ serverName: 'stripe', state: 'needs-authorization' }])
    fireEvent.click(screen.getByRole('button', { name: 'Open Tools settings' }))
    expect(openSettingsSection).toHaveBeenCalledExactlyOnceWith('tools')
  })

  it('dismisses the banner and keeps it hidden until the affected set changes', () => {
    const { rerender } = mount([{ serverName: 'stripe', state: 'needs-authorization' }])
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(screen.queryByRole('status')).toBeNull()

    // Same set, re-rendered (e.g. an unrelated status-changed tick): stays dismissed.
    rerender([{ serverName: 'stripe', state: 'needs-authorization' }])
    expect(screen.queryByRole('status')).toBeNull()

    // The affected set changed: the banner reopens even though it was dismissed before.
    rerender([{ serverName: 'stripe', state: 'gave-up' }])
    expect(screen.getByText('stripe gave up reconnecting')).toBeDefined()
  })

  it('reopens after dismissal when a previously-quiet server joins the affected set', () => {
    const { rerender } = mount([{ serverName: 'stripe', state: 'needs-authorization' }])
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    rerender([
      { serverName: 'stripe', state: 'needs-authorization' },
      { serverName: 'supabase', state: 'gave-up' },
    ])
    expect(screen.getByRole('status')).toBeDefined()
  })
})

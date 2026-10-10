// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { McpServerStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { ToolsSection } from '../src/client/ToolsSection.tsx'
import type { ToolsSectionInjected } from '../src/client/ToolsSection.tsx'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

function statusOf(serverName: string, overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return { serverName, state: 'connected', attempts: 0, maxAttempts: 10, ...overrides }
}

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * Minimal `remote` service test double extending Cordis's `Service` base so
 * dotted-namespace property access (`ctx.remote.mcp`) resolves through the
 * same Proxy mechanism production uses — a plain `ctx.provide('remote', ...)`
 * (as `TestRemote` does) has no service tracker and cannot do this. `$on`/
 * `$dispatch` are copied from `TestRemote`'s own subscription/dispatch logic.
 */
class RemoteService extends Service {
  private readonly subscriptions = new Map<string, Set<(...args: never[]) => void>>()

  constructor(serviceCtx: Context) {
    super(serviceCtx, 'remote')
  }

  $dispatch(event: string, args: readonly unknown[]): void {
    const listeners = this.subscriptions.get(event)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener(...args as never[])
  }

  $on(event: string, listener: (...args: never[]) => void): () => void {
    const listeners = this.subscriptions.get(event) ?? new Set()
    this.subscriptions.set(event, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  new RemoteService(ctx)
  const status = vi.fn<() => Promise<RemoteResult<McpServerStatus[]>>>()
    .mockResolvedValue({ ok: true, value: [] })
  const authorizeStart = vi.fn<(serverName: string) => Promise<RemoteResult<{ consentUrl: string }>>>()
  const reconnect = vi.fn<(serverName: string) => Promise<RemoteResult<void>>>()
  const setEnabled = vi.fn<(serverName: string, enabled: boolean) => Promise<RemoteResult<void>>>()
  ctx.provide('remote.mcp', {
    status,
    'authorize-start': authorizeStart,
    reconnect,
    'set-enabled': setEnabled,
  })
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, status, authorizeStart, reconnect, setEnabled,
  }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-tools browser plugin', () => {
  it('declares the mcp Remote namespace specifically, not just any remote mount', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.mcp'])
  })

  it('registers the Tools nav entry with the right id/order and a locale-following label', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section').find(candidate => candidate.options.id === 'tools')!
    expect(entry.component).toBe(ToolsSection)
    expect(entry.options).toMatchObject({ id: 'tools', order: 25 })
    expect(resolveSlotLabel(entry.options.label)).toBe('工具')
    expect(b.locale.bind(NS)('nav')).toBe('工具')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Tools')
    b.locale.setLocale('zh')

    await b.ctx.fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    // The (ns, locale) seats are free again — the dictionary disposer ran.
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
  })

  it('wires status/authorize/reconnect/set-enabled, each unwrapping a rejected RemoteResult into a thrown Error', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section').find(candidate => candidate.options.id === 'tools')!
    const injected = (entry.inject as unknown as () => ToolsSectionInjected)()

    const rows = [statusOf('alpha')]
    b.status.mockResolvedValueOnce({ ok: true, value: rows })
    await injected.controller.load()
    expect(injected.controller.store.getSnapshot()).toEqual({ status: 'ready', error: null, rows })

    b.status.mockResolvedValueOnce({ ok: false, error: { code: 'UNAVAILABLE', message: 'mcp offline' } })
    await injected.controller.load()
    expect(injected.controller.store.getSnapshot().error).toBe('mcp.status failed: UNAVAILABLE: mcp offline')

    b.authorizeStart.mockResolvedValueOnce({ ok: true, value: { consentUrl: 'https://example.com/c' } })
    await expect(injected.authorize('alpha')).resolves.toBe('https://example.com/c')
    expect(b.authorizeStart).toHaveBeenCalledWith('alpha')
    b.authorizeStart.mockResolvedValueOnce({ ok: false, error: { code: 'DENIED', message: 'nope' } })
    await expect(injected.authorize('alpha')).rejects.toThrow('mcp.authorize-start failed: DENIED: nope')

    b.reconnect.mockResolvedValueOnce({ ok: true, value: undefined })
    await expect(injected.reconnect('alpha')).resolves.toBeUndefined()
    expect(b.reconnect).toHaveBeenCalledWith('alpha')
    b.reconnect.mockResolvedValueOnce({ ok: false, error: { code: 'TIMEOUT', message: 'slow' } })
    await expect(injected.reconnect('alpha')).rejects.toThrow('mcp.reconnect failed: TIMEOUT: slow')

    b.setEnabled.mockResolvedValueOnce({ ok: true, value: undefined })
    await expect(injected.setEnabled('alpha', false)).resolves.toBeUndefined()
    expect(b.setEnabled).toHaveBeenCalledWith('alpha', false)
    b.setEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'LOCKED', message: 'busy' } })
    await expect(injected.setEnabled('alpha', true)).rejects.toThrow('mcp.set-enabled failed: LOCKED: busy')

    await b.ctx.fiber.dispose()
  })

  it('folds a live mcp/status-changed push into the controller without a reload', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section').find(candidate => candidate.options.id === 'tools')!
    const injected = (entry.inject as unknown as () => ToolsSectionInjected)()

    const pushed = statusOf('beta', { state: 'gave-up', attempts: 2 })
    b.ctx.remote.$dispatch('mcp/status-changed', [pushed])
    expect(injected.controller.store.getSnapshot().rows).toEqual([pushed])
    expect(b.status).not.toHaveBeenCalled()

    await b.ctx.fiber.dispose()
  })
})

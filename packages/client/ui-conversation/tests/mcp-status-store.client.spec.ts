import { describe, expect, it, vi } from 'vitest'
import type { McpServerStatus } from '@deepseek-ai/dsh-mcp-client/status'
import { McpAttentionStore } from '../src/client/mcp-status-store.ts'
import type { McpStatusRemote } from '../src/client/mcp-status-store.ts'

function status(partial: Partial<McpServerStatus> & { serverName: string; state: McpServerStatus['state'] }): McpServerStatus {
  return { attempts: 0, maxAttempts: 3, ...partial }
}

function remoteOk(value: McpServerStatus[]): McpStatusRemote {
  return { status: vi.fn(async () => ({ ok: true as const, value })) }
}

describe('McpAttentionStore', () => {
  it('starts empty and stays empty while the Remote namespace is not yet mounted', async () => {
    const getRemote = vi.fn(() => undefined)
    const store = new McpAttentionStore(getRemote)
    expect(store.store.getSnapshot()).toEqual([])
    await store.load()
    expect(getRemote).toHaveBeenCalledOnce()
    expect(store.store.getSnapshot()).toEqual([])
  })

  it('loads and keeps only needs-authorization/gave-up servers, sorted by name', async () => {
    const remote = remoteOk([
      status({ serverName: 'stripe', state: 'connected' }),
      status({ serverName: 'zeta', state: 'needs-authorization' }),
      status({ serverName: 'alpha', state: 'gave-up' }),
      status({ serverName: 'supabase', state: 'connecting' }),
      status({ serverName: 'offline-one', state: 'disabled' }),
    ])
    const store = new McpAttentionStore(() => remote)
    await store.load()
    expect(store.store.getSnapshot()).toEqual([
      { serverName: 'alpha', state: 'gave-up' },
      { serverName: 'zeta', state: 'needs-authorization' },
    ])
  })

  it('leaves the last-known set when the Remote call resolves not-ok', async () => {
    const remote: McpStatusRemote = { status: vi.fn(async () => ({ ok: false as const, error: { message: 'boom' } })) }
    const store = new McpAttentionStore(() => remote)
    await store.load()
    expect(store.store.getSnapshot()).toEqual([])
  })

  it('leaves the last-known set when the Remote call throws (not an unhandled rejection)', async () => {
    const remote: McpStatusRemote = { status: vi.fn(async () => { throw new Error('offline') }) }
    const store = new McpAttentionStore(() => remote)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.store.getSnapshot()).toEqual([])
  })

  it('folds a forwarded mcp/status-changed event into the live set by serverName', async () => {
    const remote = remoteOk([status({ serverName: 'stripe', state: 'needs-authorization' })])
    const store = new McpAttentionStore(() => remote)
    await store.load()
    expect(store.store.getSnapshot()).toEqual([{ serverName: 'stripe', state: 'needs-authorization' }])

    store.apply(status({ serverName: 'stripe', state: 'connected' }))
    expect(store.store.getSnapshot()).toEqual([])

    store.apply(status({ serverName: 'supabase', state: 'gave-up' }))
    expect(store.store.getSnapshot()).toEqual([{ serverName: 'supabase', state: 'gave-up' }])
  })

  it('drops a server whose forwarded status carries removed: true, rather than merging it in', async () => {
    const remote = remoteOk([status({ serverName: 'stripe', state: 'needs-authorization' })])
    const store = new McpAttentionStore(() => remote)
    await store.load()
    expect(store.store.getSnapshot()).toEqual([{ serverName: 'stripe', state: 'needs-authorization' }])

    store.apply(status({ serverName: 'stripe', state: 'needs-authorization', removed: true }))
    expect(store.store.getSnapshot()).toEqual([])
  })

  it('re-resolves the Remote face on every load call rather than caching an early undefined', async () => {
    const box: { remote?: McpStatusRemote } = {}
    const store = new McpAttentionStore(() => box.remote)
    await store.load()
    expect(store.store.getSnapshot()).toEqual([])

    box.remote = remoteOk([status({ serverName: 'stripe', state: 'needs-authorization' })])
    await store.load()
    expect(store.store.getSnapshot()).toEqual([{ serverName: 'stripe', state: 'needs-authorization' }])
  })
})

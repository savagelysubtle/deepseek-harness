import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { McpServerStatus } from '@deepseek-ai/dsh-mcp-client/status'
import { McpAttentionStore } from '../src/client/mcp-status-store.ts'
import type { McpStatusRemote } from '../src/client/mcp-status-store.ts'

/**
 * Stands in for api-gateway's `ClientRemoteService` (registered as `'remote'`
 * through the real `Service` base class, which is what gives `ctx.remote`
 * its property-forwarding tracker) — a plain `ctx.provide('remote', {})`
 * object has no tracker and can never reproduce the regression below.
 */
class FakeRemoteService extends Service {
  constructor(ctx: Context) { super(ctx, 'remote') }
}

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

/**
 * Production `getRemote` wiring (apply.ts): `ctx.get('remote.mcp')`, not the
 * `ctx.remote.mcp` property chain. In the real app, `packages/api/remotes`'s
 * aggregator mounts the `mcp` Remote namespace from its OWN fiber — a
 * sibling of ui-conversation's fiber, never an ancestor, and never a name
 * this package injects. Property access forwards through a tracker that
 * walks only the calling fiber's ANCESTOR chain looking for a fiber whose
 * own store resolved the name (via that fiber's own `inject`); a sibling's
 * provide is invisible to that walk, so it throws `cannot get property
 * "remote.mcp" without inject` on every access once the namespace mounts —
 * the console error pilot found on every page load. `ctx.get` instead reads
 * the shared reflect store directly, which does see it.
 */
describe('getRemote wiring: ctx.remote.mcp (regression) vs ctx.get (fix)', () => {
  /** Mounts `fakeRemote` under `'remote.mcp'` from a fiber sibling to the consumer's. */
  async function withSiblingMountedMcp(fakeRemote: McpStatusRemote, consumer: (ctx: Context) => void) {
    const ctx = new Context()
    new FakeRemoteService(ctx)
    await ctx.plugin({ apply: (sibling: Context) => { sibling.provide('remote.mcp', fakeRemote) } }).await()
    await ctx.plugin({ inject: ['remote'], apply: consumer }).await()
  }

  it('ctx.remote.mcp throws across the sibling boundary — proves the bug this fix addresses', async () => {
    let caught: unknown
    await withSiblingMountedMcp({ status: vi.fn() }, (ctx) => {
      try {
        void (ctx as unknown as { remote: { mcp: unknown } }).remote.mcp
      } catch (error) {
        caught = error
      }
    })
    expect((caught as Error | undefined)?.message).toBe('cannot get property "remote.mcp" without inject')
  })

  it("ctx.get('remote.mcp') resolves the same sibling-mounted face without throwing", async () => {
    const fakeRemote: McpStatusRemote = { status: vi.fn() }
    let resolved: McpStatusRemote | undefined
    await withSiblingMountedMcp(fakeRemote, (ctx) => {
      resolved = ctx.get('remote.mcp') as McpStatusRemote | undefined
    })
    expect(resolved).toBe(fakeRemote)
  })

  it('McpAttentionStore.load(), wired the production way, loads from the sibling-mounted face without throwing or logging', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fakeRemote = remoteOk([status({ serverName: 'stripe', state: 'needs-authorization' })])
    let loaded: readonly { serverName: string }[] = []
    await withSiblingMountedMcp(fakeRemote, (ctx) => {
      const store = new McpAttentionStore(() => ctx.get('remote.mcp') as McpStatusRemote | undefined)
      void store.load().then(() => { loaded = store.store.getSnapshot() })
    })
    await vi.waitFor(() => { expect(loaded).toHaveLength(1) })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { McpServerStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { McpToolsStore, messageOf } from '../src/client/store.ts'

function statusOf(serverName: string, overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return { serverName, state: 'connected', attempts: 0, maxAttempts: 10, ...overrides }
}

describe('messageOf', () => {
  it('reads an Error message and stringifies anything else', () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf('plain string')).toBe('plain string')
    expect(messageOf({ weird: true })).toBe('[object Object]')
  })
})

describe('McpToolsStore', () => {
  it('starts idle and transitions through loading to ready', async () => {
    const rows = [statusOf('alpha'), statusOf('beta', { state: 'connecting' })]
    const status = vi.fn().mockResolvedValue(rows)
    const store = new McpToolsStore({ status })
    expect(store.store.getSnapshot()).toEqual({ status: 'idle', error: null, rows: [] })

    const promise = store.load()
    expect(store.store.getSnapshot().status).toBe('loading')
    await promise
    expect(store.store.getSnapshot()).toEqual({ status: 'ready', error: null, rows })
    expect(status).toHaveBeenCalledOnce()
  })

  it('surfaces a load failure and keeps the previous rows', async () => {
    const rows = [statusOf('alpha')]
    const status = vi.fn()
      .mockResolvedValueOnce(rows)
      .mockRejectedValueOnce(new Error('transport down'))
    const store = new McpToolsStore({ status })
    await store.load()
    await store.load()
    expect(store.store.getSnapshot()).toEqual({ status: 'error', error: 'transport down', rows })
  })

  it('drops a stale load resolution superseded by a newer one', async () => {
    const first = Promise.withResolvers<McpServerStatus[]>()
    const second = Promise.withResolvers<McpServerStatus[]>()
    const status = vi.fn<() => Promise<McpServerStatus[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = new McpToolsStore({ status })

    const firstLoad = store.load()
    const secondLoad = store.load()
    second.resolve([statusOf('beta')])
    await secondLoad
    first.resolve([statusOf('alpha')])
    await firstLoad

    expect(store.store.getSnapshot().rows).toEqual([statusOf('beta')])
  })

  it('drops a stale load rejection superseded by a newer resolution', async () => {
    const first = Promise.withResolvers<McpServerStatus[]>()
    const second = Promise.withResolvers<McpServerStatus[]>()
    const status = vi.fn<() => Promise<McpServerStatus[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = new McpToolsStore({ status })

    const firstLoad = store.load()
    const secondLoad = store.load()
    second.resolve([statusOf('beta')])
    await secondLoad
    first.reject(new Error('stale failure'))
    await firstLoad

    expect(store.store.getSnapshot()).toEqual({ status: 'ready', error: null, rows: [statusOf('beta')] })
  })

  it('applyStatus replaces an existing row by serverName', async () => {
    const status = vi.fn().mockResolvedValue([statusOf('alpha'), statusOf('beta')])
    const store = new McpToolsStore({ status })
    await store.load()
    store.applyStatus(statusOf('beta', { state: 'gave-up', attempts: 5 }))
    expect(store.store.getSnapshot().rows).toEqual([
      statusOf('alpha'),
      statusOf('beta', { state: 'gave-up', attempts: 5 }),
    ])
  })

  it('applyStatus appends a server not previously listed', () => {
    const store = new McpToolsStore({ status: vi.fn() })
    store.applyStatus(statusOf('new-server'))
    expect(store.store.getSnapshot().rows).toEqual([statusOf('new-server')])
  })

  it('applyStatus deletes the row when the push carries removed: true', async () => {
    const status = vi.fn().mockResolvedValue([statusOf('alpha'), statusOf('beta')])
    const store = new McpToolsStore({ status })
    await store.load()
    store.applyStatus({ ...statusOf('alpha'), removed: true })
    expect(store.store.getSnapshot().rows).toEqual([statusOf('beta')])
  })

  it('applyStatus is a no-op when a removed: true push names a server not in the roster', () => {
    const store = new McpToolsStore({ status: vi.fn() })
    store.applyStatus({ ...statusOf('ghost'), removed: true })
    expect(store.store.getSnapshot().rows).toEqual([])
  })
})

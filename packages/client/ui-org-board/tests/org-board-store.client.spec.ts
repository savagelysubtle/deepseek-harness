/**
 * Controller coverage: a successful read publishes the full value, an outer
 * RPC failure publishes ITS OWN error state (not a "ready with everything
 * unavailable" shape), a thrown transport error is caught the same way, a
 * stale in-flight response never overwrites a newer one, dispose stops any
 * further publish, and a reconnect refreshes a loaded board (never leaving
 * pre-reconnect data on screen) while staying a no-op before first load.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ResponseValue, RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { OrgBoardController, refreshOrgBoardIfLoaded } from '../src/client/org-board-store.ts'

/** The `org.get` response envelope, exactly as the controller's caller receives it. */
type OrgGetResponse = RpcResponse<ResponseValue<'org.get'>>

let rpc = 0

/** A successful envelope. Built through the real response type so a wire-shape change breaks here. */
function ok(value: ResponseValue<'org.get'>): OrgGetResponse {
  return { rpcId: `org-get-${rpc++}` as never, result: { ok: true, value } }
}

/** A failed envelope: the call reached the host and the host refused it. */
function failed(message: string): OrgGetResponse {
  return {
    rpcId: `org-get-${rpc++}` as never,
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  }
}

const VALUE: ResponseValue<'org.get'> = {
  profile: 'web-stable',
  registry: {
    ok: true,
    registry: {
      baseDir: '/org', seats: { alfred: { cwd: '/org/a', lead: true } }, edges: [], callUp: [],
    },
    // The unresolved twin of `registry`: seat cwds exactly as authored. Edits
    // are built from this, never from the resolved view above.
    document: {
      baseDir: '/org', seats: { alfred: { cwd: '/org/a', lead: true } }, edges: [], callUp: [],
    },
    token: 'token-1',
  },
  mailboxBridge: { ok: true, addresses: ['alfred'] },
  toolMailbox: { ok: true, addresses: ['alfred'] },
  drift: { ok: true, rows: [] },
}

describe('OrgBoardController', () => {
  it('starts idle with no value and no error', () => {
    const controller = new OrgBoardController({ org: { get: vi.fn(), write: vi.fn() } })
    expect(controller.store.getSnapshot()).toEqual({ status: 'idle', error: null, value: null })
  })

  it('publishes the full value on a successful read', async () => {
    const get = vi.fn().mockResolvedValue(ok(VALUE))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(get).toHaveBeenCalledWith({})
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', error: null, value: VALUE })
  })

  it('publishes its own error state on an outer RPC failure, never a ready-but-empty shape', async () => {
    const get = vi.fn().mockResolvedValue(failed('connection lost'))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({ status: 'error', error: 'connection lost', value: null })
  })

  it('catches a thrown transport error the same way as a business error', async () => {
    const get = vi.fn().mockRejectedValue(new Error('socket closed'))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({ status: 'error', error: 'socket closed', value: null })
  })

  it('stringifies a non-Error throw', async () => {
    const get = vi.fn().mockRejectedValue('boom')
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(controller.store.getSnapshot().error).toBe('boom')
  })

  it('sets status to loading synchronously before the promise settles', () => {
    const get = vi.fn(() => new Promise<OrgGetResponse>(() => {}))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    void controller.load()
    expect(controller.store.getSnapshot().status).toBe('loading')
  })

  it('a stale in-flight response never overwrites a newer completed one', async () => {
    let resolveFirst: (value: OrgGetResponse) => void = () => {}
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise<OrgGetResponse>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(ok(VALUE))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })

    const first = controller.load()
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')

    resolveFirst(ok({ ...VALUE, profile: 'stale' }))
    await first
    expect(controller.store.getSnapshot().value?.profile).toBe('web-stable')
  })

  it('dispose stops an in-flight response from publishing', async () => {
    let resolve: (value: OrgGetResponse) => void = () => {}
    const get = vi.fn(() => new Promise<OrgGetResponse>((r) => { resolve = r }))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    const pending = controller.load()
    controller.dispose()
    resolve(ok(VALUE))
    await pending
    expect(controller.store.getSnapshot().status).toBe('loading')
  })

  it('dispose after an outer-failure in-flight response also suppresses the publish', async () => {
    let reject: (error: unknown) => void = () => {}
    const get = vi.fn(() => new Promise<OrgGetResponse>((_resolve, r) => { reject = r }))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    const pending = controller.load()
    controller.dispose()
    reject(new Error('too late'))
    await pending.catch(() => {})
    expect(controller.store.getSnapshot().status).toBe('loading')
  })
})

describe('refreshOrgBoardIfLoaded', () => {
  it('is a no-op before the modal has ever loaded (idle stays idle, no request issued)', () => {
    const get = vi.fn()
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    refreshOrgBoardIfLoaded(controller)
    expect(get).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().status).toBe('idle')
  })

  it('reconnect does not leave stale data on screen: a loaded board re-reads and replaces its value', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(ok(VALUE))
      .mockResolvedValueOnce(ok({ ...VALUE, profile: 'post-reconnect' }))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(controller.store.getSnapshot().value?.profile).toBe('web-stable')

    refreshOrgBoardIfLoaded(controller)
    // Pre-reconnect data stays on screen while the fresh read is in flight
    // (never a blank/loading flash for a viewer already looking at the
    // board) -- then the reconnect-triggered read lands and replaces it.
    expect(controller.store.getSnapshot().value?.profile).toBe('web-stable')
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().value?.profile).toBe('post-reconnect')
    })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('also refreshes a board that last landed on an error, not only a ready one', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(failed('connection lost'))
      .mockResolvedValueOnce(ok(VALUE))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')

    refreshOrgBoardIfLoaded(controller)
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().status).toBe('ready')
    })
    expect(get).toHaveBeenCalledTimes(2)
  })
})

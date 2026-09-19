/**
 * Controller coverage: a successful read publishes the full value, an outer
 * RPC failure publishes ITS OWN error state (not a "ready with everything
 * unavailable" shape), a thrown transport error is caught the same way, a
 * stale in-flight response never overwrites a newer one, dispose stops any
 * further publish, and a reconnect refreshes a loaded board (never leaving
 * pre-reconnect data on screen) while staying a no-op before first load.
 *
 * SWD-134 slice 4 step 3 adds the write path's own coverage below: success
 * always chains a fresh `load()`; the three server outcomes
 * (`org-registry-conflict`/`org-registry-rejected`/`org-registry-write-failed`)
 * stay distinct (conflict alone auto-reloads and none of the three retries);
 * a local `edit.ts` refusal never calls `org.write` at all; a stale in-flight
 * write can never overwrite newer state; and every write reads the CURRENT
 * token, never one captured across an intervening reload.
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  OrgRegistryDocument, ResponseValue, RpcError, RpcResponse,
} from '@deepseek-ai/dsh-api-remotes/client'
import { OrgBoardController, refreshOrgBoardIfLoaded } from '../src/client/org-board-store.ts'

/** The `org.get` response envelope, exactly as the controller's caller receives it. */
type OrgGetResponse = RpcResponse<ResponseValue<'org.get'>>

/** The `org.write` response envelope, exactly as the controller's caller receives it. */
type OrgWriteResponse = RpcResponse<ResponseValue<'org.write'>>

let rpc = 0

/** A successful `org.get` envelope. Built through the real response type so a wire-shape change breaks here. */
function ok(value: ResponseValue<'org.get'>): OrgGetResponse {
  return { rpcId: `org-get-${rpc++}` as never, result: { ok: true, value } }
}

/** A failed `org.get` envelope: the call reached the host and the host refused it. */
function failed(message: string): OrgGetResponse {
  return {
    rpcId: `org-get-${rpc++}` as never,
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  }
}

/** A successful `org.write` envelope. Built through the real response type so a wire-shape change breaks here. */
function okWrite(value: ResponseValue<'org.write'>): OrgWriteResponse {
  return { rpcId: `org-write-${rpc++}` as never, result: { ok: true, value } }
}

/** A refused `org.write` envelope carrying one of the three write-specific error codes. */
function failedWrite(
  code: 'org-registry-conflict' | 'org-registry-rejected' | 'org-registry-write-failed',
  message: string,
): OrgWriteResponse {
  const error: RpcError = code === 'org-registry-conflict'
    ? { code, message, details: { expectedToken: 'stale', actualToken: 'current' } }
    : { code, message, details: {} }
  return { rpcId: `org-write-${rpc++}` as never, result: { ok: false, error } }
}

/**
 * The `ok: true` member of `OrgRegistryResult` alone (not the full
 * read-or-reason union `ResponseValue<'org.get'>['registry']` is), so
 * `{ ...REGISTRY, token: '...' }` below stays a concrete `ok: true` object
 * rather than a union spread that TS would reject for carrying `token` on
 * its `ok: false` member too.
 */
type OrgRegistryOk = Extract<ResponseValue<'org.get'>['registry'], { ok: true }>

const REGISTRY: OrgRegistryOk = {
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
}

const VALUE: ResponseValue<'org.get'> = {
  profile: 'web-stable',
  registry: REGISTRY,
  mailboxBridge: { ok: true, addresses: ['alfred'] },
  toolMailbox: { ok: true, addresses: ['alfred'] },
  drift: { ok: true, rows: [] },
}

/** A second `org.get` value, distinguishable from {@link VALUE} by `profile` and its registry `token`. */
const VALUE_2: ResponseValue<'org.get'> = {
  ...VALUE,
  profile: 'post-reconnect',
  registry: { ...REGISTRY, token: 'token-2' },
}

/** A minimal, always-valid `org.write` success value; the controller only uses it to trigger a reload. */
const WRITE_OK: ResponseValue<'org.write'> = {
  registry: { baseDir: '/org', seats: { alfred: { cwd: '/org/a', lead: true } }, edges: [], callUp: [] },
  token: 'token-after-write',
}

describe('OrgBoardController', () => {
  it('starts idle with no value and no error', () => {
    const controller = new OrgBoardController({ org: { get: vi.fn(), write: vi.fn() } })
    expect(controller.store.getSnapshot()).toEqual({
      status: 'idle', error: null, value: null, write: { pending: false, notice: null },
    })
  })

  it('publishes the full value on a successful read', async () => {
    const get = vi.fn().mockResolvedValue(ok(VALUE))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(get).toHaveBeenCalledWith({})
    expect(controller.store.getSnapshot()).toEqual({
      status: 'ready', error: null, value: VALUE, write: { pending: false, notice: null },
    })
  })

  it('publishes its own error state on an outer RPC failure, never a ready-but-empty shape', async () => {
    const get = vi.fn().mockResolvedValue(failed('connection lost'))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({
      status: 'error', error: 'connection lost', value: null, write: { pending: false, notice: null },
    })
  })

  it('catches a thrown transport error the same way as a business error', async () => {
    const get = vi.fn().mockRejectedValue(new Error('socket closed'))
    const controller = new OrgBoardController({ org: { get, write: vi.fn() } })
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({
      status: 'error', error: 'socket closed', value: null, write: { pending: false, notice: null },
    })
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

describe('OrgBoardController write path', () => {
  it('refuses locally, without ever calling org.write, before any registry has been loaded', async () => {
    const write = vi.fn()
    const controller = new OrgBoardController({ org: { get: vi.fn(), write } })
    await controller.addSeat('lucius', '/org/lucius')
    expect(write).not.toHaveBeenCalled()
    const { write: writeState } = controller.store.getSnapshot()
    expect(writeState.pending).toBe(false)
    expect(writeState.notice?.kind).toBe('invalid')
    expect(typeof writeState.notice?.message).toBe('string')
  })

  it('a local edit.ts refusal (duplicate seat name) never reaches org.write', async () => {
    const get = vi.fn().mockResolvedValue(ok(VALUE))
    const write = vi.fn()
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    await controller.addSeat('alfred', '/org/other')
    expect(write).not.toHaveBeenCalled()
    const { write: writeState } = controller.store.getSnapshot()
    expect(writeState.pending).toBe(false)
    expect(writeState.notice?.kind).toBe('invalid')
    expect(writeState.notice?.message).toContain('alfred')
  })

  it('sets write.pending synchronously before an in-flight write settles', async () => {
    const get = vi.fn().mockResolvedValue(ok(VALUE))
    const write = vi.fn(() => new Promise<OrgWriteResponse>(() => {}))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    void controller.addSeat('lucius', '/org/lucius')
    // Synchronous flush: the write() body runs its first `store.update` before
    // the first `await` suspends it, exactly like load()'s 'loading' flip.
    await Promise.resolve()
    expect(controller.store.getSnapshot().write.pending).toBe(true)
  })

  it('sends the CURRENT token, never a stale capture held from an earlier load', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(ok(VALUE))
      .mockResolvedValueOnce(ok(VALUE_2))
    const write = vi.fn().mockResolvedValue(okWrite(WRITE_OK))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    await controller.load() // simulates a reconnect refresh landing before any write
    await controller.addSeat('lucius', '/org/lucius')
    expect(write).toHaveBeenCalledWith({
      document: { baseDir: '/org', seats: { alfred: { cwd: '/org/a', lead: true }, lucius: { cwd: '/org/lucius' } }, edges: [], callUp: [] },
      expectedToken: 'token-2',
    })
  })

  it('on success, NEVER hand-patches state: it always chains a fresh full load()', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(ok(VALUE))
      .mockResolvedValueOnce(ok(VALUE_2))
    const write = vi.fn().mockResolvedValue(okWrite(WRITE_OK))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    await controller.addSeat('lucius', '/org/lucius')
    expect(get).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().value).toEqual(VALUE_2)
    expect(controller.store.getSnapshot().write).toEqual({ pending: false, notice: null })
  })

  it('org-registry-conflict auto-reloads so the viewer sees the true state, and does NOT retry the write', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(ok(VALUE))
      .mockResolvedValueOnce(ok(VALUE_2))
    const write = vi.fn().mockResolvedValue(failedWrite('org-registry-conflict', 'registry changed since it was read'))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    await controller.addSeat('lucius', '/org/lucius')
    expect(write).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().value).toEqual(VALUE_2)
    expect(controller.store.getSnapshot().write).toEqual({
      pending: false, notice: { kind: 'conflict', message: 'registry changed since it was read' },
    })
  })

  it('org-registry-rejected does NOT reload (nothing changed on disk) and leaves value untouched, with its own distinct notice', async () => {
    const get = vi.fn().mockResolvedValueOnce(ok(VALUE))
    const write = vi.fn().mockResolvedValue(failedWrite('org-registry-rejected', 'seat "lucius" has no cwd'))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    await controller.addSeat('lucius', '/org/lucius')
    expect(get).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().value).toEqual(VALUE)
    expect(controller.store.getSnapshot().write).toEqual({
      pending: false, notice: { kind: 'rejected', message: 'seat "lucius" has no cwd' },
    })
  })

  it('org-registry-write-failed does NOT reload and leaves value untouched, with its own distinct notice (never collapsed with rejected)', async () => {
    const get = vi.fn().mockResolvedValueOnce(ok(VALUE))
    const write = vi.fn().mockResolvedValue(failedWrite('org-registry-write-failed', 'disk full'))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    await controller.addSeat('lucius', '/org/lucius')
    expect(get).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().value).toEqual(VALUE)
    expect(controller.store.getSnapshot().write).toEqual({
      pending: false, notice: { kind: 'write-failed', message: 'disk full' },
    })
  })

  it('a thrown transport error during write is treated as write-failed (retry-the-same-document), not reloaded', async () => {
    const get = vi.fn().mockResolvedValueOnce(ok(VALUE))
    const write = vi.fn().mockRejectedValue(new Error('socket closed'))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    await controller.addSeat('lucius', '/org/lucius')
    expect(get).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().value).toEqual(VALUE)
    expect(controller.store.getSnapshot().write).toEqual({
      pending: false, notice: { kind: 'write-failed', message: 'socket closed' },
    })
  })

  it('a rejected write leaves the exact same payload resubmittable: the identical verb call rebuilds it unchanged', async () => {
    const get = vi.fn().mockResolvedValue(ok(VALUE))
    const write = vi.fn().mockResolvedValue(failedWrite('org-registry-rejected', 'invalid'))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()
    await controller.addSeat('lucius', '/org/lucius')
    const firstCallArgs = write.mock.calls[0]?.[0] as unknown
    write.mockClear()
    await controller.addSeat('lucius', '/org/lucius')
    expect(write).toHaveBeenCalledWith(firstCallArgs)
  })

  it('a stale in-flight write can never overwrite newer state (a reconnect refresh landing mid-write wins)', async () => {
    let resolveWrite: (value: OrgWriteResponse) => void = () => {}
    const get = vi.fn()
      .mockResolvedValueOnce(ok(VALUE))
      .mockResolvedValueOnce(ok(VALUE_2))
    const write = vi.fn(() => new Promise<OrgWriteResponse>((resolve) => { resolveWrite = resolve }))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()

    const writing = controller.addSeat('lucius', '/org/lucius')
    await Promise.resolve()
    expect(controller.store.getSnapshot().write.pending).toBe(true)

    // A background reconnect refresh lands while the write is still in flight.
    await controller.load()
    expect(controller.store.getSnapshot().value).toEqual(VALUE_2)
    // The fresh load reset the now-orphaned pending flag; nothing will ever
    // flip it back for a write whose generation has already moved past.
    expect(controller.store.getSnapshot().write.pending).toBe(false)

    // The write's late response arrives after the fact -- even a SUCCESS
    // response must be discarded: it answers a question (against the OLD
    // token/document) the UI has already moved past.
    resolveWrite(okWrite(WRITE_OK))
    await writing

    expect(get).toHaveBeenCalledTimes(2) // no extra reload triggered by the stale write's own success handling
    expect(controller.store.getSnapshot().value).toEqual(VALUE_2)
    expect(controller.store.getSnapshot().write).toEqual({ pending: false, notice: null })
  })

  it('removeSeat, addEdge, removeEdge, and setSeatTools all round-trip through the same write path', async () => {
    const baseDocument: OrgRegistryDocument = {
      baseDir: '/org',
      seats: { alfred: { cwd: '/org/a', lead: true }, batman: { cwd: '/org/b' }, robin: { cwd: '/org/r' } },
      edges: [['alfred', 'batman']],
      callUp: ['alfred'],
    }
    const richValue: ResponseValue<'org.get'> = {
      ...VALUE,
      registry: {
        ok: true, token: 'token-rich', registry: baseDocument, document: baseDocument,
      },
    }
    // Every write below resolves ok, so the controller reloads and this same
    // fixture value lands again each time -- each verb call below therefore
    // starts from the SAME pristine baseDocument, not a cumulative edit
    // chain, exactly like the real controller against a real (mocked) host.
    const get = vi.fn().mockResolvedValue(ok(richValue))
    const write = vi.fn().mockResolvedValue(okWrite(WRITE_OK))
    const controller = new OrgBoardController({ org: { get, write } })
    await controller.load()

    await controller.addEdge('batman', 'robin')
    expect(write).toHaveBeenNthCalledWith(1, {
      document: { ...baseDocument, edges: [['alfred', 'batman'], ['batman', 'robin']] },
      expectedToken: 'token-rich',
    })

    await controller.removeEdge('alfred', 'batman')
    expect(write).toHaveBeenNthCalledWith(2, {
      document: { ...baseDocument, edges: [] },
      expectedToken: 'token-rich',
    })

    await controller.setSeatTools('robin', ['read'], undefined)
    expect(write).toHaveBeenNthCalledWith(3, {
      document: { ...baseDocument, seats: { ...baseDocument.seats, robin: { cwd: '/org/r', tools: { allow: ['read'] } } } },
      expectedToken: 'token-rich',
    })

    await controller.removeSeat('batman')
    expect(write).toHaveBeenNthCalledWith(4, {
      document: {
        baseDir: '/org',
        seats: { alfred: { cwd: '/org/a', lead: true }, robin: { cwd: '/org/r' } },
        edges: [],
        callUp: ['alfred'],
      },
      expectedToken: 'token-rich',
    })
  })
})

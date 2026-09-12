import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { WorktreeError } from '@deepseek-ai/dsh-worktree'
import type {
  WorktreeRow as ServiceWorktreeRow,
  WorktreeService,
  WorktreeSlug,
  WorktreeSpawnRequest,
  WorktreeSpawnResult,
} from '@deepseek-ai/dsh-worktree'
import type { WorktreeRef } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { sessionCreateRequestSchema } from '../src/api/sessions.schema.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`worktree-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() { return false },
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** The WorktreeService members the consumer adapts; the double implements exactly this shape. */
type MockWorktreeService = Pick<WorktreeService, 'spawn' | 'list' | 'lock' | 'unlock' | 'remove'>

/** Refusals the double raises before its normal logic; the value is thrown as-is. */
interface MockServiceRefusals {
  spawn?: unknown
  list?: unknown
  lock?: unknown
  remove?: unknown
}

/**
 * Deterministic in-memory double over the real `WorktreeService` interface
 * shape, mirroring its observable row lifecycle: rows are born locked with the
 * `<seat> <session>` creation reason, `lock`/`remove` refuse while a lock is
 * held, unknown slugs refuse `NO_ROW`, and every refusal is a typed
 * WorktreeError whose message is the reason. Minted paths live under `base` so
 * a spawn-fed session create can really ensure the directory. The seat-side
 * `unlock` lets tests move a born-locked row through the lifecycle step the
 * wire surface does not expose.
 */
function mockService(refusals: MockServiceRefusals = {}, base = '/wt') {
  let nextSlug = 1
  const rows = new Map<string, ServiceWorktreeRow>()
  const calls = {
    spawn: [] as WorktreeSpawnRequest[],
    lock: [] as { slug: WorktreeSlug; reason: string }[],
    remove: [] as { slug: WorktreeSlug; reason: string }[],
  }
  const service: MockWorktreeService = {
    async spawn(request: WorktreeSpawnRequest): Promise<WorktreeSpawnResult> {
      calls.spawn.push(request)
      if (refusals.spawn !== undefined) throw refusals.spawn
      const slug = `wt-${nextSlug++}` as WorktreeSlug
      const branch = `${request.seat}/${slug}`
      const session = `${request.seat}.${slug}`
      const path = join(base, request.seat, slug)
      const lockReason = `${request.seat} ${session}`
      rows.set(slug, {
        slug,
        seat: request.seat,
        branch,
        session,
        path,
        branchRef: 'master',
        createdAt: 0,
        lockReason,
        lastReason: request.intent,
      })
      return { slug, seat: request.seat, branch, session, path, branchRef: 'master', lockReason, copied: [] }
    },
    list() {
      if (refusals.list !== undefined) throw refusals.list
      return [...rows.values()]
    },
    async lock(slug: WorktreeSlug, reason: string) {
      calls.lock.push({ slug, reason })
      if (refusals.lock !== undefined) throw refusals.lock
      const row = rows.get(slug)
      if (row === undefined) throw new WorktreeError(`no live worktree carries slug ${JSON.stringify(slug)}`, 'NO_ROW')
      if (row.lockReason !== undefined) {
        throw new WorktreeError(
          `worktree ${slug} is already locked (reason: ${JSON.stringify(row.lockReason)}); ` +
          'unlock with a reason before locking again',
          'ALREADY_LOCKED',
        )
      }
      const locked = { ...row, lockReason: reason, lastReason: reason }
      rows.set(slug, locked)
      return locked
    },
    async unlock(slug: WorktreeSlug, reason: string) {
      const row = rows.get(slug)
      if (row === undefined) throw new WorktreeError(`no live worktree carries slug ${JSON.stringify(slug)}`, 'NO_ROW')
      if (row.lockReason === undefined) {
        throw new WorktreeError(`worktree ${slug} is not locked; nothing to unlock`, 'NOT_LOCKED')
      }
      const { lockReason: _stripped, ...unlocked } = row
      const committed = { ...unlocked, lastReason: reason }
      rows.set(slug, committed)
      return committed
    },
    async remove(slug: WorktreeSlug, reason: string) {
      calls.remove.push({ slug, reason })
      if (refusals.remove !== undefined) throw refusals.remove
      const row = rows.get(slug)
      if (row === undefined) throw new WorktreeError(`no live worktree carries slug ${JSON.stringify(slug)}`, 'NO_ROW')
      if (row.lockReason !== undefined) {
        throw new WorktreeError(
          `worktree ${slug} is locked (reason: ${JSON.stringify(row.lockReason)}); ` +
          'unlock with a reason before removing',
          'LOCKED',
        )
      }
      rows.delete(slug)
    },
  }
  return { service, calls, rows }
}

/** Compose the API over real Session, Agent, Storage, Domain, and Workspace services. */
async function harness(service?: MockWorktreeService, persistence: unknown = { list: () => Promise.resolve([]) }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-worktree-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', persistence as never)
  await ctx.plugin(WorkspaceRegistry)
  if (service !== undefined) ctx.provide('worktrees', service as never)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
  })
  return { api, ctx, root }
}

describe('worktree.list', () => {
  it('serves every live row with lock state and reason', async () => {
    const { service } = mockService()
    const { api } = await harness(service)
    const handle = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))).worktree

    // Born locked: the service's creation lock carries `<seat> <session>`.
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      {
        seat: 'eve',
        path: join('/wt', 'eve', handle.slug),
        branch: `eve/${handle.slug}`,
        sessionName: `eve.${handle.slug}`,
        locked: true,
        lockReason: `eve eve.${handle.slug}`,
      },
    ])

    await service.unlock(handle.slug as WorktreeSlug, 'work starts')
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      {
        seat: 'eve',
        path: join('/wt', 'eve', handle.slug),
        branch: `eve/${handle.slug}`,
        sessionName: `eve.${handle.slug}`,
        locked: false,
      },
    ])

    expectOk(await api.worktree.lock(request({ ref: handle.slug as WorktreeRef, reason: 'rebase in flight' })))
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      {
        seat: 'eve',
        path: join('/wt', 'eve', handle.slug),
        branch: `eve/${handle.slug}`,
        sessionName: `eve.${handle.slug}`,
        locked: true,
        lockReason: 'rebase in flight',
      },
    ])
  })

  it('refuses with worktree-unavailable instead of an empty list when the seam is absent', async () => {
    const { api } = await harness()
    const response = await api.worktree.list(request({}))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'worktree-unavailable' } })
  })

  it('surfaces a service read failure with its reason', async () => {
    const { service } = mockService({ list: new Error('registry store unreadable') })
    const { api } = await harness(service)
    const response = await api.worktree.list(request({}))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'registry store unreadable',
        details: { op: 'worktree.list', seamCode: 'worktree-forbidden' },
      },
    })
  })
})

describe('worktree.create', () => {
  it('forwards the seat and the session-as-intent and answers the minted handle', async () => {
    const { service, calls } = mockService()
    const { api } = await harness(service)

    const value = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' })))
    expect(value.worktree).toEqual({
      slug: 'wt-1',
      branch: 'eve/wt-1',
      path: join('/wt', 'eve', 'wt-1'),
      sessionName: 'eve.wt-1',
      seat: 'eve',
    })
    expect(calls.spawn).toEqual([{ seat: 'eve', intent: 'task' }])
  })

  it('refuses with worktree-unavailable when the seam is absent', async () => {
    const { api } = await harness()
    const response = await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'worktree-unavailable' } })
  })

  it('surfaces the service\u2019s typed refusal with its code', async () => {
    const { service } = mockService({
      spawn: new WorktreeError('invalid seat "eve(guest)": must match the session-name grammar', 'SEAT_INVALID'),
    })
    const { api } = await harness(service)
    const response = await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'invalid seat "eve(guest)": must match the session-name grammar',
        details: { op: 'worktree.create', seat: 'eve', seamCode: 'worktree-forbidden' },
      },
    })
  })

  it('surfaces a non-Error refusal as its string', async () => {
    const { service } = mockService({ spawn: 'worktree registry offline' })
    const { api } = await harness(service)
    const response = await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'worktree-refused', message: 'worktree registry offline', details: { seamCode: 'worktree-forbidden' } },
    })
  })
})

describe('worktree.lock / worktree.remove', () => {
  it('surfaces an already-locked refusal with the service\u2019s reason', async () => {
    const { service } = mockService()
    const { api } = await harness(service)
    const handle = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))).worktree

    // Born locked: the wire lock meets the service's creation lock.
    const second = await api.worktree.lock(request({ ref: handle.slug as WorktreeRef, reason: 'second holder' }))
    expect(second.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: `worktree ${handle.slug} is already locked (reason: "eve eve.${handle.slug}"); unlock with a reason before locking again`,
        details: { op: 'worktree.lock', ref: handle.slug, seamCode: 'worktree-locked' },
      },
    })
  })

  it('surfaces an unknown-reference refusal', async () => {
    const { service } = mockService()
    const { api } = await harness(service)
    const response = await api.worktree.lock(request({ ref: 'wt-ghost' as WorktreeRef, reason: 'why' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'no live worktree carries slug "wt-ghost"',
        details: { op: 'worktree.lock', ref: 'wt-ghost', seamCode: 'worktree-unknown' },
      },
    })
  })

  it('refuses removing a locked worktree and keeps it listed with its reason', async () => {
    const { service } = mockService()
    const { api } = await harness(service)
    const handle = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))).worktree

    const response = await api.worktree.remove(request({ ref: handle.slug as WorktreeRef, reason: 'cleanup' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: `worktree ${handle.slug} is locked (reason: "eve eve.${handle.slug}"); unlock with a reason before removing`,
        details: { op: 'worktree.remove', ref: handle.slug, seamCode: 'worktree-locked' },
      },
    })
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      expect.objectContaining({ seat: 'eve', sessionName: `eve.${handle.slug}`, locked: true }),
    ])
  })

  it('removes an unlocked worktree through the service', async () => {
    const { service, calls } = mockService()
    const { api } = await harness(service)
    const handle = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))).worktree
    await service.unlock(handle.slug as WorktreeSlug, 'work starts')

    expect(expectOk(await api.worktree.remove(request({ ref: handle.slug as WorktreeRef, reason: 'obsolete' }))))
      .toEqual({ removed: true })
    expect(calls.remove).toEqual([{ slug: 'wt-1', reason: 'obsolete' }])
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([])
  })

  it('refuses with worktree-unavailable when the seam is absent', async () => {
    const { api } = await harness()
    expect((await api.worktree.lock(request({ ref: 'wt-x' as WorktreeRef, reason: 'why' }))).result)
      .toMatchObject({ ok: false, error: { code: 'worktree-unavailable' } })
    expect((await api.worktree.remove(request({ ref: 'wt-x' as WorktreeRef, reason: 'why' }))).result)
      .toMatchObject({ ok: false, error: { code: 'worktree-unavailable' } })
  })
})

describe('session.create worktree intent', () => {
  it('spawns the session inside the seam-minted worktree', async () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-worktree-spawn-')))
    const { service, calls } = mockService({}, base)
    const { api, ctx } = await harness(service)

    const value = expectOk(await api.sessions.create(request({ worktree: { seat: 'eve', sessionName: 'task' } })))
    expect(calls.spawn).toEqual([{ seat: 'eve', intent: 'task' }])
    expect(expectOk(await api.sessions.list(request({}))).items).toContainEqual(
      expect.objectContaining({ sessionId: value.sessionId, cwd: join(base, 'eve', 'wt-1') }),
    )
    expect(ctx.agents.get(value.sessionId)).toBeDefined()
  })

  it('refuses the spawn with worktree-unavailable and creates no session when the seam is absent', async () => {
    const { api, ctx, root } = await harness()
    const response = await api.sessions.create(request({ worktree: { seat: 'eve', sessionName: 'task' } }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'worktree-unavailable' } })
    expect(ctx.agents.list()).toHaveLength(0)
    expect(expectOk(await api.sessions.list(request({}))).items).toEqual([])
    // No silent fallback: nothing was spawned into the Host cwd either.
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.cwd)).not.toContain(root)
  })

  it('refuses the spawn with the service\u2019s reason and creates no session', async () => {
    const { service, calls } = mockService({
      spawn: new WorktreeError('work session requires DEEPSEEK_API_KEY in the environment', 'ENV_MISSING'),
    })
    const { api, ctx } = await harness(service)
    const response = await api.sessions.create(request({ worktree: { seat: 'eve', sessionName: 'task' } }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'work session requires DEEPSEEK_API_KEY in the environment',
        details: { op: 'session.create', seat: 'eve', seamCode: 'worktree-forbidden' },
      },
    })
    expect(calls.spawn).toEqual([{ seat: 'eve', intent: 'task' }])
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('keeps a minted worktree visible when the session create fails afterwards', async () => {
    const { service } = mockService()
    const coldId = SessionId('session-cold-conflict')
    const coldCwd = '/cold/elsewhere'
    const coldHeader = { version: 0, id: coldId, createdAt: 0, cwd: coldCwd }
    const persistence = {
      list: () => Promise.resolve([coldHeader]),
      inspect: () => Promise.resolve({ meta: coldHeader, events: [] }),
    }
    const { api } = await harness(service, persistence)

    const response = await api.sessions.create(request({
      sessionId: coldId,
      worktree: { seat: 'eve', sessionName: 'task' },
    }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-conflict' } })
    // The worktree minted before the failure stays live and listed — never
    // silently reclaimed or fenced out of the registry.
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      expect.objectContaining({ seat: 'eve', sessionName: 'eve.wt-1', locked: true }),
    ])
  })
})

describe('session.create worktree schema', () => {
  it('accepts a lone worktree intent and refuses every project combination', () => {
    expect(sessionCreateRequestSchema.safeParse({ worktree: { seat: 'eve', sessionName: 'task' } }).success).toBe(true)
    expect(sessionCreateRequestSchema.safeParse({}).success).toBe(true)

    expect(sessionCreateRequestSchema.safeParse({
      workspaceId: 'w',
      worktree: { seat: 'eve', sessionName: 'task' },
    }).success).toBe(false)
    expect(sessionCreateRequestSchema.safeParse({
      cwd: '/x',
      worktree: { seat: 'eve', sessionName: 'task' },
    }).success).toBe(false)
    expect(sessionCreateRequestSchema.safeParse({ workspaceId: 'w', cwd: '/x' }).success).toBe(false)
    expect(sessionCreateRequestSchema.safeParse({ worktree: { seat: '', sessionName: 'task' } }).success).toBe(false)
    expect(sessionCreateRequestSchema.safeParse({ worktree: { seat: 'eve' } }).success).toBe(false)
  })
})

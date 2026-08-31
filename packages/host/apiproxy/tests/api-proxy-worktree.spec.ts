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
import type { WorktreeRef, WorktreeRow } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy, WorktreeSeamError } from '@deepseek-ai/dsh-host-apiproxy'
import type { WorktreeSeam, WorktreeSpawnInput } from '@deepseek-ai/dsh-host-apiproxy'
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
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Refusals the double raises before its normal logic; the value is thrown as-is. */
interface MockSeamRefusals {
  spawn?: unknown
  list?: unknown
  lock?: unknown
  remove?: unknown
}

/**
 * Deterministic in-memory WorktreeSeam double. Refs are the minted slugs, per
 * the consumer's declared convention; every refusal is a typed
 * WorktreeSeamError whose message is the reason the caller must see. Minted
 * paths live under `base` so a spawn-fed session create can really ensure the
 * directory.
 */
function mockSeam(refusals: MockSeamRefusals = {}, base = '/wt') {
  const rows = new Map<string, WorktreeRow>()
  const calls = {
    spawn: [] as WorktreeSpawnInput[],
    lock: [] as { ref: WorktreeRef; reason: string }[],
    remove: [] as { ref: WorktreeRef; reason: string }[],
  }
  const seam: WorktreeSeam = {
    async spawn(input) {
      calls.spawn.push(input)
      if (refusals.spawn !== undefined) throw refusals.spawn
      const slug = `wt-${input.seat}-${input.sessionName}`
      if (!rows.has(slug)) {
        rows.set(slug, {
          seat: input.seat,
          path: join(base, input.seat, input.sessionName),
          branch: `worktree/${input.seat}/${input.sessionName}`,
          sessionName: input.sessionName,
          locked: false,
        })
      }
      const row = rows.get(slug)
      if (row === undefined) throw new Error('mock seam lost the minted row')
      return { slug, branch: row.branch, path: row.path, sessionName: row.sessionName, seat: row.seat }
    },
    async list() {
      if (refusals.list !== undefined) throw refusals.list
      return [...rows.values()]
    },
    async lock(ref, reason) {
      calls.lock.push({ ref, reason })
      if (refusals.lock !== undefined) throw refusals.lock
      const row = rows.get(ref)
      if (row === undefined) throw new WorktreeSeamError('worktree-unknown', `worktree "${ref}" is not live`)
      if (row.locked) {
        throw new WorktreeSeamError('worktree-locked', `worktree "${ref}" is already locked: ${row.lockReason ?? 'unspecified'}`)
      }
      rows.set(ref, { ...row, locked: true, lockReason: reason })
    },
    async remove(ref, reason) {
      calls.remove.push({ ref, reason })
      if (refusals.remove !== undefined) throw refusals.remove
      const row = rows.get(ref)
      if (row === undefined) throw new WorktreeSeamError('worktree-unknown', `worktree "${ref}" is not live`)
      if (row.locked) {
        throw new WorktreeSeamError('worktree-locked', `worktree "${ref}" is locked: ${row.lockReason ?? 'unspecified'}; the removal naming "${reason}" was refused`)
      }
      rows.delete(ref)
    },
  }
  return { seam, calls, rows }
}

/** Compose the API over real Session, Agent, Storage, Domain, and Workspace services. */
async function harness(seam?: WorktreeSeam, persistence: unknown = { list: () => Promise.resolve([]) }) {
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
  if (seam !== undefined) ctx.provide('worktree', seam)

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
    const { seam } = mockSeam()
    const { api } = await harness(seam)
    const handle = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))).worktree

    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      { seat: 'eve', path: '/wt/eve/task', branch: 'worktree/eve/task', sessionName: 'task', locked: false },
    ])

    expectOk(await api.worktree.lock(request({ ref: handle.slug as WorktreeRef, reason: 'rebase in flight' })))
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      {
        seat: 'eve',
        path: '/wt/eve/task',
        branch: 'worktree/eve/task',
        sessionName: 'task',
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

  it('surfaces a seam read failure with its reason', async () => {
    const { seam } = mockSeam({ list: new Error('registry store unreadable') })
    const { api } = await harness(seam)
    const response = await api.worktree.list(request({}))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'worktree-refused', message: 'registry store unreadable', details: { op: 'worktree.list' } },
    })
  })
})

describe('worktree.create', () => {
  it('forwards the spawn input verbatim and returns the minted handle', async () => {
    const { seam, calls } = mockSeam()
    const { api } = await harness(seam)

    const value = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' })))
    expect(value.worktree).toEqual({
      slug: 'wt-eve-task',
      branch: 'worktree/eve/task',
      path: '/wt/eve/task',
      sessionName: 'task',
      seat: 'eve',
    })
    expect(calls.spawn).toEqual([{ seat: 'eve', sessionName: 'task' }])
  })

  it('refuses with worktree-unavailable when the seam is absent', async () => {
    const { api } = await harness()
    const response = await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'worktree-unavailable' } })
  })

  it('surfaces the seam\u2019s typed refusal with its code', async () => {
    const { seam } = mockSeam({ spawn: new WorktreeSeamError('worktree-forbidden', 'seat "eve" is frozen') })
    const { api } = await harness(seam)
    const response = await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'seat "eve" is frozen',
        details: { op: 'worktree.create', seat: 'eve', seamCode: 'worktree-forbidden' },
      },
    })
  })

  it('surfaces a non-Error refusal as its string', async () => {
    const { seam } = mockSeam({ spawn: 'seat registry offline' })
    const { api } = await harness(seam)
    const response = await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'worktree-refused', message: 'seat registry offline' },
    })
  })
})

describe('worktree.lock / worktree.remove', () => {
  it('surfaces an already-locked refusal with the seam\u2019s reason', async () => {
    const { seam } = mockSeam()
    const { api } = await harness(seam)
    const handle = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))).worktree
    expectOk(await api.worktree.lock(request({ ref: handle.slug as WorktreeRef, reason: 'rebase in flight' })))

    const second = await api.worktree.lock(request({ ref: handle.slug as WorktreeRef, reason: 'second holder' }))
    expect(second.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'worktree "wt-eve-task" is already locked: rebase in flight',
        details: { op: 'worktree.lock', ref: handle.slug, seamCode: 'worktree-locked' },
      },
    })
  })

  it('surfaces an unknown-reference refusal', async () => {
    const { seam } = mockSeam()
    const { api } = await harness(seam)
    const response = await api.worktree.lock(request({ ref: 'wt-ghost' as WorktreeRef, reason: 'why' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'worktree "wt-ghost" is not live',
        details: { op: 'worktree.lock', ref: 'wt-ghost', seamCode: 'worktree-unknown' },
      },
    })
  })

  it('refuses removing a locked worktree and keeps it listed with its reason', async () => {
    const { seam } = mockSeam()
    const { api } = await harness(seam)
    const handle = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))).worktree
    expectOk(await api.worktree.lock(request({ ref: handle.slug as WorktreeRef, reason: 'session still running' })))

    const response = await api.worktree.remove(request({ ref: handle.slug as WorktreeRef, reason: 'cleanup' }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'worktree "wt-eve-task" is locked: session still running; the removal naming "cleanup" was refused',
        details: { op: 'worktree.remove', ref: handle.slug, seamCode: 'worktree-locked' },
      },
    })
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      expect.objectContaining({ seat: 'eve', sessionName: 'task', locked: true, lockReason: 'session still running' }),
    ])
  })

  it('removes an unlocked worktree through the seam', async () => {
    const { seam, calls } = mockSeam()
    const { api } = await harness(seam)
    const handle = expectOk(await api.worktree.create(request({ seat: 'eve', sessionName: 'task' }))).worktree

    expect(expectOk(await api.worktree.remove(request({ ref: handle.slug as WorktreeRef, reason: 'obsolete' }))))
      .toEqual({ removed: true })
    expect(calls.remove).toEqual([{ ref: handle.slug, reason: 'obsolete' }])
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
    const { seam, calls } = mockSeam({}, base)
    const { api, ctx } = await harness(seam)

    const value = expectOk(await api.sessions.create(request({ worktree: { seat: 'eve', sessionName: 'task' } })))
    expect(calls.spawn).toEqual([{ seat: 'eve', sessionName: 'task' }])
    expect(expectOk(await api.sessions.list(request({}))).items).toContainEqual(
      expect.objectContaining({ sessionId: value.sessionId, cwd: join(base, 'eve', 'task') }),
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

  it('refuses the spawn with the seam\u2019s reason and creates no session', async () => {
    const { seam, calls } = mockSeam({ spawn: new WorktreeSeamError('worktree-forbidden', 'seat "eve" is frozen') })
    const { api, ctx } = await harness(seam)
    const response = await api.sessions.create(request({ worktree: { seat: 'eve', sessionName: 'task' } }))
    expect(response.result).toMatchObject({
      ok: false,
      error: {
        code: 'worktree-refused',
        message: 'seat "eve" is frozen',
        details: { op: 'session.create', seat: 'eve', seamCode: 'worktree-forbidden' },
      },
    })
    expect(calls.spawn).toEqual([{ seat: 'eve', sessionName: 'task' }])
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('keeps a minted worktree visible when the session create fails afterwards', async () => {
    const { seam } = mockSeam()
    const coldId = SessionId('session-cold-conflict')
    const coldCwd = '/cold/elsewhere'
    const coldHeader = { version: 0, id: coldId, createdAt: 0, cwd: coldCwd }
    const persistence = {
      list: () => Promise.resolve([coldHeader]),
      inspect: () => Promise.resolve({ meta: coldHeader, events: [] }),
    }
    const { api } = await harness(seam, persistence)

    const response = await api.sessions.create(request({
      sessionId: coldId,
      worktree: { seat: 'eve', sessionName: 'task' },
    }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-conflict' } })
    // The worktree minted before the failure stays live and listed — never
    // silently reclaimed or fenced out of the registry.
    expect(expectOk(await api.worktree.list(request({}))).items).toEqual([
      expect.objectContaining({ seat: 'eve', sessionName: 'task', locked: false }),
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

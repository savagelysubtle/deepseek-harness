/**
 * Headless session workspace attachment: a `dsh --profile headless
 * --session-name <name>` run is an independent process that never calls
 * `session.create`, so nothing ever gave it the eager `ensureWorkspace` +
 * `Workspace#attachSession` pair a UI-created session gets — the session
 * stayed ungrouped until the next time the WorkspaceRegistry service opened
 * (a host restart). This proves the fix: this host must attach such a
 * session to its workspace the moment it discovers it, with no restart and
 * no WorkspaceRegistry re-open, by reading real workspace/group state
 * afterward rather than trusting a log line or a return value.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { deriveNamedSessionId, internals, lockPathForToken } from '@deepseek-ai/dsh-named-sessions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let dirs: string[] = []
const originalInternals = { ...internals }

afterEach(() => {
  Object.assign(internals, originalInternals)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  delete process.env.DSH_HOME
})

/** A pid that is definitely not this process; paired with a stubbed liveness probe. */
const FOREIGN_PID = process.pid + 1

/** Hold a seat's lock as a live, foreign headless process would. */
function holdForeignLock(name: string): { release(): void } {
  const path = lockPathForToken(deriveNamedSessionId(name).slice('named-'.length))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid: FOREIGN_PID, createdAt: Date.now() }), 'utf8')
  internals.isPidAlive = pid => pid === FOREIGN_PID
  return {
    release() {
      rmSync(path, { force: true })
      Object.assign(internals, originalInternals)
    },
  }
}

function tempDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-apiproxy-headless-workspace-'))
  dirs.push(dir)
  process.env.DSH_HOME = dir
  return dir
}

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`headless-ws-${String(nextRpc++)}`), payload }
}

describe('headless session workspace attachment (no restart, no registry re-open)', () => {
  it('attaches a live headless-owned session to its workspace the moment a history() read discovers it', async () => {
    tempDshHome()
    const seatRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-headless-seat-')))
    dirs.push(seatRoot)

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', storageDomain)
    ctx.provide('storageDomain', storageDomain)

    // The registry boots BEFORE the headless run exists: sessionPersistence
    // lists nothing yet, mirroring a host that has already started when a
    // seat run begins later — the exact ordering the restart-only fix missed.
    const sessionId = deriveNamedSessionId('headless-attach-seat')
    let persistedHeaders: SessionHeader[] = []
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve(persistedHeaders),
      inspect: () => Promise.resolve({
        meta: persistedHeaders.find(candidate => candidate.id === sessionId) as SessionHeader,
        events,
      }),
      locate: () => undefined,
    } as never)
    await ctx.plugin(WorkspaceRegistry)

    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    // Baseline: the registry opened onto an empty world, so nothing is grouped yet.
    expect(ctx.workspaceRegistry.list()).toEqual([])

    // The headless process now runs: its header lands in persistence and it
    // holds the seat's lock, exactly as `dsh --profile headless
    // --session-name headless-attach-seat` would from another process.
    const header: SessionHeader = { version: 0, id: sessionId, createdAt: 1000, cwd: seatRoot }
    persistedHeaders = [header]
    const lock = holdForeignLock('headless-attach-seat')
    try {
      const history = await api.sessions.history(request({ sessionId }))
      expect(history.result.ok).toBe(true)
      if (history.result.ok) {
        expect(history.result.value.events.map(entry => entry.event.type)).toEqual(['turn/start', 'turn/end'])
      }
    } finally {
      lock.release()
    }

    // No restart, no WorkspaceRegistry re-open — the single history() read
    // above is the only thing that happened since boot. Assert against real
    // workspace/group state, not a log line or a return value.
    const workspaces = ctx.workspaceRegistry.list()
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]?.path).toBe(seatRoot)
    expect(workspaces[0]?.sessionIds).toEqual([sessionId])
  })

  it('attaches a live headless-owned session via the periodic follow-tail sweep, with no client read at all', async () => {
    tempDshHome()
    const seatRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-headless-seat-sweep-')))
    dirs.push(seatRoot)

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', storageDomain)
    ctx.provide('storageDomain', storageDomain)

    const sessionId = deriveNamedSessionId('headless-sweep-seat')
    let persistedHeaders: SessionHeader[] = []
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve(persistedHeaders),
      inspect: () => Promise.resolve({
        meta: persistedHeaders.find(candidate => candidate.id === sessionId) as SessionHeader,
        events,
      }),
      locate: () => undefined,
    } as never)
    await ctx.plugin(WorkspaceRegistry)
    createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    expect(ctx.workspaceRegistry.list()).toEqual([])

    const header: SessionHeader = { version: 0, id: sessionId, createdAt: 1000, cwd: seatRoot }
    persistedHeaders = [header]
    const lock = holdForeignLock('headless-sweep-seat')
    try {
      // The sweep polls the lock directory every FOLLOW_SWEEP_INTERVAL_MS
      // (1000ms), and workspace registration and session attach are two
      // separate steps (the workspace entity is added to the registry
      // synchronously, but its sessionIds are only populated once
      // attachSession()'s async mutate() resolves) — so poll for the
      // session to actually be attached, not merely for the workspace to
      // exist, since this only proves the discovery is autonomous, not its
      // exact latency.
      const deadline = Date.now() + 5000
      while (
        !ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(sessionId)) &&
        Date.now() < deadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } finally {
      lock.release()
    }

    const workspaces = ctx.workspaceRegistry.list()
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]?.path).toBe(seatRoot)
    expect(workspaces[0]?.sessionIds).toEqual([sessionId])
  }, 10000)
})

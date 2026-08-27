/**
 * `follow-tail.ts` in isolation: the ownership probe reads the SAME lock
 * file `dsh --profile headless --session-name <name>` takes (no fixture
 * duplicates that format), and the tailer reads real Zstandard-framed JSONL
 * bytes written by the real backend, so a decode bug here would be a decode
 * bug against a genuine artifact, not a hand-rolled fixture.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  acquireNamedSessionLock, deriveNamedSessionId, internals, lockPathForToken,
} from '@deepseek-ai/dsh-named-sessions'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { meta, oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'
import { FollowTailer, liveHeadlessOwner } from '../src/follow-tail.ts'

let dirs: string[] = []
const originalInternals = { ...internals }

afterEach(() => {
  Object.assign(internals, originalInternals)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  delete process.env.DSH_HOME
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A pid that is definitely not this process; paired with a stubbed liveness probe. */
const FOREIGN_PID = process.pid + 1

/**
 * Write a lock naming ANOTHER process, in the exact format
 * `acquireNamedSessionLock` writes. A test cannot take a genuinely foreign
 * lock through the real API — that records `process.pid` — so foreign-holding
 * scenarios write the file directly and pair it with a stubbed liveness probe.
 */
function writeForeignLock(name: string, pid = FOREIGN_PID): void {
  const path = lockPathForToken(deriveNamedSessionId(name).slice('named-'.length))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid, createdAt: Date.now() }), 'utf8')
}

describe('liveHeadlessOwner', () => {
  it('reads no owner for a non-named session id without touching the filesystem', async () => {
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    await expect(liveHeadlessOwner('session-plain' as SessionId)).resolves.toBeUndefined()
  })

  it('reads no owner when no lock file exists', async () => {
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    await expect(liveHeadlessOwner(deriveNamedSessionId('nobody-holds-this'))).resolves.toBeUndefined()
  })

  it('reads a live owner from the exact lock file dsh-named-sessions writes', async () => {
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    writeForeignLock('owned-seat')
    internals.isPidAlive = pid => pid === FOREIGN_PID
    await expect(liveHeadlessOwner(deriveNamedSessionId('owned-seat')))
      .resolves.toEqual({ pid: FOREIGN_PID })
  })

  it('reads the host\'s own lock as a live owner — any holder is foreign', async () => {
    // The one-writer rule gives this host no legitimate way to hold a named
    // session's lock: a lock naming this pid is a holder to fence against,
    // not a self-exemption (docs/architecture.md § "Session log").
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    const lock = acquireNamedSessionLock('self-held-seat')
    try {
      await expect(liveHeadlessOwner(deriveNamedSessionId('self-held-seat')))
        .resolves.toEqual({ pid: process.pid })
    } finally {
      lock.release()
    }
  })

  it('reads no owner once the lock is released', async () => {
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    const lock = acquireNamedSessionLock('released-seat')
    lock.release()
    await expect(liveHeadlessOwner(deriveNamedSessionId('released-seat'))).resolves.toBeUndefined()
  })

  it('treats a lock naming a dead pid as no owner', async () => {
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    writeForeignLock('stale-seat')
    internals.isPidAlive = () => false
    await expect(liveHeadlessOwner(deriveNamedSessionId('stale-seat'))).resolves.toBeUndefined()
  })
})

describe('FollowTailer', () => {
  it('pushes only events appended after start(), in seq order, and self-stops once the owner dies', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const root = tempDir('dsh-follow-tail-')
    await ctx.plugin(JsonlSessionPersistence, { root })
    const header = meta('named-tail-session', '/proj')
    await ctx.sessionPersistence.create(header)
    const baseline = oneTurnLog()
    await ctx.sessionPersistence.append(header.id, baseline)

    const pushed: SessionEvent[] = []
    let owned = true
    const tailer = new FollowTailer({
      locate: h => ctx.sessionPersistence.locate(h),
      liveOwner: () => Promise.resolve(owned ? { pid: 1 } : undefined),
      push: (_sessionId, event) => { pushed.push(event) },
      intervalMs: 15,
    })

    tailer.start(header.id, header, baseline)
    expect(tailer.isFollowing(header.id)).toBe(true)

    // Give the tailer a moment to establish its cursor and run a poll with
    // nothing new to find, before the file grows further below.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(pushed).toEqual([])

    const secondTurn: SessionEvent[] = [
      { type: 'turn/start', seq: 6, time: 10, data: { turn: 2 } },
      { type: 'turn/end', seq: 7, time: 11, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    await ctx.sessionPersistence.append(header.id, secondTurn)

    await vi.waitFor(() => {
      expect(pushed.map(event => event.seq)).toEqual([6, 7])
    }, { timeout: 2000, interval: 20 })
    expect(pushed.map(event => event.type)).toEqual(['turn/start', 'turn/end'])

    // The owner dies; the next poll must observe that and self-stop instead
    // of polling forever.
    owned = false
    await vi.waitFor(() => {
      expect(tailer.isFollowing(header.id)).toBe(false)
    }, { timeout: 2000, interval: 20 })

    tailer.disposeAll()
  })

  it('does not start a tail when the backend has no per-session artifact', () => {
    const pushed: unknown[] = []
    const tailer = new FollowTailer({
      locate: () => undefined,
      liveOwner: () => Promise.resolve({ pid: 1 }),
      push: (_sessionId, event) => { pushed.push(event) },
    })
    tailer.start('named-no-artifact' as SessionId, meta('named-no-artifact'), [])
    expect(tailer.isFollowing('named-no-artifact' as SessionId)).toBe(false)
  })

  it('start() is idempotent while already following', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const root = tempDir('dsh-follow-tail-idem-')
    await ctx.plugin(JsonlSessionPersistence, { root })
    const header = meta('named-idempotent', '/proj')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())

    const locate = vi.fn((h: typeof header) => ctx.sessionPersistence.locate(h))
    const tailer = new FollowTailer({
      locate,
      liveOwner: () => Promise.resolve({ pid: 1 }),
      push: () => {},
      intervalMs: 1_000,
    })
    tailer.start(header.id, header, oneTurnLog())
    tailer.start(header.id, header, oneTurnLog())
    expect(locate).toHaveBeenCalledTimes(1)
    tailer.disposeAll()
  })
})

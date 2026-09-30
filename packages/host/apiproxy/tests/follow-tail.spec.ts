/**
 * `follow-tail.ts` in isolation: the ownership probe reads the SAME lock
 * file `dsh --profile headless --session-name <name>` takes (no fixture
 * duplicates that format), and the tailer reads real Zstandard-framed JSONL
 * bytes written by the real backend, so a decode bug here would be a decode
 * bug against a genuine artifact, not a hand-rolled fixture.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
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
import { FollowTailer, liveHeadlessOwner, listLiveOwnedSessionIds } from '../src/follow-tail.ts'

/**
 * Control for the `node:fs/promises` mock below: a one-shot override for the
 * NEXT call to `stat()`, used only by the `FollowTailer` tests that need
 * `initCursor`'s own `await stat(path)` to settle at an exact, test-chosen
 * moment instead of whenever the real filesystem happens to answer. Every
 * other call (and every other function) passes through to the real
 * implementation untouched — `liveHeadlessOwner`/`listLiveOwnedSessionIds`
 * never arm it, so their real lock-file reads are unaffected.
 */
const fsControl = vi.hoisted(() => ({
  pendingStat: undefined as undefined | Promise<{ size: number }>,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async stat(...args: Parameters<typeof actual.stat>): ReturnType<typeof actual.stat> {
      if (fsControl.pendingStat !== undefined) {
        const promise = fsControl.pendingStat
        fsControl.pendingStat = undefined
        return promise as unknown as ReturnType<typeof actual.stat>
      }
      return actual.stat(...args)
    },
  }
})

/**
 * Drains the microtask queue several times over. `initCursor`'s continuation
 * after `await stat(path)` settles is reached through a chain of promise
 * hops (the mocked `stat()`'s own return-value adoption, then its caller's
 * `await`), not a single one, so waiting on the armed promise directly
 * (one hop) resolves the test's own `await` before that continuation has
 * actually run. Looping `await Promise.resolve()` well past the real hop
 * count is not a timing guess — `Promise.resolve()` never touches a timer
 * (fake or real) or the actual event loop's I/O phases, so this is exactly
 * as deterministic as a single microtask flush, just with enough rounds to
 * comfortably outlast any realistic chain depth.
 */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/**
 * Arms the NEXT `stat()` call to resolve/reject on command instead of via
 * the real filesystem, then flushes the microtask queue so that by the time
 * the returned promise settles, `initCursor`'s own `await stat(path)` —
 * and its synchronous continuation (the delete/return in its catch, or the
 * cursor/timer setup on success) — has already run. No real timer, no
 * fixed sleep.
 */
function armPendingStat(): {
  resolve: (size: number) => Promise<void>
  reject: (error: unknown) => Promise<void>
} {
  let resolve!: (value: { size: number }) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<{ size: number }>((res, rej) => { resolve = res; reject = rej })
  fsControl.pendingStat = promise
  return {
    resolve: async (size) => {
      resolve({ size })
      await flushMicrotasks()
    },
    reject: async (error) => {
      reject(error)
      await flushMicrotasks()
    },
  }
}

let dirs: string[] = []
const originalInternals = { ...internals }

afterEach(() => {
  Object.assign(internals, originalInternals)
  fsControl.pendingStat = undefined
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

  it('treats a lock whose pid field is not a positive integer as no owner', async () => {
    // Exercises the shape guard directly (typeof/isInteger/< 1), distinct from
    // the liveness probe covered by the dead-pid case above: even if
    // isPidAlive were stubbed to return true, a malformed pid field must
    // never reach it.
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    internals.isPidAlive = () => true
    const path = lockPathForToken(deriveNamedSessionId('bad-pid-seat').slice('named-'.length))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: 'not-a-number' }), 'utf8')
    await expect(liveHeadlessOwner(deriveNamedSessionId('bad-pid-seat'))).resolves.toBeUndefined()
  })
})

describe('listLiveOwnedSessionIds', () => {
  it('returns empty when the lock directory has never been created', async () => {
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    await expect(listLiveOwnedSessionIds()).resolves.toEqual([])
  })

  it('skips non-lock files and malformed tokens, and returns only the live-held named sessions', async () => {
    process.env.DSH_HOME = tempDir('dsh-follow-home-')
    writeForeignLock('owned-seat-a')
    writeForeignLock('stale-seat-b')
    internals.isPidAlive = pid => pid === FOREIGN_PID
    // Make the stale one read as dead by naming a pid nothing matches.
    const staleLockPath = lockPathForToken(deriveNamedSessionId('stale-seat-b').slice('named-'.length))
    writeFileSync(staleLockPath, JSON.stringify({ pid: FOREIGN_PID + 1000, createdAt: Date.now() }), 'utf8')

    const lockDir = dirname(lockPathForToken('0'.repeat(32)))
    // A non-.lock file, and a .lock file whose name isn't a 32-hex token:
    // both must be skipped without error.
    writeFileSync(join(lockDir, 'not-a-lock-file.txt'), 'irrelevant', 'utf8')
    writeFileSync(join(lockDir, 'short-token.lock'), JSON.stringify({ pid: FOREIGN_PID }), 'utf8')

    const owned = await listLiveOwnedSessionIds()
    expect(owned).toEqual([deriveNamedSessionId('owned-seat-a')])
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

  it('abandons startup when the artifact vanishes between locate() and stat()', async () => {
    // stat() is armed (not real): the exact moment it rejects, and the exact
    // moment initCursor's own continuation has finished reacting to that
    // rejection, are both under this test's control — no real fs timing and
    // no timer of any kind.
    const { reject } = armPendingStat()
    const tailer = new FollowTailer({
      locate: () => ({ path: '/does-not-matter.jsonl' }),
      liveOwner: () => Promise.resolve({ pid: 1 }),
      push: () => {},
    })
    const sessionId = 'named-vanished' as SessionId
    tailer.start(sessionId, meta('named-vanished'), [])
    // Synchronously "starting" until the armed stat() rejection lands.
    expect(tailer.isFollowing(sessionId)).toBe(true)

    await reject(Object.assign(new Error('ENOENT: simulated'), { code: 'ENOENT' }))

    expect(tailer.isFollowing(sessionId)).toBe(false)
  })

  it('abandons startup silently when the artifact vanishes AND stop() already superseded it', async () => {
    // Distinct from the plain "vanishes" case above: there, the attempt's
    // own token still matched `starting` when the catch ran, so the catch
    // itself deleted it. Here, stop() already cleared `starting` (a
    // different, earlier event) before the stat() rejection lands, so the
    // catch's token check must come back false and skip a redundant delete.
    const { reject } = armPendingStat()
    const tailer = new FollowTailer({
      locate: () => ({ path: '/does-not-matter.jsonl' }),
      liveOwner: () => Promise.resolve({ pid: 1 }),
      push: () => {},
    })
    const sessionId = 'named-vanished-superseded' as SessionId
    tailer.start(sessionId, meta('named-vanished-superseded'), [])
    tailer.stop(sessionId) // clears `starting` before the armed stat() rejects
    expect(tailer.isFollowing(sessionId)).toBe(false)

    await reject(Object.assign(new Error('ENOENT: simulated'), { code: 'ENOENT' }))

    expect(tailer.isFollowing(sessionId)).toBe(false)
  })

  it('abandons startup when stop() lands while the initial stat() is still in flight', async () => {
    // Same armed-stat technique, but the stat() SUCCEEDS here (the artifact
    // is fine) — it is stop() landing first that must abandon the attempt,
    // exercising the OTHER half of the token check at that same guard.
    const { resolve } = armPendingStat()
    const pushed: SessionEvent[] = []
    const tailer = new FollowTailer({
      locate: () => ({ path: '/does-not-matter.jsonl' }),
      liveOwner: () => Promise.resolve({ pid: 1 }),
      push: (_sessionId, event) => { pushed.push(event) },
      intervalMs: 15,
    })
    const sessionId = 'named-abandoned' as SessionId
    tailer.start(sessionId, meta('named-abandoned'), [])
    // stop() lands synchronously, well before the armed stat() settles.
    tailer.stop(sessionId)
    expect(tailer.isFollowing(sessionId)).toBe(false)

    await resolve(123) // the "vanished" stat now succeeds, well after stop() already superseded it

    expect(tailer.isFollowing(sessionId)).toBe(false)
    expect(pushed).toEqual([])
  })

  it('stops the tail when the artifact shrinks (torn-tail crash repair)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const root = tempDir('dsh-follow-tail-shrink-')
    await ctx.plugin(JsonlSessionPersistence, { root })
    const header = meta('named-shrink', '/proj')
    await ctx.sessionPersistence.create(header)
    const baseline = oneTurnLog()
    await ctx.sessionPersistence.append(header.id, baseline)

    const location = ctx.sessionPersistence.locate(header)
    if (location === undefined) throw new Error('unreachable: fixture session has no locatable artifact')
    const fullSize = statSync(location.path).size

    vi.useFakeTimers()
    try {
      const { resolve } = armPendingStat()
      const tailer = new FollowTailer({
        locate: h => ctx.sessionPersistence.locate(h),
        liveOwner: () => Promise.resolve({ pid: 1 }),
        push: () => {},
        intervalMs: 15,
      })
      tailer.start(header.id, header, baseline)
      // Pins cursor.offset to the pre-truncation size deterministically — no
      // guessing how long the real initial stat() takes to land.
      await resolve(fullSize)
      expect(tailer.isFollowing(header.id)).toBe(true)

      truncateSync(location.path, 0)

      // One poll tick: drain()'s own (real, unmocked) stat() sees the shrink.
      await vi.advanceTimersByTimeAsync(15)
      expect(tailer.isFollowing(header.id)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the default poll interval when none is given', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const root = tempDir('dsh-follow-tail-default-interval-')
    await ctx.plugin(JsonlSessionPersistence, { root })
    const header = meta('named-default-interval', '/proj')
    await ctx.sessionPersistence.create(header)
    const baseline = oneTurnLog()
    await ctx.sessionPersistence.append(header.id, baseline)

    const tailer = new FollowTailer({
      locate: h => ctx.sessionPersistence.locate(h),
      liveOwner: () => Promise.resolve({ pid: 1 }),
      push: () => {},
      // intervalMs omitted: exercises the `?? DEFAULT_POLL_INTERVAL_MS` fallback.
    })
    tailer.start(header.id, header, baseline)
    await vi.waitFor(() => { expect(tailer.isFollowing(header.id)).toBe(true) })
    tailer.disposeAll()
  })

  it('disposeAll stops every currently active tail, not just ones already self-stopped', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const root = tempDir('dsh-follow-tail-disposeall-')
    await ctx.plugin(JsonlSessionPersistence, { root })
    const header = meta('named-disposeall', '/proj')
    await ctx.sessionPersistence.create(header)
    const baseline = oneTurnLog()
    await ctx.sessionPersistence.append(header.id, baseline)
    const location = ctx.sessionPersistence.locate(header)
    if (location === undefined) throw new Error('unreachable: fixture session has no locatable artifact')
    const fullSize = statSync(location.path).size

    const { resolve } = armPendingStat()
    const tailer = new FollowTailer({
      locate: h => ctx.sessionPersistence.locate(h),
      liveOwner: () => Promise.resolve({ pid: 1 }), // never self-stops
      push: () => {},
      intervalMs: 1_000,
    })
    tailer.start(header.id, header, baseline)
    // Pins cursor/timer registration deterministically — the timer is now
    // actually registered, not merely "starting".
    await resolve(fullSize)
    expect(tailer.isFollowing(header.id)).toBe(true)

    tailer.disposeAll()
    expect(tailer.isFollowing(header.id)).toBe(false)
  })

  it('never redelivers an event the caller\'s baseline already reported, even if it lands on disk after the tail starts', async () => {
    // Reproduces the race `cursor.lastSeq` guards against: the caller's
    // baseline (from an earlier history() read) can report a seq that was
    // not yet physically flushed at the moment start() captured its byte
    // cursor. Once that seq's bytes do land and get scanned, they must be
    // suppressed rather than redelivered.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const root = tempDir('dsh-follow-tail-race-')
    await ctx.plugin(JsonlSessionPersistence, { root })
    const header = meta('named-baseline-race', '/proj')
    await ctx.sessionPersistence.create(header)

    const fullLog = oneTurnLog() // seq 0..5
    const alreadyOnDisk = fullLog.slice(0, 4) // seq 0..3
    const notYetFlushed = fullLog.slice(4) // seq 4..5
    await ctx.sessionPersistence.append(header.id, alreadyOnDisk)
    const location = ctx.sessionPersistence.locate(header)
    if (location === undefined) throw new Error('unreachable: fixture session has no locatable artifact')
    const partialSize = statSync(location.path).size

    const { resolve } = armPendingStat()
    const pushed: SessionEvent[] = []
    const tailer = new FollowTailer({
      locate: h => ctx.sessionPersistence.locate(h),
      liveOwner: () => Promise.resolve({ pid: 1 }),
      push: (_sessionId, event) => { pushed.push(event) },
      intervalMs: 15,
    })
    // The caller's baseline claims it already has the FULL log (through seq
    // 5) even though only seq 0..3 are on disk right now.
    tailer.start(header.id, header, fullLog)
    // Pins cursor.offset to the seq-0..3 size deterministically — no
    // guessing how long the real initial stat() takes to land.
    await resolve(partialSize)

    // Both the "missing" tail of the baseline AND a genuinely new event
    // land on disk before any poll can observe either. This test does NOT
    // use fake timers for what follows: draining real, Zstandard-framed
    // bytes off disk is a chain of real fs syscalls (stat, open, read,
    // close) dispatched through libuv's real thread pool across possibly
    // several poll ticks, not microtasks a fake clock can flush in
    // lockstep — vi.advanceTimersByTimeAsync(15) was tried here and does
    // not reliably wait long enough for that real I/O to finish. A single
    // vi.waitFor on the FINAL state proves both outcomes: seq 4/5 (already
    // reported via the baseline) never appear, and seq 6 (genuinely new)
    // does — if suppression ever broke, pushed would contain 4 and 5
    // alongside (or instead of) 6, and the exact-equality check below
    // would fail.
    await ctx.sessionPersistence.append(header.id, notYetFlushed)
    await ctx.sessionPersistence.append(header.id, [
      { type: 'turn/start', seq: 6, time: 20, data: { turn: 2 } },
    ])
    await vi.waitFor(() => {
      expect(pushed.map(event => event.seq)).toEqual([6])
    }, { timeout: 2000, interval: 20 })

    tailer.disposeAll()
  })
})

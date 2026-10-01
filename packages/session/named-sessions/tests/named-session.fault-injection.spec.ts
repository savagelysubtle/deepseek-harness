/**
 * Named-session lock-lifecycle edge cases that real filesystem calls almost
 * never exercise: a non-finite `/proc` start-ticks parse, a missing-startTicks
 * instance-identity fallback, an `openSync`/`unlinkSync` failure other than
 * the one the lock algebra specifically handles, and an exhausted create-race
 * loop. Each is driven either through the `internals` seam already exported
 * for this purpose, or (where no seam exists) a one-shot `node:fs`
 * control-flag mock, matching the pattern in
 * subprocess-local/tests/spawn.spec.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireNamedSessionLock,
  internals,
  isLockHolderLive,
  namedLockPath,
} from '../src/index.ts'

const fsFault = vi.hoisted(() => ({
  /** readFileSync throws this error once for an exact path match. */
  readFileOnce: undefined as { path: string; code: string } | undefined,
  /** openSync throws this error once for an exact path match. */
  openOnce: undefined as { path: string; code: string } | undefined,
  /** openSync always throws EEXIST for an exact path match (never clears). */
  alwaysEexistPath: undefined as string | undefined,
  /** unlinkSync throws this error once for an exact path match. */
  unlinkOnce: undefined as { path: string; code: string } | undefined,
  /** readFileSync returns this content for an exact path match (/proc faking). */
  fakeProcStat: undefined as { path: string; content: string } | undefined,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const target = String(args[0])
      if (fsFault.fakeProcStat?.path === target) return fsFault.fakeProcStat.content
      if (fsFault.readFileOnce?.path === target) {
        const { code } = fsFault.readFileOnce
        fsFault.readFileOnce = undefined
        throw Object.assign(new Error(`simulated readFileSync failure: ${code}`), { code })
      }
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const target = String(args[0])
      if (fsFault.alwaysEexistPath === target) {
        throw Object.assign(new Error('simulated EEXIST on open'), { code: 'EEXIST' })
      }
      if (fsFault.openOnce?.path === target) {
        const { code } = fsFault.openOnce
        fsFault.openOnce = undefined
        throw Object.assign(new Error(`simulated openSync failure: ${code}`), { code })
      }
      return actual.openSync(...args)
    }),
    unlinkSync: ((...args: Parameters<typeof actual.unlinkSync>) => {
      const target = String(args[0])
      if (fsFault.unlinkOnce?.path === target) {
        const { code } = fsFault.unlinkOnce
        fsFault.unlinkOnce = undefined
        throw Object.assign(new Error(`simulated unlinkSync failure: ${code}`), { code })
      }
      actual.unlinkSync(...args)
    }),
  }
})

const originalInternals = { ...internals }
let home: string | undefined

afterEach(() => {
  Object.assign(internals, originalInternals)
  fsFault.readFileOnce = undefined
  fsFault.openOnce = undefined
  fsFault.alwaysEexistPath = undefined
  fsFault.unlinkOnce = undefined
  fsFault.fakeProcStat = undefined
  if (home !== undefined) {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
  home = undefined
})

/** Point DSH_HOME at a fresh temp directory so tests never touch the user home. */
function useTempHome(): string {
  home = mkdtempSync(join(tmpdir(), 'dsh-named-sessions-fault-'))
  process.env.DSH_HOME = home
  return home
}

describe('processStartTicks: /proc parse edge cases', () => {
  it('returns undefined when /proc/<pid>/stat cannot be read at all', () => {
    // A pid this large is never allocated in practice, so the real
    // `/proc/<pid>/stat` read throws ENOENT without any mocking.
    expect(internals.processStartTicks(999_999)).toBeUndefined()
  })

  it('returns undefined when the starttime field parses to a non-finite number', () => {
    const fakePid = 888_888
    // Real /proc/<pid>/stat format: "pid (comm) state ppid ... fields". The
    // implementation slices past the ")" and splits on spaces, reading index
    // 19 as starttime. Only 4 fields follow here, so index 19 is undefined
    // and Number(undefined) is NaN — not finite.
    fsFault.fakeProcStat = { path: `/proc/${fakePid}/stat`, content: `${fakePid} (fake) R 1 2 3` }
    expect(internals.processStartTicks(fakePid)).toBeUndefined()
  })
})

describe('isLockHolderLive: missing instance identity on this platform', () => {
  it('honors pid liveness when start ticks cannot be read for the holder', () => {
    internals.isPidAlive = () => true
    internals.processStartTicks = () => undefined
    // The holder record carries startTicks, but this "platform" cannot read
    // them back — instance identity is unavailable, so pid liveness stands.
    expect(isLockHolderLive({ pid: 4242, startTicks: 7 })).toBe(true)
  })
})

describe('acquireLockAtPath: own start-ticks unavailable', () => {
  it('writes a payload with no startTicks field when the platform cannot read its own', () => {
    useTempHome()
    internals.processStartTicks = () => undefined
    const path = namedLockPath('no-ticks-platform')
    const lock = acquireNamedSessionLock('no-ticks-platform')
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      expect(payload).not.toHaveProperty('startTicks')
      expect(payload.pid).toBe(process.pid)
    } finally {
      lock.release()
    }
  })
})

describe('acquireLockAtPath: openSync failures other than EEXIST', () => {
  it('propagates a non-EEXIST openSync failure instead of treating it as contention', () => {
    useTempHome()
    const path = namedLockPath('open-fails')
    fsFault.openOnce = { path, code: 'EACCES' }
    expect(() => acquireNamedSessionLock('open-fails')).toThrow('simulated openSync failure: EACCES')
    // Never reached the "active in another process" contention message.
  })
})

describe('acquireLockAtPath: create-race attempts exhausted', () => {
  it('reports contention once every takeover attempt loses the create race to an always-EEXIST artifact', () => {
    useTempHome()
    const path = namedLockPath('exhausted')
    mkdirSync(join(path, '..'), { recursive: true })
    // A dead holder: every throwIfLiveHolder call treats it (and its absence,
    // after the first real unlink) as abandoned, so the loop never throws
    // contention early — it only runs out of LOCK_ACQUIRE_ATTEMPTS attempts
    // because openSync is forced to EEXIST unconditionally for this path.
    writeFileSync(path, JSON.stringify({ pid: 999_999, createdAt: 1 }))
    internals.isPidAlive = () => false
    fsFault.alwaysEexistPath = path
    expect(() => acquireNamedSessionLock('exhausted')).toThrow('session "exhausted" is active in another process')
  })
})

describe('throwIfLiveHolder: structurally invalid pid field', () => {
  it('treats a non-numeric pid field as no provable holder and takes over', () => {
    useTempHome()
    const path = namedLockPath('bad-pid-field')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: 'not-a-number', createdAt: 1 }))
    const lock = acquireNamedSessionLock('bad-pid-field')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
  })
})

describe('release(): reading the artifact back fails', () => {
  it('returns silently when the artifact is already gone by the time release reads it', () => {
    useTempHome()
    const path = namedLockPath('vanished-before-release')
    const lock = acquireNamedSessionLock('vanished-before-release')
    // Simulate another process having already cleaned it up.
    unlinkSync(path)
    expect(() => { lock.release() }).not.toThrow()
  })

  it('propagates a non-ENOENT failure reading the artifact back', () => {
    useTempHome()
    const path = namedLockPath('read-fails-on-release')
    const lock = acquireNamedSessionLock('read-fails-on-release')
    fsFault.readFileOnce = { path, code: 'EIO' }
    expect(() => { lock.release() }).toThrow('simulated readFileSync failure: EIO')
  })
})

describe('release(): unlinking the matched artifact fails', () => {
  it('returns silently when the artifact disappears between the read and the unlink', () => {
    useTempHome()
    const path = namedLockPath('unlink-races-release')
    const lock = acquireNamedSessionLock('unlink-races-release')
    fsFault.unlinkOnce = { path, code: 'ENOENT' }
    expect(() => { lock.release() }).not.toThrow()
  })

  it('propagates a non-ENOENT unlink failure', () => {
    useTempHome()
    const path = namedLockPath('unlink-fails-release')
    const lock = acquireNamedSessionLock('unlink-fails-release')
    fsFault.unlinkOnce = { path, code: 'EACCES' }
    expect(() => { lock.release() }).toThrow('simulated unlinkSync failure: EACCES')
  })
})

describe('unlinkAbandoned(): removing a takeover target fails', () => {
  it('propagates a non-ENOENT unlink failure while taking over an abandoned artifact', () => {
    useTempHome()
    const path = namedLockPath('abandon-unlink-fails')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: 999_999, createdAt: 1 }))
    internals.isPidAlive = () => false
    fsFault.unlinkOnce = { path, code: 'EACCES' }
    expect(() => acquireNamedSessionLock('abandon-unlink-fails')).toThrow('simulated unlinkSync failure: EACCES')
    // The abandoned artifact is left behind: unlink failed before takeover.
    expect(existsSync(path)).toBe(true)
  })
})

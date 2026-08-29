/** Named-session identity derivation and per-name lock lifecycle. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acquireNamedSessionLock,
  acquireSessionLock,
  assertValidSessionName,
  deriveNamedSessionId,
  internals,
  isLockHolderLive,
  lockPathForSession,
  namedLockPath,
  namedSessionToken,
} from '../src/index.ts'

const originalInternals = { ...internals }
let home: string | undefined

afterEach(() => {
  Object.assign(internals, originalInternals)
  if (home !== undefined) delete process.env.DSH_HOME
  home = undefined
})

/** Point DSH_HOME at a fresh temp directory so tests never touch the user home. */
function useTempHome(): string {
  home = mkdtempSync(join(tmpdir(), 'dsh-named-sessions-'))
  process.env.DSH_HOME = home
  return home
}

describe('named session identity', () => {
  it('derives the documented id deterministically from the name', () => {
    const expected = createHash('sha256').update('alpha', 'utf8').digest('hex').slice(0, 32)
    expect(deriveNamedSessionId('alpha')).toBe(SessionId(`named-${expected}`))
    expect(deriveNamedSessionId('alpha')).toBe(deriveNamedSessionId('alpha'))
    expect(deriveNamedSessionId('alpha')).not.toBe(deriveNamedSessionId('beta'))
  })

  it.each([
    ['plain', true],
    ['A-b_1.2', true],
    ['', false],
    ['-leading', false],
    ['.leading', false],
    ['has space', false],
    ['sl/ash', false],
    ['x'.repeat(65), false],
  ])('validates %j against the filename-safe pattern', (name, valid) => {
    const attempt = () => {
      assertValidSessionName(name)
    }
    if (valid) expect(attempt).not.toThrow()
    else expect(attempt).toThrow('invalid session name')
  })
})

describe('per-name lock', () => {
  it('creates the artifact on acquire and removes it on release', () => {
    useTempHome()
    const path = namedLockPath('work')
    const lock = acquireNamedSessionLock('work')
    expect(existsSync(path)).toBe(true)
    const record = JSON.parse(readFileSync(path, 'utf8')) as unknown as { pid: number; createdAt: number }
    expect(record.pid).toBe(process.pid)
    expect(Number.isFinite(record.createdAt)).toBe(true)
    lock.release()
    expect(existsSync(path)).toBe(false)
  })

  it('rejects while a live process holds the lock and keeps its artifact', () => {
    useTempHome()
    const path = namedLockPath('busy')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: 1 }))
    internals.isPidAlive = () => true
    expect(() => acquireNamedSessionLock('busy')).toThrow('session "busy" is active in another process')
    expect(existsSync(path)).toBe(true)
  })

  it('takes over the artifact when the holder pid is dead', () => {
    useTempHome()
    const path = namedLockPath('stale')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: 999_999, createdAt: 1 }))
    internals.isPidAlive = () => false
    const lock = acquireNamedSessionLock('stale')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
    expect(existsSync(path)).toBe(false)
  })

  it('takes over the artifact when a recycled pid no longer matches the recorded start ticks', () => {
    useTempHome()
    const path = namedLockPath('recycled')
    mkdirSync(join(path, '..'), { recursive: true })
    // A live pid (this one) holding a record whose start ticks name a
    // DIFFERENT process instance — the signature of pid reuse after a crash.
    writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: 1, startTicks: 42 }))
    const lock = acquireNamedSessionLock('recycled')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
    expect(existsSync(path)).toBe(false)
  })

  it('records the holder process start ticks in a fresh lock and honors the match', () => {
    useTempHome()
    const lock = acquireNamedSessionLock('ticked')
    try {
      const payload = JSON.parse(readFileSync(namedLockPath('ticked'), 'utf8'))
      expect(payload.startTicks).toBe(internals.processStartTicks(process.pid))
      expect(isLockHolderLive(payload)).toBe(true)
    } finally {
      lock.release()
    }
  })

  it('takes over a torn artifact that records no holder', () => {
    useTempHome()
    const path = namedLockPath('torn')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '')
    const lock = acquireNamedSessionLock('torn')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
  })

  it('probes liveness through the operating system', async () => {
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn('true')
      if (child.pid === undefined) {
        child.kill()
        reject(new Error('spawn could not create a process'))
        return
      }
      const { pid } = child
      child.on('error', reject)
      child.on('exit', () => { resolve(pid) })
    })
    expect(internals.isPidAlive(deadPid)).toBe(false)
    expect(internals.isPidAlive(process.pid)).toBe(true)
  })

  it('refuses to release an artifact taken over by another record', () => {
    useTempHome()
    const path = namedLockPath('taken')
    const lock = acquireNamedSessionLock('taken')
    writeFileSync(path, JSON.stringify({ pid: 424_242, createdAt: 2 }))
    lock.release()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: 424_242 })
  })
})

describe('maxAgeMs takeover bound', () => {
  it('takes over a live holder older than the bound', () => {
    useTempHome()
    const path = namedLockPath('aged')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 10_000 }))
    internals.isPidAlive = () => true
    const lock = acquireNamedSessionLock('aged', { maxAgeMs: 5_000 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid })
    lock.release()
    expect(existsSync(path)).toBe(false)
  })

  it('rejects a live holder younger than the bound and keeps its artifact', () => {
    useTempHome()
    const path = namedLockPath('fresh')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
    internals.isPidAlive = () => true
    expect(() => acquireNamedSessionLock('fresh', { maxAgeMs: 60_000 }))
      .toThrow('session "fresh" is active in another process')
    expect(existsSync(path)).toBe(true)
  })

  it('still rejects a live holder without a readable timestamp even with the bound set', () => {
    useTempHome()
    const path = namedLockPath('undated')
    mkdirSync(join(path, '..'), { recursive: true })
    // A malformed-but-alive holder cannot be proved old; honoring it beats
    // silently stealing an artifact whose age is unknown.
    writeFileSync(path, JSON.stringify({ pid: process.pid }))
    internals.isPidAlive = () => true
    expect(() => acquireNamedSessionLock('undated', { maxAgeMs: 1 }))
      .toThrow('session "undated" is active in another process')
  })
})

describe('session-keyed locking — the lock guards what is written', () => {
  it('locks a derived id at the same path its name would', () => {
    // A seat whose identity is still name-derived must not change lock files
    // just because the caller switched entry points.
    expect(lockPathForSession(String(deriveNamedSessionId('robin')))).toBe(namedLockPath('robin'))
  })

  it('gives a non-derived id its own lock rather than colliding on a name', () => {
    const uiSession = 'session-35081af5-7bb7-4910-899e-b80bbe8915b2'
    expect(lockPathForSession(uiSession)).not.toBe(namedLockPath('robin'))
    expect(lockPathForSession(uiSession)).toBe(lockPathForSession(uiSession))
  })

  it('keeps one lock across a rename — the id is what is locked, not the label', () => {
    // Identity recorded once and carried through a rename: both names resolve to
    // the same session id, so both must contend for exactly one lock. Locking by
    // name would hand them two, which is two writers on one log.
    const pinned = String(deriveNamedSessionId('robin'))
    const held = acquireSessionLock(pinned)
    try {
      expect(() => acquireSessionLock(pinned)).toThrow(/active in another process/)
    } finally {
      held.release()
    }
  })

  it('reads the token back out of a derived id, and refuses a foreign one', () => {
    const id = String(deriveNamedSessionId('robin'))
    expect(namedSessionToken(id)).toMatch(/^[0-9a-f]{32}$/)
    expect(namedSessionToken('session-not-derived')).toBeUndefined()
    expect(namedSessionToken('named-tooshort')).toBeUndefined()
  })
})

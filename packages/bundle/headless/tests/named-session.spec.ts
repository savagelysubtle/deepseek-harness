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
  assertValidSessionName,
  deriveNamedSessionId,
  internals,
  namedLockPath,
} from '../src/named-session.ts'

const originalInternals = { ...internals }
let home: string | undefined

afterEach(() => {
  Object.assign(internals, originalInternals)
  if (home !== undefined) delete process.env.DSH_HOME
  home = undefined
})

/** Point DSH_HOME at a fresh temp directory so tests never touch the user home. */
function useTempHome(): string {
  home = mkdtempSync(join(tmpdir(), 'dsh-headless-named-'))
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
    const deadPid = await new Promise<number>((resolve) => {
      const child = spawn('true')
      child.on('exit', () => { resolve(child.pid) })
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

/**
 * Directory-ownership checks of the binary attestation. A directory owned by
 * a third user cannot be created without privileges, so `statSync` is wrapped
 * to report a chosen owner for chosen paths; everything else is real.
 */

import { chmodSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attestClaudePath } from '../src/attest.ts'
import { cleanTempDirs, fakeClaudeBinary, tempDir } from './fakes.ts'

const owners = vi.hoisted(() => new Map<string, number>())

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const statSync = ((path: string, ...rest: unknown[]) => {
    const real = (actual.statSync as (...args: unknown[]) => import('node:fs').Stats)(path, ...rest)
    const uid = owners.get(path)
    return uid === undefined ? real : Object.assign(Object.create(Object.getPrototypeOf(real) as object) as import('node:fs').Stats, real, { uid })
  }) as typeof actual.statSync
  return { ...actual, statSync }
})

afterEach(() => {
  owners.clear()
  cleanTempDirs()
})

const mine = process.getuid?.() ?? 0

describe('directory ownership of the attested binary (review 8)', () => {
  it('refuses a directory in the resolved chain owned by someone who is neither the operator nor root', () => {
    const file = fakeClaudeBinary()
    owners.set(dirname(file), mine + 1)
    expect(() => attestClaudePath(file)).toThrow(new RegExp(`its directory ${dirname(file)} is owned by uid ${mine + 1}, neither the running user ${mine} nor root`))
  })

  it('accepts a directory owned by root', () => {
    const file = fakeClaudeBinary()
    owners.set(dirname(file), 0)
    expect(attestClaudePath(file).realPath).toBe(file)
  })

  it('also checks the directory that holds the symlink, which decides where it can be retargeted', () => {
    const file = fakeClaudeBinary()
    const linkDir = tempDir('cc-link-')
    chmodSync(linkDir, 0o700)
    const link = join(linkDir, 'claude')
    symlinkSync(file, link)
    expect(attestClaudePath(link).realPath).toBe(file)
    owners.set(linkDir, mine + 1)
    expect(() => attestClaudePath(link)).toThrow(new RegExp(`its directory ${linkDir} is owned by uid ${mine + 1}`))
  })

  it('refuses a world-writable directory that holds only the symlink', () => {
    const file = fakeClaudeBinary()
    const linkDir = tempDir('cc-link-')
    const link = join(linkDir, 'claude')
    symlinkSync(file, link)
    chmodSync(linkDir, 0o777)
    expect(() => attestClaudePath(link)).toThrow(/its directory .* is group- or world-writable \(mode 777\)/)
  })
})

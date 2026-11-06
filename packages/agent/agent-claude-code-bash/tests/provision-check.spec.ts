import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveWorkdir } from '../src/provision-check.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bash-workdir-')))
const clone = join(root, 'clone')
const outside = join(root, 'outside')
mkdirSync(join(clone, 'sub', 'deep'), { recursive: true })
mkdirSync(outside)
writeFileSync(join(clone, 'file.txt'), 'x')
symlinkSync(join(clone, 'sub'), join(clone, 'link-in'))
symlinkSync(outside, join(clone, 'link-out'))

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

import { containing } from './helpers.ts'

describe('resolveWorkdir', () => {
  it('defaults to the clone root', () => {
    expect(resolveWorkdir(clone, undefined)).toEqual({ ok: true, workdir: clone })
  })

  it('accepts the root itself and a nested directory', () => {
    expect(resolveWorkdir(clone, clone)).toEqual({ ok: true, workdir: clone })
    expect(resolveWorkdir(clone, join(clone, 'sub', 'deep'))).toEqual({ ok: true, workdir: join(clone, 'sub', 'deep') })
  })

  it('resolves a symlink that stays inside the clone to its real directory', () => {
    expect(resolveWorkdir(clone, join(clone, 'link-in'))).toEqual({ ok: true, workdir: join(clone, 'sub') })
  })

  it('refuses a leading dash, a relative path, NUL and newline', () => {
    for (const bad of ['-rf', '-', 'sub', './sub', `${clone}/a\0b`, `${clone}/a\nb`]) {
      const result = resolveWorkdir(clone, bad)
      expect(result.ok, bad).toBe(false)
    }
    expect(resolveWorkdir(clone, '-x')).toEqual({ ok: false, reason: 'cwd must be an absolute path and may not start with "-"' })
  })

  it('refuses a symlink that leaves the clone, `..` escapes and sibling directories', () => {
    for (const bad of [join(clone, 'link-out'), join(clone, '..', 'outside'), outside, `${clone}-two`, '/']) {
      const result = resolveWorkdir(clone, bad)
      expect(result.ok, bad).toBe(false)
    }
    expect(resolveWorkdir(clone, join(clone, 'link-out'))).toMatchObject({ reason: containing('resolves outside') })
  })

  it('refuses a missing path and a plain file', () => {
    expect(resolveWorkdir(clone, join(clone, 'nope'))).toMatchObject({ ok: false, reason: containing('does not exist') })
    expect(resolveWorkdir(clone, join(clone, 'file.txt', 'inner'))).toMatchObject({ ok: false, reason: containing('does not exist') })
    expect(resolveWorkdir(clone, join(clone, 'file.txt'))).toMatchObject({ ok: false, reason: containing('is not a directory') })
  })

  it('names the errno when the path cannot be resolved for another reason, and survives an error without a code', () => {
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
    expect(resolveWorkdir(clone, join(clone, 'x'), { realpath: () => { throw eacces }, isDirectory: () => true }))
      .toEqual({ ok: false, reason: `cwd ${join(clone, 'x')} cannot be resolved (EACCES)` })
    expect(resolveWorkdir(clone, join(clone, 'x'), { realpath: () => { throw new Error('odd') }, isDirectory: () => true }))
      .toEqual({ ok: false, reason: `cwd ${join(clone, 'x')} cannot be resolved (unknown error)` })
  })
})

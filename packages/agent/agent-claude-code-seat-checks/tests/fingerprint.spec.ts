import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fingerprintClone, realCloneFs } from '../src/fingerprint.ts'
import type { CloneFs } from '../src/fingerprint.ts'
import { addExecutableHook, errorWithCode, makeClone, replaceWithSymlink, tempRoot,
  writeConfig } from './helpers.ts'
import type { TempRoot } from './helpers.ts'

let box: TempRoot
let cwd: string
beforeEach(() => {
  box = tempRoot()
  cwd = makeClone(box.root)
})
afterEach(() => { box.cleanup() })

describe('fingerprintClone: stable when nothing changed, different when anything watched changed',
  () => {
    it('is stable across two calls', () => {
      expect(fingerprintClone(cwd)).toBe(fingerprintClone(cwd))
      expect(fingerprintClone(cwd, realCloneFs)).toBe(fingerprintClone(cwd))
    })

    it('changes when the config is rewritten (even with its mtime restored)', () => {
      const before = fingerprintClone(cwd)
      const config = join(cwd, '.git', 'config')
      const stat = realCloneFs.lstat(config)
      writeConfig(cwd, '[core]\n\thookspath = /x\n')
      utimesSync(config, Number(stat.atimeMs) / 1000, Number(stat.mtimeMs) / 1000)
      expect(fingerprintClone(cwd)).not.toBe(before)
    })

    it('changes when the config is replaced by a symlink', () => {
      const before = fingerprintClone(cwd)
      replaceWithSymlink(join(cwd, '.git', 'config'), '/etc/hostname')
      expect(fingerprintClone(cwd)).not.toBe(before)
    })

    it.each(['commondir', 'gitdir', 'dsh-hooks', 'config.worktree', 'worktrees',
      'objects/info/alternates', 'objects/info/http-alternates'])(
      'changes when .git/%s appears',
      (entry) => {
        const before = fingerprintClone(cwd)
        mkdirSync(join(cwd, '.git', 'objects', 'info'), { recursive: true })
        writeFileSync(join(cwd, '.git', entry), 'x')
        expect(fingerprintClone(cwd)).not.toBe(before)
      },
    )

    it('changes when a hook appears, changes mode, or disappears', () => {
      const before = fingerprintClone(cwd)
      addExecutableHook(cwd, 'pre-push')
      const added = fingerprintClone(cwd)
      expect(added).not.toBe(before)
      chmodSync(join(cwd, '.git', 'hooks', 'pre-push'), 0o644)
      expect(fingerprintClone(cwd)).not.toBe(added)
      rmSync(join(cwd, '.git', 'hooks', 'pre-push'))
      rmSync(join(cwd, '.git', 'hooks', 'pre-commit.sample'))
      expect(fingerprintClone(cwd)).not.toBe(before)
    })

    it('lists hook entries in a stable order', () => {
      addExecutableHook(cwd, 'b')
      addExecutableHook(cwd, 'a')
      const print = fingerprintClone(cwd)
      expect(print.indexOf('|a=')).toBeLessThan(print.indexOf('|b='))
    })

    it('gives a missing .git and a missing hooks directory a stable token', () => {
      const bare = join(box.root, 'nothing')
      expect(fingerprintClone(bare)).toBe(fingerprintClone(bare))
      rmSync(join(cwd, '.git', 'hooks'), { recursive: true })
      expect(fingerprintClone(cwd)).toBe(fingerprintClone(cwd))
    })
  })

describe('fingerprintClone: an unreadable entry is never equal to anything', () => {
  const failingFs = (code: string, where: 'lstat' | 'readdir'): CloneFs => ({
    lstat: where === 'lstat'
      ? () => { throw errorWithCode(code) }
      : realCloneFs.lstat,
    readdir: where === 'readdir'
      ? () => { throw errorWithCode(code) }
      : realCloneFs.readdir,
  })

  it('an lstat error other than ENOENT differs on every call', () => {
    const fs = failingFs('EACCES', 'lstat')
    expect(fingerprintClone(cwd, fs)).not.toBe(fingerprintClone(cwd, fs))
  })

  it('a readdir error other than ENOENT differs on every call', () => {
    const fs = failingFs('EACCES', 'readdir')
    expect(fingerprintClone(cwd, fs)).not.toBe(fingerprintClone(cwd, fs))
  })

  it('a readdir ENOENT reads as an empty directory and is stable', () => {
    const fs = failingFs('ENOENT', 'readdir')
    expect(fingerprintClone(cwd, fs)).toBe(fingerprintClone(cwd, fs))
  })
})

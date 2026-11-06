import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CloneCheckError } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertCloneHookState, createCloneChecker, inspectCloneState } from '../src/clone-state.ts'
import type { CloneInspectDeps } from '../src/clone-state.ts'
import { realCloneFs } from '../src/fingerprint.ts'
import type { CloneFs } from '../src/fingerprint.ts'
import { realRunGit } from '../src/git-config.ts'
import type { RunGit } from '../src/git-config.ts'
import { MAX_CONFIG_BYTES } from '../src/limits.ts'
import { addExecutableHook, addHardlink, CLEAN_CONFIG, errorWithCode, GIT, makeClone, okResult,
  replaceWithSymlink, tempRoot, writeConfig } from './helpers.ts'
import type { TempRoot } from './helpers.ts'

let box: TempRoot
let cwd: string
beforeEach(() => {
  box = tempRoot()
  cwd = makeClone(box.root)
})
afterEach(() => { box.cleanup() })

const real: CloneInspectDeps = { gitPath: GIT, run: realRunGit, fs: realCloneFs,
  remoteUrlAllow: ['/srv/'] }

function refusedWith(deps: CloneInspectDeps = real, where: string = cwd): CloneCheckError {
  try {
    inspectCloneState('seat-a', where, deps)
  } catch (error: unknown) {
    if (error instanceof CloneCheckError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

/** A filesystem that fails one path with the given errno and otherwise behaves. */
function failingFs(path: string, code: string, op: 'lstat' | 'readdir' = 'lstat'): CloneFs {
  return {
    lstat: p => (op === 'lstat'
      && p === path ? ((): never => { throw errorWithCode(code) })() : realCloneFs.lstat(p)),
    readdir: p => (op === 'readdir'
      && p === path ? ((): never => { throw errorWithCode(code) })() : realCloneFs.readdir(p)),
  }
}

describe('inspectCloneState: the clean clone', () => {
  it('passes a fresh clone config with real git', () => {
    expect(() => { inspectCloneState('seat-a', cwd, real) }).not.toThrow()
  })

  it('passes a clone with no hooks directory at all', () => {
    rmSync(join(cwd, '.git', 'hooks'), { recursive: true })
    expect(() => { inspectCloneState('seat-a', cwd, real) }).not.toThrow()
  })
})

describe('inspectCloneState: .git itself', () => {
  it('refuses a missing .git (enoent)', () => {
    expect(refusedWith(real, join(box.root, 'nothing'))).toMatchObject({ code: 'enoent' })
  })

  it('refuses a .git that is a file (a worktree pointer)', () => {
    rmSync(join(cwd, '.git'), { recursive: true })
    writeFileSync(join(cwd, '.git'), 'gitdir: /elsewhere\n')
    expect(refusedWith()).toMatchObject({ code: 'git-not-directory' })
  })

  it('refuses a .git that is a symlink', () => {
    const real_ = join(box.root, 'real-git')
    mkdirSync(real_)
    rmSync(join(cwd, '.git'), { recursive: true })
    symlinkSync(real_, join(cwd, '.git'))
    expect(refusedWith()).toMatchObject({ code: 'git-not-directory' })
  })

  it('refuses an unreadable .git (eacces)', () => {
    expect(refusedWith({ ...real, fs: failingFs(join(cwd, '.git'),
      'EACCES') })).toMatchObject({ code: 'eacces' })
  })

  it('refuses an lstat error that is neither ENOENT nor EACCES (fs-error)', () => {
    expect(refusedWith({ ...real, fs: failingFs(join(cwd, '.git'),
      'EIO') })).toMatchObject({ code: 'fs-error' })
    expect(refusedWith({ ...real, fs: failingFs(join(cwd, '.git'),
      'EPERM') })).toMatchObject({ code: 'eacces' })
  })

  it('names an error without an errno as unknown', () => {
    const fs: CloneFs = { ...realCloneFs, lstat: (p) => { if (p === join(cwd,
      '.git')) throw new Error('odd'); return realCloneFs.lstat(p) } }
    expect(refusedWith({ ...real, fs }).reason).toContain('unknown error')
  })
})

describe('inspectCloneState: entries that must be absent', () => {
  it.each([
    'commondir', 'gitdir', 'dsh-hooks', 'config.worktree', 'worktrees', 'objects/info/alternates',
    'objects/info/http-alternates',
  ])('refuses .git/%s', (entry) => {
    mkdirSync(join(cwd, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(cwd, '.git', entry), 'x')
    const error = refusedWith()
    expect(error.code).toBe('forbidden-entry')
    expect(error.reason).toContain(entry)
  })

  it('refuses a forbidden entry that is a dangling symlink', () => {
    symlinkSync('/nonexistent', join(cwd, '.git', 'commondir'))
    expect(refusedWith()).toMatchObject({ code: 'forbidden-entry' })
  })

  it('refuses when a forbidden entry cannot be read', () => {
    expect(refusedWith({ ...real, fs: failingFs(join(cwd, '.git', 'commondir'),
      'EACCES') })).toMatchObject({ code: 'eacces' })
  })
})

describe('inspectCloneState: hooks', () => {
  it.each(['pre-commit', 'pre-push', 'reference-transaction',
    'post-checkout'])('refuses an executable %s', (name) => {
    addExecutableHook(cwd, name)
    const error = refusedWith()
    expect(error.code).toBe('hook-entry')
    expect(error.reason).toContain(name)
  })

  it('refuses a non-executable file that is not a sample', () => {
    writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit'), 'x')
    expect(refusedWith()).toMatchObject({ code: 'hook-entry' })
  })

  it('refuses a symlink named like a sample', () => {
    symlinkSync('/bin/sh', join(cwd, '.git', 'hooks', 'evil.sample'))
    expect(refusedWith()).toMatchObject({ code: 'hook-entry' })
  })

  it('refuses a subdirectory, even one named like a sample', () => {
    mkdirSync(join(cwd, '.git', 'hooks', 'x.sample'))
    expect(refusedWith()).toMatchObject({ code: 'hook-entry' })
  })

  it('refuses a hooks directory that is a symlink or a file', () => {
    replaceWithSymlink(join(cwd, '.git', 'hooks'), '/tmp')
    expect(refusedWith()).toMatchObject({ code: 'hook-entry' })
    rmSync(join(cwd, '.git', 'hooks'))
    writeFileSync(join(cwd, '.git', 'hooks'), 'x')
    expect(refusedWith()).toMatchObject({ code: 'hook-entry' })
  })

  it('refuses when the hooks directory cannot be listed', () => {
    expect(refusedWith({ ...real, fs: failingFs(join(cwd, '.git', 'hooks'), 'EACCES',
      'readdir') })).toMatchObject({ code: 'eacces' })
  })

  it('refuses when the hooks directory cannot be inspected', () => {
    expect(refusedWith({ ...real, fs: failingFs(join(cwd, '.git', 'hooks'),
      'EIO') })).toMatchObject({ code: 'fs-error' })
  })

  it('refuses an entry that vanishes between the listing and the lstat', () => {
    const fs: CloneFs = {
      ...realCloneFs,
      lstat: (p) => {
        if (p.endsWith('pre-commit.sample')) throw errorWithCode('ENOENT')
        return realCloneFs.lstat(p)
      },
    }
    expect(refusedWith({ ...real, fs })).toMatchObject({ code: 'hook-entry' })
  })
})

describe('inspectCloneState: the config file before git runs', () => {
  it('refuses a missing config (enoent) and never spawns git', () => {
    rmSync(join(cwd, '.git', 'config'))
    const run = vi.fn<RunGit>()
    expect(refusedWith({ ...real, run })).toMatchObject({ code: 'enoent' })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a symlinked config and never spawns git', () => {
    const run = vi.fn<RunGit>()
    replaceWithSymlink(join(cwd, '.git', 'config'), join(box.root, 'elsewhere'))
    writeFileSync(join(box.root, 'elsewhere'), CLEAN_CONFIG)
    expect(refusedWith({ ...real, run })).toMatchObject({ code: 'config-not-regular' })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a hardlinked config (nlink 2)', () => {
    addHardlink(join(cwd, '.git', 'config'), join(box.root, 'twin'))
    expect(refusedWith()).toMatchObject({ code: 'config-not-regular' })
  })

  it('refuses a config that is a directory', () => {
    rmSync(join(cwd, '.git', 'config'))
    mkdirSync(join(cwd, '.git', 'config'))
    expect(refusedWith()).toMatchObject({ code: 'config-not-regular' })
  })

  it('refuses a config over 64 KiB without spawning git; exactly 64 KiB passes', () => {
    const run = vi.fn<RunGit>(() => okResult('core.filemode\ntrue\0'))
    writeConfig(cwd, `${CLEAN_CONFIG}${'#'.repeat(MAX_CONFIG_BYTES - CLEAN_CONFIG.length + 1)}`)
    expect(refusedWith({ ...real, run })).toMatchObject({ code: 'config-too-large' })
    expect(run).not.toHaveBeenCalled()
    writeConfig(cwd, `${CLEAN_CONFIG}${'#'.repeat(MAX_CONFIG_BYTES - CLEAN_CONFIG.length)}`)
    expect(() => { inspectCloneState('seat-a', cwd, { ...real, run }) }).not.toThrow()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('refuses an unreadable config (eacces)', () => {
    expect(refusedWith({ ...real, fs: failingFs(join(cwd, '.git', 'config'),
      'EACCES') })).toMatchObject({ code: 'eacces' })
  })

  it('a hostile key buried past 64 KiB cannot be hidden by truncation: the file is refused first',
    () => {
      writeConfig(cwd, `${CLEAN_CONFIG}${'#'.repeat(70_000)}\n[core]\n\thookspath = /evil\n`)
      expect(refusedWith()).toMatchObject({ code: 'config-too-large' })
    })
})

describe('inspectCloneState: git failures all refuse (real spawn)', () => {
  it('refuses when the git binary does not exist', () => {
    expect(refusedWith({ ...real,
      gitPath: '/nonexistent/git' })).toMatchObject({ code: 'git-missing' })
  })

  it('refuses a git that is not executable', () => {
    const fake = join(box.root, 'git')
    writeFileSync(fake, '#!/bin/sh\n')
    chmodSync(fake, 0o644)
    expect(refusedWith({ ...real, gitPath: fake })).toMatchObject({ code: 'eacces' })
  })

  it('refuses a git that prints to stderr or exits non-zero', () => {
    const noisy = join(box.root, 'noisy-git')
    writeFileSync(noisy,
      '#!/bin/sh\necho "core.filemode\ntrue" >&2\nprintf "core.filemode\\ntrue\\0"\nexit 0\n')
    chmodSync(noisy, 0o755)
    expect(refusedWith({ ...real, gitPath: noisy })).toMatchObject({ code: 'git-stderr' })
    const failingGit = join(box.root, 'failing-git')
    writeFileSync(failingGit, '#!/bin/sh\nexit 3\n')
    chmodSync(failingGit, 0o755)
    expect(refusedWith({ ...real, gitPath: failingGit })).toMatchObject({ code: 'git-exit' })
  })

  it('refuses a git that prints something that is not NUL-terminated records', () => {
    const odd = join(box.root, 'odd-git')
    writeFileSync(odd, '#!/bin/sh\nprintf "core.filemode\\ntrue"\n')
    chmodSync(odd, 0o755)
    expect(refusedWith({ ...real, gitPath: odd })).toMatchObject({ code: 'parse' })
  })
})

describe('inspectCloneState: the allowlist, through real git', () => {
  const hostile: Array<[string, string, string, string]> = [
    ['core.hooksPath', '[core]\n\thooksPath = /tmp/hooks', 'config-key', 'core.hooksPath'],
    ['a relative core.hooksPath', '[core]\n\thooksPath = .githooks', 'config-key',
      'core.hooksPath'],
    ['core.fsmonitor', '[core]\n\tfsmonitor = /tmp/x', 'config-key', 'core.fsmonitor'],
    ['extensions.worktreeConfig', '[extensions]\n\tworktreeConfig = true', 'config-key',
      'extensions.worktreeconfig'],
    ['a filter driver', '[filter "x"]\n\tclean = /bin/true', 'config-key', 'filter.x.clean'],
    ['the dsh merge driver', '[merge "dsh-translation-pairing"]\n\tdriver = node x', 'config-key',
      'merge.dsh-translation-pairing.driver'],
    ['include.path', '[include]\n\tpath = /tmp/extra', 'config-key', 'include.path'],
    ['includeIf', '[includeIf "gitdir:/"]\n\tpath = /tmp/extra', 'config-key',
      'includeif.gitdir:/.path'],
    ['remote uploadpack', '[remote "o"]\n\tuploadpack = /bin/true', 'config-key',
      'remote.o.uploadpack'],
    ['core.gitProxy', '[core]\n\tgitProxy = /bin/true', 'config-key', 'core.gitproxy'],
    ['diff.external', '[diff]\n\texternal = /bin/true', 'config-key', 'diff.external'],
    ['credential.helper', '[credential]\n\thelper = !x', 'config-key', 'credential.helper'],
    ['protocol.ext.allow', '[protocol "ext"]\n\tallow = always', 'config-key',
      'protocol.ext.allow'],
    ['core.bare true', '[core]\n\tbare = true', 'config-value', 'core.bare'],
    ['core.bare as a bare boolean', '[core]\n\tbare', 'config-value', 'core.bare'],
    ['an ext:: url', '[remote "o"]\n\turl = ext::sh -c true', 'config-value', 'remote.o.url'],
    ['a fd:: url', '[remote "o"]\n\turl = fd::3', 'config-value', 'remote.o.url'],
    ['a file:// url', '[remote "o"]\n\turl = file:///srv/x', 'config-value', 'remote.o.url'],
    ['a branch remote with a path', '[branch "x"]\n\tremote = /tmp/evil', 'config-value',
      'branch.x.remote'],
  ]

  it.each(hostile)('refuses %s', (_label, text, code, key) => {
    writeConfig(cwd, `${CLEAN_CONFIG}${text}\n`)
    const error = refusedWith()
    expect(error.code).toBe(code)
    expect(error.reason.toLowerCase()).toContain(key.toLowerCase())
  })

  it('names the config path and carries the scrub commands in the remedy', () => {
    writeConfig(cwd, `${CLEAN_CONFIG}[core]\n\thooksPath = /x\n`)
    const error = refusedWith()
    expect(error.reason).toContain(join(cwd, '.git', 'config'))
    expect(error.reason).toContain(
      'pnpm install --offline --ignore-scripts --config.package-import-method=copy',
    )
    expect(error.reason).toContain('--unset-all')
    expect(error.reason).toContain('core.hooksPath=/dev/null')
    expect(error.seat).toBe('seat-a')
  })

  it('does not read an include target: the include key itself is the refusal', () => {
    writeFileSync(join(box.root, 'extra'), '[core]\n\tfilemode = false\n')
    writeConfig(cwd, `${CLEAN_CONFIG}[include]\n\tpath = ${join(box.root, 'extra')}\n`)
    expect(refusedWith()).toMatchObject({ code: 'config-key' })
  })

  it('accepts local, https, ssh and scp-style remotes and a user identity', () => {
    writeConfig(cwd, [
      CLEAN_CONFIG,
      '[remote "b"]\n\turl = https://example.com/x.git\n',
      '[remote "c"]\n\turl = git@example.com:x/y.git\n',
      '[user]\n\tname = A B\n\temail = a@b.c\n',
      '[init]\n\tdefaultBranch = main\n',
    ].join(''))
    const allow = ['/srv/', 'https://example.com/', 'git@example.com:x/y.git']
    expect(() => { inspectCloneState('seat-a', cwd, { ...real,
      remoteUrlAllow: allow }) }).not.toThrow()
  })
})

describe('inspectCloneState: remoteUrlAllow', () => {
  it('refuses a clean-looking clone whose remote is not covered, with the dedicated code', () => {
    writeConfig(cwd, CLEAN_CONFIG.replace('/srv/example.git', '/home/other/repo.git'))
    expect(refusedWith()).toMatchObject({ code: 'remote-url-not-allowed' })
  })

  it('fails closed on an empty list: even the source repository is refused', () => {
    expect(refusedWith({ ...real,
      remoteUrlAllow: [] })).toMatchObject({ code: 'remote-url-not-allowed' })
    expect(() => { assertCloneHookState(cwd) })
      .toThrow(expect.objectContaining({ code: 'remote-url-not-allowed' }))
  })

  it('accepts an exact entry', () => {
    expect(() => { inspectCloneState('seat-a', cwd, { ...real,
      remoteUrlAllow: ['/srv/example.git'] }) }).not.toThrow()
  })

  it('a clone with no remote passes with an empty list', () => {
    writeConfig(cwd, '[core]\n\trepositoryformatversion = 0\n')
    expect(() => { inspectCloneState('seat-a', cwd, { ...real,
      remoteUrlAllow: [] }) }).not.toThrow()
  })
})

describe('inspectCloneState: seat-controlled names never reach the text as typed', () => {
  it.each(['x;rm -rf ~', '$(id)', 'a`id`b', 'two words', 'new\nline'])('hook file %j', (name) => {
    writeFileSync(join(cwd, '.git', 'hooks', name), 'x')
    const error = refusedWith()
    expect(error.code).toBe('hook-entry')
    expect(error.reason).toContain('<unprintable name,')
    expect(error.reason).not.toContain(name)
    expect(error.reason).not.toContain('\n')
    expect(error.reason).toContain('find <clone>/.git/hooks -type f ! -name "*.sample" -delete')
  })

  it.each([
    ['$(id)', '[filter "$(id)"]\n\tclean = x'],
    ['x;rm -rf ~', '[remote "x;rm -rf ~"]\n\tuploadpack = x'],
    ['quote"it', '[alias "quote\\"it"]\n\tx = y'],
  ])('config key with subsection %j', (name, text) => {
    writeConfig(cwd, `${CLEAN_CONFIG}${text}\n`)
    const error = refusedWith()
    expect(error.code).toBe('config-key')
    expect(error.reason).toContain('<unprintable name,')
    expect(error.reason).not.toContain(name)
    expect(error.reason).not.toContain('\n')
  })

  it('a plain hook name still prints as it is', () => {
    addExecutableHook(cwd, 'pre-push')
    expect(refusedWith().reason).toContain(`${join(cwd, '.git', 'hooks')}/pre-push `)
  })

  it('an lstat error on an unprintable hook entry names the printable form too', () => {
    writeFileSync(join(cwd, '.git', 'hooks', '$(id)'), 'x')
    const fs: CloneFs = {
      ...realCloneFs,
      lstat: (p) => {
        if (p.endsWith('$(id)')) throw errorWithCode('EIO')
        return realCloneFs.lstat(p)
      },
    }
    const error = refusedWith({ ...real, fs })
    expect(error.code).toBe('fs-error')
    expect(error.reason).not.toContain('$(id)')
  })
})

describe('createCloneChecker: cadence', () => {
  const ctx = (seat = 'seat-a', where = cwd): { seat: string; cwd: string } => ({ seat,
    cwd: where })

  it('parses at the first query and not again while the fingerprint is unchanged', () => {
    const run = vi.fn<RunGit>(realRunGit)
    const checker = createCloneChecker({ ...real, run })
    checker.check(ctx())
    checker.check(ctx())
    checker.check(ctx())
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('re-parses when the config is rewritten and refuses a hostile rewrite', () => {
    const run = vi.fn<RunGit>(realRunGit)
    const checker = createCloneChecker({ ...real, run })
    checker.check(ctx())
    writeConfig(cwd, `${CLEAN_CONFIG}[core]\n\thooksPath = /evil\n`)
    expect(() => { checker.check(ctx()) }).toThrow(expect.objectContaining({ code: 'config-key' }))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never remembers a refusal: the same bad state is refused again, and a fix is accepted',
    () => {
      const run = vi.fn<RunGit>(realRunGit)
      const checker = createCloneChecker({ ...real, run })
      addExecutableHook(cwd, 'pre-commit')
      expect(() => { checker.check(ctx()) })
        .toThrow(expect.objectContaining({ code: 'hook-entry' }))
      expect(() => { checker.check(ctx()) })
        .toThrow(expect.objectContaining({ code: 'hook-entry' }))
      rmSync(join(cwd, '.git', 'hooks', 'pre-commit'))
      expect(() => { checker.check(ctx()) }).not.toThrow()
    })

  it('re-inspects after a clean pass when a hook appears', () => {
    const checker = createCloneChecker(real)
    checker.check(ctx())
    addExecutableHook(cwd, 'reference-transaction')
    expect(() => { checker.check(ctx()) }).toThrow(expect.objectContaining({ code: 'hook-entry' }))
  })

  it('re-parses on a cwd change and keeps seats apart', () => {
    const other = makeClone(box.root, 'other')
    const run = vi.fn<RunGit>(realRunGit)
    const checker = createCloneChecker({ ...real, run })
    checker.check(ctx('seat-a', cwd))
    checker.check(ctx('seat-b', other))
    expect(run).toHaveBeenCalledTimes(2)
    checker.check(ctx('seat-a', other))
    expect(run).toHaveBeenCalledTimes(3)
    checker.check(ctx('seat-b', other))
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('an unreadable entry is a changed fingerprint, never a pass', () => {
    const run = vi.fn<RunGit>(realRunGit)
    let broken = false
    const fs: CloneFs = {
      ...realCloneFs,
      lstat: (p) => { if (broken && p === join(cwd, '.git',
        'hooks')) throw errorWithCode('EACCES'); return realCloneFs.lstat(p) },
    }
    const checker = createCloneChecker({ ...real, run, fs })
    checker.check(ctx())
    broken = true
    expect(() => { checker.check(ctx()) }).toThrow(expect.objectContaining({ code: 'eacces' }))
  })

  it('refuses every query after dispose, with code disposed', () => {
    const checker = createCloneChecker(real)
    checker.check(ctx())
    checker.dispose()
    const error = ((): CloneCheckError | undefined => {
      try {
        checker.check(ctx())
      } catch (e: unknown) {
        return e as CloneCheckError
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(CloneCheckError)
    expect(error?.code).toBe('disposed')
  })
})

describe('assertCloneHookState', () => {
  it('passes a clean clone with the default git and refuses a dirty one', () => {
    expect(() => { assertCloneHookState(cwd, { remoteUrlAllow: ['/srv/'] }) }).not.toThrow()
    addExecutableHook(cwd, 'pre-push')
    expect(() => { assertCloneHookState(cwd,
      { remoteUrlAllow: ['/srv/'] }) }).toThrow(expect.objectContaining({ code: 'hook-entry',
      seat: 'host-git' }))
  })

  it('takes a seat name, a git path, a runner and a filesystem', () => {
    const run = vi.fn<RunGit>(() => okResult('core.filemode\ntrue\0'))
    expect(() => { assertCloneHookState(cwd, { seat: 'seat-z', gitPath: '/anything/git', run,
      fs: realCloneFs, remoteUrlAllow: [] }) }).not.toThrow()
    expect(run).toHaveBeenCalledWith('/anything/git', expect.any(Array))
    expect(() => { assertCloneHookState(join(box.root, 'nothing'),
      { seat: 'seat-z' }) }).toThrow(expect.objectContaining({ seat: 'seat-z' }))
  })

  it('refuses with git-missing when no candidate exists', () => {
    expect(() => { assertCloneHookState(cwd,
      { exists: () => false }) }).toThrow(expect.objectContaining({ code: 'git-missing' }))
  })

  it('picks the first candidate that exists', () => {
    const run = vi.fn<RunGit>(() => okResult('core.filemode\ntrue\0'))
    assertCloneHookState(cwd, { exists: path => path === '/usr/local/bin/git', run })
    expect(run).toHaveBeenCalledWith('/usr/local/bin/git', expect.any(Array))
  })
})

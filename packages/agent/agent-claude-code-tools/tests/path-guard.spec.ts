import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertCanonicalDir, assertCaseSensitiveEntries, checkGlob, checkPath, globStaticPrefix, isInside, reachesProtected, UnsafePathError,
} from '../src/path-guard.ts'
import type { GuardScope } from '../src/path-guard.ts'
import { makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let box: Sandbox
let scope: GuardScope

beforeEach(() => {
  box = makeSandbox()
  mkdirSync(join(box.cwd, 'src'))
  writeFileSync(join(box.cwd, 'src', 'a.ts'), 'a')
  scope = { cwd: box.cwd, allowedRoots: [box.cwd], deniedPrefixes: [join(box.cwd, '.git'), join(box.home, '.ssh')] }
})
afterEach(() => {
  box.cleanup()
})

function denied(verdict: ReturnType<typeof checkPath>): string {
  if (verdict.ok) throw new Error('expected a deny')
  return verdict.reason
}

describe('isInside', () => {
  it('compares whole segments', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/bb')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
    expect(isInside('/', '/a/b')).toBe(true)
  })
})

describe('assertCanonicalDir', () => {
  it('accepts a canonical directory', () => {
    expect(assertCanonicalDir('cwd', box.cwd)).toBe(box.cwd)
  })

  it.each(['*', '?', '[', ']', '!', '#', '{', '}', '\\', '(', ')', ' ', '\t', '\u0001'])('refuses the character %j', (char) => {
    expect(() => assertCanonicalDir('cwd', `${box.root}/x${char}y`)).toThrow(UnsafePathError)
  })

  it('refuses relative, unnormalised, root, missing and non-directory paths', () => {
    expect(() => assertCanonicalDir('cwd', 'proj')).toThrow(/absolute/)
    expect(() => assertCanonicalDir('cwd', `${box.cwd}/../proj`)).toThrow(/normalised/)
    expect(() => assertCanonicalDir('cwd', `${box.cwd}/`)).toThrow(/normalised/)
    expect(() => assertCanonicalDir('cwd', '/')).toThrow(/root/)
    expect(() => assertCanonicalDir('cwd', join(box.root, 'missing'))).toThrow(/cannot be resolved/)
    expect(() => assertCanonicalDir('cwd', join(box.outside, 'secret.txt'))).toThrow(/not a directory/)
  })

  it('refuses a symlinked (non-canonical) directory and names the subject', () => {
    const link = join(box.root, 'link')
    symlinkSync(box.cwd, link)
    expect(() => assertCanonicalDir('cwd', link)).toThrow(/not canonical/)
    try {
      assertCanonicalDir('home', link)
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(UnsafePathError)
      expect((error as UnsafePathError).subject).toBe('home')
      expect((error as UnsafePathError).path).toBe(link)
    }
  })
})

describe('checkPath', () => {
  it('passes existing, relative and new files inside the roots', () => {
    expect(checkPath(scope, join(box.cwd, 'src', 'a.ts'))).toEqual({ ok: true })
    expect(checkPath(scope, 'src/a.ts')).toEqual({ ok: true })
    expect(checkPath(scope, 'src/new.ts')).toEqual({ ok: true })
    expect(checkPath(scope, 'new-dir/deeper/new.ts')).toEqual({ ok: true })
    expect(checkPath(scope, box.cwd)).toEqual({ ok: true })
  })

  it('denies malformed values', () => {
    expect(denied(checkPath(scope, ''))).toMatch(/empty/)
    expect(denied(checkPath(scope, 'a\0b'))).toMatch(/NUL/)
    expect(denied(checkPath(scope, '~/.ssh/id_rsa'))).toMatch(/~/)
    expect(denied(checkPath(scope, 'src/../../outside/secret.txt'))).toMatch(/\.\./)
    expect(denied(checkPath(scope, `${box.cwd}/src/../a`))).toMatch(/\.\./)
  })

  it('denies absolute paths outside and the sibling /a/b vs /a/bb confusion', () => {
    expect(denied(checkPath(scope, join(box.outside, 'secret.txt')))).toMatch(/outside/)
    expect(denied(checkPath(scope, '/etc/passwd'))).toMatch(/outside/)
    const sibling = `${box.cwd}bb`
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'x'), 'x')
    expect(denied(checkPath(scope, join(sibling, 'x')))).toMatch(/outside/)
  })

  it('denies a symlink that leaves the cwd, for existing and new targets', () => {
    symlinkSync(join(box.outside, 'secret.txt'), join(box.cwd, 'leak'))
    symlinkSync(box.outside, join(box.cwd, 'outdir'))
    expect(denied(checkPath(scope, 'leak'))).toMatch(/outside/)
    expect(denied(checkPath(scope, 'outdir/secret.txt'))).toMatch(/outside/)
    expect(denied(checkPath(scope, 'outdir/new-file.txt'))).toMatch(/outside/)
  })

  it('allows a symlink that stays inside the cwd', () => {
    symlinkSync(join(box.cwd, 'src'), join(box.cwd, 'alias'))
    expect(checkPath(scope, 'alias/a.ts')).toEqual({ ok: true })
  })

  it('denies an existing hard-linked file but not a directory', () => {
    linkSync(join(box.outside, 'secret.txt'), join(box.cwd, 'hard'))
    expect(denied(checkPath(scope, 'hard'))).toMatch(/hard-linked/)
    expect(checkPath(scope, 'src')).toEqual({ ok: true })
  })

  it('denies protected prefixes by spelling, by symlink target and through a symlinked prefix', () => {
    mkdirSync(join(box.cwd, '.git'))
    writeFileSync(join(box.cwd, '.git', 'config'), 'c')
    expect(denied(checkPath(scope, '.git/config'))).toMatch(/protected/)
    expect(denied(checkPath(scope, '.git/new'))).toMatch(/protected/)
    symlinkSync(join(box.cwd, '.git'), join(box.cwd, 'gitlink'))
    expect(denied(checkPath(scope, 'gitlink/config'))).toMatch(/protected/)
    mkdirSync(join(box.cwd, 'secret'))
    writeFileSync(join(box.cwd, 'secret', 'x'), 'x')
    symlinkSync(join(box.cwd, 'secret'), join(box.cwd, 'prefix-link'))
    const viaLink: GuardScope = { ...scope, deniedPrefixes: [join(box.cwd, 'prefix-link')] }
    expect(denied(checkPath(viaLink, 'secret/x'))).toMatch(/protected/)
  })

  it('denies a dangling symlink, a symlink loop and an unusable allowed root', () => {
    symlinkSync(join(box.outside, 'not-there'), join(box.cwd, 'dangling'))
    symlinkSync(join(box.cwd, 'loop-b'), join(box.cwd, 'loop-a'))
    symlinkSync(join(box.cwd, 'loop-a'), join(box.cwd, 'loop-b'))
    expect(denied(checkPath(scope, 'dangling'))).toMatch(/dangling/)
    expect(denied(checkPath(scope, 'loop-a'))).toMatch(/cannot resolve/)
    expect(denied(checkPath({ ...scope, allowedRoots: [join(box.root, 'gone')] }, 'src/a.ts'))).toMatch(/outside/)
    expect(denied(checkPath({ ...scope, allowedRoots: [] }, 'src/a.ts'))).toMatch(/outside/)
  })

  it('treats a path below a regular file as a new path inside the root', () => {
    expect(checkPath(scope, 'src/a.ts/child')).toEqual({ ok: true })
  })
})

describe('checkGlob', () => {
  it('passes relative and absolute patterns whose fixed prefix is inside', () => {
    for (const pattern of ['**/*.ts', 'src/**', 'src/*.ts', 'a.ts', `${box.cwd}/**`, `${box.cwd}/src/*.ts`, '*.{ts,js}']) {
      expect(checkGlob(scope, pattern)).toEqual({ ok: true })
    }
  })

  it('denies malformed and escaping patterns', () => {
    expect(denied(checkGlob(scope, ''))).toMatch(/empty/)
    expect(denied(checkGlob(scope, 'a\0'))).toMatch(/NUL/)
    expect(denied(checkGlob(scope, '~/*'))).toMatch(/~/)
    expect(denied(checkGlob(scope, '../*'))).toMatch(/\.\./)
    expect(denied(checkGlob(scope, '{src,../outside}/*'))).toMatch(/\.\./)
    expect(denied(checkGlob(scope, '/etc/**'))).toMatch(/outside/)
    expect(denied(checkGlob(scope, '/**'))).toMatch(/outside/)
    expect(denied(checkGlob(scope, `${box.outside}/*.txt`))).toMatch(/outside/)
  })

  it('denies a pattern that goes through a symlink out of the cwd', () => {
    symlinkSync(box.outside, join(box.cwd, 'outdir'))
    expect(denied(checkGlob(scope, 'outdir/**'))).toMatch(/outside/)
  })
})

describe('checkGlob alternatives', () => {
  it.each([
    '{/etc/passwd,x}', '@(/etc/x|y)', '{a,/etc/x}', '+(a|/b)', '{a,~/x}', '!(a|~b)', '{src/a,src/b}/*', '@(a/b|c)', '{a,{b/c,d}}',
  ])('denies the group trick %s', (pattern) => {
    expect(checkGlob(scope, pattern).ok).toBe(false)
  })

  it('keeps ordinary groups and brackets working', () => {
    for (const pattern of ['**/*.{ts,js}', 'src/@(a|b).ts', 'a)/b', '{a,b}', 'src/[ab]/x']) {
      expect(checkGlob(scope, pattern)).toEqual({ ok: true })
    }
  })

  it('documents that a symlinked directory behind a leading group is judged by the tool, not the guard', () => {
    symlinkSync(box.outside, join(box.cwd, 'lnk'))
    expect(checkGlob(scope, '{lnk,x}/*')).toEqual({ ok: true })
    expect(denied(checkGlob(scope, 'lnk/*'))).toMatch(/outside/)
  })

  it('computes the static prefix', () => {
    expect(globStaticPrefix('/a/b/*.ts')).toBe('/a/b')
    expect(globStaticPrefix('/**')).toBe('/')
    expect(globStaticPrefix('**/x')).toBe('.')
    expect(globStaticPrefix('src/lib/x.ts')).toBe('src/lib/x.ts')
  })
})

describe('reachesProtected', () => {
  it('finds an existing protected location below the directory only', () => {
    mkdirSync(join(box.cwd, '.git'))
    expect(reachesProtected(scope, '.')).toBe(join(box.cwd, '.git'))
    expect(reachesProtected(scope, box.cwd)).toBe(join(box.cwd, '.git'))
    expect(reachesProtected(scope, '/')).toBe(join(box.cwd, '.git'))
    expect(reachesProtected(scope, 'src')).toBeUndefined()
    expect(reachesProtected(scope, '.git')).toBe(join(box.cwd, '.git'))
  })

  it('ignores protected locations that do not exist and directories that cannot be resolved', () => {
    expect(reachesProtected(scope, '.')).toBeUndefined()
    symlinkSync(join(box.cwd, 'loop-b'), join(box.cwd, 'loop-a'))
    symlinkSync(join(box.cwd, 'loop-a'), join(box.cwd, 'loop-b'))
    expect(reachesProtected(scope, 'loop-a')).toBeUndefined()
  })
})

describe('assertCaseSensitiveEntries', () => {
  it('passes on a case-sensitive filesystem with and without the entries', () => {
    expect(() => { assertCaseSensitiveEntries(box.cwd, ['.git', '.husky']) }).not.toThrow()
    mkdirSync(join(box.cwd, '.git'))
    expect(() => { assertCaseSensitiveEntries(box.cwd, ['.git', '.husky']) }).not.toThrow()
  })

  it('refuses when an existing entry also answers to its upper-case name', () => {
    expect(() => { assertCaseSensitiveEntries(box.cwd, ['.git'], () => ({})) }).toThrow(/case-insensitive filesystem/)
  })

  it('continues when only the entry exists or neither does', () => {
    const onlyLower = (path: string): unknown => {
      if (path.endsWith('.GIT')) throw new Error('ENOENT')
      return {}
    }
    expect(() => { assertCaseSensitiveEntries(box.cwd, ['.git'], onlyLower) }).not.toThrow()
    expect(() => { assertCaseSensitiveEntries(box.cwd, ['.git'], () => { throw new Error('ENOENT') }) }).not.toThrow()
  })
})

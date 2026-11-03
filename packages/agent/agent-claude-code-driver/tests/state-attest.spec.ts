import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertBinaryUnchanged, attestClaudePath, BinaryPins, sha256File } from '../src/attest.ts'
import { assertPrivateFile, currentUid, ensurePrivateDir, resolveStateDir, writeAtomic } from '../src/state.ts'
import { cleanTempDirs, fakeClaudeBinary, tempDir } from './fakes.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  cleanTempDirs()
})

const otherUid = (): number => (process.getuid?.() ?? 0) + 1

describe('state directory resolution', () => {
  it('puts a relative name under the harness home and accepts an absolute path already inside it', () => {
    const home = tempDir('cc-home-')
    expect(resolveStateDir('claude-code', home)).toBe(join(home, 'claude-code'))
    expect(resolveStateDir(join(home, 'a', 'b'), home)).toBe(join(home, 'a', 'b'))
  })

  it('refuses the home itself, a path that escapes it, and an absolute path elsewhere', () => {
    const home = tempDir('cc-home-')
    for (const bad of ['.', '', '..', '../elsewhere', 'a/../../x', '/etc', join(home, '..', 'x')]) {
      expect(() => resolveStateDir(bad, home)).toThrow(/must name a subdirectory of the harness home/)
    }
  })

  it('defaults the home to $DSH_HOME, then to ~/.dsh', () => {
    const home = tempDir('cc-home-')
    vi.stubEnv('DSH_HOME', home)
    expect(resolveStateDir('state')).toBe(join(home, 'state'))
    vi.stubEnv('DSH_HOME', undefined)
    expect(resolveStateDir('state')).toBe(join(homedir(), '.dsh', 'state'))
  })
})

describe('private state files', () => {
  it('creates a 0700 directory and accepts it again', () => {
    const dir = join(tempDir(), 'a', 'b')
    ensurePrivateDir(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    ensurePrivateDir(dir)
  })

  it('refuses a symlinked, foreign-owned, or open directory', () => {
    const base = tempDir()
    const real = join(base, 'real')
    mkdirSync(real, { mode: 0o700 })
    symlinkSync(real, join(base, 'link'))
    expect(() => { ensurePrivateDir(join(base, 'link')) }).toThrow(/not a real directory/)
    expect(() => { ensurePrivateDir(real, otherUid()) }).toThrow(/owned by uid/)
    chmodSync(real, 0o750)
    expect(() => { ensurePrivateDir(real) }).toThrow(/accessible by group or others \(mode 750\)/)
  })

  it('checks an existing file: missing passes, symlink, foreign owner and open mode refuse, other lstat errors rethrow', () => {
    const base = tempDir()
    const file = join(base, 'f.json')
    assertPrivateFile(file)
    writeFileSync(file, '[]', { mode: 0o600 })
    assertPrivateFile(file)
    symlinkSync(file, join(base, 'link.json'))
    expect(() => { assertPrivateFile(join(base, 'link.json')) }).toThrow(/not a regular file/)
    expect(() => { assertPrivateFile(file, otherUid()) }).toThrow(/owned by uid/)
    chmodSync(file, 0o640)
    expect(() => { assertPrivateFile(file) }).toThrow(/accessible by group or others \(mode 640\)/)
    expect(() => { assertPrivateFile(join(file, 'inside')) }).toThrow(/ENOTDIR/)
  })

  it('skips ownership checks where the platform has no user id', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(undefined as never)
    expect(currentUid()).toBeUndefined()
    const base = tempDir()
    ensurePrivateDir(join(base, 'd'))
    const file = join(base, 'f')
    writeFileSync(file, 'x', { mode: 0o600 })
    assertPrivateFile(file)
  })

  it('writes atomically through an exclusive temporary file and never follows a planted symlink', () => {
    const base = tempDir()
    const file = join(base, 'state.json')
    writeAtomic(file, 'one\n')
    writeAtomic(file, 'two\n')
    expect(readFileSync(file, 'utf8')).toBe('two\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(base)).toEqual(['state.json'])
    const victim = join(base, 'victim')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, `${file}.${process.pid}.deadbeef.tmp`)
    writeAtomic(file, 'three\n')
    expect(readFileSync(victim, 'utf8')).toBe('keep')
  })
})

describe('binary attestation', () => {
  it('accepts a private executable and reports its hash and stat signature', () => {
    const file = fakeClaudeBinary('#!/bin/sh\necho hi\n')
    const attestation = attestClaudePath(file)
    expect(attestation.sha256).toBe(sha256File(file))
    expect(attestation.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(attestation.realPath).toBe(file)
    expect(attestation.size).toBe(statSync(file).size)
    assertBinaryUnchanged(attestation)
    appendFileSync(file, '# changed\n')
    expect(() => { assertBinaryUnchanged(attestation) }).toThrow(/changed since this host attested it/)
  })

  it('accepts a binary in a sticky world-writable directory but not in a plain world-writable one', () => {
    const file = fakeClaudeBinary()
    const dir = join(file, '..')
    chmodSync(dir, 0o1777)
    expect(attestClaudePath(file).realPath).toBe(file)
    chmodSync(dir, 0o777)
    expect(() => attestClaudePath(file)).toThrow(/its directory .* is group- or world-writable \(mode 777\)/)
    chmodSync(dir, 0o770)
    expect(() => attestClaudePath(file)).toThrow(/group- or world-writable/)
    chmodSync(dir, 0o700)
  })

  it('refuses scripts, non-files, foreign owners, writable and non-executable files, and unresolvable paths', () => {
    const file = fakeClaudeBinary()
    const dir = join(file, '..')
    const script = join(dir, 'cli.js')
    copyFileSync(file, script)
    chmodSync(script, 0o700)
    expect(() => attestClaudePath(script)).toThrow(/is a script/)
    const linked = join(dir, 'claude-link')
    symlinkSync(script, linked)
    expect(() => attestClaudePath(linked)).toThrow(/is a script/)
    for (const name of ['run.sh', 'tool.py', 'x.mjs', 'y.cjs', 'Z.JS']) {
      const named = join(dir, name)
      copyFileSync(file, named)
      expect(() => attestClaudePath(named)).toThrow(/is a script/)
    }
    expect(() => attestClaudePath(dir)).toThrow(/not a regular file/)
    expect(() => attestClaudePath(file, { uid: otherUid() })).toThrow(/is owned by uid/)
    expect(attestClaudePath(file, { uid: undefined }).sha256).toHaveLength(64)
    chmodSync(file, 0o720)
    expect(() => attestClaudePath(file)).toThrow(/group- or world-writable; run chmod go-w/)
    chmodSync(file, 0o600)
    expect(() => attestClaudePath(file)).toThrow(/not executable/)
    expect(() => attestClaudePath(join(dir, 'missing'))).toThrow(/cannot resolve it \(ENOENT\)/)
  })
})

describe('binary pins', () => {
  const sha = (char: string): string => char.repeat(64)

  it('records the first-seen hash, accepts it again, and refuses a change with the re-pin remedy', () => {
    const dir = tempDir()
    const pins = new BinaryPins(dir)
    pins.enforce('seat', sha('a'), undefined)
    expect(statSync(join(dir, 'claude-code-binary-pins.json')).mode & 0o777).toBe(0o600)
    pins.enforce('seat', sha('a'), undefined)
    expect(() => { pins.enforce('seat', sha('b'), undefined) })
      .toThrow(new RegExp(`seat "seat": the claude binary changed \\(first seen ${sha('a')}, now ${sha('b')}\\).*claude_path_sha256: ${sha('b')}`))
    const again = new BinaryPins(dir)
    expect(() => { again.enforce('seat', sha('b'), undefined) }).toThrow(/binary changed/)
    again.enforce('other', sha('b'), undefined)
  })

  it('lets an explicit pin that matches the file re-pin, and refuses one that does not', () => {
    const dir = tempDir()
    const pins = new BinaryPins(dir)
    pins.enforce('seat', sha('a'), undefined)
    expect(() => { pins.enforce('seat', sha('b'), sha('c')) }).toThrow(/SHA-256 is b+ but claude_path_sha256 pins c+/)
    pins.enforce('seat', sha('b'), sha('b'))
    new BinaryPins(dir).enforce('seat', sha('b'), undefined)
    expect(() => { new BinaryPins(dir).enforce('seat', sha('a'), undefined) }).toThrow(/binary changed/)
  })

  it('refuses an unreadable or malformed pin file, an open one, and ignores non-string pins', () => {
    const dir = tempDir()
    const file = join(dir, 'claude-code-binary-pins.json')
    writeFileSync(file, '{broken', { mode: 0o600 })
    expect(() => new BinaryPins(dir)).toThrow(/binary pin file .* is unreadable/)
    writeFileSync(file, '[]')
    expect(() => new BinaryPins(dir)).toThrow(/is unreadable \(not an object\)/)
    writeFileSync(file, JSON.stringify({ good: sha('a'), bad: 5 }))
    const pins = new BinaryPins(dir)
    expect(() => { pins.enforce('good', sha('b'), undefined) }).toThrow(/binary changed/)
    pins.enforce('bad', sha('c'), undefined)
    chmodSync(file, 0o644)
    expect(() => new BinaryPins(dir)).toThrow(/accessible by group or others/)
  })
})

describe('symlink retargeting and change time (review 5)', () => {
  function linked() {
    const target = fakeClaudeBinary('#!/bin/sh\necho one\n')
    const other = fakeClaudeBinary('#!/bin/sh\necho two\n')
    const linkDir = tempDir('cc-link-')
    chmodSync(linkDir, 0o700)
    const link = join(linkDir, 'claude')
    symlinkSync(target, link)
    return { target, other, link, linkDir }
  }

  it('attests the resolved file behind a symlink and refuses once the link points elsewhere', () => {
    const { target, other, link, linkDir } = linked()
    const attestation = attestClaudePath(link)
    expect(attestation.realPath).toBe(target)
    expect(attestation.path).toBe(link)
    assertBinaryUnchanged(attestation)
    rmSync(link)
    symlinkSync(other, join(linkDir, 'claude'))
    expect(() => { assertBinaryUnchanged(attestation) }).toThrow(/changed since this host attested it/)
  })

  it('refuses when the configured path no longer resolves at all', () => {
    const { link } = linked()
    const attestation = attestClaudePath(link)
    rmSync(link)
    expect(() => { assertBinaryUnchanged(attestation) }).toThrow(/changed since this host attested it/)
  })

  it('refuses when only the change time moved (a chmod keeps size, mtime and inode)', () => {
    const file = fakeClaudeBinary()
    const attestation = attestClaudePath(file)
    chmodSync(file, 0o500)
    chmodSync(file, 0o700)
    expect(statSync(file).ctimeMs).not.toBe(attestation.ctimeMs)
    expect(() => { assertBinaryUnchanged(attestation) }).toThrow(/changed since this host attested it/)
  })
})

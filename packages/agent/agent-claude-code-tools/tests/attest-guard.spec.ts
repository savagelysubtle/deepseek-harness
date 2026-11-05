import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertAttestedUnchanged, attestFile } from '../src/attest-guard.ts'
import { makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let box: Sandbox
let script: string
const uid = process.getuid?.() ?? 0

beforeEach(() => {
  box = makeSandbox()
  script = join(box.root, 'guard.js')
  writeFileSync(script, 'console.log(1)\n', { mode: 0o755 })
})
afterEach(() => {
  box.cleanup()
})

describe('attestFile', () => {
  it('attests a clean executable and a clean readable script', () => {
    const exec = attestFile(script, { access: 'exec' })
    expect(exec.realPath).toBe(script)
    expect(exec.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(attestFile(script, { access: 'read', expectedSha256: exec.sha256 }).sha256).toBe(exec.sha256)
  })

  it('accepts a root-owned system binary reached through a symlink when the operator is the owner', () => {
    const link = join(box.root, 'env-link')
    symlinkSync('/usr/bin/env', link)
    expect(attestFile(link, { access: 'exec' }).realPath).toMatch(/env$/)
  })

  it('skips owner checks when no uid is known', () => {
    expect(attestFile(script, { access: 'exec', uid: undefined }).path).toBe(script)
  })

  it('refuses bad files with a named reason', () => {
    expect(() => attestFile('guard.js', { access: 'exec' })).toThrow(/absolute/)
    expect(() => attestFile(join(box.root, 'missing'), { access: 'exec' })).toThrow(/cannot resolve/)
    expect(() => attestFile(box.cwd, { access: 'exec' })).toThrow(/regular file/)
    expect(() => attestFile(script, { access: 'exec', uid: uid + 1 })).toThrow(/owned by uid/)
    const writable = join(box.root, 'writable.js')
    writeFileSync(writable, 'x', { mode: 0o666 })
    chmodSync(writable, 0o666)
    expect(() => attestFile(writable, { access: 'exec' })).toThrow(/writable/)
    const plain = join(box.root, 'plain.js')
    writeFileSync(plain, 'x', { mode: 0o644 })
    expect(() => attestFile(plain, { access: 'exec' })).toThrow(/not executable/)
    const writeOnly = join(box.root, 'write-only.js')
    writeFileSync(writeOnly, 'x', { mode: 0o200 })
    expect(() => attestFile(writeOnly, { access: 'read' })).toThrow(/not readable/)
    expect(() => attestFile(script, { access: 'exec', expectedSha256: '0'.repeat(64) })).toThrow(/pinned/)
  })

  it('refuses a file under a group- or world-writable directory and a directory owned by someone else', () => {
    const open = join(box.root, 'open')
    mkdirSync(open)
    copyFileSync(script, join(open, 'guard.js'))
    chmodSync(join(open, 'guard.js'), 0o755)
    chmodSync(open, 0o777)
    expect(() => attestFile(join(open, 'guard.js'), { access: 'exec' })).toThrow(/directory .* is group- or world-writable/)
    chmodSync(open, 0o700)
    const link = join(box.root, 'env-link')
    symlinkSync('/usr/bin/env', link)
    expect(() => attestFile(link, { access: 'exec', uid: uid + 1 })).toThrow(/directory .* is owned by uid/)
  })
})

describe('attestFile private-group relaxation', () => {
  const me = userInfo()
  let passwd: string
  let group: string
  let file: string

  /** A file whose group bit is writable and whose gid is the real gid of the sandbox files. */
  function groupWritable(): number {
    file = join(box.root, 'gw.js')
    writeFileSync(file, 'x', { mode: 0o775 })
    chmodSync(file, 0o775)
    return statSync(file).gid
  }
  function databases(gid: number, groupLine: string, extraPasswd = ''): { passwdPath: string; groupPath: string } {
    passwd = join(box.root, 'passwd')
    group = join(box.root, 'group')
    writeFileSync(passwd, `# comment\n\n${me.username}:x:${me.uid}:${gid}::/home:/bin/sh\n${extraPasswd}`)
    writeFileSync(group, groupLine)
    return { passwdPath: passwd, groupPath: group }
  }

  it('accepts a group-writable file in the owner private group (name equals user, no other member)', () => {
    const gid = groupWritable()
    expect(attestFile(file, { access: 'exec', ...databases(gid, `${me.username}:x:${gid}:\n`) }).path).toBe(file)
    expect(attestFile(file, { access: 'exec', ...databases(gid, `${me.username}:x:${gid}:${me.username}\n`) }).path).toBe(file)
  })

  it('refuses a second group member, a differently named group, another primary-group user or an unknown gid', () => {
    const gid = groupWritable()
    expect(attestFile(file, { access: 'exec', ...databases(gid, `${me.username}:x:${gid}\n`) }).path).toBe(file)
    expect(() => attestFile(file, { access: 'exec', ...databases(gid, `${me.username}:x:${gid}:${me.username},other\n`) })).toThrow(/group- or world-writable/)
    expect(() => attestFile(file, { access: 'exec', ...databases(gid, `shared:x:${gid}:\n`) })).toThrow(/group- or world-writable/)
    expect(() => attestFile(file, { access: 'exec', ...databases(gid, `${me.username}:x:${gid}:\n`, `other:x:${me.uid + 1}:${gid}::/h:/bin/sh\n`) })).toThrow(/group- or world-writable/)
    expect(() => attestFile(file, { access: 'exec', ...databases(gid, `${me.username}:x:${gid + 1}:\n`) })).toThrow(/group- or world-writable/)
  })

  it('refuses when the group database cannot be read, and for an owner that is not the running user', () => {
    const gid = groupWritable()
    const paths = databases(gid, `${me.username}:x:${gid}:\n`)
    expect(() => attestFile(file, { access: 'exec', passwdPath: paths.passwdPath, groupPath: join(box.root, 'no-group') })).toThrow(/group- or world-writable/)
    expect(() => attestFile(file, { access: 'exec', uid: undefined, ...paths })).toThrow(/group- or world-writable/)
  })

  it('refuses world-writable regardless of the group', () => {
    const gid = groupWritable()
    chmodSync(file, 0o777)
    expect(() => attestFile(file, { access: 'exec', ...databases(gid, `${me.username}:x:${gid}:\n`) })).toThrow(/group- or world-writable/)
  })

  it('applies to the directory chain too', () => {
    const gid = groupWritable()
    const dir = join(box.root, 'gdir')
    mkdirSync(dir)
    copyFileSync(file, join(dir, 'guard.js'))
    chmodSync(join(dir, 'guard.js'), 0o755)
    chmodSync(dir, 0o770)
    expect(() => attestFile(join(dir, 'guard.js'), { access: 'exec', passwdPath: join(box.root, 'none') })).toThrow(/directory .* is group- or world-writable/)
    expect(attestFile(join(dir, 'guard.js'), { access: 'exec', ...databases(gid, `${me.username}:x:${gid}:\n`) }).path).toBe(join(dir, 'guard.js'))
  })
})

describe('assertAttestedUnchanged', () => {
  it('passes for an untouched file and fails after a change', () => {
    const attested = attestFile(script, { access: 'exec' })
    expect(() => { assertAttestedUnchanged(attested) }).not.toThrow()
    writeFileSync(script, 'console.log(2222)\n')
    expect(() => { assertAttestedUnchanged(attested) }).toThrow(/changed since/)
  })

  it('fails when a symlink is retargeted or removed', () => {
    const other = join(box.root, 'other.js')
    writeFileSync(other, 'x', { mode: 0o755 })
    const link = join(box.root, 'link.js')
    symlinkSync(script, link)
    const attested = attestFile(link, { access: 'exec' })
    unlinkSync(link)
    symlinkSync(other, link)
    expect(() => { assertAttestedUnchanged(attested) }).toThrow(/changed since/)
    rmSync(link)
    expect(() => { assertAttestedUnchanged(attested) }).toThrow(/changed since/)
  })
})

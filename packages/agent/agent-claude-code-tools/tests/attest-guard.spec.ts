import { chmodSync, copyFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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

import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serializePolicy, writePolicyFile } from '../src/policy-file.ts'
import { readPolicyFile, validatePolicy } from '../src/policy-read.ts'
import { coderPolicy, makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let box: Sandbox
let dir: string

beforeEach(() => {
  box = makeSandbox()
  dir = join(box.root, 'state', 'policy')
})
afterEach(() => {
  box.cleanup()
})

describe('writePolicyFile', () => {
  it('writes atomically, creates the directory privately and returns the hash of the bytes', () => {
    const policy = coderPolicy(box)
    const written = writePolicyFile(dir, policy)
    expect(written.path).toBe(join(dir, 'coder-one.json'))
    const bytes = readFileSync(written.path)
    expect(bytes.toString('utf8')).toBe(serializePolicy(policy))
    expect(written.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(written.path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['coder-one.json'])
    expect(readPolicyFile(written.path, 'coder-one', written.sha256)).toEqual({ ok: true, policy })
  })

  it('replaces an earlier file and ignores a stray partial temp file', () => {
    const first = writePolicyFile(dir, coderPolicy(box))
    writeFileSync(join(dir, '.coder-one.1.deadbeef.tmp'), '{"v":1,"seat":')
    const second = writePolicyFile(dir, coderPolicy(box, ['Read']))
    expect(second.sha256).not.toBe(first.sha256)
    expect(readPolicyFile(second.path, 'coder-one', second.sha256).ok).toBe(true)
    expect(readPolicyFile(second.path, 'coder-one', first.sha256)).toEqual({ ok: false, reason: 'policy file hash does not match the host record' })
  })

  it('refuses a seat name that could traverse or is malformed', () => {
    for (const seat of ['../evil', 'a/b', 'A', '', 'x'.repeat(33), '1abc']) {
      expect(() => writePolicyFile(dir, { ...coderPolicy(box), seat })).toThrow(/valid seat name/)
    }
  })

  it('refuses an invalid policy', () => {
    expect(() => writePolicyFile(dir, { ...coderPolicy(box), role: 'god' as never })).toThrow(/invalid policy/)
  })

  it('throws when the directory is not writable', () => {
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o500)
    try {
      expect(() => writePolicyFile(dir, coderPolicy(box))).toThrow()
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('throws and leaves no temp file when the final rename fails', () => {
    mkdirSync(join(dir, 'coder-one.json'), { recursive: true })
    expect(() => writePolicyFile(dir, coderPolicy(box))).toThrow()
    expect(readdirSync(dir)).toEqual(['coder-one.json'])
  })
})

describe('readPolicyFile and validatePolicy', () => {
  function put(content: string): { path: string; sha: string } {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'coder-one.json')
    writeFileSync(path, content)
    return { path, sha: createHash('sha256').update(content).digest('hex') }
  }

  it('denies a missing file', () => {
    expect(readPolicyFile(join(dir, 'nope.json'), 'coder-one', '0'.repeat(64))).toEqual({ ok: false, reason: 'policy file unreadable (ENOENT)' })
  })

  it('denies corrupt JSON, another version, another seat and a bad shape (each with a matching hash)', () => {
    const good = JSON.parse(serializePolicy(coderPolicy(box))) as Record<string, unknown>
    const cases: [string, string][] = [
      ['{"v":1,', 'not valid JSON'],
      [JSON.stringify({ ...good, v: 2 }), 'version 2 is not supported'],
      [JSON.stringify({ ...good, seat: 'other' }), 'different seat'],
      [JSON.stringify({ ...good, role: 'mail-only' }), 'role'],
    ]
    for (const [content, expected] of cases) {
      const { path, sha } = put(content)
      const result = readPolicyFile(path, 'coder-one', sha)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.reason).toContain(expected)
    }
  })

  it.each([
    [null, 'not an object'],
    [[], 'not an object'],
    ['x', 'not an object'],
    [{ v: 1, seat: 'Bad', role: 'lead', cwd: '/a', allowedRoots: [], deniedPrefixes: [], tools: [] }, 'seat'],
    [{ v: 1, seat: 'a', role: 'lead', cwd: 'rel', allowedRoots: [], deniedPrefixes: [], tools: [] }, 'cwd'],
    [{ v: 1, seat: 'a', role: 'lead', cwd: 3, allowedRoots: [], deniedPrefixes: [], tools: [] }, 'cwd'],
    [{ v: 1, seat: 'a', role: 'lead', cwd: '/a', allowedRoots: 'x', deniedPrefixes: [], tools: [] }, 'allowedRoots'],
    [{ v: 1, seat: 'a', role: 'lead', cwd: '/a', allowedRoots: ['rel'], deniedPrefixes: [], tools: [] }, 'allowedRoots'],
    [{ v: 1, seat: 'a', role: 'lead', cwd: '/a', allowedRoots: [], deniedPrefixes: [''], tools: [] }, 'deniedPrefixes'],
    [{ v: 1, seat: 'a', role: 'lead', cwd: '/a', allowedRoots: [], deniedPrefixes: ['/b'], tools: [1] }, 'tools'],
  ])('validatePolicy rejects %j', (value, fragment) => {
    const result = validatePolicy(value)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain(fragment)
  })

  it('validatePolicy accepts a lead policy with empty lists', () => {
    const lead = { v: 1, seat: 'lead-1', role: 'lead', cwd: '/a', allowedRoots: [], deniedPrefixes: ['/b'], tools: ['mcp__dsh__x'] }
    expect(validatePolicy(lead)).toEqual({ ok: true, policy: lead })
  })
})

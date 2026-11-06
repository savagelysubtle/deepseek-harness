import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CloneCheckError } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfigRecords, printableName, readGitConfig, realRunGit,
  refusal } from '../src/git-config.ts'
import type { RunGit } from '../src/git-config.ts'
import { CLEAN_CONFIG, errorWithCode, failing, GIT, okResult, tempRoot } from './helpers.ts'
import type { TempRoot } from './helpers.ts'

let box: TempRoot
beforeEach(() => { box = tempRoot() })
afterEach(() => {
  vi.unstubAllEnvs()
  box.cleanup()
})

function code(run: RunGit): string {
  try {
    readGitConfig('s', GIT, '/x/.git/config', run)
  } catch (error: unknown) {
    if (error instanceof CloneCheckError) return error.code
    throw error
  }
  return 'granted'
}

describe('readGitConfig: grants only a clean run', () => {
  it('passes the exact argument vector to the injected runner', () => {
    const run = vi.fn<RunGit>(() => okResult('core.filemode\ntrue\0'))
    expect(readGitConfig('s', GIT, '/x/.git/config', run)).toEqual([{ key: 'core.filemode',
      value: 'true' }])
    expect(run).toHaveBeenCalledWith(GIT, ['config', '--file', '/x/.git/config', '--list', '-z',
      '--no-includes'])
  })

  it('grants a plain successful run', () => {
    expect(code(failing({}))).toBe('granted')
  })
})

describe('readGitConfig: every other outcome refuses with its own code', () => {
  it.each([
    ['ENOENT', 'git-missing'], ['EACCES', 'eacces'], ['EPERM', 'eacces'], ['ETIMEDOUT', 'timeout'],
    ['ENOBUFS', 'enobufs'], ['EIO', 'git-error'],
  ])('spawn error %s -> %s', (errno, expected) => {
    expect(code(failing({ error: errorWithCode(errno) }))).toBe(expected)
  })

  it('maps an error without a code to git-error and names its message', () => {
    expect(() => readGitConfig('s', GIT, '/x/.git/config', failing({ error: errorWithCode(undefined,
      'weird') }))).toThrow('weird')
  })

  it('an error wins even when status and output look fine', () => {
    expect(code(failing({ error: errorWithCode('ETIMEDOUT'), status: 0 }))).toBe('timeout')
  })

  it('refuses a signal', () => {
    expect(code(failing({ signal: 'SIGKILL', status: null }))).toBe('git-signal')
  })

  it.each([1, 128, null])('refuses status %s', (status) => {
    expect(code(failing({ status }))).toBe('git-exit')
  })

  it('refuses any stderr, even with status 0 and good output', () => {
    expect(code(failing({ stderr: 'warning: x' }))).toBe('git-stderr')
  })

  it('refuses unparsable output', () => {
    expect(code(failing({ stdout: '' }))).toBe('parse')
    expect(code(failing({ stdout: 'core.filemode\ntrue' }))).toBe('parse')
  })

  it('every refusal is a CloneCheckError carrying the seat, a code and a remedy', () => {
    try {
      readGitConfig('seat-a', GIT, '/x/.git/config', failing({ status: 1 }))
      expect.unreachable()
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CloneCheckError)
      const refused = error as CloneCheckError
      expect(refused.seat).toBe('seat-a')
      expect(refused.reason).toContain('Remedy')
      expect(refused.reason).toContain('agent-claude-code-seat-checks:')
    }
    expect(refusal('s', 'c', 'what', 'Remedy: x').reason).toBe('what. Remedy: x')
  })
})

describe('printableName', () => {
  it.each(['pre-commit', 'remote.origin.url', 'a/b@c+d=e:f-g_h'.replace('_',
    '.')])('prints %s as it is', (name) => {
    expect(printableName(name)).toBe(name)
  })

  it.each(['x;rm -rf ~', '$(id)', 'a b', 'a\nb', 'a`b`', 'caf\u00e9',
    ''])('replaces %j by a byte count and hex', (name) => {
    const shown = printableName(name)
    expect(shown).toMatch(/^<unprintable name, \d+ bytes, hex [0-9a-f]*(\.\.\.)?; do not paste it/)
    expect(shown).not.toMatch(/[;$`\n ](rm|\(id\))/)
    expect(shown).not.toContain('\n')
  })

  it('cuts a long name to 32 bytes of hex and says so', () => {
    const shown = printableName(`${'a'.repeat(40)} b`)
    expect(shown).toContain('42 bytes')
    expect(shown).toContain(`${'61'.repeat(32)}...`)
  })
})

describe('parseConfigRecords', () => {
  it('says "empty config" for empty output and "not NUL-terminated" for a cut-off one', () => {
    expect(() => parseConfigRecords('s', '')).toThrow('an empty config')
    expect(() => parseConfigRecords('s', 'a.b\nc')).toThrow('not NUL-terminated')
  })

  it('splits on the first newline only, so a value may hold newlines', () => {
    expect(parseConfigRecords('s', 'user.name\nA\nB\0core.filemode\ntrue\0')).toEqual([
      { key: 'user.name', value: 'A\nB' }, { key: 'core.filemode', value: 'true' },
    ])
  })

  it('reads a key without a newline as a bare boolean', () => {
    expect(parseConfigRecords('s', 'core.bare\0')).toEqual([{ key: 'core.bare', value: undefined }])
  })

  it('keeps an empty value distinct from a bare boolean', () => {
    expect(parseConfigRecords('s', 'core.bare\n\0')).toEqual([{ key: 'core.bare', value: '' }])
  })

  it.each([
    ['no final NUL', 'a.b\nc'],
    ['replacement character', 'a.b\nc\uFFFD\0'],
    ['empty key', '\nvalue\0'],
    ['empty record', 'a.b\nc\0\0'],
  ])('refuses %s with code parse', (_label, stdout) => {
    expect(() => parseConfigRecords('s',
      stdout)).toThrow(expect.objectContaining({ code: 'parse' }))
  })
})

describe('realRunGit', () => {
  it('reports a missing binary as a spawn error with empty output', () => {
    const result = realRunGit('/nonexistent/git', ['config'])
    expect(result.error?.code).toBe('ENOENT')
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('lists a real config file as NUL-terminated records', () => {
    const file = join(box.root, 'config')
    writeFileSync(file, CLEAN_CONFIG)
    const result = realRunGit(GIT, ['config', '--file', file, '--list', '-z', '--no-includes'])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.startsWith('core.repositoryformatversion\n0\0')).toBe(true)
  })

  it('does not read the includes of the file it lists', () => {
    const extra = join(box.root, 'extra')
    const file = join(box.root, 'config')
    writeFileSync(extra, '[core]\n\thookspath = /evil\n')
    writeFileSync(file, `[include]\n\tpath = ${extra}\n`)
    const records = readGitConfig('s', GIT, file, realRunGit)
    expect(records).toEqual([{ key: 'include.path', value: extra }])
  })

  it('ignores the host environment: parameters, global config and counted config do not leak in',
    () => {
      const file = join(box.root, 'config')
      writeFileSync(file, '[core]\n\tfilemode = true\n')
      vi.stubEnv('GIT_CONFIG_PARAMETERS', '\'core.hookspath=/evil\'')
      vi.stubEnv('GIT_CONFIG_COUNT', '1')
      vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hookspath')
      vi.stubEnv('GIT_CONFIG_VALUE_0', '/evil')
      expect(readGitConfig('s', GIT, file, realRunGit)).toEqual([{ key: 'core.filemode',
        value: 'true' }])
    })

  it('refuses a config file that does not exist (git exits non-zero)', () => {
    expect(() => readGitConfig('s', GIT, join(box.root, 'missing'),
      realRunGit)).toThrow(expect.objectContaining({ code: 'git-exit' }))
  })
})

import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_POLICY_BYTES } from '../src/policy-read.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decide } from '../src/decide.ts'
import { MAX_STDIN_BYTES, runGuard } from '../src/guard-core.ts'
import { writePolicyFile } from '../src/policy-file.ts'
import { coderPolicy, makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let box: Sandbox
let argv: string[]
let policyPath: string

const call = (tool_name: unknown, tool_input: unknown, extra: string[] = argv): ReturnType<typeof runGuard> =>
  runGuard({ argv: extra, stdin: JSON.stringify({ tool_name, tool_input }) })

beforeEach(() => {
  box = makeSandbox()
  mkdirSync(join(box.cwd, 'src'))
  writeFileSync(join(box.cwd, 'src', 'a.ts'), 'a')
  const written = writePolicyFile(join(box.root, 'policy'), coderPolicy(box))
  policyPath = written.path
  argv = ['--policy', written.path, '--sha256', written.sha256, '--seat', 'coder-one']
})
afterEach(() => {
  box.cleanup()
})

const allowed = { code: 0, reason: '' }

describe('runGuard allow path (silent exit 0)', () => {
  it.each([
    ['Read', { file_path: 'src/a.ts' }],
    ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: 'src/brand-new.ts', content: 'x' }],
    ['MultiEdit', { file_path: 'src/a.ts', edits: [] }],
    ['NotebookEdit', { notebook_path: 'src/n.ipynb' }],
    ['Grep', { pattern: '../not-a-path-it-is-a-regex', path: 'src', glob: '**/*.ts' }],
    ['Grep', {}],
    ['Glob', { pattern: 'src/**/*.ts' }],
    ['Glob', {}],
    ['mcp__dsh__mailbox_send', { to: 'x', path: '/etc/passwd' }],
  ])('%s %j', (tool, input) => {
    expect(call(tool, input)).toEqual(allowed)
  })
})

describe('runGuard deny reasons (exit 2)', () => {
  function expectDeny(outcome: ReturnType<typeof call>, fragment: string): void {
    expect(outcome.code).toBe(2)
    expect(outcome.reason).toMatch(/^seat-guard: denied: /)
    expect(outcome.reason).toContain(fragment)
    expect(outcome.reason).not.toContain('\n')
  }

  it('denies tools not granted and unknown mcp tools', () => {
    expectDeny(call('Bash', { command: 'ls' }), 'not granted')
    expectDeny(call('mcp__dsh__other', {}), 'not granted')
    expectDeny(call('mcp__evil__x', {}), 'not granted')
  })

  it('denies bad payload shapes', () => {
    expectDeny(call(undefined, {}), 'tool_name is missing')
    expectDeny(call('', {}), 'tool_name is missing')
    expectDeny(call('Read', 'text'), 'not an object')
    expectDeny(call('Read', null), 'not an object')
    expectDeny(call('Read', { file_path: 3 }), 'not a string')
    expectDeny(call('Glob', { pattern: 3 }), 'not a string')
    expectDeny(runGuard({ argv, stdin: 'not json' }), 'not valid JSON')
    expectDeny(runGuard({ argv, stdin: '[]' }), 'not an object')
    expectDeny(runGuard({ argv, stdin: 'null' }), 'not an object')
    expectDeny(runGuard({ argv, stdin: '' }), 'not valid JSON')
  })

  it('denies escapes through every checked field', () => {
    symlinkSync(join(box.outside, 'secret.txt'), join(box.cwd, 'leak'))
    linkSync(join(box.outside, 'secret.txt'), join(box.cwd, 'hard'))
    expectDeny(call('Read', { file_path: '/etc/passwd' }), 'file_path')
    expectDeny(call('Read', { file_path: '../outside/secret.txt' }), '..')
    expectDeny(call('Read', { file_path: 'leak' }), 'outside')
    expectDeny(call('Read', { file_path: 'hard' }), 'hard-linked')
    expectDeny(call('Grep', { pattern: 'x', path: box.outside }), 'path:')
    expectDeny(call('NotebookEdit', { notebook_path: join(box.outside, 'n.ipynb') }), 'notebook_path')
    expectDeny(call('Glob', { pattern: '/etc/*' }), 'pattern:')
    expectDeny(call('Glob', { pattern: '../*' }), 'pattern:')
    expectDeny(call('Grep', { pattern: 'x', glob: '../**' }), 'glob:')
    expectDeny(call('Edit', { file_path: join(box.cwd, '.git', 'config') }), 'protected')
    expectDeny(call('Read', { file_path: join(box.home, '.ssh', 'id_rsa') }), 'outside')
  })

  it('denies bad arguments', () => {
    const base = argv
    expectDeny(call('Read', {}, []), 'need --policy')
    expectDeny(call('Read', {}, ['--bogus', 'x']), 'unexpected argument')
    expectDeny(call('Read', {}, [...base, '--seat']), 'has no value')
    expectDeny(call('Read', {}, [...base, '--seat', 'coder-one']), 'given twice')
    expectDeny(call('Read', {}, ['--policy', policyPath, '--sha256', base[3] ?? '']), 'need --policy')
    expectDeny(call('Read', {}, ['--policy', policyPath, '--sha256', base[3] ?? '', '--seat', 'Bad Seat']), 'seat name')
    expectDeny(call('Read', {}, ['--policy', policyPath, '--sha256', 'zz', '--seat', 'coder-one']), 'sha256')
    expectDeny(call('Read', {}, ['--policy', 'relative.json', '--sha256', base[3] ?? '', '--seat', 'coder-one']), 'not absolute')
  })

  it('denies when the policy file is missing, tampered, from another seat or from another host record', () => {
    expectDeny(call('Read', {}, ['--policy', join(box.root, 'none.json'), '--sha256', argv[3] ?? '', '--seat', 'coder-one']), 'unreadable')
    expectDeny(call('Read', {}, ['--policy', policyPath, '--sha256', '0'.repeat(64), '--seat', 'coder-one']), 'hash does not match')
    expectDeny(call('Read', {}, ['--policy', policyPath, '--sha256', argv[3] ?? '', '--seat', 'other-seat']), 'different seat')
    writeFileSync(policyPath, '{}')
    expectDeny(call('Read', { file_path: 'src/a.ts' }), 'hash does not match')
  })

  it('denies when the decision function throws, with a one-line reason and no detail', () => {
    const throwing = { decide: (() => { throw new TypeError('secret detail') }) as typeof decide }
    const outcome = runGuard({ argv, stdin: '{}' }, throwing)
    expect(outcome).toEqual({ code: 2, reason: 'seat-guard: denied: guard failed (TypeError)' })
    const odd = runGuard({ argv, stdin: '{}' }, { decide: (() => { throw 'string' }) })
    expect(odd.reason).toBe('seat-guard: denied: guard failed (error)')
  })

  it('caps and flattens a long reason', () => {
    const outcome = call('Read', { file_path: `${'x'.repeat(500)}/\n/../y` })
    expect(outcome.code).toBe(2)
    expect(outcome.reason.length).toBeLessThanOrEqual(400)
  })
})

describe('size caps', () => {
  it('denies a hook payload above the cap and a policy file above the cap', () => {
    const big = runGuard({ argv, stdin: 'x'.repeat(MAX_STDIN_BYTES + 1) })
    expect(big).toEqual({ code: 2, reason: `seat-guard: denied: hook input is larger than ${MAX_STDIN_BYTES} bytes` })
    writeFileSync(policyPath, ' '.repeat(MAX_POLICY_BYTES + 1))
    expect(call('Read', {}).reason).toContain('policy file is larger than')
  })

  it('denies a policy path that is a directory', () => {
    expect(call('Read', {}, ['--policy', box.cwd, '--sha256', argv[3] ?? '', '--seat', 'coder-one']).reason).toContain('not a regular file')
  })
})

describe('directories that contain protected locations', () => {
  beforeEach(() => {
    mkdirSync(join(box.cwd, '.git'))
  })

  it('denies Grep and Glob whose search directory is above .git', () => {
    for (const [tool, input] of [
      ['Grep', {}], ['Grep', { path: '.' }], ['Grep', { pattern: 'x', path: box.cwd }], ['Glob', { pattern: '**/*' }],
      ['Glob', { pattern: `${box.cwd}/**` }], ['Glob', { pattern: '*.ts' }], ['Glob', {}],
    ] as const) {
      const outcome = call(tool, input)
      expect(outcome.code, `${tool} ${JSON.stringify(input)}`).toBe(2)
      expect(outcome.reason).toContain('contains the protected location')
    }
  })

  it('allows Grep and Glob inside a subdirectory', () => {
    for (const [tool, input] of [
      ['Grep', { path: 'src' }], ['Glob', { pattern: 'src/**/*.ts' }], ['Glob', { pattern: '*.ts', path: 'src' }], ['Glob', { path: 'src' }],
      ['Glob', { pattern: `${box.cwd}/src/**` }],
    ] as const) {
      expect(call(tool, input), `${tool} ${JSON.stringify(input)}`).toEqual(allowed)
    }
  })

  it('allows them again when the policy turns the check off, and rejects a non-boolean flag', () => {
    const off = writePolicyFile(join(box.root, 'policy-off'), { ...coderPolicy(box), denyDirsContainingProtected: false })
    const offArgs = ['--policy', off.path, '--sha256', off.sha256, '--seat', 'coder-one']
    expect(call('Grep', {}, offArgs)).toEqual(allowed)
    expect(call('Glob', { pattern: '**/*' }, offArgs)).toEqual(allowed)
    expect(() => writePolicyFile(join(box.root, 'policy-bad'), { ...coderPolicy(box), denyDirsContainingProtected: 'no' as never })).toThrow(/denyDirsContainingProtected/)
  })
})

describe('glob alternatives', () => {
  it('denies path-starting alternatives', () => {
    expect(call('Glob', { pattern: '{/etc/passwd,x}' }).code).toBe(2)
    expect(call('Grep', { glob: '@(/etc/x|y)' }).code).toBe(2)
  })
})

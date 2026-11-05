import { spawnSync } from 'node:child_process'
import { copyFileSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_STDIN_BYTES } from '../src/guard-core.ts'
import { writePolicyFile } from '../src/policy-file.ts'
import { coderPolicy, makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

const here = dirname(fileURLToPath(import.meta.url))
const BIN = join(here, '..', 'src', 'bin.ts')
const BUILT = join(here, '..', 'lib', 'seat-guard.js')

let box: Sandbox
let args: string[]

beforeEach(() => {
  box = makeSandbox()
  mkdirSync(join(box.cwd, 'src'))
  writeFileSync(join(box.cwd, 'src', 'a.ts'), 'a')
  const written = writePolicyFile(join(box.root, 'policy'), coderPolicy(box))
  args = ['--policy', written.path, '--sha256', written.sha256, '--seat', 'coder-one']
})
afterEach(() => {
  box.cleanup()
})

function run(toolName: string, toolInput: unknown, argv: string[] = args, stdin?: string, script = BIN) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    input: stdin ?? JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('seat-guard as a child process', () => {
  it('allows with exit 0 and no output at all', () => {
    expect(run('Read', { file_path: join(box.cwd, 'src', 'a.ts') })).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(run('Write', { file_path: 'src/new.ts', content: 'x' })).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(run('mcp__dsh__mailbox_send', { to: 'x' })).toEqual({ status: 0, stdout: '', stderr: '' })
  })

  it('denies with exit 2, a one-line reason on stderr and nothing on stdout', () => {
    symlinkSync(join(box.outside, 'secret.txt'), join(box.cwd, 'leak'))
    linkSync(join(box.outside, 'secret.txt'), join(box.cwd, 'hard'))
    const cases: [string, unknown, string][] = [
      ['Read', { file_path: 'leak' }, 'outside'],
      ['Read', { file_path: 'hard' }, 'hard-linked'],
      ['Read', { file_path: '../outside/secret.txt' }, '..'],
      ['Read', { file_path: '/etc/passwd' }, 'outside'],
      ['Write', { file_path: join(box.cwd, '.git', 'hooks', 'pre-commit') }, 'protected'],
      ['Glob', { pattern: '/etc/*' }, 'pattern'],
      ['Bash', { command: 'ls' }, 'not granted'],
      ['mcp__dsh__unlisted', {}, 'not granted'],
    ]
    for (const [tool, input, fragment] of cases) {
      const result = run(tool, input)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^seat-guard: denied: .*\n$/)
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1)
      expect(result.stderr).toContain(fragment)
    }
  })

  it('denies on a missing, corrupt, wrong-version or hash-mismatched policy and on bad input', () => {
    const policyPath = args[1] ?? ''
    const sha = args[3] ?? ''
    expect(run('Read', {}, ['--policy', join(box.root, 'gone.json'), '--sha256', sha, '--seat', 'coder-one']).status).toBe(2)
    expect(run('Read', {}, ['--policy', policyPath, '--sha256', '1'.repeat(64), '--seat', 'coder-one']).stderr).toContain('hash does not match')
    expect(run('Read', {}, args, '').status).toBe(2)
    expect(run('Read', {}, args, '{').stderr).toContain('not valid JSON')
    expect(run('Read', {}, []).stderr).toContain('need --policy')
    writeFileSync(policyPath, readFileSync(policyPath, 'utf8').replace('"v":1', '"v":2'))
    expect(run('Read', {}, args).stderr).toContain('hash does not match')
  })

  it('fails closed when stdin cannot be read', () => {
    const result = spawnSync(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
  })
})

describe('size caps in the child process', () => {
  it('denies a payload above 1 MiB after reading only one byte past the cap', () => {
    const result = run('Read', {}, args, 'x'.repeat(MAX_STDIN_BYTES + 1))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('larger than 1048576 bytes')
  })

  it('denies an oversized policy file', () => {
    writeFileSync(args[1] ?? '', ' '.repeat(70 * 1024))
    const result = run('Read', {})
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('policy file is larger than')
  })
})

describe('the built guard (lib/seat-guard.js)', () => {
  function installed(): string {
    const dir = join(box.root, 'node_modules', '@deepseek-ai', 'dsh-agent-claude-code-tools', 'lib')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'seat-guard.js')
    copyFileSync(BUILT, target)
    return target
  }

  it('runs from under node_modules, where Node refuses to strip TypeScript, and denies with exit 2', () => {
    const script = installed()
    const denied = run('Read', { file_path: '/etc/passwd' }, args, undefined, script)
    expect(denied.status).toBe(2)
    expect(denied.stdout).toBe('')
    expect(denied.stderr).toMatch(/^seat-guard: denied: .*outside/)
    expect(run('Read', { file_path: join(box.cwd, 'src', 'a.ts') }, args, undefined, script)).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(run('Bash', { command: 'ls' }, args, undefined, script).status).toBe(2)
  })

  it('is one self-contained file that imports only node builtins', () => {
    const imports = readFileSync(BUILT, 'utf8').split('\n').filter(line => /^import /.test(line))
    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line).toMatch(/from "node:/)
  })
})

describe('static guarantee: the hook has no allow output path', () => {
  const sources = ['src/bin.ts', 'src/guard-core.ts', 'src/decide.ts', 'src/path-guard.ts', 'src/policy-read.ts', 'src/grammar.ts', 'src/stdin.ts']
    .map(file => [file, readFileSync(join(here, '..', file), 'utf8')] as const)

  it.each(sources)('%s prints no decision', (_file, text) => {
    expect(text).not.toMatch(/permissionDecision|hookSpecificOutput|stdout|console\.|process\.stdout|["'`]allow["'`]/)
  })

  it('writes only to stderr and only in the bin', () => {
    const [bin] = sources[0] ?? ['', '']
    expect(bin).toBe('src/bin.ts')
    for (const [file, text] of sources) {
      expect(/process\.stderr\.write/.test(text)).toBe(file === 'src/bin.ts')
    }
  })
})

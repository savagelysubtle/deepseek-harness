import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createShellBashExecutor, SHELL_CAPTURE_BYTES } from '../src/executor.ts'
import { StubShell } from './harness.ts'

function make(): { shell: StubShell; session: Session } {
  const id = SessionId('s')
  return {
    shell: new StubShell(new Context()),
    session: Session.create(id, [], { version: 0, id, createdAt: 0, cwd: '/' }),
  }
}

const base = { command: 'echo hi', cwd: '/work', env: { A: '1' }, timeoutMs: 5000, maxOutputBytes: 64 * 1024,
  signal: new AbortController().signal }

describe('shell bash executor', () => {
  it('refuses to load when the shell confines but no sandbox policy service is mounted', () => {
    class ConfiningShell extends StubShell {
      override get sandboxMode(): 'workspace-write' { return 'workspace-write' }
    }
    const { session } = make()
    const shell = new ConfiningShell(new Context())
    expect(() => createShellBashExecutor({ shell, session })).toThrow(/ctx\.sandboxPolicy is missing/)
  })

  it('runs through the shell with the workdir, env and capture cap', async () => {
    const { shell, session } = make()
    const exec = createShellBashExecutor({ shell, session })
    const result = await exec.run(base)
    expect(result.exitCode).toBe(0)
    expect(shell.specs).toHaveLength(1)
    expect(shell.specs[0]).toMatchObject({ command: 'echo hi', workdir: '/work', timeoutMs: 5000, stdoutMaxBytes: SHELL_CAPTURE_BYTES })
    expect(shell.specs[0]?.env).toEqual({ A: '1' })
  })

  it('sends a zero-length boundary chunk then the output', async () => {
    const { shell, session } = make()
    shell.handler = () => ({ stdout: { text: 'out', truncated: false }, stderr: { text: 'err', truncated: false } })
    const chunks: Array<[string, number]> = []
    await createShellBashExecutor({ shell, session }).run({ ...base, onOutput: (stream, chunk) => { chunks.push([stream, chunk.length]) } })
    expect(chunks).toEqual([['stdout', 0], ['stdout', 3], ['stderr', 3]])
  })

  it('keeps a 64 KB tail on a UTF-8 boundary and flags truncation', async () => {
    const { shell, session } = make()
    shell.handler = () => ({ stdout: { text: 'a'.repeat(100 * 1024) + 'é'.repeat(10), truncated: false } })
    const result = await createShellBashExecutor({ shell, session }).run(base)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.stdout.endsWith('é')).toBe(true)
    expect(result.stdoutBytes).toBe(100 * 1024 + 20)
  })

  it('reports a failed and a timed-out command', async () => {
    const { shell, session } = make()
    shell.handler = () => ({ exitCode: 2, timedOut: true })
    const result = await createShellBashExecutor({ shell, session }).run(base)
    expect(result).toMatchObject({ exitCode: 2, timedOut: true })
  })
})

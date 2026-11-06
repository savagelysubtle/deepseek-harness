import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { SandboxHost } from '../src/host.ts'
import { realPreflightDeps } from '../src/preflight.ts'
import { realRunnerDeps } from '../src/runner.ts'
import { createBashToolFactory } from '../src/tool.ts'
import { makeContext } from './helpers.ts'

/** True when a real bubblewrap sandbox can start here: bwrap, a user systemd bus, and permission to create namespaces. */
function sandboxAvailable(): boolean {
  const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find(path => existsSync(path))
  if (bwrap === undefined || !existsSync('/usr/bin/systemd-run') || !existsSync('/usr/bin/prlimit')) return false
  if (spawnSync('/usr/bin/systemctl', ['--user', 'show-environment'], { timeout: 10000 }).status !== 0) return false
  return spawnSync(bwrap, ['--ro-bind', '/', '/', '--unshare-net', '--unshare-user', '/usr/bin/true'], { timeout: 10000 }).status === 0
}

describe.skipIf(!sandboxAvailable())('real bwrap sandbox', () => {
  let root = ''
  let clone = ''
  let ctx: Context
  let host: SandboxHost
  let call: (input: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'bash-integ-')))
    const origin = join(root, 'origin')
    const git = (cwd: string, ...args: string[]): void => { execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' }) }
    execFileSync('git', ['init', '-q', origin], { stdio: 'ignore' })
    writeFileSync(join(origin, 'a.txt'), 'hello\n')
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', 'init')
    clone = join(root, 'clone')
    execFileSync('git', ['clone', '-q', '--no-hardlinks', origin, clone], { stdio: 'ignore' })
    mkdirSync(join(root, 'scratch'))
    ctx = new Context()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(LocalSubprocessRuntime as never, {} as never)
    const resolved = resolveConfig({ scratchDir: join(root, 'scratch') })
    if (!resolved.ok) throw new Error(resolved.reason)
    const runner = realRunnerDeps(ctx.subprocess.spawn.bind(ctx.subprocess), () => {})
    host = new SandboxHost(resolved.config, realPreflightDeps(runner), () => {})
    const started = await host.start()
    if (!started.ok) throw new Error(`preflight failed: ${JSON.stringify(started)}`)
    const tool = createBashToolFactory(host)(makeContext({ seat: 'itest-bash', cwd: clone, scrub: text => text }))
    call = async (input) => {
      const result = await tool.handler(input)
      return { ...(result.isError === true ? { isError: true } : {}), text: result.content.map(part => part.text).join('') }
    }
  }, 60000)

  afterEach(() => {
    // The runner stops its own scope after every call; a unit left over by a failing test is stopped here, and only
    // units of this suite's seat (`itest-bash`) are matched.
    const listed = spawnSync('/usr/bin/systemctl', ['--user', 'list-units', '--plain', '--no-legend', '--all', 'dsh-seat.itest-bash.*'], { encoding: 'utf8' })
    for (const line of listed.stdout.split('\n')) {
      const unit = line.trim().split(/\s+/)[0]
      if (unit?.startsWith('dsh-seat.itest-bash.') === true) spawnSync('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 10000 })
    }
  })

  afterAll(() => {
    host?.unload()
    if (root !== '') rmSync(root, { recursive: true, force: true })
  })

  it('runs a command and reports its output and exit code', async () => {
    const result = await call({ command: 'echo hi; echo err >&2; exit 3' })
    expect(result.text).toContain('status=exited exit_code=3')
    expect(result.text).toContain('hi')
    expect(result.text).toContain('err')
  }, 60000)

  it('sees the clone as its working directory', async () => {
    const result = await call({ command: 'cat a.txt && pwd' })
    expect(result.text).toContain('hello')
    expect(result.text).toContain(clone)
  }, 60000)

  it('kills a command at its deadline', async () => {
    const result = await call({ command: 'sleep 4822', timeout_s: 1 })
    expect(result.text).toContain('status=timeout')
  }, 60000)

  it('leaves no orphan behind a setsid daemon', async () => {
    await call({ command: 'setsid sleep 4821 >/dev/null 2>&1 & echo started' })
    const left = spawnSync('pgrep', ['-fx', 'sleep 4821'], { encoding: 'utf8' })
    expect(left.stdout.trim()).toBe('')
  }, 60000)

  it('cannot write outside the working directory', async () => {
    const result = await call({ command: 'echo x > /etc/dsh-probe; echo rc=$?' })
    expect(result.text).not.toContain('rc=0')
    expect(existsSync('/etc/dsh-probe')).toBe(false)
  }, 60000)

  it('has no network', async () => {
    const result = await call({ command: 'cat < /dev/tcp/1.1.1.1/53; echo rc=$?' })
    expect(result.text).not.toContain('rc=0')
  }, 60000)
})

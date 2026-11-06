import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as Tools from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { ClaudeCodePolicy } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Bash from '../src/index.ts'
import { BashConfigError } from '../src/config.ts'
import type { ResolveEnv } from '../src/config.ts'
import { mountBashSandbox } from '../src/plugin.ts'
import { FakeHandle, FakeWorld, makeContext, makePreflightDeps } from './helpers.ts'
import type { FakePreflightDeps } from './helpers.ts'

let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'bash-plugin-'))) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const hostEnv = (over: Partial<ResolveEnv> = {}): ResolveEnv => ({
  env: { XDG_RUNTIME_DIR: '/run/user/1000' },
  execPath: '/opt/node/bin/node',
  homeDir: '/home/op',
  tmpDir: '/tmp',
  exists: () => true,
  realpath: path => path,
  ...over,
})

const healthyMount = (): { host: ResolveEnv; deps: () => FakePreflightDeps } => ({
  host: hostEnv(), deps: () => makePreflightDeps(healthyWorld()),
})

function healthyWorld(): FakeWorld {
  const world = new FakeWorld()
  world.stopExit = 0
  world.makeLaunch = () => {
    const handle = new FakeHandle({ stdout: 'ok\n' })
    handle.exit(0)
    return handle
  }
  return world
}

interface Rig {
  readonly ctx: Context
  /** Warn-level log lines, in order. */
  readonly warnings: string[]
  /** Info-level log lines, in order. */
  readonly infos: string[]
}

/** A context with the tools provider mounted (so the registries exist) and a stand-in subprocess service. */
async function toolsContext(spawn: (spec: { argv: string[] }) => FakeHandle = () => new FakeHandle()): Promise<Rig> {
  const ctx = new Context()
  const warnings: string[] = []
  const infos: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)) })
  vi.spyOn(ctx.logger, 'info').mockImplementation((message: unknown) => { infos.push(String(message)) })
  ctx.provide('subprocess', { spawn } as never)
  await ctx.plugin(Tools, Tools.Config({
    policyDir: join(root, 'policy'), home: '/home/op', nodePath: '/bin/node', guardPath: '/bin/guard',
  }))
  return { ctx, warnings, infos }
}

const readiness = (ctx: Context): ReturnType<ClaudeCodePolicy['readiness']> => (ctx.get('claudeCodePolicy') as ClaudeCodePolicy).readiness()

describe('mountBashSandbox: nothing is registered', () => {
  it('when the config turns the tool off', async () => {
    const { ctx, warnings } = await toolsContext()
    expect(await mountBashSandbox(ctx, { enabled: false })).toBeUndefined()
    expect(warnings.join('\n')).toContain('disabled by config')
    expect(ctx.claudeCodePolicyRegistries.tools.names()).toEqual(['mailbox_send', 'mailbox_directory'])
    expect(readiness(ctx).missing).toEqual(['sandbox', 'canary', 'rules-hooks'])
  })

  it('when the host has no bwrap', async () => {
    const { ctx, warnings } = await toolsContext()
    expect(await mountBashSandbox(ctx, {}, { host: hostEnv({ exists: () => false }) })).toBeUndefined()
    expect(warnings.join('\n')).toContain('bwrap was not found')
    expect(readiness(ctx).missing).toEqual(['sandbox', 'canary', 'rules-hooks'])
  })

  it('when the preflight fails, with the reason in the log and the coder still without a sandbox', async () => {
    const { ctx, warnings } = await toolsContext()
    const world = healthyWorld()
    world.stopExit = 1
    expect(await mountBashSandbox(ctx, {}, { host: hostEnv(), deps: () => makePreflightDeps(world) })).toBeUndefined()
    const logged = warnings
    expect(logged.some(line => line.includes('sandbox preflight failed, bash calls are refused: user-bus'))).toBe(true)
    expect(logged.some(line => line.includes('not registered and coder seats stay not-ready'))).toBe(true)
    expect(ctx.claudeCodePolicyRegistries.tools.names()).not.toContain('bash')
    expect(ctx.claudeCodePolicyRegistries.contributors.templateTools('coder')).not.toContain('bash')
    expect(readiness(ctx).missing).toEqual(['sandbox', 'canary', 'rules-hooks'])
  })

  it('throws for a config value that is out of range', async () => {
    const { ctx } = await toolsContext()
    await expect(mountBashSandbox(ctx, { deadlineS: 900 }, { host: hostEnv() })).rejects.toThrow(BashConfigError)
  })
})

describe('mountBashSandbox: a passing preflight', () => {
  it('registers the tool, the contributor and the sandbox readiness, and the coder is still refused for canary and rules-hooks', async () => {
    const { ctx, infos } = await toolsContext()
    const host = await mountBashSandbox(ctx, {}, { host: hostEnv(), deps: () => makePreflightDeps(healthyWorld()) })
    expect(host).toBeDefined()
    const registries = ctx.claudeCodePolicyRegistries
    expect(registries.tools.names()).toEqual(['mailbox_send', 'mailbox_directory', 'bash'])
    expect(registries.contributors.templateTools('coder')).toEqual(['mailbox_send', 'mailbox_directory', 'bash'])
    expect(registries.contributors.templateTools('lead')).toEqual(['mailbox_send', 'mailbox_directory'])
    const report = readiness(ctx)
    expect(report.missing).toEqual(['canary', 'rules-hooks'])
    expect([...report.roles]).toEqual(['lead'])
    const policy = ctx.get('claudeCodePolicy') as ClaudeCodePolicy
    expect(() => policy.extend({ seat: 'coder-one', role: 'coder', cwd: root } as never))
      .toThrow('agent-claude-code-tools: seat "coder-one": role coder is not ready (missing: canary, rules-hooks)')
    expect(infos.join('\n')).toContain('sandbox preflight passed')
  })

  it('works whichever plugin mounts first, because it injects the registries and the subprocess seam', async () => {
    const ctx = new Context()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
    ctx.provide('subprocess', { spawn: () => new FakeHandle() } as never)
    expect(Bash.inject).toEqual(['claudeCodePolicyRegistries', 'subprocess'])
    const fiber = ctx.plugin({
      name: 'bash-first',
      inject: Bash.inject,
      apply: (inner: Context) => mountBashSandbox(inner, {}, healthyMount()).then(() => undefined),
    })
    await ctx.plugin(Tools, Tools.Config({ policyDir: join(root, 'policy'), home: '/home/op', nodePath: '/bin/node', guardPath: '/bin/guard' }))
    await fiber
    expect(ctx.claudeCodePolicyRegistries.tools.names()).toContain('bash')
    expect(readiness(ctx).missing).toEqual(['canary', 'rules-hooks'])
  })

  it('a second, bogus `sandbox` contributor changes nothing: canary and rules-hooks are still missing and the coder is still refused', async () => {
    const { ctx } = await toolsContext()
    await mountBashSandbox(ctx, {}, healthyMount())
    ctx.claudeCodePolicyRegistries.readiness.register({ id: 'bogus-sandbox', provides: 'sandbox' })
    expect(readiness(ctx).missing).toEqual(['canary', 'rules-hooks'])
    const policy = ctx.get('claudeCodePolicy') as ClaudeCodePolicy
    expect(() => policy.extend({ seat: 'coder-one', role: 'coder', cwd: root } as never)).toThrow('missing: canary, rules-hooks')
  })

  it('refuses to register twice: a reload fails loud instead of leaving two tools', async () => {
    const { ctx } = await toolsContext()
    const options = { host: hostEnv(), deps: () => makePreflightDeps(healthyWorld()) }
    await mountBashSandbox(ctx, {}, options)
    await expect(mountBashSandbox(ctx, {}, options)).rejects.toThrow('already registered')
  })

  it('refuses every call once the plugin is disposed, because the registries cannot unregister the tool', async () => {
    const { ctx } = await toolsContext()
    const fiber = ctx.plugin({
      name: 'bash-temp',
      inject: Bash.inject,
      apply: (inner: Context) => mountBashSandbox(inner, {}, healthyMount()).then(() => undefined),
    })
    await fiber
    const tool = ctx.claudeCodePolicyRegistries.tools.build('coder-one', ['bash'], makeContext())[0]
    expect((await tool?.handler({ command: 'ls' }))?.isError).toBeUndefined()
    await (await fiber).dispose()
    const refused = await tool?.handler({ command: 'ls' })
    expect(refused?.isError).toBe(true)
    expect(refused?.content[0]?.text).toContain('the sandbox plugin was unloaded')
  })

  it('uses the real preflight dependencies and the subprocess seam when none are injected', async () => {
    const spawned: string[] = []
    const { ctx, warnings } = await toolsContext((spec) => {
      spawned.push(spec.argv.join(' '))
      const handle = new FakeHandle()
      handle.exit(1)
      return handle
    })
    // bwrapPath points at a binary that exists; the bus probe (the first spawn) fails, so nothing registers.
    expect(await mountBashSandbox(ctx, { bwrapPath: '/usr/bin/env' }, { host: hostEnv({ exists: () => true }) })).toBeUndefined()
    expect(spawned[0]).toBe('systemctl --user show-environment')
    expect(warnings.join('\n')).toContain('user-bus')
  })
})

describe('mountBashSandbox: real host facts', () => {
  it('resolves against the real machine when no host facts are injected, and never registers on a dead bus', async () => {
    const { ctx } = await toolsContext((_spec) => {
      const handle = new FakeHandle()
      handle.exit(1)
      return handle
    })
    expect(await mountBashSandbox(ctx, {})).toBeUndefined()
    expect(ctx.claudeCodePolicyRegistries.tools.names()).not.toContain('bash')
  })
})

describe('package entry', () => {
  it('declares the plugin name, the injected services and the config schema', () => {
    expect(Bash.name).toBe('agent-claude-code-bash')
    expect(Bash.inject).toContain('claudeCodePolicyRegistries')
    expect(Bash.Config({}).enabled).toBe(true)
  })

  it('apply mounts the sandbox; a disabled row registers nothing', async () => {
    const { ctx, warnings } = await toolsContext()
    await Bash.apply(ctx, { enabled: false })
    expect(warnings.join('\n')).toContain('disabled by config')
  })
})

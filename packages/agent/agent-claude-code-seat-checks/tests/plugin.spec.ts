import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ClaudeCodePolicy } from '@deepseek-ai/dsh-agent-claude-code-driver'
import * as Tools from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { GuardProbe, GuardProbeResult, PolicyRegistries } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as SeatChecks from '../src/index.ts'
import { SeatChecksConfigError } from '../src/config.ts'
import { mountSeatChecks } from '../src/plugin.ts'
import type { RunGit } from '../src/git-config.ts'
import { realRunGit } from '../src/git-config.ts'
import { addExecutableHook, errorWithCode, makeClone, okResult, tempRoot } from './helpers.ts'
import type { TempRoot } from './helpers.ts'

let box: TempRoot
beforeEach(() => { box = tempRoot() })
afterEach(() => { box.cleanup() })

const OK: GuardProbeResult = { ok: true, nodeSha256: 'a'.repeat(64), guardSha256: 'b'.repeat(64), policySha256: 'c'.repeat(64) }

interface Rig {
  readonly ctx: Context
  readonly registries: PolicyRegistries
  readonly errors: string[]
  readonly infos: string[]
  readonly warnings: string[]
  readonly probe: ReturnType<typeof vi.fn<GuardProbe['probe']>>
}

/** Registries plus a scripted guard probe, with the logger captured. */
function rig(result: GuardProbeResult | Error = OK): Rig {
  const ctx = new Context()
  const errors: string[] = []
  const infos: string[] = []
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'error').mockImplementation((message: unknown) => { errors.push(String(message)) })
  vi.spyOn(ctx.logger, 'info').mockImplementation((message: unknown) => { infos.push(String(message)) })
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)) })
  const registries: PolicyRegistries = {
    readiness: new Tools.ReadinessRegistry(),
    contributors: new Tools.ContributorRegistry(),
    tools: Tools.createLeadTemplate(),
    cloneChecks: new Tools.CloneCheckRegistry(),
  }
  const probe = vi.fn<GuardProbe['probe']>(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)))
  ctx.provide('claudeCodePolicyRegistries', registries)
  ctx.provide('claudeCodeGuardProbe', { probe })
  return { ctx, registries, errors, infos, warnings, probe }
}

const missing = (r: Rig): readonly string[] => r.registries.readiness.readiness().missing
const nothingRegistered = (r: Rig): void => {
  expect(r.registries.cloneChecks.has(Tools.CLONE_HOOKS_CHECK_ID)).toBe(false)
  expect(missing(r)).toEqual(['sandbox', 'canary', 'rules-hooks'])
  expect(r.registries.readiness.version).toBe(0)
}

describe('mountSeatChecks: success', () => {
  it('registers the clone check, then rules-hooks, then canary, and pins the exact missing list', async () => {
    const r = rig()
    expect(await mountSeatChecks(r.ctx, { gitPath: '/usr/bin/git', canaryTimeoutMs: 777 })).toBe(true)
    expect(r.probe).toHaveBeenCalledWith(undefined, 777)
    expect(r.registries.cloneChecks.has(Tools.CLONE_HOOKS_CHECK_ID)).toBe(true)
    expect(r.registries.cloneChecks.checksFor('coder').map(entry => entry.id)).toEqual(['clone-hooks-check'])
    expect(r.registries.cloneChecks.checksFor('lead')).toEqual([])
    expect(missing(r)).toEqual(['sandbox'])
    expect(r.registries.readiness.version).toBe(2)
    expect(r.errors).toEqual([])
    expect(r.infos.join('\n')).toContain('agent-claude-code-seat-checks: guard canary passed')
    expect(r.infos.join('\n')).toContain('not the Claude CLI')
  })

  it('the registered check enforces the clone: clean passes, a planted hook refuses', async () => {
    const r = rig()
    await mountSeatChecks(r.ctx, {})
    const cwd = makeClone(box.root)
    const entry = r.registries.cloneChecks.checksFor('coder')[0]
    expect(() => entry?.check({ seat: 'coder-one', cwd })).not.toThrow()
    addExecutableHook(cwd, 'pre-push')
    expect(() => entry?.check({ seat: 'coder-one', cwd })).toThrow(expect.objectContaining({ code: 'hook-entry' }))
  })

  it('a bogus rules-hooks contributor alone does not lift enforcement: extend() still needs the clone check', () => {
    const r = rig()
    r.registries.readiness.register({ id: 'bogus', provides: 'rules-hooks' })
    expect(r.registries.cloneChecks.has(Tools.CLONE_HOOKS_CHECK_ID)).toBe(false)
    expect(missing(r)).toEqual(['sandbox', 'canary'])
  })

  it('unloading the plugin makes the clone check refuse every later query', async () => {
    const r = rig()
    const fiber = r.ctx.plugin({
      name: 'seat-checks-temp',
      inject: SeatChecks.inject,
      apply: (inner: Context) => mountSeatChecks(inner, {}).then(() => undefined),
    })
    await fiber
    const cwd = makeClone(box.root)
    const entry = r.registries.cloneChecks.checksFor('coder')[0]
    expect(() => entry?.check({ seat: 'coder-one', cwd })).not.toThrow()
    await (await fiber).dispose()
    expect(() => entry?.check({ seat: 'coder-one', cwd })).toThrow(expect.objectContaining({ code: 'disposed' }))
  })

  it('the cordis entry point mounts it', async () => {
    const r = rig()
    expect(SeatChecks.name).toBe('agent-claude-code-seat-checks')
    expect(SeatChecks.inject).toEqual(['claudeCodePolicyRegistries', 'claudeCodeGuardProbe'])
    await r.ctx.plugin(SeatChecks, SeatChecks.Config({}))
    expect(missing(r)).toEqual(['sandbox'])
  })
})

describe('mountSeatChecks: nothing is registered', () => {
  it('when the config turns it off (warn, not error)', async () => {
    const r = rig()
    expect(await mountSeatChecks(r.ctx, { enabled: false })).toBe(false)
    expect(r.warnings.join('\n')).toContain('disabled by config')
    expect(r.errors).toEqual([])
    expect(r.probe).not.toHaveBeenCalled()
    nothingRegistered(r)
  })

  it('throws a config error before doing anything', async () => {
    const r = rig()
    await expect(mountSeatChecks(r.ctx, { gitPath: 'git' })).rejects.toThrow(SeatChecksConfigError)
    expect(r.probe).not.toHaveBeenCalled()
    nothingRegistered(r)
  })

  it.each(['attest', 'timeout', 'exit', 'reason', 'control', 'changed', 'spawn', 'error'] as const)('when the probe fails with %s', async (code) => {
    const r = rig({ ok: false, code, reason: `the probe said ${code}` })
    expect(await mountSeatChecks(r.ctx, {})).toBe(false)
    expect(r.errors[0]).toBe(`agent-claude-code-seat-checks: canary FAILED ${code}`)
    expect(r.errors[1]).toContain(`the probe said ${code}`)
    expect(r.registries.readiness.notesText()).toBe(`; guard-boot-canary: canary FAILED ${code}`)
    nothingRegistered(r)
  })

  it('when the probe rejects', async () => {
    const r = rig(new Error('the probe fell over'))
    expect(await mountSeatChecks(r.ctx, {})).toBe(false)
    expect(r.errors[0]).toBe('agent-claude-code-seat-checks: canary FAILED error')
    nothingRegistered(r)
  })

  it('when git cannot be found, without running the probe', async () => {
    const r = rig()
    expect(await mountSeatChecks(r.ctx, {}, { exists: () => false })).toBe(false)
    expect(r.errors[0]).toBe('agent-claude-code-seat-checks: canary FAILED git-missing')
    expect(r.probe).not.toHaveBeenCalled()
    nothingRegistered(r)
  })

  it('when the checker self-test finds a wrong verdict', async () => {
    const r = rig()
    const blind: RunGit = () => okResult('core.filemode\ntrue\0')
    expect(await mountSeatChecks(r.ctx, {}, { run: blind })).toBe(false)
    expect(r.errors[0]).toBe('agent-claude-code-seat-checks: canary FAILED error')
    expect(r.errors[1]).toContain('checker self-test')
    nothingRegistered(r)
  })

  it('when git fails during the self-test, with the typed code of the failure', async () => {
    const r = rig()
    const run: RunGit = () => ({ error: errorWithCode('ETIMEDOUT'), signal: null, status: null, stdout: '', stderr: '' })
    expect(await mountSeatChecks(r.ctx, {}, { run })).toBe(false)
    expect(r.errors[0]).toBe('agent-claude-code-seat-checks: canary FAILED timeout')
    nothingRegistered(r)
  })

  it('when something throws that is not an Error', async () => {
    const r = rig()
    vi.spyOn(r.registries.cloneChecks, 'register').mockImplementation(() => { throw 'plain text' })
    expect(await mountSeatChecks(r.ctx, {})).toBe(false)
    expect(r.errors).toEqual(['agent-claude-code-seat-checks: canary FAILED error', 'agent-claude-code-seat-checks: plain text'])
    nothingRegistered(r)
  })

  it('when a registration throws midway, the later ones are not made', async () => {
    const r = rig()
    r.registries.readiness.register({ id: Tools.CLONE_HOOKS_CHECK_ID, provides: 'sandbox' })
    expect(await mountSeatChecks(r.ctx, {})).toBe(false)
    expect(r.errors[0]).toBe('agent-claude-code-seat-checks: canary FAILED error')
    expect(missing(r)).toEqual(['canary', 'rules-hooks'])
  })
})

describe('mountSeatChecks: a second mount fails loud', () => {
  it('throws before registering anything, and the first mount is untouched', async () => {
    const r = rig()
    await mountSeatChecks(r.ctx, {})
    const version = r.registries.readiness.version
    await expect(mountSeatChecks(r.ctx, {})).rejects.toThrow('already mounted')
    expect(r.registries.readiness.version).toBe(version)
    expect(missing(r)).toEqual(['sandbox'])
    expect(r.registries.readiness.notesText()).toBe('')
  })

  it('two concurrent mounts: one wins, the loser logs, registers nothing and leaves no failure note', async () => {
    const r = rig()
    const outcomes = await Promise.all([mountSeatChecks(r.ctx, {}), mountSeatChecks(r.ctx, {})])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(r.errors[0]).toBe('agent-claude-code-seat-checks: canary FAILED error')
    expect(r.errors[1]).toContain('already registered')
    expect(missing(r)).toEqual(['sandbox'])
    expect(r.registries.readiness.notesText()).toBe('')
  })
})

describe('end to end against the real tools provider and the real guard', () => {
  it('lifts the readiness gate to sandbox-only, then refuses a coder query for the clone state', async () => {
    const ctx = new Context()
    vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const errors: string[] = []
    vi.spyOn(ctx.logger, 'error').mockImplementation((message: unknown) => { errors.push(String(message)) })
    const policyDir = join(box.root, 'policy')
    await ctx.plugin(Tools, Tools.Config({ policyDir, home: box.root, nodePath: process.execPath, guardPath: Tools.guardScriptPath() }))
    expect(await mountSeatChecks(ctx, {}, { run: realRunGit })).toBe(true)
    expect(errors).toEqual([])
    const policy = ctx.get('claudeCodePolicy') as ClaudeCodePolicy
    expect(policy.readiness().missing).toEqual(['sandbox'])
    expect(readdirSync(policyDir).filter(name => name.startsWith('canary-'))).toEqual([])
  })
})

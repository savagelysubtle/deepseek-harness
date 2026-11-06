/**
 * T-043: the advisory warning when the mailbox mounts on the LIVE default
 * database while DSH_ORG_REGISTRY names a throwaway registry. Warn-only: the
 * mount behavior is unchanged. The real `~/.dsh` is never touched: `homedir`
 * is mocked to a temp directory.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MailboxRegistry } from '@deepseek-ai/dsh-mailbox'
import MailboxLocal, { shouldWarnLiveMailbox } from '../src/index.ts'

const { fakeHome } = vi.hoisted(() => ({ fakeHome: { value: '' } }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome.value || actual.homedir() }
})

const dirs: string[] = []
const saved = { reg: process.env.DSH_ORG_REGISTRY, home: process.env.DSH_HOME }

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-live-warn-'))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  fakeHome.value = temp()
  delete process.env.DSH_HOME
  delete process.env.DSH_ORG_REGISTRY
})
afterEach(() => {
  fakeHome.value = ''
  if (saved.reg === undefined) delete process.env.DSH_ORG_REGISTRY
  else process.env.DSH_ORG_REGISTRY = saved.reg
  if (saved.home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved.home
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Mount and return every message passed to `ctx.logger.warn`. */
async function mount(config: { path?: string }): Promise<string[]> {
  const ctx = new Context()
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
  await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
  const fiber = await ctx.plugin(MailboxLocal, config)
  await fiber.dispose()
  return warnings
}

describe('shouldWarnLiveMailbox (pure)', () => {
  const home = '/h/.dsh'
  const live = '/h/.dsh/mailbox/mailbox.db'
  it('warns naming both paths: live default + registry elsewhere', () => {
    const r = shouldWarnLiveMailbox({ resolvedPath: live, home, registryEnv: '/tmp/x/registry.yml' })
    expect(r.warn).toBe(true)
    expect(r.message).toContain(live)
    expect(r.message).toContain('/tmp/x/registry.yml')
    expect(r.message).toContain('/h/.dsh/org/registry.yml')
  })
  it('no warn: explicit other path, :memory:, unset/blank env, env equals live registry', () => {
    const reg = '/tmp/x/registry.yml'
    expect(shouldWarnLiveMailbox({ resolvedPath: '/tmp/m.db', home, registryEnv: reg }).warn).toBe(false)
    expect(shouldWarnLiveMailbox({ resolvedPath: ':memory:', home, registryEnv: reg }).warn).toBe(false)
    expect(shouldWarnLiveMailbox({ resolvedPath: live, home, registryEnv: undefined }).warn).toBe(false)
    expect(shouldWarnLiveMailbox({ resolvedPath: live, home, registryEnv: '   ' }).warn).toBe(false)
    expect(shouldWarnLiveMailbox({ resolvedPath: live, home, registryEnv: '/h/.dsh/org/registry.yml' }).warn).toBe(false)
    expect(shouldWarnLiveMailbox({ resolvedPath: live, home, registryEnv: '/h/.dsh/org/../org/registry.yml' }).warn).toBe(false)
  })
  it('swallows errors from weird input instead of throwing', () => {
    const bad = { resolvedPath: live, home: undefined as unknown as string, registryEnv: '/x' }
    expect(() => shouldWarnLiveMailbox(bad)).not.toThrow()
    expect(shouldWarnLiveMailbox(bad).warn).toBe(false)
  })
})

describe('MailboxLocal constructor guard', () => {
  it('default path + registry override elsewhere: exactly one warn naming both paths', async () => {
    const reg = join(temp(), 'registry.yml')
    process.env.DSH_ORG_REGISTRY = reg
    const warnings = await mount({})
    expect(warnings).toHaveLength(1)
    const msg = warnings[0]!
    expect(msg).toContain(join(fakeHome.value, '.dsh', 'mailbox', 'mailbox.db'))
    expect(msg).toContain(reg)
  })
  it('explicit tmp path: no warn', async () => {
    process.env.DSH_ORG_REGISTRY = join(temp(), 'registry.yml')
    const warnings = await mount({ path: ':memory:' })
    expect(warnings).toHaveLength(0)
  })
  it('registry env unset: no warn', async () => {
    const warnings = await mount({})
    expect(warnings).toHaveLength(0)
  })
  it('registry env blank: no warn', async () => {
    process.env.DSH_ORG_REGISTRY = '  '
    const warnings = await mount({})
    expect(warnings).toHaveLength(0)
  })
  it('registry env equals the live registry: no warn', async () => {
    process.env.DSH_ORG_REGISTRY = join(fakeHome.value, '.dsh', 'org', 'registry.yml')
    const warnings = await mount({})
    expect(warnings).toHaveLength(0)
  })
})

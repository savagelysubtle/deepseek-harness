/**
 * Role acceptance is lazy and driven by the policy service's readiness: `lead` needs the service and a `lead`
 * readiness, `coder` needs a `coder` readiness (which exists only once the sandbox, canary and rules-hooks
 * contributors have all registered), `mail-only` needs nothing. Host-private policy fields are validated, and a registry row
 * may never carry one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SeatMutedByPolicyError } from '../src/policy-contract.ts'
import type { ClaudeCodePolicy } from '../src/policy-contract.ts'
import { assertRoleServable, mergeHostSeat, parseHostSeat, POLICY_HOST_KEYS } from '../src/seat-config.ts'
import { cleanHostEnv, cleanTempDirs, harness, mailMessage, stubPolicy } from './fakes.ts'
import { bindingFor, bootedContext, hostSeat, hostWorld, optionsWith, registryRow, trustingSource } from './host-fakes.ts'

const Driver = await import('../src/index.ts')

describe('assertRoleServable', () => {
  const policy = (roles: readonly ('lead' | 'coder')[], missing: readonly ('sandbox' | 'canary' | 'rules-hooks')[] = []): ClaudeCodePolicy =>
    ({ version: 1, extend: () => ({}), readiness: () => ({ roles: new Set(roles), missing }) })

  it('always serves mail-only, even with no service', () => {
    expect(() => { assertRoleServable('mail-only', 's', undefined) }).not.toThrow()
  })

  it('refuses lead and coder with a visible reason when the service is absent', () => {
    expect(() => { assertRoleServable('lead', 's', undefined) }).toThrow(/seat "s": role "lead" is refused: policy service absent/)
    expect(() => { assertRoleServable('coder', 's', undefined) }).toThrow(/role "coder" is refused: policy service absent/)
  })

  it('serves exactly the roles the readiness lists', () => {
    expect(() => { assertRoleServable('lead', 's', policy(['lead'])) }).not.toThrow()
    expect(() => { assertRoleServable('coder', 's', policy(['lead', 'coder'])) }).not.toThrow()
    expect(() => { assertRoleServable('coder', 's', policy(['lead'], ['sandbox', 'canary', 'rules-hooks'])) })
      .toThrow(new RegExp(
        'not ready for it \\(missing: sandbox, canary, rules-hooks\\); coder seats wait for the sandbox, canary and rules-hooks '
        + 'contributors, and a retry works once the host logs the canary line',
      ))
    expect(() => { assertRoleServable('lead', 's', policy([])) }).toThrow(/not ready for it; coder seats wait/)
  })

  it('refuses a contract version it does not know', () => {
    expect(() => { assertRoleServable('lead', 's', { ...policy(['lead']), version: 2 as never }) }).toThrow(/contract version 2/)
  })

  it('refuses a service whose readiness throws, whatever it throws', () => {
    const broken = (thrown: unknown): ClaudeCodePolicy => ({ ...policy([]), readiness: () => { throw thrown } })
    expect(() => { assertRoleServable('lead', 's', broken(new Error('boom'))) }).toThrow(/could not report readiness \(boom\)/)
    expect(() => { assertRoleServable('lead', 's', broken('plain')) }).toThrow(/could not report readiness \(plain\)/)
  })
})

describe('host policy fields', () => {
  const parse = (overrides: Record<string, unknown>) => {
    const world = hostWorld()
    return parseHostSeat(hostSeat(world, overrides), 'ops', [world.prefix])
  }

  afterEach(() => { cleanTempDirs() })

  it('carries a lead entry\'s tools, send_to and allow_blocking as copies', () => {
    const tools = ['mailbox_send', 'roster_directory']
    const config = parse({ role: 'lead', tools, send_to: ['web-ceo', 'deep.thought@dsh'], allow_blocking: false })
    expect(config.policy).toEqual({ tools, send_to: ['web-ceo', 'deep.thought@dsh'], allow_blocking: false })
    expect(config.policy?.tools).not.toBe(tools)
  })

  it('carries only the fields the entry sets', () => {
    expect(parse({ role: 'lead', tools: ['a'] }).policy).toEqual({ tools: ['a'] })
  })

  it('carries rules_dir for a coder only', () => {
    expect(parse({ role: 'coder', rules_dir: '/etc/rules', allow_blocking: true }).policy).toEqual({ rules_dir: '/etc/rules', allow_blocking: true })
    expect(() => parse({ role: 'lead', rules_dir: '/etc/rules' })).toThrow(/rules_dir needs role "coder"/)
    expect(() => parse({ role: 'coder', rules_dir: 'rules' })).toThrow(/rules_dir must be an absolute path/)
    expect(() => parse({ role: 'coder', rules_dir: '/a\0b' })).toThrow(/rules_dir must be an absolute path/)
    expect(() => parse({ role: 'coder', rules_dir: 7 })).toThrow(/rules_dir must be an absolute path/)
  })

  it('has no policy block when a lead or coder entry sets none, and treats empty lists as nothing', () => {
    expect(parse({ role: 'lead' })).not.toHaveProperty('policy')
    expect(parse({ role: 'lead', tools: [], send_to: [] })).not.toHaveProperty('policy')
    expect(parse({ role: 'mail-only', tools: [], send_to: [] })).not.toHaveProperty('policy')
  })

  it('refuses policy fields on a mail-only seat', () => {
    expect(() => parse({ role: 'mail-only', tools: ['a'] })).toThrow(/tools need role "lead" or "coder"/)
    expect(() => parse({ role: 'mail-only', allow_blocking: false, send_to: ['x'] })).toThrow(/send_to, allow_blocking need role/)
  })

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['a tool name with upper case', { tools: ['Send'] }, /tools must be a list/],
    ['a tool name with a dash', { tools: ['a-b'] }, /tools must be a list/],
    ['a non-string tool', { tools: [3] }, /tools must be a list/],
    ['tools that is not a list', { tools: 'send' }, /tools must be a list/],
    ['too many tools', { tools: Array.from({ length: 65 }, (_v, i) => `t${i}`) }, /at most 64 entries/],
    ['a seat name with a space', { send_to: ['a b'] }, /send_to must be a list/],
    ['an empty seat name', { send_to: [''] }, /send_to must be a list/],
    ['allow_blocking that is not a boolean', { allow_blocking: 'yes' }, /allow_blocking must be true or false/],
  ])('refuses %s', (_label, fields, message) => {
    expect(() => parse({ role: 'lead', ...fields })).toThrow(message)
  })

  it.each(POLICY_HOST_KEYS)('quarantines a registry row that carries %s', (key) => {
    const world = hostWorld()
    const host = hostSeat(world, { role: 'lead' })
    expect(() => mergeHostSeat({ driver: 'claude-code', cwd: world.cwd, admit_from: ['peer'], [key]: key === 'allow_blocking' ? true : ['x'] }, host, [world.prefix], 'ops'))
      .toThrow(new RegExp(`registry row carries ${key}, which belongs in the host profile only`))
    expect(mergeHostSeat({ driver: 'claude-code', cwd: world.cwd, admit_from: ['peer'] }, host, [world.prefix], 'ops').role).toBe('lead')
  })
})

describe('role acceptance through the plugin', () => {
  beforeEach(() => { cleanHostEnv() })
  afterEach(() => { vi.unstubAllEnvs(); cleanTempDirs() })

  const mount = async (policy: ClaudeCodePolicy | null, role: 'lead' | 'coder' | 'mail-only', via: 'host' | 'static' = 'host') => {
    const world = hostWorld()
    const ctx = await bootedContext(policy)
    ctx.provide('claudeCodeSeatSource', trustingSource())
    const fiber = await ctx.plugin(Driver, Driver.Config({
      stateDir: 'claude-code', dshHome: world.dshHome, claudePathPrefixes: [world.prefix],
      hostSeats: via === 'host' ? { ops: hostSeat(world, { role }) } : {},
      seats: via === 'static' ? { ops: { driver: 'claude-code', claude_code: { model: 'haiku', role, claude_path: world.binary } } } : {},
    }))
    const create = (id: string) => ctx.agents.create({
      sessionId: SessionId(id), driver: 'claude-code', meta: { cwd: world.cwd, ...via === 'static' ? { agentPreset: 'ops' } : {} },
      ...via === 'host' ? { agentOptions: optionsWith(bindingFor('ops', registryRow(world))) } : {},
    })
    return { ctx, fiber, create }
  }

  it('mounts a lead host seat with no policy service, then refuses it at create with the reason', async () => {
    const { fiber, create } = await mount(null, 'lead')
    await expect(create('a')).rejects.toThrow(/seat "ops": role "lead" is refused: policy service absent/)
    await fiber.dispose()
  })

  it('serves the same seat once a service registers after mount', async () => {
    const { ctx, fiber, create } = await mount(null, 'lead')
    await expect(create('a')).rejects.toThrow(/policy service absent/)
    ctx.provide('claudeCodePolicy', stubPolicy({}, ['lead']))
    const handle = await create('b')
    expect(handle.agent.options.model).toBe('haiku')
    await handle.dispose()
    await fiber.dispose()
  })

  it('keeps coder refused while readiness lacks it, for both host and static seats', async () => {
    for (const via of ['host', 'static'] as const) {
      const { fiber, create } = await mount(stubPolicy({}, ['lead']), 'coder', via)
      await expect(create(`c-${via}`)).rejects.toThrow(/role "coder" is refused: the policy service is not ready for it/)
      await fiber.dispose()
    }
  })

  it('re-calls requirePolicy on every create and caches no refusal: a refused coder is served once canary registers', async () => {
    let missing: readonly ('sandbox' | 'canary' | 'rules-hooks')[] = ['canary', 'rules-hooks']
    let roles: readonly ('lead' | 'coder')[] = ['lead']
    const readiness = vi.fn(() => ({ roles: new Set(roles), missing }))
    const policy: ClaudeCodePolicy = { version: 1, extend: () => ({}), readiness }
    const { fiber, create } = await mount(policy, 'coder')
    await expect(create('first')).rejects.toThrow(
      /missing: canary, rules-hooks\); coder seats wait.*see host log lines starting agent-claude-code-seat-checks:/,
    )
    const afterFirst = readiness.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    await expect(create('second')).rejects.toThrow(/missing: canary, rules-hooks/)
    expect(readiness.mock.calls.length).toBeGreaterThan(afterFirst)
    missing = []
    roles = ['lead', 'coder']
    const handle = await create('third')
    await handle.dispose()
    await fiber.dispose()
  })

  it('serves coder once readiness lists it', async () => {
    const { fiber, create } = await mount(stubPolicy({}, ['lead', 'coder']), 'coder')
    const handle = await create('ok')
    await handle.dispose()
    await fiber.dispose()
  })

  it('serves a mail-only host seat with no policy service at all', async () => {
    const { fiber, create } = await mount(null, 'mail-only')
    const handle = await create('m')
    await handle.dispose()
    await fiber.dispose()
  })

  it('leaves the session pin where it was when the role is refused', async () => {
    const { ctx, fiber, create } = await mount(null, 'lead')
    await expect(create('first')).rejects.toThrow(/policy service absent/)
    ctx.provide('claudeCodePolicy', stubPolicy({}, ['lead']))
    // a different session id would be refused as a second pin if the refused create had already moved it
    const handle = await create('second')
    await handle.dispose()
    await fiber.dispose()
  })
})

describe('mail claimed before the policy extension throws', () => {
  it.each<[string, () => Error, string]>([
    ['a typed seat-muted refusal (what a clone check raises)', () => new SeatMutedByPolicyError('tester', 'clone hook state refused'), 'clone hook state refused'],
    ['an ordinary provider error', () => new Error('provider bug'), 'provider bug'],
  ])('fails its lease once with the reason, never loses it and never re-runs the turn: %s', async (_label, thrown, reasonText) => {
    const h = await harness()
    const extend = vi.fn(() => { throw thrown() })
    h.state.policy = { ...stubPolicy(), extend }
    const agent = h.agent()
    agent.followup(mailMessage('hi', 'm-claimed'))
    await agent.whenIdle()
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(extend).toHaveBeenCalledTimes(1)
    expect(h.state.leases).toHaveLength(1)
    expect(h.state.leases[0]).toMatch(/^fail:m-claimed:/)
    expect(h.state.leases[0]).toContain(reasonText)
  })
})

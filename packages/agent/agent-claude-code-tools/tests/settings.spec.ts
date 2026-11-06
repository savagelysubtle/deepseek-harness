import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attestFile } from '../src/attest-guard.ts'
import {
  BASE_TOOL_TEMPLATE, CODER_NATIVE_TOOLS, ContributorRegistry, MAILBOX_DIRECTORY_TOOL, MAILBOX_SEND_TOOL, mcpToolName,
} from '../src/contributors.ts'
import { UnsafePathError } from '../src/path-guard.ts'
import { ensurePolicyDir } from '../src/policy-file.ts'
import { readPolicyFile } from '../src/policy-read.ts'
import { CODER_REQUIREMENTS, ReadinessRegistry } from '../src/readiness.ts'
import { generateRules } from '../src/rules.ts'
import { buildPolicyFile, generateSeatPolicy } from '../src/settings.ts'
import type { SeatPolicyInput } from '../src/settings.ts'
import { makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let box: Sandbox
let input: SeatPolicyInput

beforeEach(() => {
  box = makeSandbox()
  const nodeCopy = join(box.root, 'node')
  const guardCopy = join(box.root, 'seat-guard.js')
  writeFileSync(nodeCopy, '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(guardCopy, '// guard\n', { mode: 0o755 })
  chmodSync(nodeCopy, 0o755)
  ensurePolicyDir(join(box.root, 'state', 'policy'))
  input = {
    seat: 'lead-one',
    role: 'lead',
    cwd: box.cwd,
    home: box.home,
    host: { tools: [MAILBOX_SEND_TOOL, MAILBOX_DIRECTORY_TOOL] },
    contributors: new ContributorRegistry(),
    policyDir: join(box.root, 'state', 'policy'),
    node: attestFile(nodeCopy, { access: 'exec' }),
    guard: attestFile(guardCopy, { access: 'read' }),
  }
})
afterEach(() => {
  box.cleanup()
})

describe('generateRules', () => {
  it('emits // absolute deny rules for Read and Edit only, role-independent', () => {
    for (const role of ['lead', 'coder'] as const) {
      const rules = generateRules(role, box.cwd, box.home)
      for (const expected of [
        `Read(/${box.home}/.claude/**)`, `Edit(/${box.home}/.claude/**)`, `Read(/${box.home}/.claude.json)`,
        `Edit(/${box.home}/.ssh/**)`, `Edit(/${box.home}/.config/gh/**)`, `Edit(/${box.home}/.dsh/**)`,
        `Read(/${box.home}/.agents/**)`, `Read(/${box.cwd}/.git/**)`, `Edit(/${box.cwd}/.claude/**)`,
        `Edit(/${box.cwd}/.mcp.json)`, `Read(/${box.cwd}/.husky/**)`,
      ]) expect(rules.deny).toContain(expected)
      expect(rules.deny).toHaveLength(36)
      expect(rules.deny.every(entry => /^(Read|Edit)\(\/\/[^/]/.test(entry))).toBe(true)
      expect(rules.deniedPrefixes).toHaveLength(10)
    }
  })

  it('denies the policy directory when given: four more rules, one more prefix', () => {
    const policyDir = join(box.root, 'policy')
    mkdirSync(policyDir)
    const rules = generateRules('coder', box.cwd, box.home, policyDir)
    expect(rules.deny).toHaveLength(40)
    expect(rules.deniedPrefixes).toHaveLength(11)
    expect(rules.deniedPrefixes).toContain(policyDir)
    for (const tool of ['Read', 'Edit']) {
      expect(rules.deny).toContain(`${tool}(//${policyDir.slice(1)})`)
      expect(rules.deny).toContain(`${tool}(//${policyDir.slice(1)}/**)`)
    }
    expect(generateRules('coder', box.cwd, box.home).deniedPrefixes).not.toContain(policyDir)
  })

  it('refuses a cwd that is the policy directory or inside it, and a policy directory that is not canonical', () => {
    const policyDir = join(box.root, 'pol')
    mkdirSync(join(policyDir, 'work'), { recursive: true })
    expect(() => generateRules('coder', policyDir, box.home, policyDir)).toThrow(/contains the policy directory/)
    expect(() => generateRules('coder', join(policyDir, 'work'), box.home, policyDir)).toThrow(/protected location/)
    const under = join(box.cwd, 'policy')
    mkdirSync(under)
    expect(() => generateRules('coder', box.cwd, box.home, under)).toThrow(/contains the policy directory/)
    expect(() => generateRules('coder', box.cwd, box.home, join(box.root, 'missing'))).toThrow(UnsafePathError)
    expect(() => generateRules('coder', box.cwd, box.home, 'relative')).toThrow(UnsafePathError)
  })

  it('emits the exact // + path-without-leading-slash form, bare and /** for directories', () => {
    const rules = generateRules('coder', box.cwd, box.home)
    const cwd = box.cwd.slice(1)
    const home = box.home.slice(1)
    expect(rules.allow).toEqual([`Read(//${cwd}/**)`, `Edit(//${cwd}/**)`])
    expect(rules.allow[0]).toMatch(/^Read\(\/\/tmp\/cct-[A-Za-z0-9]+\/proj\/\*\*\)$/)
    expect(rules.deny).toContain(`Read(//${home}/.claude/**)`)
    expect(rules.deny).toContain(`Read(//${home}/.claude)`)
    expect(rules.deny).toContain(`Edit(//${home}/.claude.json)`)
    expect(rules.deny).toContain(`Edit(//${home}/.config/gh/**)`)
    expect(rules.deny).toContain(`Edit(//${cwd}/.git)`)
    expect(rules.deny).toContain(`Edit(//${cwd}/.git/**)`)
    expect(rules.deny.some(entry => entry.includes('///'))).toBe(false)
  })

  it('gives a coder Read/Edit over the cwd only, a lead nothing', () => {
    expect(generateRules('coder', box.cwd, box.home)).toMatchObject({
      allow: [`Read(/${box.cwd}/**)`, `Edit(/${box.cwd}/**)`], allowedRoots: [box.cwd],
    })
    expect(generateRules('lead', box.cwd, box.home)).toMatchObject({ allow: [], allowedRoots: [] })
  })

  it('refuses a cwd with pattern characters, a symlinked cwd, a bad home and a cwd inside a protected place', () => {
    expect(() => generateRules('coder', join(box.root, 'my proj'), box.home)).toThrow(UnsafePathError)
    expect(() => generateRules('coder', join(box.root, '#proj'), box.home)).toThrow(UnsafePathError)
    expect(() => generateRules('coder', join(box.root, '!proj'), box.home)).toThrow(UnsafePathError)
    symlinkSync(box.cwd, join(box.root, 'linked'))
    expect(() => generateRules('coder', join(box.root, 'linked'), box.home)).toThrow(/not canonical/)
    expect(() => generateRules('coder', box.cwd, join(box.root, '{home}'))).toThrow(UnsafePathError)
    expect(() => generateRules('coder', box.home, box.home)).toThrow(/home directory itself/)
    mkdirSync(join(box.home, '.ssh', 'work'), { recursive: true })
    expect(() => generateRules('coder', join(box.home, '.ssh', 'work'), box.home)).toThrow(/protected location/)
  })
})

describe('contributors and readiness', () => {
  it('starts with the exact lead template', () => {
    expect(BASE_TOOL_TEMPLATE).toEqual(['mailbox_send', 'mailbox_directory'])
    expect(mcpToolName('mailbox_send')).toBe('mcp__dsh__mailbox_send')
    expect(new ContributorRegistry().templateTools('lead')).toEqual(['mailbox_send', 'mailbox_directory'])
  })

  it('appends tool contributions by role and validates them', () => {
    const registry = new ContributorRegistry()
    registry.registerToolContributor({ id: 's6', roles: ['coder'], names: ['bash', 'mailbox_send'] })
    expect(registry.templateTools('coder')).toEqual(['mailbox_send', 'mailbox_directory', 'bash'])
    expect(registry.templateTools('lead')).toEqual(['mailbox_send', 'mailbox_directory'])
    expect(() => { registry.registerToolContributor({ id: 's6', roles: ['coder'], names: [] }) }).toThrow(/already registered/)
    expect(() => { registry.registerToolContributor({ id: 'bad', roles: ['coder'], names: ['Bad-Name'] }) }).toThrow(/not a valid tool name/)
  })

  it('merges hook contributions by event and role and rejects duplicates', () => {
    const registry = new ContributorRegistry()
    const group = (command: string) => ({ hooks: [{ type: 'command' as const, command }] })
    registry.registerHookContributor({ id: 'a', roles: ['coder'], groups: () => ({ PreToolUse: [group('a')], PostToolUse: [group('p')] }) })
    registry.registerHookContributor({ id: 'b', roles: ['coder'], groups: () => ({ PreToolUse: [group('b')] }) })
    registry.registerHookContributor({ id: 'c', roles: ['lead'], groups: () => ({ PreToolUse: [group('c')] }) })
    expect(registry.extraHookGroups({ seat: 'x', role: 'coder' })).toEqual({ PreToolUse: [group('a'), group('b')], PostToolUse: [group('p')] })
    expect(registry.extraHookGroups({ seat: 'x', role: 'lead' })).toEqual({ PreToolUse: [group('c')] })
    expect(() => { registry.registerHookContributor({ id: 'a', roles: [], groups: () => ({}) }) }).toThrow(/already registered/)
  })

  it('accepts a cwd holding a protected entry on a case-sensitive filesystem', () => {
    mkdirSync(join(box.cwd, '.git'))
    expect(generateRules('coder', box.cwd, box.home).deniedPrefixes).toContain(join(box.cwd, '.git'))
  })

  it('serves lead always and coder only with sandbox, canary and rules-hooks', () => {
    const registry = new ReadinessRegistry()
    expect(registry.readiness()).toEqual({ roles: new Set(['lead']), missing: ['sandbox', 'canary', 'rules-hooks'] })
    registry.register({ id: 's6', provides: 'sandbox' })
    registry.register({ id: 's7', provides: 'canary' })
    expect(registry.readiness()).toEqual({ roles: new Set(['lead']), missing: ['rules-hooks'] })
    registry.register({ id: 'rules', provides: 'rules-hooks' })
    expect(registry.readiness()).toEqual({ roles: new Set(['lead', 'coder']), missing: [] })
    expect(() => { registry.register({ id: 'rules', provides: 'rules-hooks' }) }).toThrow(/already registered/)
    expect(CODER_REQUIREMENTS).toEqual(['sandbox', 'canary', 'rules-hooks'])
  })
})

describe('generateSeatPolicy', () => {
  it('builds a lead policy: mcp tools only, no native tool, deny rules, guard hook, policy file on disk', () => {
    const policy = generateSeatPolicy(input)
    expect(policy.tools).toEqual(['mcp__dsh__mailbox_send', 'mcp__dsh__mailbox_directory'])
    expect(policy.allow).toEqual(policy.tools)
    expect(policy.disallowedTools).toEqual(['Bash'])
    expect(policy.fences).toEqual({ permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true })
    const deny = policy.settings.permissions?.deny ?? []
    expect(deny.some(entry => entry.startsWith('Write(') || entry.startsWith('Grep('))).toBe(false)
    type Groups = { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] }
    const groups = (policy.settings.hooks as Groups).PreToolUse
    expect(groups).toHaveLength(1)
    expect(groups[0]?.hooks[0]?.command).toContain(`--policy '${policy.policyPath}' --sha256 ${policy.policySha256} --seat lead-one`)
    expect(groups[0]?.hooks[0]?.timeout).toBe(60)
    expect(readPolicyFile(policy.policyPath, 'lead-one', policy.policySha256)).toMatchObject({ ok: true, policy: { role: 'lead', allowedRoots: [] } })
    expect(readFileSync(policy.policyPath, 'utf8')).toContain('"lead-one"')
    expect(policy.settingsSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(generateSeatPolicy(input).settingsSha256).toBe(policy.settingsSha256)
  })

  it('builds a coder policy with Read/Edit limited to the cwd and native tools listed', () => {
    const policy = generateSeatPolicy({ ...input, seat: 'coder-one', role: 'coder' })
    expect(policy.tools).toEqual([...CODER_NATIVE_TOOLS, 'mcp__dsh__mailbox_send', 'mcp__dsh__mailbox_directory'])
    expect(policy.allow).toEqual([`Read(/${box.cwd}/**)`, `Edit(/${box.cwd}/**)`, 'mcp__dsh__mailbox_send', 'mcp__dsh__mailbox_directory'])
    expect(policy.settingsSha256).not.toBe(generateSeatPolicy(input).settingsSha256)
  })

  it('cuts the template to what the host lists and ignores names outside the template', () => {
    const policy = generateSeatPolicy({ ...input, host: { tools: [MAILBOX_SEND_TOOL, 'bash'] } })
    expect(policy.tools).toEqual(['mcp__dsh__mailbox_send'])
  })

  it('appends contributor hook groups after the guard and tools for the role', () => {
    input.contributors.registerToolContributor({ id: 's6', roles: ['lead'], names: ['extra_tool'] })
    input.contributors.registerHookContributor({
      id: 's7',
      roles: ['lead'],
      groups: () => ({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'canary' }] }] }),
    })
    const policy = generateSeatPolicy({ ...input, host: { tools: ['extra_tool', MAILBOX_SEND_TOOL] } })
    expect(policy.tools).toEqual(['mcp__dsh__mailbox_send', 'mcp__dsh__extra_tool'])
    expect((policy.settings.hooks as { PreToolUse: { matcher: string }[] }).PreToolUse.map(group => group.matcher)).toHaveLength(2)
  })

  it('writes the dir-search flag only when turned off and rejects a non-boolean', () => {
    expect('denyDirsContainingProtected' in buildPolicyFile(input)).toBe(false)
    const off = generateSeatPolicy({ ...input, denyDirsContainingProtected: false })
    expect(readPolicyFile(off.policyPath, 'lead-one', off.policySha256)).toMatchObject({ ok: true, policy: { denyDirsContainingProtected: false } })
  })

  it('puts the policy directory in the written policy file\'s denied prefixes', () => {
    const policy = generateSeatPolicy(input)
    const read = readPolicyFile(policy.policyPath, 'lead-one', policy.policySha256)
    expect(read).toMatchObject({ ok: true, policy: { deniedPrefixes: expect.arrayContaining([input.policyDir]) as unknown } })
    expect((policy.settings.permissions?.deny ?? []).some(entry => entry === `Read(//${input.policyDir.slice(1)}/**)`)).toBe(true)
    expect(buildPolicyFile({ ...input, policyDir: undefined } as never).deniedPrefixes).not.toContain(input.policyDir)
  })

  it('passes rules in instead of recomputing them', () => {
    const rules = generateRules('lead', box.cwd, box.home)
    expect(buildPolicyFile(input, rules).deniedPrefixes).toEqual(rules.deniedPrefixes)
  })

  it('refuses a .ts guard unless the source guard is explicitly allowed', () => {
    const tsGuard = join(box.root, 'seat-guard.ts')
    writeFileSync(tsGuard, '// g\n', { mode: 0o755 })
    const attested = attestFile(tsGuard, { access: 'read' })
    expect(() => generateSeatPolicy({ ...input, guard: attested })).toThrow(/TypeScript source/)
    expect(generateSeatPolicy({ ...input, guard: attested, allowSourceGuard: true }).policyPath).toContain('lead-one.json')
  })

  it('mutes a seat with no tool left', () => {
    expect(() => generateSeatPolicy({ ...input, host: {} })).toThrow(SeatMutedByPolicyError)
    expect(() => buildPolicyFile({ ...input, host: { tools: ['nothing_matches'] } })).toThrow(/muted by policy/)
    expect(buildPolicyFile({ ...input, role: 'coder', host: {} }).tools).toEqual([...CODER_NATIVE_TOOLS])
  })

  it('refuses an unusable cwd before writing anything', () => {
    expect(() => generateSeatPolicy({ ...input, cwd: join(box.root, 'a b') })).toThrow(UnsafePathError)
  })
})

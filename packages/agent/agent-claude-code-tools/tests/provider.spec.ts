import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import type { ClaudeCodePolicy, PolicyQueryContext } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attestFile } from '../src/attest-guard.ts'
import { CLONE_HOOKS_CHECK_ID, CloneCheckError, CloneCheckRegistry } from '../src/clone-checks.ts'
import { installGuardCopy } from '../src/guard-copy.ts'
import { RESERVED_PROBE_SEAT } from '../src/guard-probe.ts'
import { ContributorRegistry, GUARD_MATCHER } from '../src/index.ts'
import * as Plugin from '../src/index.ts'
import { createClaudeCodePolicy } from '../src/provider.ts'
import type { PolicyOptions } from '../src/provider.ts'
import { ReadinessRegistry } from '../src/readiness.ts'
import { createLeadTemplate } from '../src/mcp/template.ts'
import { defineSeatTool, textResult } from '../src/mcp/types.ts'
import type { SeatScrubOptions } from '../src/mcp/types.ts'
import { DIRECTORY_SCHEMA } from '../src/mcp/schema.ts'
import { installRealGuard, makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'
import { callThroughServer, listThroughServer, textOf } from './mcp/helpers.ts'

let box: Sandbox
let fakeNode: string
let fakeGuard: string

beforeEach(() => {
  box = makeSandbox()
  fakeNode = join(box.root, 'fake-node')
  fakeGuard = join(box.root, 'fake-guard.js')
  writeFileSync(fakeNode, '#!/bin/sh\n')
  writeFileSync(fakeGuard, '// guard\n')
  chmodSync(fakeNode, 0o755)
  chmodSync(fakeGuard, 0o755)
})
afterEach(() => {
  box.cleanup()
  vi.restoreAllMocks()
})

interface Fields { tools?: string[]; send_to?: string[]; allow_blocking?: boolean; rules_dir?: string }

function query(fields: Fields | undefined, over: Partial<PolicyQueryContext> = {}): PolicyQueryContext & { marks: string[] } {
  const marks: string[] = []
  const base = {
    seat: 'lead-one',
    role: 'lead',
    config: { model: 'haiku', role: 'lead', ...fields === undefined ? {} : { policy: fields } },
    cwd: box.cwd,
    binding: { kind: 'first', sdkSessionId: 'sdk-1' },
    isTurnTainted: () => false,
    markTurnTainted: (reason: string) => { marks.push(reason) },
    deliveredTraceIds: () => new Set(['trace-1']),
    ...over,
  }
  return Object.assign(base, { marks }) as unknown as PolicyQueryContext & { marks: string[] }
}

/** A policy that runs the real proof (no injected verify) against the given node wrapper and guard. */
function realPolicy(nodePath: string, guardPath: string): ClaudeCodePolicy {
  const { verify: _injected, ...rest } = options({ nodePath, guardPath })
  return createClaudeCodePolicy(rest)
}

const LEAD: Fields = { tools: ['mailbox_send', 'mailbox_directory'], send_to: ['ops-lead', 'sam'] }

function options(over: Partial<PolicyOptions> = {}): PolicyOptions & { published: unknown[]; verify: ReturnType<typeof vi.fn> } {
  const published: unknown[] = []
  const verify = vi.fn()
  return {
    policyDir: join(box.root, 'state', 'policy'),
    home: box.home,
    nodePath: fakeNode,
    guardPath: fakeGuard,
    publish: (input) => { published.push(input); return Promise.resolve('id') },
    verify,
    newTraceId: () => 'fresh',
    warn: () => undefined,
    ...over,
    published,
    ...over.verify === undefined ? { verify } : {},
  } as PolicyOptions & { published: unknown[]; verify: ReturnType<typeof vi.fn> }
}

describe('the extension for a lead seat', () => {
  it('hands back the dsh server, the exact allow list, the guard hook and the deny rules', async () => {
    const policy = createClaudeCodePolicy(options())
    const ext = policy.extend(query(LEAD))
    expect(ext.allow).toEqual(['mcp__dsh__mailbox_send', 'mcp__dsh__mailbox_directory'])
    expect(Object.keys(ext.mcpServers ?? {})).toEqual(['dsh'])
    expect(ext.mcpServers?.dsh.type).toBe('sdk')
    expect((await listThroughServer(ext.mcpServers?.dsh.instance)).map(tool => tool.name)).toEqual(['mailbox_send', 'mailbox_directory'])
    const groups = ext.settings?.hooks?.['PreToolUse'] as { matcher: string; hooks: { type: string; command: string }[] }[]
    expect(groups[0]?.matcher).toBe(GUARD_MATCHER)
    expect(groups[0]?.hooks[0]?.command).toContain('--seat lead-one')
    expect((ext.settings?.permissions?.deny ?? []).length).toBeGreaterThan(0)
    expect(policy.version).toBe(1)
  })

  it('writes the policy file atomically and pins it by hash in the hook command', () => {
    const opts = options()
    const ext = createClaudeCodePolicy(opts).extend(query(LEAD))
    const file = join(opts.policyDir, 'lead-one.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { seat: string; role: string; tools: string[] }
    expect(parsed).toMatchObject({ seat: 'lead-one', role: 'lead', tools: ['mcp__dsh__mailbox_send', 'mcp__dsh__mailbox_directory'] })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const command = (ext.settings?.hooks?.['PreToolUse'] as { hooks: { command: string }[] }[])[0]?.hooks[0]?.command
    expect(command).toContain(file)
  })

  it('builds a fresh server per query, and the servers share nothing', async () => {
    const opts = options()
    const policy = createClaudeCodePolicy(opts)
    const a = policy.extend(query(LEAD))
    const b = policy.extend(query(LEAD))
    expect(a.mcpServers?.dsh.instance).not.toBe(b.mcpServers?.dsh.instance)
    const other = policy.extend(query({ tools: ['mailbox_send'], send_to: ['zed'] }, { seat: 'lead-two' }))
    await callThroughServer(a.mcpServers?.dsh.instance, 'mailbox_send', { to: 'sam', body: 'x' })
    await callThroughServer(other.mcpServers?.dsh.instance, 'mailbox_send', { to: 'zed', body: 'y' })
    expect((opts.published as { from: string; to: string }[]).map(m => [m.from, m.to])).toEqual([['lead-one', 'sam'], ['lead-two', 'zed']])
  })
})

describe('the tools see the live query, not a snapshot', () => {
  it('reads taint and delivered traces from the query context at call time and mints a uuid by default', async () => {
    const opts = options()
    delete (opts as { newTraceId?: unknown }).newTraceId
    let tainted = false
    const ext = createClaudeCodePolicy(opts).extend(query(LEAD, { isTurnTainted: () => tainted }))
    const server = ext.mcpServers?.dsh.instance
    await callThroughServer(server, 'mailbox_send', { to: 'sam', body: 'one' })
    tainted = true
    await callThroughServer(server, 'mailbox_send', { to: 'sam', body: 'two', replyToTraceId: 'trace-1' })
    const refused = await callThroughServer(server, 'mailbox_send', { to: 'sam', body: 'three', replyToTraceId: 'nope' })
    const [first, second] = opts.published as { traceId: string; tainted?: boolean }[]
    expect(first?.traceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first).not.toHaveProperty('tainted')
    expect(second).toMatchObject({ traceId: 'trace-1', tainted: true })
    expect(second).not.toHaveProperty('chain')
    expect(refused.isError).toBe(true)
  })

  it('wires markTainted through to the driver for any future tool that reads external content', async () => {
    const template = createLeadTemplate()
    template.register('peek', context => defineSeatTool(context, {
      name: 'peek', description: 'reads external content', inputSchema: DIRECTORY_SCHEMA, taint: 'always',
      handler: async () => textResult(context, 'body'),
    }))
    const contributors = new ContributorRegistry()
    contributors.registerToolContributor({ id: 'peek', roles: ['lead'], names: ['peek'] })
    const q = query({ tools: ['peek'] })
    const ext = createClaudeCodePolicy(options({ template, contributors })).extend(q)
    await callThroughServer(ext.mcpServers?.dsh.instance, 'peek', {})
    expect(q.marks).toEqual(['tool:peek'])
    expect(ext.allow).toEqual(['mcp__dsh__peek'])
  })

  it('scrubs the home and the working directory out of what the model reads', async () => {
    const ext = createClaudeCodePolicy(options()).extend(query({ tools: ['mailbox_directory'], send_to: [`${box.home}/x`, `${box.cwd}/y`] }))
    expect(textOf(await callThroughServer(ext.mcpServers?.dsh.instance, 'mailbox_directory', {}))).toBe('Seats you may mail:\n- [path]\n- [path]')
  })
})

describe('the working directory is pinned', () => {
  it('refuses a query whose cwd differs from the one the seat was first served with', () => {
    const policy = createClaudeCodePolicy(options())
    policy.extend(query(LEAD))
    expect(() => policy.extend(query(LEAD, { cwd: box.outside }))).toThrow(/not the pinned/)
    expect(() => policy.extend(query(LEAD, { cwd: `${box.cwd}/` }))).toThrow(/not the pinned/)
    expect(() => policy.extend(query(LEAD))).not.toThrow()
  })

  it('refuses a cwd that is not canonical before any file is written', () => {
    const opts = options()
    expect(() => createClaudeCodePolicy(opts).extend(query(LEAD, { cwd: '../x' }))).toThrow()
    expect(() => statSync(join(opts.policyDir, 'lead-one.json'))).toThrow()
  })
})

describe('policy generation is cached per seat and cwd and heals itself', () => {
  const inode = (opts: PolicyOptions): number => statSync(join(opts.policyDir, 'lead-one.json')).ino

  it('does not rewrite the file for an unchanged policy, and rewrites it when the fields change', () => {
    const opts = options()
    const policy = createClaudeCodePolicy(opts)
    policy.extend(query(LEAD))
    const first = inode(opts)
    policy.extend(query(LEAD))
    expect(inode(opts)).toBe(first)
    policy.extend(query({ ...LEAD, send_to: ['sam'] }))
    const second = inode(opts)
    expect(second).not.toBe(first)
    policy.extend(query({ ...LEAD, send_to: ['sam'], allow_blocking: true }))
    const third = inode(opts)
    expect(third).not.toBe(second)
    policy.extend(query({ ...LEAD, send_to: ['sam'], allow_blocking: true, rules_dir: '/rules' }))
    expect(inode(opts)).not.toBe(third)
  })

  it('rewrites a deleted or tampered policy file', () => {
    const opts = options()
    const policy = createClaudeCodePolicy(opts)
    policy.extend(query(LEAD))
    const file = join(opts.policyDir, 'lead-one.json')
    const good = readFileSync(file, 'utf8')
    writeFileSync(file, '{}')
    policy.extend(query(LEAD))
    expect(readFileSync(file, 'utf8')).toBe(good)
    writeFileSync(file, '{}')
    chmodSync(file, 0o000)
    policy.extend(query(LEAD))
    expect(readFileSync(file, 'utf8')).toBe(good)
  })

  it('a write failure throws and hands out nothing', () => {
    const blocker = join(box.root, 'blocker')
    writeFileSync(blocker, 'file')
    const opts = options({ policyDir: join(blocker, 'policy') })
    expect(() => createClaudeCodePolicy(opts).extend(query(LEAD))).toThrow()
    expect(opts.verify).not.toHaveBeenCalled()
  })
})

describe('the hook runs a host-owned copy of the guard (F1)', () => {
  const commandOf = (ext: ReturnType<ClaudeCodePolicy['extend']>): string => (ext.settings?.hooks?.['PreToolUse'] as { hooks: { command: string }[] }[])[0]?.hooks[0]?.command ?? ''

  it('copies the guard into the policy directory with mode 0500 and names the copy in the hook command', () => {
    const opts = options()
    const copy = join(opts.policyDir, 'seat-guard.js')
    const command = commandOf(createClaudeCodePolicy(opts).extend(query(LEAD)))
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(fakeGuard, 'utf8'))
    expect(statSync(copy).mode & 0o777).toBe(0o500)
    expect(command).toContain(`'${copy}'`)
    expect(command).not.toContain(fakeGuard)
    expect(command.startsWith("'/usr/bin/env' -u NODE_OPTIONS ")).toBe(true)
  })

  it('re-copies a tampered copy from the attested source and leaves an intact one alone', () => {
    const opts = options()
    const policy = createClaudeCodePolicy(opts)
    policy.extend(query(LEAD))
    const copy = join(opts.policyDir, 'seat-guard.js')
    const inode = statSync(copy).ino
    policy.extend(query(LEAD))
    expect(statSync(copy).ino).toBe(inode)
    chmodSync(copy, 0o700)
    writeFileSync(copy, 'process.exit(0)\n')
    chmodSync(copy, 0o500)
    policy.extend(query(LEAD))
    expect(readFileSync(copy, 'utf8')).toBe('// guard\n')
    chmodSync(copy, 0o700)
    writeFileSync(copy, 'process.exit(0)\n')
    const command = commandOf(policy.extend(query(LEAD)))
    expect(readFileSync(copy, 'utf8')).toBe('// guard\n')
    expect(statSync(copy).mode & 0o777).toBe(0o500)
    expect(command).toContain(copy)
  })

  it('refuses a copy that was replaced with a wrong-mode file even when the bytes match', () => {
    const opts = options()
    const policy = createClaudeCodePolicy(opts)
    policy.extend(query(LEAD))
    const copy = join(opts.policyDir, 'seat-guard.js')
    chmodSync(copy, 0o700)
    policy.extend(query(LEAD))
    expect(statSync(copy).mode & 0o777).toBe(0o500)
  })

  it('never copies from a changed source', () => {
    const opts = options()
    const policy = createClaudeCodePolicy(opts)
    policy.extend(query(LEAD))
    const copy = join(opts.policyDir, 'seat-guard.js')
    writeFileSync(fakeGuard, '// edited source\n')
    chmodSync(copy, 0o700)
    writeFileSync(copy, 'tampered\n')
    expect(() => policy.extend(query(LEAD))).toThrow(/changed since this host attested it/)
    expect(readFileSync(copy, 'utf8')).toBe('tampered\n')
  })

  it('refuses a source that changes between attestation and copy', () => {
    const opts = options()
    const copy = join(opts.policyDir, 'seat-guard.js')
    mkdirSync(opts.policyDir, { recursive: true, mode: 0o700 })
    const attested = attestFile(fakeGuard, { access: 'read' })
    writeFileSync(fakeGuard, '// swapped\n')
    expect(() => installGuardCopy(opts.policyDir, attested)).toThrow(/changed since this host attested it/)
    expect(existsSync(copy)).toBe(false)
  })

  it('removes its temp file and throws when the copy cannot be renamed into place', () => {
    const opts = options()
    mkdirSync(join(opts.policyDir, 'seat-guard.js'), { recursive: true, mode: 0o700 })
    expect(() => createClaudeCodePolicy(opts).extend(query(LEAD))).toThrow()
    expect(readdirSync(opts.policyDir)).toEqual(['seat-guard.js'])
  })

  it('refuses a policy directory that is not mode 0700', () => {
    const opts = options()
    mkdirSync(opts.policyDir, { recursive: true })
    chmodSync(opts.policyDir, 0o755)
    expect(() => createClaudeCodePolicy(opts).extend(query(LEAD))).toThrow(/chmod 700/)
  })
})

describe('policy cache keys on the registries (F5) and the file check never hangs (F4a)', () => {
  it('a hook contributor registered after a cached entry yields a fresh policy', () => {
    const opts = options()
    const contributors = new ContributorRegistry()
    const policy = createClaudeCodePolicy({ ...opts, contributors })
    const before = policy.extend(query(LEAD))
    expect(Object.keys(before.settings?.hooks ?? {})).toEqual(['PreToolUse'])
    contributors.registerHookContributor({
      id: 'late',
      roles: ['lead'],
      groups: () => ({ SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }] }),
    })
    const after = policy.extend(query(LEAD))
    expect(Object.keys(after.settings?.hooks ?? {}).sort()).toEqual(['PreToolUse', 'SessionStart'])
  })

  it('a readiness contributor or a tool registered later also bumps the version', () => {
    const readiness = new ReadinessRegistry()
    const template = createLeadTemplate()
    const contributors = new ContributorRegistry()
    const versions = (): number[] => [readiness.version, template.version, contributors.version]
    const start = versions()
    readiness.register({ id: 'a', provides: 'sandbox' })
    template.register('ping', context => defineSeatTool(context, { name: 'ping', description: 'x', inputSchema: DIRECTORY_SCHEMA, taint: 'never', taintReason: 'test tool returning a constant', handler: () => Promise.resolve(textResult(context, 'x')) }))
    contributors.registerToolContributor({ id: 't', roles: ['coder'], names: ['ping'] })
    expect(versions().every((value, index) => value > (start[index] ?? 0))).toBe(true)
  })

  it('treats a FIFO, a directory or an oversized file at the policy path as not intact and rewrites a regular file', () => {
    const opts = options()
    const policy = createClaudeCodePolicy(opts)
    policy.extend(query(LEAD))
    const file = join(opts.policyDir, 'lead-one.json')
    const good = readFileSync(file, 'utf8')
    writeFileSync(file, 'x'.repeat(70 * 1024))
    policy.extend(query(LEAD))
    expect(readFileSync(file, 'utf8')).toBe(good)
    rmSync(file)
    expect(spawnSync('/usr/bin/mkfifo', [file]).status).toBe(0)
    expect(() => policy.extend(query(LEAD))).not.toThrow()
    expect(readFileSync(file, 'utf8')).toBe(good)
  })
})

describe('the guard must prove it denies before any tool can run', () => {
  it('verifies once per guard and policy hash, again when the policy changes', () => {
    const opts = options()
    const policy = createClaudeCodePolicy(opts)
    policy.extend(query(LEAD))
    policy.extend(query(LEAD))
    policy.extend(query(LEAD, { seat: 'lead-one' }))
    expect(opts.verify).toHaveBeenCalledTimes(1)
    expect(opts.verify.mock.calls[0]?.[0]).toContain('--seat lead-one')
    policy.extend(query({ tools: ['mailbox_send'], send_to: ['sam'] }))
    expect(opts.verify).toHaveBeenCalledTimes(2)
    policy.extend(query(LEAD, { seat: 'lead-two' }))
    expect(opts.verify).toHaveBeenCalledTimes(3)
  })

  it('a failed proof throws, hands out no server, and is retried on the next query', () => {
    const verify = vi.fn(() => { throw new Error('the seat guard did not deny the probe (exit 1)') })
    const template = createLeadTemplate()
    const names = vi.spyOn(template, 'build')
    const policy = createClaudeCodePolicy(options({ verify, template }))
    expect(() => policy.extend(query(LEAD))).toThrow(/did not deny the probe/)
    expect(() => policy.extend(query(LEAD))).toThrow(/did not deny the probe/)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(names).not.toHaveBeenCalled()
  })

  it('a provider whose guard file is missing never returns an extension', () => {
    const opts = options({ guardPath: join(box.root, 'no-such-guard.js') })
    const policy = createClaudeCodePolicy(opts)
    expect(() => policy.extend(query(LEAD))).toThrow(/cannot resolve it/)
    expect(opts.verify).not.toHaveBeenCalled()
  })

  it('refuses a node binary that cannot be attested', () => {
    expect(() => createClaudeCodePolicy(options({ nodePath: join(box.root, 'no-node') })).extend(query(LEAD))).toThrow(/cannot resolve it/)
  })

  it('refuses when an attested file changes under the host', () => {
    const policy = createClaudeCodePolicy(options())
    policy.extend(query(LEAD))
    writeFileSync(fakeGuard, '// tampered\n')
    expect(() => policy.extend(query(LEAD))).toThrow(/changed since this host attested it/)
  })

  describe('with the real guard and the real proof', () => {
    it('accepts the genuine built guard', () => {
      const { node, guard } = installRealGuard(box.root)
      const ext = realPolicy(node, guard).extend(query(LEAD))
      expect(ext.allow).toEqual(['mcp__dsh__mailbox_send', 'mcp__dsh__mailbox_directory'])
    })

    it('rejects a guard that starts but allows (it would fail open)', () => {
      const { node, guard } = installRealGuard(box.root)
      writeFileSync(guard, 'process.exit(0)\n')
      expect(() => realPolicy(node, guard).extend(query(LEAD))).toThrow(/did not deny the probe \(exit 0\)/)
    })

    it('rejects a guard that cannot start (node exits 1 on a script it cannot load)', () => {
      const { node, guard } = installRealGuard(box.root)
      writeFileSync(guard, 'this is not javascript (\n')
      expect(() => realPolicy(node, guard).extend(query(LEAD))).toThrow(/did not deny the probe/)
    })
  })
})

describe('muting', () => {
  it('an empty or absent tools list throws SeatMutedByPolicyError and writes nothing', () => {
    for (const fields of [undefined, {}, { tools: [], send_to: ['sam'] }] as (Fields | undefined)[]) {
      const opts = options()
      expect(() => createClaudeCodePolicy(opts).extend(query(fields))).toThrow(SeatMutedByPolicyError)
      expect(() => statSync(join(opts.policyDir, 'lead-one.json'))).toThrow()
    }
  })

  it('an unknown tool name throws with the names, and so does a name the policy template does not offer', () => {
    expect(() => createClaudeCodePolicy(options()).extend(query({ tools: ['mailbox_send', 'mailbox_await', 'bash'] }))).toThrow(/cannot provide: mailbox_await, bash/)
    const template = createLeadTemplate()
    template.register('extra', context => defineSeatTool(context, { name: 'extra', description: 'x', inputSchema: DIRECTORY_SCHEMA, taint: 'never', taintReason: 'test tool returning a constant', handler: async () => textResult(context, 'x') }))
    let caught: unknown
    try {
      createClaudeCodePolicy(options({ template })).extend(query({ tools: ['extra'] }))
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SeatMutedByPolicyError)
    expect((caught as SeatMutedByPolicyError).reason).toBe('the lead policy template does not offer: extra')
  })
})

describe('readiness and roles', () => {
  it('lead is ready on its own; coder is not, and says what is missing', () => {
    const policy = createClaudeCodePolicy(options())
    const readiness = policy.readiness()
    expect([...readiness.roles]).toEqual(['lead'])
    expect(readiness.missing).toEqual(['sandbox', 'canary', 'rules-hooks'])
  })

  it('a coder query is refused while the contributors are missing (no contributor is faked)', () => {
    const policy = createClaudeCodePolicy(options())
    expect(() => policy.extend(query(LEAD, { role: 'coder' }))).toThrow(/role coder is not ready \(missing: sandbox, canary, rules-hooks\)/)
  })

  it('a coder is served once S6 and S7 register their contributors', () => {
    const readiness = new ReadinessRegistry()
    for (const provides of ['sandbox', 'canary', 'rules-hooks'] as const) readiness.register({ id: provides, provides })
    const cloneChecks = new CloneCheckRegistry()
    cloneChecks.register({ id: CLONE_HOOKS_CHECK_ID, roles: ['coder'], check: () => undefined })
    const policy = createClaudeCodePolicy(options({ readiness, cloneChecks }))
    expect([...policy.readiness().roles].sort()).toEqual(['coder', 'lead'])
    const ext = policy.extend(query({ tools: ['mailbox_send'], send_to: ['sam'] }, { role: 'coder', seat: 'coder-one' }))
    expect(ext.allow).toContain('mcp__dsh__mailbox_send')
    expect((ext.allow ?? []).some(entry => entry.startsWith('Edit(//'))).toBe(true)
  })

  it('a mail-only seat takes no policy', () => {
    expect(() => createClaudeCodePolicy(options()).extend(query(LEAD, { role: 'mail-only' }))).toThrow(/mail-only/)
  })
})

describe('the seat closure: cwd and scrub roots', () => {
  /** A tool that reports the closure's cwd and scrubs a fixed text with the requested options. */
  function probeTemplate(text: () => string, scrubOptions?: SeatScrubOptions) {
    const template = createLeadTemplate()
    template.register('probe', context => defineSeatTool(context, {
      name: 'probe', description: 'x', inputSchema: DIRECTORY_SCHEMA, taint: 'never', taintReason: 'test tool returning a constant',
      handler: async () => textResult(context, `${context.cwd}|${text()}`, false, scrubOptions),
    }))
    const contributors = new ContributorRegistry()
    contributors.registerToolContributor({ id: 'probe', roles: ['lead'], names: ['probe'] })
    return { template, contributors }
  }
  async function run(scrubOptions: SeatScrubOptions | undefined, text: () => string): Promise<string> {
    const { template, contributors } = probeTemplate(text, scrubOptions)
    const ext = createClaudeCodePolicy(options({ template, contributors })).extend(query({ tools: ['probe'] }))
    return textOf(await callThroughServer(ext.mcpServers?.dsh.instance, 'probe', {}))
  }

  it('hands every tool the pinned cwd', async () => {
    expect(await run(undefined, () => 'x')).toBe('[path]|x')
  })

  it('scrubs home and cwd by default (the mailbox tools\' behaviour)', async () => {
    expect(await run(undefined, () => `${box.home}/a ${box.cwd}/b`)).toBe('[path]|[path] [path]')
  })

  it('a tool scrubbing with roots [home] leaves the cwd readable', async () => {
    expect(await run({ scrubRoots: ['home'] }, () => `${box.home}/a ${box.cwd}/b`)).toBe(`${box.cwd}|[path] ${box.cwd}/b`)
  })

  it('a tool scrubbing with roots [cwd] leaves the home readable', async () => {
    expect(await run({ scrubRoots: ['cwd'] }, () => `${box.home}/a ${box.cwd}/b`)).toBe(`[path]|${box.home}/a [path]`)
  })

  it('refuses an empty or unknown scrub root list: at least one root is required (the handler throws, the SDK reports it)', async () => {
    expect(await run({ scrubRoots: [] }, () => 'x')).toMatch(/at least one of "home" and "cwd"/)
    expect(await run({ scrubRoots: ['tmp' as never] }, () => 'x')).toMatch(/at least one of/)
  })

  it('refuses a maxLength that is not a positive safe integer of at most 1 MiB, and accepts the bounds', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 * 1_048_576, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await run({ maxLength: bad }, () => 'x')).toMatch(/maxLength must be a positive integer of at most 1048576/)
    }
    expect(await run({ maxLength: 1_048_576 }, () => 'x')).toBe('[path]|x')
    expect(await run({ maxLength: 1000 }, () => 'x')).toBe('[path]|x')
  })

  describe('a cwd under the home directory, roots [home]', () => {
    let nested: string
    beforeEach(() => {
      nested = join(box.home, 'clones', 'seat-one')
      mkdirSync(nested, { recursive: true })
    })

    async function nestedRun(text: () => string, roots: SeatScrubOptions['scrubRoots'], maxLength?: number): Promise<string> {
      const scrub: SeatScrubOptions = {
        ...roots === undefined ? {} : { scrubRoots: roots },
        ...maxLength === undefined ? {} : { maxLength },
      }
      const { template, contributors } = probeTemplate(text, scrub)
      const ext = createClaudeCodePolicy(options({ template, contributors })).extend(query({ tools: ['probe'] }, { cwd: nested }))
      return textOf(await callThroughServer(ext.mcpServers?.dsh.instance, 'probe', {}))
    }

    it('keeps a path inside the cwd and still redacts a sibling path under the home', async () => {
      const out = await nestedRun(() => `${nested}/src/a.ts ${nested} ${box.home}/clones/other/x ${box.home}/.ssh/id`, ['home'])
      expect(out).toBe(`${nested}|${nested}/src/a.ts ${nested} [path] [path]`)
    })

    it('does not treat a longer sibling name as inside the cwd, and still caps the length and strips controls', async () => {
      expect(await nestedRun(() => `${nested}-two/x`, ['home'])).toBe(`${nested}|[path]`)
      expect(await nestedRun(() => `a\u0000b ${nested}/f ${'z'.repeat(60)}`, ['home'], 40)).toMatch(/^.{1,40}$/su)
      expect(await nestedRun(() => `${nested}/f\u0000g`, ['home'])).toBe(`${nested}|${nested}/fg`)
    })

    it('strips controls before matching, so a NUL cannot disguise a sibling name as the cwd', async () => {
      expect(await nestedRun(() => `${nested}\u0000-two/x`, ['home'])).toBe(`${nested}|[path]`)
    })

    it('a path that climbs out of the cwd with a .. segment is not inside it; a dotted name is', async () => {
      expect(await nestedRun(() => `${nested}/../.ssh/id`, ['home'])).toBe(`${nested}|[path]`)
      expect(await nestedRun(() => `${nested}/a/../../x ok ${nested}/..`, ['home'])).toBe(`${nested}|[path] ok [path]`)
      expect(await nestedRun(() => `${nested}/a/..b/c ${nested}/.hidden`, ['home'])).toBe(`${nested}|${nested}/a/..b/c ${nested}/.hidden`)
      expect(await nestedRun(() => `${nested}/../x then ${nested}/ok`, ['home'])).toBe(`${nested}|[path] then ${nested}/ok`)
    })

    it('with cwd among the roots, the cwd is redacted again', async () => {
      expect(await nestedRun(() => `${nested}/src`, ['home', 'cwd'])).toBe('[path]|[path]')
    })
  })

  it('honours a longer length cap than the mailbox default', async () => {
    const long = 'y'.repeat(5000)
    expect((await run(undefined, () => long)).length).toBeLessThan(4100)
    expect((await run({ maxLength: 20_000 }, () => long)).length).toBeGreaterThan(5000)
  })
})

describe('allowedCwdRoots (plugin-side cwd pin)', () => {
  it('serves a cwd inside a root, including the root itself, and refuses one outside', () => {
    const inside = createClaudeCodePolicy(options({ allowedCwdRoots: [box.root] }))
    expect(inside.extend(query(LEAD)).allow).toContain('mcp__dsh__mailbox_send')
    expect(createClaudeCodePolicy(options({ allowedCwdRoots: [box.cwd] })).extend(query(LEAD)).allow).toBeDefined()
    const outside = createClaudeCodePolicy(options({ allowedCwdRoots: [box.outside] }))
    expect(() => outside.extend(query(LEAD))).toThrow(/is not inside an allowed cwd root/)
    // whole segments: /a/proj is not inside /a/pro
    const prefixOnly = createClaudeCodePolicy(options({ allowedCwdRoots: [box.cwd.slice(0, -1)] }))
    expect(() => prefixOnly.extend(query(LEAD))).toThrow(/allowed cwd root/)
  })

  it('an empty list refuses every seat; absent means no pin', () => {
    expect(() => createClaudeCodePolicy(options({ allowedCwdRoots: [] })).extend(query(LEAD))).toThrow(/allowed cwd root/)
    expect(createClaudeCodePolicy(options()).extend(query(LEAD))).toBeDefined()
  })

  it('refuses a root that is not absolute, not normalised, or the filesystem root, at construction', () => {
    for (const root of ['relative/dir', '/a/../b', '/a/b/', '/']) {
      expect(() => createClaudeCodePolicy(options({ allowedCwdRoots: [root] }))).toThrow(/allowedCwdRoots entry/)
    }
  })

  it('is part of the plugin config and reaches the policy', async () => {
    expect(Plugin.Config({ policyDir: '/x', allowedCwdRoots: ['/a'] }).allowedCwdRoots).toEqual(['/a'])
    const ctx = new Context()
    Plugin.apply(ctx, { policyDir: join(box.root, 'p'), home: box.home, nodePath: fakeNode, guardPath: fakeGuard, allowedCwdRoots: [box.outside] })
    const policy = ctx.get('claudeCodePolicy') as ClaudeCodePolicy
    expect(() => policy.extend(query(LEAD))).toThrow(/allowed cwd root/)
    expect(() => { Plugin.apply(new Context(), { policyDir: join(box.root, 'p'), allowedCwdRoots: ['rel'] }) }).toThrow(/allowedCwdRoots entry/)
  })
})

describe('the policy directory is denied to file tools', () => {
  it('is in the denied prefixes and the deny rules of a generated policy, and a cwd inside it is refused', () => {
    const opts = options()
    createClaudeCodePolicy(opts).extend(query(LEAD))
    const file = JSON.parse(readFileSync(join(opts.policyDir, 'lead-one.json'), 'utf8')) as { deniedPrefixes: string[] }
    expect(file.deniedPrefixes).toContain(opts.policyDir)
    mkdirSync(join(opts.policyDir, 'work'))
    expect(() => createClaudeCodePolicy(opts).extend(query(LEAD, { cwd: join(opts.policyDir, 'work') }))).toThrow(/inside the policy directory/)
    expect(() => createClaudeCodePolicy(opts).extend(query(LEAD, { cwd: opts.policyDir }))).toThrow(/inside the policy directory/)
  })

  it('refuses a cwd that contains the policy directory, naming both paths, before any pin', () => {
    const policyDir = join(box.cwd, 'state', 'policy')
    const policy = createClaudeCodePolicy(options({ policyDir }))
    let message = ''
    try {
      policy.extend(query(LEAD))
    } catch (error: unknown) {
      message = (error as Error).message
    }
    expect(message).toContain(JSON.stringify(box.cwd))
    expect(message).toContain(JSON.stringify(policyDir))
    expect(message).toContain('contains or is inside the policy directory')
    expect(existsSync(policyDir)).toBe(false)
    // an unrelated sibling cwd is still served afterwards: nothing was pinned
    expect(policy.extend(query(LEAD, { cwd: box.outside })).allow).toContain('mcp__dsh__mailbox_send')
  })
})

describe('readiness after the S6 sandbox contributor (changelog item 12)', () => {
  const coder = (): PolicyQueryContext => query({ tools: ['mailbox_send'], send_to: ['sam'] }, { role: 'coder', seat: 'coder-one' })

  it('coder is still refused with exactly canary and rules-hooks missing', () => {
    const readiness = new ReadinessRegistry()
    readiness.register({ id: 'sandbox-bwrap-seat', provides: 'sandbox' })
    const policy = createClaudeCodePolicy(options({ readiness }))
    expect(policy.readiness().missing).toEqual(['canary', 'rules-hooks'])
    expect([...policy.readiness().roles]).toEqual(['lead'])
    expect(() => policy.extend(coder())).toThrow('agent-claude-code-tools: seat "coder-one": role coder is not ready (missing: canary, rules-hooks)')
  })

  it('a bogus second sandbox contributor satisfies neither canary nor rules-hooks, and lead is unchanged', () => {
    const readiness = new ReadinessRegistry()
    readiness.register({ id: 'sandbox-bwrap-seat', provides: 'sandbox' })
    readiness.register({ id: 'sandbox-bogus', provides: 'sandbox' })
    const policy = createClaudeCodePolicy(options({ readiness }))
    expect(policy.readiness().missing).toEqual(['canary', 'rules-hooks'])
    expect(() => policy.extend(coder())).toThrow(/missing: canary, rules-hooks/)
    expect(policy.extend(query(LEAD)).allow).toEqual(['mcp__dsh__mailbox_send', 'mcp__dsh__mailbox_directory'])
  })

  it('registering the same contributor id twice fails loud', () => {
    const readiness = new ReadinessRegistry()
    readiness.register({ id: 'sandbox-bwrap-seat', provides: 'sandbox' })
    expect(() => { readiness.register({ id: 'sandbox-bwrap-seat', provides: 'sandbox' }) }).toThrow(/already registered/)
  })
})

describe('mounting', () => {
  it('declares its plugin name and a config with a required policyDir', () => {
    expect(Plugin.name).toBe('agent-claude-code-tools')
    expect(() => Plugin.Config({} as never)).toThrow()
    expect(Plugin.Config({ policyDir: '/x' }).policyDir).toBe('/x')
  })

  it('provides claudeCodePolicy, and the driver sees it whether it mounts before or after', async () => {
    for (const toolsFirst of [true, false]) {
      const ctx = new Context()
      const seen: (ClaudeCodePolicy | undefined)[] = []
      const driverStandIn = (c: Context): void => { seen.push(c.get('claudeCodePolicy')) }
      const config = Plugin.Config({ policyDir: join(box.root, 'p'), home: box.home, nodePath: fakeNode, guardPath: fakeGuard })
      if (toolsFirst) await ctx.plugin(Plugin, config)
      await ctx.plugin(driverStandIn)
      if (!toolsFirst) await ctx.plugin(Plugin, config)
      const late = ctx.get('claudeCodePolicy')
      expect(late?.version).toBe(1)
      expect([...late?.readiness().roles ?? []]).toEqual(['lead'])
      expect(toolsFirst ? seen[0]?.version : late?.version).toBe(1)
    }
  })

  it('refuses a relative path in its config', () => {
    const ctx = new Context()
    expect(() => { Plugin.apply(ctx, { policyDir: 'relative' }) }).toThrow(/policyDir must be an absolute path/)
    expect(() => { Plugin.apply(ctx, { policyDir: '/x', guardPath: 'g.js' }) }).toThrow(/guardPath must be an absolute path/)
  })

  it('looks the mailbox up at send time: a clear error without it, a real publish with it', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const { node, guard } = installRealGuard(box.root)
    Plugin.apply(ctx, { policyDir: join(box.root, 'p'), home: box.home, nodePath: node, guardPath: guard })
    const policy = ctx.get('claudeCodePolicy') as ClaudeCodePolicy
    const ext = policy.extend(query(LEAD))
    const missing = await callThroughServer(ext.mcpServers?.dsh.instance, 'mailbox_send', { to: 'sam', body: 'x' })
    expect(textOf(missing)).toBe('mailbox_send refused: the mailbox rejected the message')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the mailbox service is not mounted'))
    const publish = vi.fn(() => Promise.resolve('id'))
    ctx.provide('mailbox' as never, { publish } as never)
    const sent = await callThroughServer(policy.extend(query(LEAD)).mcpServers?.dsh.instance, 'mailbox_send', { to: 'sam', body: 'x' })
    expect(sent.isError).toBeUndefined()
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ from: 'lead-one', to: 'sam' }), undefined)
  })

  it('routes a mailbox rejection to the host logger, not to the model', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const { node, guard } = installRealGuard(box.root)
    Plugin.apply(ctx, { policyDir: join(box.root, 'p'), home: box.home, nodePath: node, guardPath: guard })
    ctx.provide('mailbox' as never, { publish: () => Promise.reject(new Error('secret store detail')) } as never)
    const ext = (ctx.get('claudeCodePolicy') as ClaudeCodePolicy).extend(query(LEAD))
    const result = await callThroughServer(ext.mcpServers?.dsh.instance, 'mailbox_send', { to: 'sam', body: 'x' })
    expect(textOf(result)).toBe('mailbox_send refused: the mailbox rejected the message')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secret store detail'))
  })

  it('defaults home, node and guard when the config leaves them out', () => {
    const ctx = new Context()
    Plugin.apply(ctx, { policyDir: join(box.root, 'p') })
    expect((ctx.get('claudeCodePolicy') as ClaudeCodePolicy).version).toBe(1)
  })

  describe('the registries service (how S6 and S7 get in)', () => {
    const config = (): ReturnType<typeof Plugin.Config> => Plugin.Config({ policyDir: join(box.root, 'p'), home: box.home, nodePath: fakeNode, guardPath: fakeGuard })

    /** A stand-in S6 plugin: needs the registries, registers a sandbox contributor and one extra tool. */
    function s6(seen: string[]): { inject: string[]; apply(c: Context): void; name: string } {
      return {
        name: 'stand-in-s6',
        inject: ['claudeCodePolicyRegistries'],
        apply(c: Context): void {
          const registries = c.claudeCodePolicyRegistries
          registries.readiness.register({ id: 's6-sandbox', provides: 'sandbox' })
          registries.contributors.registerToolContributor({ id: 's6-tools', roles: ['coder'], names: ['bash_sandboxed'] })
          registries.tools.register('bash_sandboxed', context => defineSeatTool(context, {
            name: 'bash_sandboxed', description: 'x', inputSchema: DIRECTORY_SCHEMA, taint: 'always', handler: () => Promise.resolve(textResult(context, 'x')),
          }))
          seen.push('registered')
        },
      }
    }

    for (const s6First of [false, true]) {
      it(`a plugin mounted ${s6First ? 'before' : 'after'} the provider registers into the live policy`, async () => {
        const ctx = new Context()
        const seen: string[] = []
        if (s6First) await ctx.plugin(s6(seen))
        expect(seen).toEqual([])
        await ctx.plugin(Plugin, config())
        if (!s6First) await ctx.plugin(s6(seen))
        expect(seen).toEqual(['registered'])
        const policy = ctx.get('claudeCodePolicy') as ClaudeCodePolicy
        const registries = ctx.get('claudeCodePolicyRegistries')
        expect(registries?.tools.names()).toEqual(['mailbox_send', 'mailbox_directory', 'bash_sandboxed'])
        expect(registries?.contributors.templateTools('coder')).toContain('bash_sandboxed')
        expect(registries?.contributors.templateTools('lead')).not.toContain('bash_sandboxed')
        const readiness = policy.readiness()
        expect([...readiness.roles]).toEqual(['lead'])
        expect(readiness.missing).toEqual(['canary', 'rules-hooks'])
        expect(() => policy.extend(query({ tools: ['bash_sandboxed'] }, { role: 'coder', seat: 'coder-one' }))).toThrow(/role coder is not ready \(missing: canary, rules-hooks\)/)
      })
    }
  })
})

describe('clone checks and the S7 seams in extend', () => {
  const coderQuery = (over: Partial<PolicyQueryContext> = {}): PolicyQueryContext => query({ tools: ['mailbox_send'], send_to: ['sam'] }, { role: 'coder', seat: 'coder-one', ...over })
  const readyReadiness = (): ReadinessRegistry => {
    const readiness = new ReadinessRegistry()
    for (const provides of ['sandbox', 'canary', 'rules-hooks'] as const) readiness.register({ id: provides, provides })
    return readiness
  }

  it('a ready coder is still refused (typed, muting) when no clone-hooks-check is registered', () => {
    const policy = createClaudeCodePolicy(options({ readiness: readyReadiness() }))
    let caught: unknown
    try {
      policy.extend(coderQuery())
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CloneCheckError)
    expect(caught).toBeInstanceOf(SeatMutedByPolicyError)
    expect((caught as CloneCheckError).code).toBe('check-missing')
    expect((caught as CloneCheckError).reason).toContain('agent-claude-code-seat-checks:')
  })

  it('a clone check with another id does not satisfy the coupling', () => {
    const cloneChecks = new CloneCheckRegistry()
    cloneChecks.register({ id: 'other', roles: ['coder'], check: () => undefined })
    const policy = createClaudeCodePolicy(options({ readiness: readyReadiness(), cloneChecks }))
    expect(() => policy.extend(coderQuery())).toThrow(CloneCheckError)
  })

  it('runs the registered checks for the role on every query with the seat and cwd; a lead needs none', () => {
    const cloneChecks = new CloneCheckRegistry()
    const calls: unknown[] = []
    cloneChecks.register({ id: CLONE_HOOKS_CHECK_ID, roles: ['coder'], check: (ctx) => { calls.push(ctx) } })
    cloneChecks.register({ id: 'lead-only', roles: ['lead'], check: () => { calls.push('lead') } })
    const policy = createClaudeCodePolicy(options({ readiness: readyReadiness(), cloneChecks }))
    policy.extend(coderQuery())
    policy.extend(coderQuery())
    expect(calls).toEqual([{ seat: 'coder-one', cwd: box.cwd }, { seat: 'coder-one', cwd: box.cwd }])
    policy.extend(query(LEAD))
    expect(calls).toHaveLength(3)
    expect(calls[2]).toBe('lead')
  })

  it('a CloneCheckError from a check propagates unchanged and no policy is written', () => {
    const cloneChecks = new CloneCheckRegistry()
    const refusal = new CloneCheckError('coder-one', 'hooks-path', 'core.hooksPath is set')
    cloneChecks.register({ id: CLONE_HOOKS_CHECK_ID, roles: ['coder'], check: () => { throw refusal } })
    const opts = options({ readiness: readyReadiness(), cloneChecks })
    expect(() => createClaudeCodePolicy(opts).extend(coderQuery())).toThrow(refusal)
    expect(existsSync(join(opts.policyDir, 'coder-one.json'))).toBe(false)
  })

  it('fails closed: a check that throws something else, even a non-Error, becomes a typed refusal', () => {
    for (const thrown of [new TypeError('boom'), 'plain string']) {
      const cloneChecks = new CloneCheckRegistry()
      cloneChecks.register({ id: CLONE_HOOKS_CHECK_ID, roles: ['coder'], check: () => { throw thrown } })
      let caught: unknown
      try {
        createClaudeCodePolicy(options({ readiness: readyReadiness(), cloneChecks })).extend(coderQuery())
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(CloneCheckError)
      expect((caught as CloneCheckError).code).toBe('check-failed')
      expect((caught as CloneCheckError).reason).toBe(`clone check ${CLONE_HOOKS_CHECK_ID} failed unexpectedly (${thrown instanceof Error ? 'TypeError' : 'error'})`)
    }
  })

  it('refuses the reserved probe seat name for any role, before anything else', () => {
    const policy = createClaudeCodePolicy(options())
    expect(() => policy.extend(query(LEAD, { seat: RESERVED_PROBE_SEAT }))).toThrow(/reserved for the guard boot probe/)
    expect(() => policy.extend(coderQuery({ seat: RESERVED_PROBE_SEAT }))).toThrow(/reserved for the guard boot probe/)
  })

  it('appends the readiness notes to the not-ready error and never to a ready one', () => {
    const readiness = new ReadinessRegistry()
    readiness.register({ id: 'sandbox-bwrap-seat', provides: 'sandbox' })
    readiness.note('guard-boot-canary', 'canary FAILED exit\nsecond line')
    const policy = createClaudeCodePolicy(options({ readiness }))
    expect(() => policy.extend(coderQuery())).toThrow('role coder is not ready (missing: canary, rules-hooks); guard-boot-canary: canary FAILED exit second line')
    expect(policy.readiness().missing).toEqual(['canary', 'rules-hooks'])
  })

  it('mount provides the clone-check registry and the guard probe service, same instances the policy uses', async () => {
    const ctx = new Context()
    const real = installRealGuard(box.root)
    await ctx.plugin(Plugin, Plugin.Config({ policyDir: join(box.root, 'p'), home: box.home, nodePath: real.node, guardPath: real.guard, allowedCwdRoots: [box.root] }))
    const registries = ctx.get('claudeCodePolicyRegistries')
    expect(registries?.cloneChecks).toBeInstanceOf(CloneCheckRegistry)
    const probed = await ctx.get('claudeCodeGuardProbe')?.probe()
    expect(probed?.ok).toBe(true)
    for (const provides of ['sandbox', 'canary', 'rules-hooks'] as const) registries?.readiness.register({ id: provides, provides })
    const policy = ctx.get('claudeCodePolicy') as ClaudeCodePolicy
    expect(() => policy.extend(coderQuery())).toThrow(CloneCheckError)
    registries?.cloneChecks.register({ id: CLONE_HOOKS_CHECK_ID, roles: ['coder'], check: () => undefined })
    expect(policy.extend(coderQuery()).allow).toContain('mcp__dsh__mailbox_send')
  })
})

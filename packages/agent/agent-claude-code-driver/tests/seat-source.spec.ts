/**
 * Registry-routed seats through the plugin: the static config is consulted first, the seat source second,
 * and a source-resolved seat is held to the host entry (ceiling, cwd pin, binary pin) and to every fence a
 * static seat gets. The SDK `query` is mocked as in plugin.spec.ts; no real Claude Code process is started.
 */

import { appendFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { MailAdmissionRequest } from '../src/admission.ts'
import { cleanHostEnv, cleanTempDirs, FakeQuery, fakeClaudeBinary, mailMessage, resultMessage, seatRow, tempDir, tick, userMessage } from './fakes.ts'
import { bindingFor, bootedContext, hostSeat, hostWorld, optionsWith, registryRow, trustingSource } from './host-fakes.ts'
import type { HostWorld } from './host-fakes.ts'

const sdk = vi.hoisted(() => ({
  queries: [] as unknown[],
  make: undefined as undefined | ((prompt: never, options: never) => unknown),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...original,
    query: ({ prompt, options }: { prompt: never; options: never }) => {
      const fake = (sdk.make as NonNullable<typeof sdk.make>)(prompt, options)
      sdk.queries.push(fake)
      return fake
    },
    getSessionInfo: () => Promise.resolve({ sessionId: 'x' }),
  }
})

sdk.make = (prompt, options) => new FakeQuery(prompt, options)

const Driver = await import('../src/index.ts')

async function nthQuery(index: number): Promise<FakeQuery> {
  for (let attempt = 0; attempt < 200 && sdk.queries[index] === undefined; attempt++) await tick(5)
  return sdk.queries[index] as FakeQuery
}

/** Mount the driver with one host seat `ops` and a trusting source; returns what a test needs. */
async function mounted(
  world: HostWorld,
  extra: { hostSeats?: Record<string, ReturnType<typeof hostSeat>>; seats?: Record<string, ReturnType<typeof seatRow>> } = {},
) {
  const ctx = await bootedContext()
  const source = trustingSource()
  ctx.provide('claudeCodeSeatSource', source)
  const fiber = await ctx.plugin(Driver, Driver.Config({
    stateDir: 'claude-code',
    dshHome: world.dshHome,
    claudePathPrefixes: [world.prefix],
    hostSeats: extra.hostSeats ?? { ops: hostSeat(world) },
    seats: extra.seats ?? {},
  }))
  return { ctx, source, fiber }
}

describe('registry-routed seats through the plugin', () => {
  beforeEach(() => { cleanHostEnv() })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    cleanTempDirs()
  })

  it('consults the static config first and the source only for a seat the config does not hold', async () => {
    const world = hostWorld()
    const staticBinary = fakeClaudeBinary()
    const { ctx, source, fiber } = await mounted(world, { seats: { 'static-s': seatRow({ claude_path: staticBinary, role: 'lead' }) } })
    const staticCwd = tempDir('cc-static-')
    const staticHandle = await ctx.agents.create({ sessionId: SessionId('static-s'), driver: 'claude-code', meta: { cwd: staticCwd } })
    expect(source.requests).toHaveLength(0)
    expect(staticHandle.agent.options.model).toBe('sonnet')
    const sourced = await ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd }, agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
    })
    expect(source.requests).toHaveLength(1)
    expect(source.requests[0]).toMatchObject({ sessionId: 'named-ops', hint: undefined, binding: { seat: 'ops' } })
    expect(sourced.agent.options).toEqual({ provider: 'claude-code', model: 'haiku' })
    await sourced.dispose()
    await staticHandle.dispose()
    await fiber.dispose()
  })

  it('keeps the old unknown-seat refusal when no source is provided', async () => {
    const ctx = await bootedContext()
    const world = hostWorld()
    const fiber = await ctx.plugin(Driver, Driver.Config({ seats: {}, stateDir: 'claude-code', dshHome: world.dshHome }))
    await expect(ctx.agents.create({ sessionId: SessionId('nobody'), driver: 'claude-code', meta: { cwd: world.cwd } }))
      .rejects.toThrow(/no claude-code seat row for "nobody" \(configured seats: none\)/)
    await fiber.dispose()
  })

  it('refuses a caller that carries no binding (the source decides, and the fake refuses)', async () => {
    const world = hostWorld()
    const { ctx, source, fiber } = await mounted(world)
    await expect(ctx.agents.create({ sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd } }))
      .rejects.toThrow(/no binding/)
    expect(source.requests).toHaveLength(1)
    await fiber.dispose()
  })

  it('passes the preset hint to the source', async () => {
    const world = hostWorld()
    const { ctx, source, fiber } = await mounted(world)
    const handle = await ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd, agentPreset: 'ops' },
      agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
    })
    expect(source.requests[0]).toMatchObject({ hint: 'ops' })
    await handle.dispose()
    await fiber.dispose()
  })

  it('refuses a registry row that has no host entry, and prints the stanza to add', async () => {
    const world = hostWorld()
    const { ctx, fiber } = await mounted(world)
    const row = registryRow(world, { admit_from: ['peer', 'lead'] })
    const error = await ctx.agents.create({
      sessionId: SessionId('named-new'), driver: 'claude-code', meta: { cwd: world.cwd }, agentOptions: optionsWith(bindingFor('newcomer', row)),
    }).then(() => undefined, (cause: unknown) => cause as Error)
    expect(error?.message).toContain('seat "newcomer" is routed to claude-code by the registry but has no host entry, so it is refused')
    expect(error?.message).toContain('hostSeats:')
    expect(error?.message).toContain('"newcomer":')
    expect(error?.message).toContain(`cwd: ${JSON.stringify(world.cwd)}`)
    expect(error?.message).toContain('admit_from_ceiling: ["peer", "lead"]')
    expect(ctx.agents.get(SessionId('named-new'))).toBeUndefined()
    await fiber.dispose()
  })

  it('refuses a row asking for senders beyond the founder ceiling', async () => {
    const world = hostWorld()
    const { ctx, fiber } = await mounted(world)
    await expect(ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd },
      agentOptions: optionsWith(bindingFor('ops', registryRow(world, { admit_from: ['peer', 'web-bot'] }))),
    })).rejects.toThrow(/admit_from names "web-bot" beyond the host admit_from_ceiling \[peer\]/)
    await fiber.dispose()
  })

  it('refuses a row whose cwd differs from the host pin, and a caller whose resolved cwd does', async () => {
    const world = hostWorld()
    const { ctx, fiber } = await mounted(world)
    await expect(ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd },
      agentOptions: optionsWith(bindingFor('ops', registryRow(world, { cwd: tempDir('cc-moved-') }))),
    })).rejects.toThrow(/registry cwd .* differs from the host cwd pin/)
    const elsewhere = tempDir('cc-elsewhere-')
    await expect(ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: elsewhere }, agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
    })).rejects.toThrow(/working directory .* differs from the host cwd pin/)
    await fiber.dispose()
  })

  it('refuses a row routed to a different driver', async () => {
    const world = hostWorld()
    const { ctx, fiber } = await mounted(world)
    await expect(ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd },
      agentOptions: optionsWith(bindingFor('ops', registryRow(world, { driver: 'default' }))),
    })).rejects.toThrow(/driver is "default", not "claude-code"/)
    await fiber.dispose()
  })

  it('resumes a routed seat through persistence with the same checks, including the cwd pin', async () => {
    const world = hostWorld()
    const { ctx, fiber } = await mounted(world)
    const headerCwd = { value: world.cwd }
    ctx.provide('sessionPersistence', {
      prepare: (id: SessionId) => Promise.resolve(SessionPreparation.create(ctx.sessions.prepare(id, { meta: { cwd: headerCwd.value } }))),
    } as never)
    const resumed = await ctx.agents.resume({
      resumeSessionId: SessionId('named-ops'), driver: 'claude-code', agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
    })
    expect(resumed.agent.options.model).toBe('haiku')
    await resumed.dispose()
    headerCwd.value = tempDir('cc-moved-')
    await expect(ctx.agents.resume({
      resumeSessionId: SessionId('named-ops'), driver: 'claude-code', agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
    })).rejects.toThrow(/working directory .* differs from the host cwd pin/)
    await fiber.dispose()
  })

  it('keeps every query fence for a source-resolved seat: no tools, no setting sources, strict MCP', async () => {
    const world = hostWorld()
    const { ctx, fiber } = await mounted(world)
    const handle = await ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd }, agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
    })
    const before = sdk.queries.length
    handle.agent.followup(userMessage('hello'))
    const query = await nthQuery(before)
    expect(query.options.settingSources).toEqual([])
    expect(query.options.strictMcpConfig).toBe(true)
    expect(query.options.tools).toEqual([])
    expect(query.options.disallowedTools).toContain('Bash')
    expect(query.options.permissionMode).toBe('dontAsk')
    expect(query.options.pathToClaudeCodeExecutable).toBe(world.binary)
    expect(query.options.model).toBe('haiku')
    expect(query.options.maxTurns).toBe(25)
    query.spawn()
    query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    await handle.agent.whenIdle()
    await handle.dispose()
    await fiber.dispose()
  })

  it('enforces the binary attestation for a source-resolved seat on every turn', async () => {
    const world = hostWorld()
    const { ctx, fiber } = await mounted(world)
    const handle = await ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd }, agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
    })
    const before = sdk.queries.length
    appendFileSync(world.binary, '# swapped\n')
    handle.agent.followup(userMessage('hello'))
    await handle.agent.whenIdle()
    expect(sdk.queries.length).toBe(before)
    expect(JSON.stringify(handle.agent.session.events)).toContain('changed since this host attested it')
    await handle.dispose()
    await fiber.dispose()
  })

  it('hands the sender named in source.from to the admission check', async () => {
    const world = hostWorld()
    const { ctx, fiber } = await mounted(world)
    const seen: MailAdmissionRequest[] = []
    ctx.provide('claudeCodeMailHooks', { admit: (request: MailAdmissionRequest) => { seen.push(request); return { allow: true } } })
    const handle = await ctx.agents.create({
      sessionId: SessionId('named-ops'), driver: 'claude-code', meta: { cwd: world.cwd }, agentOptions: optionsWith(bindingFor('ops', registryRow(world))),
    })
    const before = sdk.queries.length
    handle.agent.followup(mailMessage('hello', 'm-1', { from: 'peer' }))
    const query = await nthQuery(before)
    query.spawn()
    query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    await handle.agent.whenIdle()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ seat: 'ops', from: 'peer', messageId: 'm-1', path: 'send', externalHops: [] })
    // typed input names no sender: the request simply carries no `from`
    handle.agent.followup(userMessage('typed'))
    const typed = await nthQuery(before + 1)
    typed.emit(resultMessage({ user_message_uuids: typed.uuids() }))
    await handle.agent.whenIdle()
    expect(seen[1]).toBeDefined()
    expect('from' in (seen[1] as MailAdmissionRequest)).toBe(false)
    await handle.dispose()
    await fiber.dispose()
  })
})

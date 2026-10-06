import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import type { GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, {
  foldSubagentSettlement,
  MAX_AWAIT_SETTLEMENT_DEADLINE_MS,
  SubagentError,
  SUBAGENT_DESCRIPTOR_VERSION,
} from '../src/index.ts'
import type { SubagentAwaitSettlementResult, SubagentRunEndInfo, SubagentRunInfo } from '../src/index.ts'
import * as SubagentInvariant from '../src/invariant.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

/** One scripted response that may wait on a caller-released gate before streaming. */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Boot the full continuable stack: loop, persistence, providers, and subagents. */
async function setupWith(adapter: LlmAdapter, options: { persistence?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  let disposePersistence: (() => Promise<void>) | undefined
  let root: string | undefined
  if (options.persistence !== false) {
    root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    roots.push(root)
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
    disposePersistence = () => persistenceFiber.dispose()
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, disposePersistence, root }
}

async function setup(script: Script, options: { persistence?: boolean } = {}) {
  const adapter = new MockAdapter(script)
  const booted = await setupWith(adapter, options)
  return { ...booted, adapter }
}

const testSignal = new AbortController().signal

function startSpec(parent: Agent, provider = 'spawn', signal: AbortSignal = testSignal) {
  return {
    provider,
    label: 'child task',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal,
  }
}

function message(text: string) {
  return [{ type: 'text' as const, text }]
}

function hasUserText(events: readonly SessionEvent[], text: string): boolean {
  return events.some(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === text))
}

/** Caller-supplied user message texts in log order (runtime-context snapshots excluded). */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'plugin'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

function followup(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  content: ReturnType<typeof message>,
  signal: AbortSignal = testSignal,
) {
  return ctx.subagents.followup(parent, childId, content, {
    source: { kind: 'user' },
    signal,
  })
}

/**
 * Exercise manager-wide teardown through the package-private owner rather than
 * adding the irreversible operation to the public service contract.
 */
function drainManager(ctx: Context): Promise<void> {
  const manager = (ctx.subagents as unknown as {
    continuations?: { drain(): Promise<void> }
  }).continuations
  if (manager === undefined) throw new Error('expected a bound continuation manager')
  return manager.drain()
}

/**
 * Reach the package-private manager to drive `hasLiveDescendants` directly,
 * the same way {@link drainManager} reaches `drain()`: the operation is
 * deliberately not on the public `SubagentRuntime` surface's test-facing
 * shape (only the pass-through wrapper is), so the manager is the thing a
 * test asserting the actual scan logic must reach.
 */
function continuationManager(ctx: Context): { hasLiveDescendants(root: Agent): boolean } {
  const manager = (ctx.subagents as unknown as {
    continuations?: { hasLiveDescendants(root: Agent): boolean }
  }).continuations
  if (manager === undefined) throw new Error('expected a bound continuation manager')
  return manager
}

/**
 * Reach the process-local "already redelivered" memo the pre-step recheck
 * consults, the same way {@link drainManager} reaches `drain()`: seeding it
 * directly lets a test simulate "this exact process already redelivered
 * this child once" without reconstructing the earlier recheck that would
 * ordinarily have populated it.
 */
function redeliveredSettlementsOf(ctx: Context): Set<SessionId> {
  return (ctx.subagents as unknown as { redeliveredSettlements: Set<SessionId> }).redeliveredSettlements
}

/**
 * Simulate the real `ctx.inject(['agents'], ...)` child-context fiber
 * disposing -- clearing `continuations` exactly as its own teardown effect
 * does (`index.ts`'s `childCtx.effect(() => () => { this.continuations =
 * undefined }, 'subagents.continuationBinding()')`) -- without literally
 * tearing down the real `agents` service.
 *
 * A literal teardown is not reachable from a test: `AgentLoop` statically
 * requires `agents` (`static inject = ['agents', 'sessions', 'llm', 'tools',
 * 'systemPrompt']`), so disposing the real `AgentRegistry` fiber forces
 * `AgentLoop` itself through the same required-dependency unload Cordis
 * gives any other missing static inject, which disposes every live Agent
 * it created as part of that unload -- verified directly, including the
 * tightest case, disposing and immediately (same tick, no intervening
 * await) replugging `AgentRegistry`: the very next call on the
 * already-created parent still throws ("agent initiator scope is
 * disposed") before either promise even settles. There is no live agent
 * left to drive a pre-step through once that teardown starts.
 *
 * This reaches the exact resulting state the real disposal produces
 * instead -- `continuations` cleared, while the `agent/pre-step` listener
 * (bound directly on the service's own ctx in the constructor, never
 * inside that injected child) stays live -- the same way {@link drainManager}
 * and {@link continuationManager} reach other package-private manager state
 * no public API exposes.
 * @param ctx - the context whose `subagents` service to affect.
 * @returns a restorer that puts the real manager back, for clean disposal.
 */
function clearContinuationsBinding(ctx: Context): () => void {
  const subagents = ctx.subagents as unknown as { continuations?: unknown }
  const manager = subagents.continuations
  subagents.continuations = undefined
  return () => { subagents.continuations = manager }
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

/**
 * Keep the top-level test parent out of a scripted model corpus. Every child
 * settlement wakes its parent, so a suite that scripts only child responses
 * would otherwise spend them on the parent's own turns.
 */
function parkParent(ctx: Context, parent: Agent): void {
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
}

/** Observe calls at the Agent cancellation boundary without a production event. */
function observeCancel(agent: Agent, callback: () => void): void {
  const cancel = agent.cancel.bind(agent)
  let observed = false
  vi.spyOn(agent, 'cancel').mockImplementation((cause, options) => {
    if (!observed) {
      observed = true
      callback()
    }
    return cancel(cause, options)
  })
}

describe('SubagentRuntime.startContinuable', () => {
  it('returns both identities at inbox acceptance, without waiting for the turn or the log', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('first answer')])
    const enqueued: { id: MessageId; loggedYet: boolean }[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      // Acceptance is the boundary `startContinuable` resolves at, so observe
      // the log state exactly there rather than after later microtasks.
      enqueued.push({ id: message.id, loggedYet: hasUserText(agent.session.events, 'child task') })
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))

    expect(started.childId).toMatch(/[0-9a-f-]{36}/)
    // The returned id is exactly the accepted inbox message's id, and nothing
    // was logged or requested to earn it.
    expect(enqueued).toEqual([{ id: started.messageId, loggedYet: false }])
    expect(adapter.requests).toEqual([])

    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'child task')).toBe(true)
  })

  it('rejects without ids when the provider has no prepareContinuable capability', async () => {
    const { ctx, parent } = await setup([])
    const start = vi.fn(async () => { throw new Error('must not dispatch') })
    ctx.subagents.registerProvider({
      name: 'one-shot',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start,
    })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'one-shot')))
      .rejects.toThrow(/does not support continuable children/)
    expect(start).not.toHaveBeenCalled()
    // No child Agent and no session were created.
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects synchronously when persistence is not configured', async () => {
    const { ctx, parent } = await setup([textResponse('unused')], { persistence: false })
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toThrow(/require session persistence/)
  })

  it('publishes the reserved child id and appends the pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptorIndex = loaded.events.findIndex(event => event.type === 'subagent/descriptor')
    const turnStartIndex = loaded.events.findIndex(event => event.type === 'turn/start')
    expect(descriptorIndex).toBeGreaterThanOrEqual(0)
    expect(descriptorIndex).toBeLessThan(turnStartIndex)
    const descriptor = loaded.events[descriptorIndex] as SessionEvent<'subagent/descriptor'>
    expect(descriptor.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'child task',
      agentProvider: 'mock',
      agentModel: 'mock',
    })
    // Model-hidden: the descriptor never carries surface metadata.
    expect('surfaceOp' in descriptor).toBe(false)
    expect(loaded.meta.id).toBe(started.childId)
    expect(loaded.meta.parentSession).toBe(SessionId('parent'))
    expect(loaded.meta.origin).toBe('subagent')
  })

  it('rolls the child back completely when the caller signal aborts before acceptance', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const controller = new AbortController()
    // Abort inside the child's creation window: setup runs before publication.
    ctx.on('agent/created', ({ agent: child }) => {
      if (child !== parent) controller.abort('caller gave up')
    })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'spawn', controller.signal)))
      .rejects.toThrow()
    // No Activation, no live child Agent, and no parent ownership remains.
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
  })

  it('rolls the child back when the signal aborts between publication and acceptance', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const controller = new AbortController()
    // `subagent/start` fires once the epoch is resident, before the prompt is
    // submitted, so cancelling here lands squarely in the handoff window.
    ctx.on('subagent/start', () => { controller.abort('caller gave up') })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'spawn', controller.signal)))
      .rejects.toThrow()

    // No resident child and no queued turn survive the abort.
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
  })

  it('rolls an unpublished Activation back when lifecycle publication fails', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))
    ctx.on('internal/dispatch', (_mode, eventName) => {
      if (eventName === 'subagent/start') throw new Error('start publication failed')
    }, { global: true })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toThrow(/start publication failed/)

    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
    expect(ends).toEqual([])
    await expect(drainManager(ctx)).resolves.toBeUndefined()
  })

  it('rejects a continuable child that would exceed the configured depth cap', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: { prompt: message('deep'), parent, maxDepth: 0 },
    })).rejects.toThrow(/exceeds maxDepth 0/)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects an invalid continuable depth cap before provider preparation', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: { prompt: message('deep'), parent, maxDepth: Number.NaN },
    })).rejects.toThrow(/non-negative safe integer/)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('omits undeclared composition fields from the descriptor', async () => {
    const { ctx } = await setup([])
    // A routeless parent declares no provider/model, and this start declares no
    // persona or tool filter, so the descriptor records only what exists.
    const routeless = ctx.agentLoop.create(SessionId('routeless'), {})
    const started = await ctx.subagents.startContinuable(startSpec(routeless))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const descriptor = child.session.events.find(event => event.type === 'subagent/descriptor')

    expect(descriptor?.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'child task',
    })
    await drainManager(ctx)
  })

  it('records a declared tool filter in the descriptor', async () => {
    const { ctx } = await setup([])
    // Register one global tool so the filter names something real.
    ctx.tools.register(defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text', text: 'noop' }],
      },
      execute: () => Promise.resolve({}),
    }))
    const routeless = ctx.agentLoop.create(SessionId('routeless-filtered'), {})
    const started = await ctx.subagents.startContinuable({
      ...startSpec(routeless),
      request: { prompt: message('filtered work'), parent: routeless, toolFilter: { deny: ['noop'] } },
    })
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    expect(child.session.events.find(event => event.type === 'subagent/descriptor')?.data)
      .toEqual({
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'continuable',
        provider: 'spawn',
        label: 'child task',
        toolFilter: { deny: ['noop'] },
      })
    await drainManager(ctx)
  })

  it('cold-resumes without inventing a model route the descriptor never declared', async () => {
    const { ctx, root } = await setup([textResponse('first')])
    const routeless = ctx.agentLoop.create(SessionId('routeless-resume'), {})
    const started = await ctx.subagents.startContinuable(startSpec(routeless))
    await waitNoActivation(ctx, started.childId)

    const fresh = new Context()
    await mountAgentLoopTestDependencies(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root: root! })
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(SubagentRuntime)
    await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })
    const freshParent = fresh.agentLoop.create(SessionId('routeless-resume'), {})
    await followup(fresh, freshParent, started.childId, message('resume routeless'))

    const resumed = await vi.waitFor(() => {
      const found = fresh.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    expect(resumed.options.provider).toBeUndefined()
    expect(resumed.options.model).toBeUndefined()
    await drainManager(fresh)
  })

  it('continues turn numbering after an inherited fork prefix and pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([
      textResponse('parent turn'),
      textResponse('forked child'),
    ])
    // Complete one parent turn so fork has a prefix to contribute.
    parent.followup(createUserMessage({ content: message('parent work'), source: { kind: 'user' } }))
    await parent.whenIdle()

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptorIndex = loaded.events.findIndex(event => event.type === 'subagent/descriptor')
    const childTurn = loaded.events.slice(descriptorIndex + 1)
      .find(event => event.type === 'turn/start')
    // The first child turn after the descriptor continues the inherited prefix
    // rather than restarting at 1, so the replayed child log stays balanced.
    expect(descriptorIndex).toBeGreaterThanOrEqual(0)
    expect(childTurn?.type === 'turn/start' && childTurn.data.turn).toBe(2)
    expect(loaded.meta.seedLength).toBeGreaterThan(0)
  })

  it('records the declared persona in the descriptor and reapplies it on cold resume', async () => {
    const { ctx, parent } = await setup([textResponse('scoped'), textResponse('resumed')])
    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: {
        prompt: message('scoped work'),
        parent,
        persona: 'You are scoped.',
      },
    })
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = loaded.events.find(event => event.type === 'subagent/descriptor')
    expect(descriptor?.data).toMatchObject({ persona: 'You are scoped.' })

    // Cold resume reconstructs the declared composition from that descriptor.
    await followup(ctx, parent, started.childId, message('resume it'))
    await waitNoActivation(ctx, started.childId)
    const resumed = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(resumed.events, 'resume it')).toBe(true)
  })
})

describe('SubagentRuntime.followup residency routing', () => {
  it('enqueues in the same Activation while it is running, preserving one inbox FIFO', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
      { chunks: textResponse('third') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)
    expect(child?.status).toBe('running')

    // Both messages queue behind the open turn, in call order.
    const firstMessage = await followup(ctx, parent, started.childId, message('first follow-up'))
    const secondMessage = await followup(ctx, parent, started.childId, message('second follow-up'))
    expect(firstMessage).not.toBe(secondMessage)
    // Still the same Activation: no second child Agent was created.
    expect(ctx.agents.get(started.childId)).toBe(child)

    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'first follow-up', 'second follow-up'])
  })

  it('cold-resumes a settled child into a new Activation', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const messageId = await followup(ctx, parent, started.childId, message('continue please'))
    expect(messageId).toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'continue please'])
    // One descriptor only: cold resume never re-seeds it.
    expect(loaded.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
  })

  it('cold-resumes after the initial provider unregisters', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SubagentInvariant)
    const disposeProvider = ctx.subagents.registerProvider({
      name: 'retired',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('one-shot start is not used') },
      prepareContinuable: () => Promise.resolve({}),
    })
    const starts: SubagentRunInfo[] = []
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/start', info => void starts.push(info))
    ctx.on('subagent/end', info => void ends.push(info))

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'retired'))
    await waitNoActivation(ctx, started.childId)
    disposeProvider()
    expect(ctx.subagents.getProvider('retired')).toBeUndefined()

    await expect(followup(ctx, parent, started.childId, message('continue without provider')))
      .resolves.toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(2) })

    expect(starts.map(info => info.provider)).toEqual(['retired', 'retired'])
    expect(ends.map(info => info.runId)).toEqual(starts.map(info => info.runId))
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'continue without provider'])
  })

  it('wakes a waiting Activation instead of cold-resuming it', async () => {
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      // The child delegates, then finishes its own turn while the grandchild runs.
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
      { chunks: textResponse('woken') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // The child starts its own continuable grandchild, then goes quiescent.
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(2) })
    await vi.waitFor(() => {
      expect(child.status).toBe('idle')
      expect(ctx.agents.get(started.childId)).toBe(child)
    }, { timeout: 5_000 })
    // Waiting retains the handle: the same Agent is still live.
    expect(ctx.agents.get(started.childId)).toBe(child)

    await followup(ctx, parent, started.childId, message('while waiting'))
    // Woken back to running on the SAME Activation.
    expect(ctx.agents.get(started.childId)).toBe(child)

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    // This child is itself a parent, so its grandchild's settlement notice is
    // an ordinary later user message in its log.
    expect(userTexts(loaded.events).slice(0, 2)).toEqual(['child task', 'while waiting'])
    expect(userTexts(loaded.events).slice(2).join('\n')).toContain('finished and will do no further work')
  })

  it('rejects a parent that is not the durable direct parent', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })

    await expect(followup(ctx, stranger, started.childId, message('mine now')))
      .rejects.toThrow(/belongs to another parent session/)
  })

  it('reports an unresumable child whose persisted log has no supported descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    // A one-shot child has durable identity but no supported continuation state.
    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    await run.result
    await ctx.sessions.flush(run.localAgent!.session)
    const oneShotId = run.id
    await run.dispose()

    await expect(followup(ctx, parent, oneShotId, message('continue')))
      .rejects.toThrow(/no supported continuation state/)
  })

  it('reports an unknown child id as unavailable', async () => {
    const { ctx, parent } = await setup([])
    await expect(followup(ctx, parent, SessionId('missing'), message('hello')))
      .rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
  })

  it('propagates cancellation while inspecting a cold child', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const inspectStarted = Promise.withResolvers<undefined>()
    const inspect = vi.spyOn(ctx.sessionPersistence, 'inspect').mockImplementation((_id, signal) => {
      return new Promise<never>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error('cold inspection must receive the followup signal'))
          return
        }
        inspectStarted.resolve(undefined)
        signal.addEventListener('abort', () => {
          reject(reason)
        }, { once: true })
      })
    })
    const controller = new AbortController()
    const reason = new Error('cold inspection cancelled')

    try {
      const delivery = followup(ctx, parent, started.childId, message('cancel me'), controller.signal)
      await inspectStarted.promise
      controller.abort(reason)
      await expect(delivery).rejects.toBe(reason)
    } finally {
      inspect.mockRestore()
    }
  })

  it('preserves a SubagentError raised while cold-materializing a child', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const failure = new SubagentError('materialization denied', 'UNAUTHORIZED')
    ctx.agents.resume = () => Promise.reject(failure)

    await expect(followup(ctx, parent, started.childId, message('continue')))
      .rejects.toBe(failure)
  })

  it('cold-resumes a delivery that lost the race with final disposal', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after the race')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Deliver in the same tick the settlement watcher opens its transaction:
    // exactly one side wins the cutoff. A delivery that loses awaits release and
    // cold-resumes rather than reaching a handle being torn down.
    const delivery = child.whenIdle().then(() =>
      followup(ctx, parent, started.childId, message('raced')))

    await expect(delivery).resolves.toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'raced')).toBe(true)
  })
})

describe('continuable child ownership', () => {
  it('keeps a parent Activation waiting until its child completes disposal', async () => {
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))

    await vi.waitFor(() => {
      expect(child.status).toBe('idle')
      expect(ctx.agents.get(started.childId)).toBe(child)
    }, { timeout: 5_000 })
    // Child-first: the parent handle is retained while the grandchild is live.
    expect(ctx.agents.get(started.childId)).toBe(child)
    expect(ctx.agents.get(grandchild.childId)).toBeDefined()

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('does not add a top-level parent to the waiting graph', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    // The top-level parent remains independently registered after its child settles.
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })
})

describe('continuable durability and teardown', () => {
  it('settles when the best-effort final flush has no listeners', async () => {
    const releaseResponse = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('unconfirmed answer'), gate: releaseResponse.promise },
    ])
    const { ctx, parent, disposePersistence } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    // Remove every persistence listener; the final flush is advisory.
    await disposePersistence!()
    releaseResponse.resolve(undefined)

    await waitNoActivation(ctx, started.childId)
    expect(warnings.some(warning => warning.includes('final session flush'))).toBe(false)
  })

  it('logs a failed final flush after every listener settles without failing the Activation', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const warnings: string[] = []
    const ends: SubagentRunEndInfo[] = []
    let peerFlushed = false
    ctx.logger.warn = (message: string) => { warnings.push(message) }
    ctx.on('subagent/end', info => void ends.push(info))
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) throw new Error('disk full')
    })
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) peerFlushed = true
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    expect(peerFlushed).toBe(true)
    expect(warnings.some(warning => warning.includes('best-effort final session flush failed'))).toBe(true)
    expect(ends.at(-1)?.stopReason).toBe('completed')
  })

  it('logs a teardown failure reached through normal settlement', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('normal settlement cleanup failed')
    }

    hold.resolve(undefined)

    await vi.waitFor(() => {
      expect(warnings.some(warning => warning.includes('normal settlement cleanup failed'))).toBe(true)
    })
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('disposes every live Activation forest child-first on manager teardown', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })

    const disposals: SessionId[] = []
    ctx.on('agent/disposed', ({ agent }) => { disposals.push(agent.id) })
    const drained = drainManager(ctx)
    // Let the held model call observe its cancellation so quiescence can settle.
    hold.resolve(undefined)
    await drained

    // Child-first: the grandchild's disposal precedes its parent's.
    expect(disposals.indexOf(grandchild.childId)).toBeGreaterThanOrEqual(0)
    expect(disposals.indexOf(grandchild.childId))
      .toBeLessThan(disposals.indexOf(started.childId))
    // Durable sessions survive process-local teardown.
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.meta.id).toBe(started.childId)
  })

  it('drains one parent forest without disabling a sibling parent forest', async () => {
    const releaseTarget = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const releaseSibling = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('target child'), gate: releaseTarget.promise },
      { chunks: textResponse('sibling child'), gate: releaseSibling.promise },
      { chunks: textResponse('target grandchild'), gate: releaseGrandchild.promise },
      { chunks: textResponse('sibling follow-up') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const siblingParent = ctx.agentLoop.create(
      SessionId('sibling-parent'),
      { provider: 'mock', model: 'mock' },
    )
    const target = await ctx.subagents.startContinuable(startSpec(parent))
    const sibling = await ctx.subagents.startContinuable(startSpec(siblingParent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const targetChild = ctx.agents.get(target.childId)!
    const siblingChild = ctx.agents.get(sibling.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(targetChild))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    const cancellations: SessionId[] = []
    observeCancel(targetChild, () => { cancellations.push(targetChild.id) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    observeCancel(grandchildAgent, () => { cancellations.push(grandchildAgent.id) })

    const drained = ctx.subagents.drainContinuableDescendants([parent])
    const convergedDrain = ctx.subagents.drainContinuableDescendants([parent])

    // The scoped cutoff stops only the selected forest. The sibling child stays
    // resident and can accept later work while target cleanup is still blocked.
    expect(cancellations).toEqual([target.childId, grandchild.childId])
    expect(ctx.agents.get(target.childId)).toBe(targetChild)
    expect(ctx.agents.get(grandchild.childId)).toBeDefined()
    expect(ctx.agents.get(sibling.childId)).toBe(siblingChild)
    await expect(followup(ctx, siblingParent, sibling.childId, message('still live')))
      .resolves.toBeTypeOf('string')
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await expect(followup(ctx, parent, target.childId, message('too late')))
      .rejects.toMatchObject({ code: 'DRAINING' })

    releaseTarget.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await Promise.all([drained, convergedDrain])
    expect(ctx.agents.get(target.childId)).toBeUndefined()
    expect(ctx.agents.get(grandchild.childId)).toBeUndefined()
    expect(ctx.agents.get(sibling.childId)).toBe(siblingChild)
    // The exact root remains closed until its host disposes it, even after all
    // current descendants are gone.
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })

    releaseSibling.resolve(undefined)
    await waitNoActivation(ctx, sibling.childId)
  })

  it('retains a continuable root while draining only its descendants', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const cancellations: SessionId[] = []
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    observeCancel(grandchildAgent, () => { cancellations.push(grandchildAgent.id) })

    const drained = ctx.subagents.drainContinuableDescendants([child])

    expect(cancellations).toEqual([grandchild.childId])
    expect(ctx.agents.get(started.childId)).toBe(child)
    releaseGrandchild.resolve(undefined)
    await drained
    expect(ctx.agents.get(grandchild.childId)).toBeUndefined()
    expect(ctx.agents.get(started.childId)).toBe(child)
    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'DRAINING' })

    releaseChild.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('finds scoped descendants after an intermediate one-shot Agent leaves the registry', async () => {
    const releaseIntermediate = Promise.withResolvers<undefined>()
    const releaseDescendant = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('one-shot'), gate: releaseIntermediate.promise },
      { chunks: textResponse('continuable descendant'), gate: releaseDescendant.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot task',
      prompt: message('one-shot task'),
      parent,
      signal: testSignal,
    })
    const intermediate = run.localAgent
    expect(intermediate).toBeDefined()
    if (intermediate === undefined) throw new Error('spawn must publish a local Agent')
    const descendant = await ctx.subagents.startContinuable(startSpec(intermediate))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })

    const intermediateId = intermediate.id
    const disposingIntermediate = run.dispose()
    releaseIntermediate.resolve(undefined)
    await disposingIntermediate
    expect(ctx.agents.get(intermediateId)).toBeUndefined()
    expect(ctx.agents.get(descendant.childId)).toBeDefined()
    const cancellations: SessionId[] = []
    const descendantAgent = ctx.agents.get(descendant.childId)!
    observeCancel(descendantAgent, () => { cancellations.push(descendantAgent.id) })

    const drained = ctx.subagents.drainContinuableDescendants([parent])

    expect(cancellations).toEqual([descendant.childId])
    releaseDescendant.resolve(undefined)
    await drained
    expect(ctx.agents.get(descendant.childId)).toBeUndefined()
  })

  it('awaits and rolls back an admitted materialization below a scoped root', async () => {
    const { ctx, parent } = await setup([])
    const manager = (ctx.subagents as unknown as {
      continuations: { ownerCtx: Context }
    }).continuations
    const agents = manager.ownerCtx.agents
    const create = agents.create.bind(agents)
    const published = Promise.withResolvers<SessionId>()
    const releaseMaterialization = Promise.withResolvers<undefined>()
    const createSpy = vi.spyOn(agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      published.resolve(handle.agent.id)
      await releaseMaterialization.promise
      return handle
    })

    try {
      const starting = ctx.subagents.startContinuable(startSpec(parent))
      const childId = await published.promise
      let drainResolved = false
      const drained = ctx.subagents.drainContinuableDescendants([parent]).then(() => {
        drainResolved = true
      })
      await Promise.resolve()
      expect(drainResolved).toBe(false)

      releaseMaterialization.resolve(undefined)
      await expect(starting).rejects.toMatchObject({ code: 'DRAINING' })
      await drained
      expect(ctx.agents.get(childId)).toBeUndefined()
    } finally {
      createSpy.mockRestore()
    }
  })

  it('ignores a stale scoped root without disabling its live same-id Agent', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await ctx.subagents.drainContinuableDescendants([stale])
    const started = await ctx.subagents.startContinuable(startSpec(parent))

    await waitNoActivation(ctx, started.childId)
  })

  it('reports a scoped teardown failure after releasing the selected branch', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('target child'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped child reap failed')
    }

    const drained = ctx.subagents.drainContinuableDescendants([parent])
    hold.resolve(undefined)

    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('rejects new materialization and delivery once draining begins', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await drainManager(ctx)

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await expect(followup(ctx, parent, started.childId, message('too late')))
      .rejects.toMatchObject({ code: 'DRAINING' })
  })

  it('rejects an initial prompt when drain starts after materialization', async () => {
    const { ctx, parent } = await setup([])
    const drains: Promise<void>[] = []
    const accepted: MessageId[] = []
    ctx.on('subagent/start', () => { drains.push(drainManager(ctx)) })
    ctx.on('agent/inbox/inserted', ({ message }) => { accepted.push(message.id) })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)

    expect(accepted).toEqual([])
    expect(ctx.agents.list()).toEqual([parent])
  })

  it('waits for a published materialization to finish rollback before drain resolves', async () => {
    const { ctx, parent } = await setup([])
    const order: string[] = []
    const drains: Promise<void>[] = []
    ctx.on('agent/created', ({ agent: child }) => {
      if (child === parent) return
      const draining = drainManager(ctx).then(() => { order.push('drain') })
      drains.push(draining)
    })
    ctx.on('agent/disposed', ({ agent: child }) => {
      if (child !== parent) order.push('disposed')
    })

    // `agent/created` runs after registry publication but before materialize()
    // receives the handle and installs the Activation.
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)

    expect(order).toEqual(['disposed', 'drain'])
    expect(ctx.agents.list()).toEqual([parent])
  })

  it('admits a live follow-up before a later drain can begin disposal', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const order: string[] = []
    child.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.content.some(block => block.type === 'text' && block.text === 'before drain')) {
        order.push('enqueue')
      }
    })
    observeCancel(child, () => { order.push('cancel') })

    const delivery = followup(ctx, parent, started.childId, message('before drain'))
    // Let the child-lock operation reach the live admission cutoff. Admission
    // and inbox submission must then complete in one synchronous span.
    await Promise.resolve()
    const drained = drainManager(ctx)
    hold.resolve(undefined)

    await expect(delivery).resolves.toBeTypeOf('string')
    await drained
    expect(order).toEqual(['enqueue', 'cancel'])
  })

  it('has no automatic replay for an accepted but unlogged message', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('first'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    // Accepted into the inbox, but this queued turn never opens.
    await followup(ctx, parent, started.childId, message('never logged'))

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    // Only what actually reached the log is reconstructable.
    expect(hasUserText(loaded.events, 'never logged')).toBe(false)
  })
})

describe('continuable review regressions', () => {
  it('rechecks exact parent liveness after cold-resume materialization', async () => {
    const { ctx } = await setup([textResponse('first')])
    const parentId = SessionId('replaceable-parent')
    const originalParent = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(originalParent.agent))
    await waitNoActivation(ctx, started.childId)

    const manager = (ctx.subagents as unknown as {
      continuations: { ownerCtx: Context }
    }).continuations
    const ownerAgents = manager.ownerCtx.agents
    const originalResume = ownerAgents.resume.bind(ownerAgents)
    const resumed = Promise.withResolvers<undefined>()
    const releaseResume = Promise.withResolvers<undefined>()
    const resumeSpy = vi.spyOn(ownerAgents, 'resume').mockImplementation(async (options) => {
      const handle = await originalResume(options)
      resumed.resolve(undefined)
      await releaseResume.promise
      return handle
    })

    const delivery = followup(
      ctx,
      originalParent.agent,
      started.childId,
      message('must not cross parent replacement'),
    )
    await resumed.promise
    await originalParent.dispose()
    const replacement = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    releaseResume.resolve(undefined)

    await expect(delivery).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    resumeSpy.mockRestore()
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'must not cross parent replacement')).toBe(false)
    await replacement.dispose()
  })

  it('clears the accepted reservation when Agent.followup throws', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, { accepted: Set<MessageId> }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realFollowup = child.followup.bind(child)
    child.followup = () => {
      throw new Error('synthetic inbox failure')
    }

    await expect(followup(ctx, parent, started.childId, message('throws')))
      .rejects.toThrow(/synthetic inbox failure/)
    expect(activation.accepted.size).toBe(0)

    child.followup = realFollowup
    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained
  })

  it('reports the child\'s own terminal reason, not teardown success', async () => {
    // The child hits its token ceiling; teardown still succeeds.
    const { ctx, parent } = await setupWith(new MockAdapter([
      [{ type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'partial' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
        { type: 'finish', reason: { kind: 'max-tokens' } }],
    ]))
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Deriving this from disposal success would report the failure as completed.
    expect(ends[0]!.stopReason).toBe('max-tokens')
  })

  it('rejects a live delivery whose caller signal aborted before admission', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const before = child.session.events.length

    const controller = new AbortController()
    controller.abort('caller gave up')
    await expect(followup(ctx, parent, started.childId, message('cancelled'), controller.signal))
      .rejects.toThrow()

    // Nothing was enqueued, so no later turn can carry it.
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'cancelled')).toBe(false)
    expect(before).toBeGreaterThan(0)
  })

  it('reports this epoch\'s own output, captured while the child was still live', async () => {
    const { ctx, parent } = await setup([textResponse('first answer'), textResponse('second answer')])
    parkParent(ctx, parent)
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Handle disposal unregisters the child, so the edge's content must have
    // been captured before that — an after-the-fact lookup would find nothing.
    expect(ends[0]!.lastAssistantMessage).toEqual([{ type: 'text', text: 'first answer' }])

    // A cold resume is a new epoch: it must report its OWN answer, never the
    // previous epoch's, which the replayed transcript still contains.
    await followup(ctx, parent, started.childId, message('again'))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(2) })
    expect(ends[1]!.lastAssistantMessage).toEqual([{ type: 'text', text: 'second answer' }])
  })

  it('keeps the epoch\'s earlier text past a final empty usage-only message', async () => {
    // A tool-only max-tokens step records an empty assistant/message for
    // usage. The terminal event retains the previous assistant content,
    // including its tool call but not the intervening tool result.
    const { ctx, parent } = await setup([
      toolCallResponse('t1', 'noop', {}, 'partial one'),
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: CallId('t2'), name: 'noop', argumentsDelta: '{}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('t2'), name: 'noop', arguments: '{}' } },
        { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    ])
    ctx.tools.register(defineTool({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [{ type: 'text', text: 'noop' }],
      },
      execute: () => Promise.resolve({}),
    }))
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('max-tokens')
    expect(ends[0]!.lastAssistantMessage).toEqual([
      { type: 'text', text: 'partial one' },
      { type: 'tool-call', id: 't1', name: 'noop', arguments: '{}' },
    ])
  })

  it('reports a resumed epoch that opened no turn without the previous answer', async () => {
    const { ctx, parent } = await setup([textResponse('first answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })
    // Block the resumed prompt so this epoch produces nothing of its own.
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === parent) return next()
      return { kind: 'reject' }
    })
    await followup(ctx, parent, started.childId, message('again'))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Reading the whole session would resurrect 'first answer' here. The
    // rejection discarded the claimed follow-up, so the epoch reads as refused.
    expect(ends[0]!.lastAssistantMessage).toBeUndefined()
    expect(ends[0]!.stopReason).toBe('refusal')
  })

  it('reports handle-disposal failure on the terminal edge', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const activation = await vi.waitFor(() => {
      const found = manager.activations.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped cleanup failed')
    }

    await expect(drainManager(ctx)).rejects.toThrow()
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    // Emitting before disposal would have reported this failed epoch as success.
    expect(ends[0]!.stopReason).toBe('error')
  })

  it('reports a pre-disposal teardown failure on the terminal edge', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, { observer: { capture: (child: Agent) => void } }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    activation.observer.capture = () => { throw new Error('capture failed') }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('error')
  })

  it('preserves independent pre-disposal and handle-disposal failures', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, {
          handle: { dispose: () => Promise<void> }
          observer: { capture: (child: Agent) => void }
        }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!
    const realDispose = activation.handle.dispose.bind(activation.handle)
    activation.observer.capture = () => { throw new Error('capture failed') }
    activation.handle.dispose = async () => {
      await realDispose()
      throw new Error('scoped cleanup failed')
    }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    const failure = await drained.catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    expect(String(failure)).toContain('capture failed')
    expect(String(failure)).toContain('scoped cleanup failed')
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('cancels a running turn before the best-effort final flush', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('slow'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const order: string[] = []
    ctx.on('session/flush', (session) => {
      if (session.header.parentSession !== undefined) order.push('flush')
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    observeCancel(child, () => { order.push('cancel') })

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    // Flushing a still-running turn cannot cover the events cancellation adds.
    expect(order.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('cancel')).toBeLessThan(order.lastIndexOf('flush'))
  })

  it('releases an accepted message that is discarded instead of run', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    // Queue a turn, then cancel so it is discarded rather than dequeued. The
    // Activation must still reach settlement instead of waiting on that id.
    await followup(ctx, parent, started.childId, message('discarded'))

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'discarded')).toBe(false)
  })

  it('settles after a delivery discarded inside its own admission window', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!

    // Cancel from the synchronous enqueue observer: the discard fires after the
    // id is recorded but before `followup()` returns.
    const off = child.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.content.some(block => block.type === 'text' && block.text === 'doomed')) {
        child.cancel({ kind: 'user' })
      }
    })
    await followup(ctx, parent, started.childId, message('doomed'))
    off()

    releaseFirst.resolve(undefined)
    // Retaining the discarded id would pin residency at `running` forever, so
    // reaching no-Activation without an explicit drain is the assertion.
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'doomed')).toBe(false)
  })

  it('releases older ids discarded during a later admission window', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const manager = (ctx.subagents as unknown as {
      continuations: {
        activations: Map<SessionId, { accepted: Set<MessageId> }>
      }
    }).continuations
    const activation = manager.activations.get(started.childId)!

    await followup(ctx, parent, started.childId, message('queued'))
    expect(activation.accepted.size).toBe(1)
    const off = child.ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.content.some(block => block.type === 'text' && block.text === 'doomed')) {
        child.cancel({ kind: 'user' })
      }
    })
    await followup(ctx, parent, started.childId, message('doomed'))
    off()

    expect(activation.accepted.size).toBe(0)
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('reports a prompt a pre-step rejection discarded as refusal', async () => {
    const { ctx, parent } = await setup([])
    parkParent(ctx, parent)
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })
    // A UserPromptSubmit deny or a policy plugin: the child claims its prompt,
    // the rejection discards it, and no step ever runs.
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === parent) return next()
      return { kind: 'reject' }
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    // The parent would otherwise believe a vetoed delivery was done and never
    // resend it — the one failure the settlement promise says cannot happen.
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('refusal')
  })

  it('retains the Activation while an accepted message is still in the inbox', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const registeredAtEnqueue: boolean[] = []
    // A synchronous inbox observer runs before the admitting microtask, the
    // exact window where `Agent.status` is still idle.
    ctx.on('agent/inbox/inserted', ({ agent }) => {
      if (agent.session.header.parentSession !== undefined) {
        registeredAtEnqueue.push(ctx.agents.get(agent.id) === agent)
      }
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)
    await followup(ctx, parent, started.childId, message('queued'))

    expect(registeredAtEnqueue.length).toBeGreaterThan(0)
    expect(registeredAtEnqueue).not.toContain(false)
    expect(ctx.agents.get(started.childId)).toBe(child)
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    // Two child turns; the third request is the parent's own turn on the
    // settlement notice.
    expect(adapter.requests.filter(request => request.sessionId === started.childId)).toHaveLength(2)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'queued')).toBe(true)
  })
})

/** Every settlement notice this agent received, in order, as flat text. */
function settlementNotices(agent: Agent): { sender: string; text: string; summary: string }[] {
  const logged = agent.session.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
  return [...logged, ...agent.inbox.nextStep, ...agent.inbox.nextTurn].flatMap((message) => {
    if (message.source.kind !== 'subagent-settled') return []
    return [{
      sender: message.source.senderSessionId,
      summary: message.source.summary,
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
    }]
  })
}

/** The durable `subagent/settlement` record persisted for one child, if any. */
async function loadSettlement(ctx: Context, childId: SessionId) {
  const loaded = await ctx.sessionPersistence.load(childId)
  return foldSubagentSettlement(loaded.events)
}

describe('continuable settlement delivery', () => {
  it('tells the parent what the child finished with, without being asked', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    const notice = settlementNotices(parent)[0]!
    expect(notice.sender).toBe(started.childId)
    expect(notice.text).toBe(
      `Background subagent ${started.childId} finished and will do no further work unless you send it more.`
      + '\nIts closing message:\nthe answer',
    )
    // The collapsed row states the outcome without the child's content.
    expect(notice.summary).toBe(
      `Background subagent ${started.childId} finished and will do no further work unless you send it more.`,
    )
  })

  it('delivers even when the child already reported for itself', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    await ctx.subagents.reportFrom(child, message('an explicit report'), {
      delivery: 'quiet',
      signal: testSignal,
    })
    await waitNoActivation(ctx, started.childId)

    // The contract is unconditional precisely so the parent-side tool
    // description can promise it; bookkeeping "did it report?" would make the
    // promise conditional on a channel this manager does not own.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
  })

  it('rejects a report from an agent that was never a resident continuable child', async () => {
    const { ctx, parent } = await setup([])

    await expect(ctx.subagents.reportFrom(parent, message('not a subagent'), {
      delivery: 'quiet',
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('rejects a report from a stale duplicate of a live resident child', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    const stale = { ...child, id: child.id } as unknown as Agent

    await expect(ctx.subagents.reportFrom(stale, message('stale report'), {
      delivery: 'quiet',
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    await waitNoActivation(ctx, started.childId)
  })

  it('wakes the parent on a wakeup delivery and reports a rejected send as the parent being unavailable', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    vi.spyOn(parent, 'followup').mockImplementation(() => {
      throw new Error('parent closed during delivery')
    })

    await expect(ctx.subagents.reportFrom(child, message('wake up'), {
      delivery: 'wakeup',
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' })

    await waitNoActivation(ctx, started.childId)
  })

  it('rejects reporting once the direct parent is no longer live', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('held open'), gate: hold.promise }])
    const { ctx } = await setupWith(adapter)
    const host = await ctx.agents.create({
      sessionId: SessionId('report-parent-gone'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })

    await host.dispose()
    await expect(ctx.subagents.reportFrom(child, message('still working'), {
      delivery: 'quiet',
      signal: testSignal,
    })).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' })

    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('delivers the terminal reason when the child never had a chance to report', async () => {
    const { ctx, parent } = await setup([maxTokensResponse('half an ans'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} ran out of room before it finished.`
      + '\nIts closing message:\nhalf an ans',
    )
  })

  it('tells the parent a policy-rejected delivery was declined, not finished', async () => {
    const { ctx, parent } = await setup([textResponse('parent ack')])
    // A pre-step rejection on the child — a UserPromptSubmit deny, a policy
    // plugin — discards the claimed prompt without running it.
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === parent) return next()
      return { kind: 'reject' }
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} declined the task.`
      + '\nIt left no closing message.',
    )
  })

  it('reports a turn that failed before reaching its first step', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('the answer'), gate: releaseFirst.promise },
      { chunks: textResponse('parent ack') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    // The shipped durability checkpoint (`dsh-session-checkpoint-policy`) is
    // fail-closed at the step boundary, so a rejected write ends the turn after
    // it claimed its messages and before it entered a step.
    ctx.on('agent/pre-step', async ({ agent: subject, turn }, next) => {
      if (subject.session.header.parentSession === undefined || turn < 2) return next()
      throw new Error('ENOSPC: no space left on device')
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await followup(ctx, parent, started.childId, message('second task'))
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    // The parent must not be told the child finished: the delivery it is still
    // waiting on was claimed out of the inbox and then swallowed by the failure.
    const child = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(child.events, 'second task')).toBe(false)
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} failed before it finished.`
      + '\nIts closing message:\nthe answer',
    )
  })

  it('reports accepted work cut short before its first step as stopped', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const releaseCheckpoint = Promise.withResolvers<undefined>()
    const atCheckpoint = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('the answer'), gate: releaseFirst.promise }])
    const { ctx, parent } = await setupWith(adapter)
    // A step-boundary participant — the shipped durability checkpoint, a hook,
    // prompt assembly — holding the child's second turn open before its first
    // step, which is where teardown cancellation then catches it.
    ctx.on('agent/pre-step', async ({ agent: subject, turn }, next) => {
      if (subject.session.header.parentSession === undefined || turn < 2) return next()
      atCheckpoint.resolve(undefined)
      await releaseCheckpoint.promise
      return next()
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    // Queued while turn 1 still runs, so turn 2 opens and claims it without a
    // second model call: the Activation is mid-turn when the drain cancels it.
    await followup(ctx, parent, started.childId, message('second task'))
    releaseFirst.resolve(undefined)
    await atCheckpoint.promise
    const drained = drainManager(ctx)
    releaseCheckpoint.resolve(undefined)
    await drained

    // Turn 2 leaves a balanced no-step `aborted` end, so the log alone would
    // answer with turn 1's clean completion and tell the parent its still-unrun
    // task had finished.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIts closing message:\nthe answer',
    )
  })

  it('reports a child stopped before it ever reached the model as stopped', async () => {
    const releaseCheckpoint = Promise.withResolvers<undefined>()
    const atCheckpoint = Promise.withResolvers<undefined>()
    const { ctx, parent } = await setupWith(new GatedAdapter([]))
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject.session.header.parentSession === undefined) return next()
      atCheckpoint.resolve(undefined)
      await releaseCheckpoint.promise
      return next()
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await atCheckpoint.promise
    const drained = drainManager(ctx)
    releaseCheckpoint.resolve(undefined)
    await drained

    // This epoch closed no stepped turn at all, which on its own reads as "had
    // nothing to report"; only the interruption distinguishes it from a child
    // that genuinely finished with no output.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIt left no closing message.',
    )
  })

  it('reports a child an ancestor interrupted before its first step as stopped', async () => {
    const atCheckpoint = Promise.withResolvers<undefined>()
    const releaseCheckpoint = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('parent ack') }])
    const { ctx, parent } = await setupWith(adapter)
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject.session.header.parentSession === undefined) return next()
      atCheckpoint.resolve(undefined)
      await releaseCheckpoint.promise
      return next()
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await atCheckpoint.promise
    // The shipped interrupt path: nothing about it runs inside this manager, so
    // no pre-cancel sample could see it — the child's own log has to say so.
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
    releaseCheckpoint.resolve(undefined)
    await waitNoActivation(ctx, started.childId)

    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIt left no closing message.',
    )
    // `interrupt()` is covered by the same path as any other stop: the
    // durable record reuses `epochStopReason()`'s own 'aborted' mapping,
    // never a fourth near-duplicate "stopped" outcome.
    expect(await loadSettlement(ctx, started.childId)).toMatchObject({
      parentSessionId: parent.id,
      outcome: 'aborted',
    })
  })

  it('reports accepted work cancelled before any turn could open as stopped', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const releaseMaintenance = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('the answer'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    // A descendant keeps the child resident once its own turn closes, so the
    // maintenance phase below is reachable without racing settlement.
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })
    releaseChild.resolve(undefined)
    await vi.waitFor(() => { expect(child.status).toBe('idle') })

    // Context maintenance folds into `idle` and defers waking work, so this
    // delivery is accepted with no turn to claim it.
    const maintaining = child.runMaintenance(async () => { await releaseMaintenance.promise })
    await followup(ctx, parent, started.childId, message('never runs'))
    const drained = drainManager(ctx)
    releaseMaintenance.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await maintaining
    await drained

    // Turn 1 closed cleanly and no later turn opened, so the cancelled queue is
    // the only record that this epoch was cut short.
    expect(hasUserText(child.session.events, 'never runs')).toBe(false)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIts closing message:\nthe answer',
    )
  })

  it('withholds an outcome the harness could not durably release', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose(): Promise<void> } }> }
    }).continuations
    const activation = await vi.waitFor(() => {
      const live = manager.activations.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    const dispose = activation.handle.dispose.bind(activation.handle)
    activation.handle.dispose = async () => {
      await dispose()
      throw new Error('scope unwind failed')
    }

    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} failed before it finished.\nIt left no closing message.`,
    )
  })

  it('gives an idle parent one ordinary turn on the notice', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const turnStarts: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === parent.id && event.type === 'turn/start') turnStarts.push(event.data.turn)
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(1)
    })
    expect(turnStarts).toEqual([1])
  })

  it('batches simultaneous notices into one step of a busy parent', async () => {
    const releaseChildren = Promise.withResolvers<undefined>()
    const releaseParent = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent works'), gate: releaseParent.promise },
      { chunks: textResponse('first child'), gate: releaseChildren.promise },
      { chunks: textResponse('second child'), gate: releaseChildren.promise },
      { chunks: textResponse('parent reacts') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    // Open a parent turn first, so both notices arrive while it is running.
    parent.followup(createUserMessage({ content: message('start working'), source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(parent.status).toBe('running') })

    const first = await ctx.subagents.startContinuable(startSpec(parent))
    const second = await ctx.subagents.startContinuable(startSpec(parent))
    releaseChildren.resolve(undefined)
    await waitNoActivation(ctx, first.childId)
    await waitNoActivation(ctx, second.childId)

    // Both notices are waiting for the same step boundary, not two turns.
    expect(parent.inbox.nextStep).toHaveLength(2)
    expect(parent.inbox.nextTurn).toHaveLength(0)
    const turnStarts: number[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === parent.id && event.type === 'turn/start') turnStarts.push(event.data.turn)
    })
    releaseParent.resolve(undefined)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(2) })
    expect(turnStarts).toEqual([])
    // Both children released together, so which settles first is not ordered.
    expect(new Set(settlementNotices(parent).map(entry => entry.sender)))
      .toEqual(new Set([first.childId, second.childId]))
  })

  it('holds a maintaining parent live until it can read the notice', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const releaseSecond = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('outer') },
      { chunks: textResponse('first inner'), gate: releaseFirst.promise },
      { chunks: textResponse('second inner'), gate: releaseSecond.promise },
      { chunks: textResponse('outer reacts') },
      { chunks: textResponse('root reacts') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startContinuable(startSpec(parent))
    const middle = await vi.waitFor(() => {
      const live = ctx.agents.get(outer.childId)
      expect(live).toBeDefined()
      return live!
    })
    const first = await ctx.subagents.startContinuable(startSpec(middle))
    const second = await ctx.subagents.startContinuable(startSpec(middle))
    await vi.waitFor(() => { expect(middle.status).toBe('idle') })

    // `Agent.status` folds maintenance into `idle`, and a waking send behind it
    // only arms a deferred wake. The first child's release moves the middle
    // Activation's settlement watcher onto its quiescence race; the second one
    // then arrives at exactly the point where an unaccounted delivery would be
    // judged quiet, settled, and cancelled — clearing the inbox it sits in.
    const maintaining = Promise.withResolvers<undefined>()
    const maintenance = middle.runMaintenance(async () => { await maintaining.promise })
    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, first.childId)
    releaseSecond.resolve(undefined)
    await waitNoActivation(ctx, second.childId)
    expect(ctx.agents.get(outer.childId)).toBe(middle)

    maintaining.resolve(undefined)
    await maintenance
    await vi.waitFor(() => { expect(settlementNotices(middle)).toHaveLength(2) })
    expect(settlementNotices(middle).map(entry => entry.sender))
      .toEqual([first.childId, second.childId])
    await waitNoActivation(ctx, outer.childId)
  })

  it('delivers before releasing the ownership that lets the parent settle', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('outer') },
      { chunks: textResponse('inner'), gate: releaseChild.promise },
      { chunks: textResponse('outer reacts') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startContinuable(startSpec(parent))
    const middle = await vi.waitFor(() => {
      const live = ctx.agents.get(outer.childId)
      expect(live).toBeDefined()
      return live!
    })
    const inner = await ctx.subagents.startContinuable(startSpec(middle))
    await vi.waitFor(() => { expect(middle.status).toBe('idle') })

    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { ownedChildren: Set<SessionId> }> }
    }).continuations
    let ownedAtDelivery: SessionId[] | undefined
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent !== middle || message.source.kind !== 'subagent-settled') return
      ownedAtDelivery = [...manager.activations.get(middle.id)!.ownedChildren]
    })

    releaseChild.resolve(undefined)
    await waitNoActivation(ctx, inner.childId)
    // Still owned at delivery: the parent is structurally unable to settle in
    // the window the notice crosses, rather than winning a race against it.
    expect(ownedAtDelivery).toEqual([inner.childId])
    await waitNoActivation(ctx, outer.childId)
  })

  it('does not wake a parent whose own teardown already began', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await drained

    // Delivered and durably logged, but no turn: waking a parent the host is
    // about to dispose spends a model request nothing reads. What happens to the
    // message when that parent is disposed next is pinned by the test below.
    expect(settlementNotices(parent)).toHaveLength(1)
    expect(settlementNotices(parent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIt left no closing message.',
    )
    expect(parent.session.events.some(event => event.type === 'agent/inbox/spliced')).toBe(true)
    expect(parent.session.events.some(event => event.type === 'turn/start')).toBe(false)
    expect(parent.status).toBe('idle')
    // The durable record survives loss case (b): injected but never woken,
    // the push lands in the log without ever starting a turn to read it.
    expect(await loadSettlement(ctx, started.childId)).toMatchObject({
      parentSessionId: parent.id,
      outcome: 'aborted',
    })
  })

  it('does not wake a parent below a scoped teardown root', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = ctx.subagents.drainContinuableDescendants([parent])
    hold.resolve(undefined)
    await drained

    expect(settlementNotices(parent)).toHaveLength(1)
    expect(parent.session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  it('records but cannot deliver a teardown notice once the parent is disposed too', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx } = await setupWith(adapter)
    const parentId = SessionId('closing-parent')
    const host = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const drained = ctx.subagents.drainContinuableDescendants([host.agent])
    hold.resolve(undefined)
    await drained
    expect(settlementNotices(host.agent)).toHaveLength(1)

    // Disposal is a `keepInbox: false` cancel, so it durably cancels the notice
    // it never claimed. Teardown delivery therefore reaches a parent that is
    // still resident — a resumed one reads the log, not a pending message — and
    // no wording anywhere may promise otherwise.
    await host.dispose()
    const resumed = await ctx.agents.resume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(settlementNotices(resumed.agent)).toEqual([])
    await resumed.dispose()
    // The account is still in the durable log: delivered, then cancelled unread.
    const persisted = await ctx.sessionPersistence.load(parentId)
    expect(persisted.events.flatMap(event => event.type === 'agent/inbox/spliced'
      ? [{ inserted: event.data.inserted.length, removed: event.data.removedCount ?? 0 }]
      : [])).toEqual([{ inserted: 1, removed: 0 }, { inserted: 0, removed: 1 }])
    // The durable record survives loss case (d): the parent disposed before
    // the waking send could ever be read, cancelling the notice durably —
    // but the child's own log still has the fact, unaffected by the parent's
    // own cancelled inbox.
    expect(await loadSettlement(ctx, started.childId)).toMatchObject({
      parentSessionId: parentId,
      outcome: 'aborted',
    })
  })

  it('drops the notice without disturbing teardown when the parent is gone', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: releaseChild.promise }])
    const { ctx } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }
    const host = await ctx.agents.create({
      sessionId: SessionId('disposable-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    releaseChild.resolve(undefined)
    await host.dispose()
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(warnings).toEqual([])
    // The durable record survives loss case (a): the parent is gone from
    // `ctx.agents` by the time `notifySettlement` runs, so the push is a
    // silent unconditional no-op, but the child's own log still has the fact.
    expect(await loadSettlement(ctx, started.childId)).toMatchObject({
      parentSessionId: host.agent.id,
      outcome: ends[0]!.stopReason,
    })
  })

  it('logs a rejected notice instead of failing the child\'s teardown', async () => {
    const { ctx, parent } = await setup([textResponse('the answer')])
    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }
    vi.spyOn(parent, 'followup').mockImplementation(() => {
      throw new Error('parent closed during delivery')
    })
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect(ends[0]!.stopReason).toBe('completed')
    expect(warnings.some(warning => warning.includes('settlement notice was not delivered'))).toBe(true)
    // The durable record survives the lost push: loss case (c), a delivery
    // that throws, still leaves the fact discoverable on the child's own log.
    expect(await loadSettlement(ctx, started.childId)).toMatchObject({
      parentSessionId: parent.id,
      outcome: 'completed',
    })
  })

  it('stays silent about a child the caller was told does not exist', async () => {
    const { ctx, parent } = await setup([])
    const drains: Promise<void>[] = []
    ctx.on('subagent/start', () => { drains.push(drainManager(ctx)) })

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await Promise.all(drains)
    expect(settlementNotices(parent)).toEqual([])
  })

  it('logs an append failure instead of blocking teardown, and still delivers the fast-path notice', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    const append = child.session.append.bind(child.session)
    child.session.append = (type: string, data: unknown, ...opts: unknown[]) => {
      if (type === 'subagent/settlement') throw new Error('disk full')
      // Forwarding the real generic overload's args verbatim.
      // oxlint-disable-next-line typescript/no-explicit-any, typescript/no-unsafe-call, typescript/no-unsafe-return
      return (append as any)(type, data, ...opts)
    }

    await waitNoActivation(ctx, started.childId)
    // Teardown completed and the fast-path push still landed, even though the
    // durable append for this same epoch failed.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })
    expect(warnings.some(warning => warning.includes('durable settlement record was not appended'))).toBe(true)
    // Nothing was appended under the current format version: the throw
    // happened before the log changed.
    const persisted = await ctx.sessionPersistence.load(started.childId)
    expect(persisted.events.some(event => event.type === 'subagent/settlement')).toBe(false)
  })
})

describe('SubagentContinuationManager.awaitSettlement', () => {
  function manager(ctx: Context) {
    const found = (ctx.subagents as unknown as {
      continuations?: { awaitSettlement(
        childId: SessionId, parent: Agent, deadlineMs: number, signal?: AbortSignal,
      ): Promise<SubagentAwaitSettlementResult> }
    }).continuations
    if (found === undefined) throw new Error('expected a bound continuation manager')
    return found
  }

  it('resolves on the fast path, well inside a generous deadline, once the child settles', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))

    const waited = ctx.subagents.awaitSettlement(started.childId, parent, 2_000)
    hold.resolve(undefined)
    const result = await waited

    expect(result).toMatchObject({ status: 'settled', outcome: 'completed' })
    await waitNoActivation(ctx, started.childId)
  })

  it('falls back to the one authoritative persistence read once the deadline passes', async () => {
    // The child is already fully settled before `awaitSettlement` is ever
    // called, so the freshly registered fast-path listener cannot have
    // missed a live event — there is no event left to miss. Resolving here
    // can only come from the deadline's own read of the durable record.
    const { ctx, parent } = await setup([textResponse('answer')])
    await ctx.plugin(SessionProjectionRegistry)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const result = await ctx.subagents.awaitSettlement(started.childId, parent, 10)
    expect(result).toEqual({ status: 'settled', outcome: 'completed', settledAt: expect.any(Number) as unknown })
  })

  it('reports pending when the deadline passes with no settlement yet', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    await ctx.plugin(SessionProjectionRegistry)
    const started = await ctx.subagents.startContinuable(startSpec(parent))

    const result = await ctx.subagents.awaitSettlement(started.childId, parent, 10)
    expect(result).toEqual({ status: 'pending' })

    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('clamps a deadline above the module cap instead of waiting out the caller\'s request', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    await ctx.plugin(SessionProjectionRegistry)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const result = manager(ctx).awaitSettlement(
        started.childId, parent, MAX_AWAIT_SETTLEMENT_DEADLINE_MS * 100,
      )
      await vi.advanceTimersByTimeAsync(MAX_AWAIT_SETTLEMENT_DEADLINE_MS)
      await expect(result).resolves.toMatchObject({ status: 'settled', outcome: 'completed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a parent that is not this child\'s durable direct parent', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const other = await ctx.agents.create({
      sessionId: SessionId('not-the-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    await expect(ctx.subagents.awaitSettlement(started.childId, other.agent, 10))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await other.dispose()
  })

  it('rejects when the parent reference is no longer the exact live registry entry', async () => {
    const { ctx } = await setup([textResponse('answer')])
    const host = await ctx.agents.create({
      sessionId: SessionId('awaiting-stale-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    await waitNoActivation(ctx, started.childId)
    // Captured before disposal: `host.agent` is now a stale reference the
    // registry no longer backs, even though nothing about its fields changed.
    const stale = host.agent
    await host.dispose()

    await expect(ctx.subagents.awaitSettlement(started.childId, stale, 10))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('ignores another child\'s end event while racing toward this one\'s', async () => {
    const holdSibling = Promise.withResolvers<undefined>()
    const holdTarget = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('sibling done'), gate: holdSibling.promise },
      { chunks: textResponse('target done'), gate: holdTarget.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const sibling = await ctx.subagents.startContinuable(startSpec(parent))
    const target = await ctx.subagents.startContinuable(startSpec(parent))

    // Both children share the same parent carrier, so the fast-path listener
    // observes the sibling's unrelated `subagent/end` too; it must filter
    // that one out and keep waiting for the actual target.
    const waited = ctx.subagents.awaitSettlement(target.childId, parent, 2_000)
    holdSibling.resolve(undefined)
    await waitNoActivation(ctx, sibling.childId)
    holdTarget.resolve(undefined)
    const result = await waited

    expect(result).toMatchObject({ status: 'settled', outcome: 'completed' })
    await waitNoActivation(ctx, target.childId)
  })

  it('throws when the sessionProjections registry is unavailable at the deadline', async () => {
    // Deliberately no `ctx.plugin(SessionProjectionRegistry)` here, unlike
    // the deadline tests above: the one authoritative read requires it, and
    // its absence must surface as this stable, documented failure rather
    // than hang or silently report `pending`.
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await expect(ctx.subagents.awaitSettlement(started.childId, parent, 10))
      .rejects.toMatchObject({ code: 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE' })
  })

  it('honors the caller signal over both the fast path and the deadline', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const controller = new AbortController()

    const waited = ctx.subagents.awaitSettlement(started.childId, parent, 2_000, controller.signal)
    controller.abort(new Error('caller gave up'))
    await expect(waited).rejects.toThrow('caller gave up')

    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('wraps a non-Error abort reason in a stable Error instead of rejecting with it verbatim', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('answer'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const controller = new AbortController()

    const waited = ctx.subagents.awaitSettlement(started.childId, parent, 2_000, controller.signal)
    controller.abort('a plain string reason, not an Error')
    await expect(waited).rejects.toBeInstanceOf(Error)
    await expect(waited).rejects.toThrow('aborted')

    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })
})

describe('SubagentRuntime pre-step settlement recheck', () => {
  it('synthesizes exactly one redelivered notice once the push was lost, and none again once it has landed', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('interrupted'), gate: hold.promise },
      { chunks: textResponse('resumed turn 1') },
      { chunks: textResponse('resumed turn 2') },
    ])
    const { ctx } = await setupWith(adapter)
    await ctx.plugin(SessionProjectionRegistry)
    const parentId = SessionId('recheck-parent')
    const host = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    // Lose the push exactly as the "disposed too" regression above does: the
    // teardown notice is injected, then durably cancelled before anything
    // reads it.
    const drained = ctx.subagents.drainContinuableDescendants([host.agent])
    hold.resolve(undefined)
    await drained
    expect(settlementNotices(host.agent)).toHaveLength(1)
    await host.dispose()

    const resumed = await ctx.agents.resume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(settlementNotices(resumed.agent)).toEqual([])

    // The resumed parent's own next step is where the recheck runs.
    resumed.agent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(settlementNotices(resumed.agent)).toHaveLength(1) })
    expect(settlementNotices(resumed.agent)[0]!.sender).toBe(started.childId)
    // The durable record carries outcome and timing only, never the child's
    // final output, so a redelivered notice always reports no closing message.
    expect(settlementNotices(resumed.agent)[0]!.text).toBe(
      `Background subagent ${started.childId} was stopped before it finished.`
      + '\nIt left no closing message.',
    )

    // A second step must not synthesize a second notice: the redelivered one
    // is now in the resumed parent's own log, same as any other.
    resumed.agent.followup(createUserMessage({ content: message('again'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(resumed.agent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 2))
        .toBe(true)
    })
    expect(settlementNotices(resumed.agent)).toHaveLength(1)

    await resumed.dispose()
  })

  it('synthesizes nothing on the parent\'s next step once the original push has already landed', async () => {
    const { ctx, parent } = await setup([textResponse('the answer'), textResponse('parent ack')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })

    // The parent's own next step (the "parent ack" turn the live push already
    // woke) must not pick up a second, redundant notice.
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 1)).toBe(true)
    })
    expect(settlementNotices(parent)).toHaveLength(1)
  })

  it('treats an already-committed notice in the session log as sufficient', async () => {
    const { ctx, parent } = await setup([textResponse('settle me'), textResponse('ack'), textResponse('go ack')])
    await ctx.plugin(SessionProjectionRegistry)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    // Let the ordinary fast path's own notice fully land first, so this test
    // adds a SECOND, independently-committed notice on top of it rather than
    // racing the first one's own in-flight claim/commit window.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })

    const summary = `Background subagent ${started.childId} completed.`
    parent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: summary }, { type: 'text', text: 'It left no closing message.' }],
      source: {
        kind: 'subagent-settled', form: 'notice', summary, senderSessionId: started.childId,
      },
    }), { surfaceOp: 'append' })
    expect(settlementNotices(parent)).toHaveLength(2)

    // The parent's next step re-runs the recheck for this same child; its
    // settlement is still durably present, but the log already carries a
    // matching notice (the one just appended), so nothing is added on top.
    parent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 2)).toBe(true)
    })
    expect(settlementNotices(parent)).toHaveLength(2)
  })

  it('treats a pending next-turn message as sufficient, without waiting for it to commit', async () => {
    const { ctx, parent } = await setup(
      [textResponse('settle me'), textResponse('ack'), textResponse('trigger ack')],
    )
    await ctx.plugin(SessionProjectionRegistry)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    // Let the ordinary fast path's own notice fully land first, so this test
    // adds a SECOND, independently-queued notice on top of it rather than
    // racing the first one's own in-flight claim/commit window.
    await vi.waitFor(() => { expect(settlementNotices(parent)).toHaveLength(1) })

    const summary = `Background subagent ${started.childId} completed.`
    parent.followup(createUserMessage({ content: message('trigger'), source: { kind: 'user' } }))
    // Queued onto the *next* turn, behind the trigger above: `next-turn`
    // claims only its first entry at a turn boundary, so this one stays
    // genuinely pending -- neither claimed nor committed -- through the
    // trigger's own (single-step) turn, which is exactly where the recheck
    // must still find it.
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: summary }, { type: 'text', text: 'It left no closing message.' }],
      source: {
        kind: 'subagent-settled', form: 'notice', summary, senderSessionId: started.childId,
      },
    }))
    expect(settlementNotices(parent)).toHaveLength(2)

    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 2)).toBe(true)
    })
    expect(settlementNotices(parent)).toHaveLength(2)
  })

  it('logs a warning and keeps the step moving when redelivery itself fails', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('interrupted'), gate: hold.promise },
      { chunks: textResponse('resumed turn 1') },
    ])
    const { ctx } = await setupWith(adapter)
    await ctx.plugin(SessionProjectionRegistry)
    const parentId = SessionId('recheck-redelivery-failure-parent')
    const host = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    // Lose the push exactly as the redelivery test above does.
    const drained = ctx.subagents.drainContinuableDescendants([host.agent])
    hold.resolve(undefined)
    await drained
    await host.dispose()

    const resumed = await ctx.agents.resume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }
    resumed.agent.inject = () => { throw new Error('inbox rejected the notice') }

    resumed.agent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(warnings.some(warning => warning.includes('settlement notice redelivery'))).toBe(true)
    })
    // The step still completed normally despite the failed redelivery.
    await vi.waitFor(() => {
      expect(resumed.agent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 1))
        .toBe(true)
    })
    await resumed.dispose()
  })

  it('redelivers after a real process restart, not only within one ctx', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('interrupted'), gate: hold.promise }])
    const { ctx, root } = await setupWith(adapter)
    await ctx.plugin(SessionProjectionRegistry)
    const parentId = SessionId('restart-recheck-parent')
    const host = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    // Lose the push exactly as the same-process regression above does: the
    // teardown notice is injected, then durably cancelled before anything
    // reads it -- before this whole process (ctx) is discarded entirely,
    // never to be resumed again.
    const drained = ctx.subagents.drainContinuableDescendants([host.agent])
    hold.resolve(undefined)
    await drained
    expect(settlementNotices(host.agent)).toHaveLength(1)
    // Force the parent's own durable write before disposal: `host.dispose()`
    // cancels its in-flight wake turn (a `keepInbox: false` cancel) before
    // that turn's own commit, so without this explicit flush the resumed
    // process below would find no persisted session at all for it.
    await ctx.sessions.flush(host.agent.session)
    await host.dispose()

    // A genuinely NEW process: a brand-new Context and a brand-new
    // SubagentRuntime instance, sharing no in-memory state at all with the
    // ctx above -- only the persisted root on disk connects them. Unlike
    // `ctx.agents.resume` within the first ctx (which keeps that same
    // SubagentRuntime's bookkeeping alive across the dispose/resume), this
    // is the actual restart MUST-FIX 1 targets.
    const fresh = new Context()
    await mountAgentLoopTestDependencies(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root: root! })
    await fresh.plugin(SessionProjectionRegistry)
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(SubagentRuntime)
    await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })
    fresh.llm.registerAdapter(['mock'], new MockAdapter([textResponse('resumed turn')]))

    const resumed = await fresh.agents.resume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(settlementNotices(resumed.agent)).toEqual([])

    // This fresh process's very first pre-step for this parent is where
    // discovery must run and redeliver: there is no leftover process-local
    // "known parent" state from the old process to have gated it.
    resumed.agent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(settlementNotices(resumed.agent)).toHaveLength(1) })
    expect(settlementNotices(resumed.agent)[0]!.sender).toBe(started.childId)

    await resumed.dispose()
  })

  it('never calls persistence.list again once a parent\'s first step finds nothing outstanding', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    await ctx.plugin(SessionProjectionRegistry)
    const listSpy = vi.spyOn(ctx.sessionPersistence, 'list')

    parent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 1)).toBe(true)
    })
    // The parent has never had a continuable child; discovery's one-time scan
    // still ran on this first step (there is no cheaper way to tell without
    // it), found nothing, and cached that emptiness.
    expect(listSpy).toHaveBeenCalledTimes(1)

    parent.followup(createUserMessage({ content: message('again'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 2)).toBe(true)
    })
    // A second step for the same parent must not re-scan: the cached empty
    // outstanding set is enough to answer "nothing to redeliver" on its own.
    expect(listSpy).toHaveBeenCalledTimes(1)
  })

  it('caches nothing and retries on a later step when discovery itself fails for a non-capability reason', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    await ctx.plugin(SessionProjectionRegistry)
    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }
    const listChildrenSpy = vi.spyOn(ctx.subagents, 'listChildren').mockImplementationOnce(
      () => Promise.reject(new Error('transient read failure')),
    )

    parent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 1)).toBe(true)
    })
    expect(warnings.some(warning => warning.includes('settlement discovery'))).toBe(true)
    expect(listChildrenSpy).toHaveBeenCalledTimes(1)

    parent.followup(createUserMessage({ content: message('again'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 2)).toBe(true)
    })
    // Nothing was cached from the earlier failure, so this later step retries
    // discovery from scratch rather than treating the parent as "checked".
    expect(listChildrenSpy).toHaveBeenCalledTimes(2)
  })

  it('merges a concurrently live-tracked settlement into its first discovery scan instead of clobbering it', async () => {
    const { ctx, parent } = await setup([textResponse('L settles'), textResponse('parent ack')])
    await ctx.plugin(SessionProjectionRegistry)

    const gate = Promise.withResolvers<undefined>()
    const realListChildren = ctx.subagents.listChildren.bind(ctx.subagents)
    const listChildrenSpy = vi.spyOn(ctx.subagents, 'listChildren').mockImplementationOnce(async (...args) => {
      await gate.promise
      return realListChildren(...args)
    })

    // Starts the parent's first-ever pre-step -- discovery begins, blocked
    // on the gate above -- from unrelated work, independent of any child.
    parent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(listChildrenSpy).toHaveBeenCalledTimes(1) })

    // While that first scan is still in flight, L settles for real: its own
    // `finishDisposal` calls `trackOutstandingSettlement` and installs this
    // parent's outstanding entry before the gated scan below ever resolves.
    const l = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, l.childId)
    expect(settlementNotices(parent).filter(notice => notice.sender === l.childId)).toHaveLength(1)

    gate.resolve(undefined)
    await vi.waitFor(() => {
      expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 1)).toBe(true)
    })
    // The resolved scan now also lists L as settled; merging into the
    // already-installed entry (rather than replacing it) must not have
    // duplicated the notice L's own live push already delivered.
    expect(settlementNotices(parent).filter(notice => notice.sender === l.childId)).toHaveLength(1)
  })

  it('never synthesizes a duplicate for a child whose live push races the recheck mid-disposal', async () => {
    // Two child turns, plus a generous supply for the parent's own wake
    // turns below (one when B settles, one when A finally does): every wake
    // still dispatches `agent/pre-step` -- where the recheck runs -- before
    // any of these responses are needed.
    const { ctx, parent } = await setup([
      textResponse('A done'), textResponse('B done'), textResponse('parent ack 1'), textResponse('parent ack 2'),
    ])
    await ctx.plugin(SessionProjectionRegistry)

    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose(): Promise<void> } }> }
    }).continuations

    const a = await ctx.subagents.startContinuable(startSpec(parent))
    const aActivation = await vi.waitFor(() => {
      const found = manager.activations.get(a.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Widen child A's disposal window: its durable settlement record and
    // `trackOutstandingSettlement` push-in-flight mark both land well before
    // this gate opens, exactly the window the MUST-FIX 3 regression targets.
    const releaseADispose = Promise.withResolvers<undefined>()
    const realDisposeA = aActivation.handle.dispose.bind(aActivation.handle)
    aActivation.handle.dispose = async () => {
      await releaseADispose.promise
      return realDisposeA()
    }

    // B settles normally while A is stuck mid-disposal; B's own live push
    // wakes the parent, whose pre-step recheck runs with A's outstanding
    // entry still `pushInFlight`.
    const b = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => {
      expect(settlementNotices(parent).some(notice => notice.sender === b.childId)).toBe(true)
    })
    // The recheck has now run at least once with A mid-disposal and must
    // have skipped it: no notice for A yet at all.
    expect(settlementNotices(parent).some(notice => notice.sender === a.childId)).toBe(false)

    releaseADispose.resolve(undefined)
    await waitNoActivation(ctx, a.childId)
    await vi.waitFor(() => {
      expect(settlementNotices(parent).some(notice => notice.sender === a.childId)).toBe(true)
    })

    expect(settlementNotices(parent).filter(notice => notice.sender === a.childId)).toHaveLength(1)
    expect(settlementNotices(parent).filter(notice => notice.sender === b.childId)).toHaveLength(1)
  })

  it('on a cold parent\'s first discovery, skips a still-running child, an already-redelivered one, and an already-noticed one', async () => {
    const dHold = Promise.withResolvers<undefined>()
    const nHold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('D done'), gate: dHold.promise },
      { chunks: textResponse('N done'), gate: nHold.promise },
    ])
    const { ctx, root } = await setupWith(adapter)
    await ctx.plugin(SessionProjectionRegistry)
    const parentId = SessionId('discovery-skip-parent')
    const host = await ctx.agents.create({ sessionId: parentId, agentOptions: { provider: 'mock', model: 'mock' } })

    const d = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(d.childId)).toBeDefined() })
    const n = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(n.childId)).toBeDefined() })

    // Settle D and N for real, durably, in the OLD process -- same
    // drain+lose-push+flush+dispose mechanism as the restart test above.
    const drained = ctx.subagents.drainContinuableDescendants([host.agent])
    dHold.resolve(undefined)
    nHold.resolve(undefined)
    await drained
    expect(settlementNotices(host.agent)).toHaveLength(2)
    await ctx.sessions.flush(host.agent.session)
    await host.dispose()

    // A genuinely new process, sharing nothing in memory with the one above.
    const fresh = new Context()
    await mountAgentLoopTestDependencies(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root: root! })
    await fresh.plugin(SessionProjectionRegistry)
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(SubagentRuntime)
    await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })

    const rHold = Promise.withResolvers<undefined>()
    fresh.llm.registerAdapter(['mock'], new GatedAdapter([
      { chunks: textResponse('R running'), gate: rHold.promise },
      { chunks: textResponse('parent ack') },
    ]))

    const resumed = await fresh.agents.resume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    // Pre-seed N's notice directly onto the resumed parent's own log, before
    // its first-ever pre-step: discovery must recognize it is already there
    // and skip re-synthesizing a duplicate.
    const nSummary = `Background subagent ${n.childId} completed.`
    resumed.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: nSummary }, { type: 'text', text: 'It left no closing message.' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: nSummary, senderSessionId: n.childId },
    }), { surfaceOp: 'append' })

    // R is a fresh child of this same process, started but never settled --
    // it stays "running" for the whole test, so discovery must skip it too.
    const r = await fresh.subagents.startContinuable(startSpec(resumed.agent))
    await vi.waitFor(() => { expect(fresh.agents.get(r.childId)).toBeDefined() })

    // D is pre-seeded as already redelivered (as if an earlier step in this
    // same fresh process had already handled it), so discovery must not
    // re-synthesize a notice for it either.
    redeliveredSettlementsOf(fresh).add(d.childId)

    // The parent's first-ever pre-step in this fresh process: discovery runs
    // once here, scanning D (redelivered), N (already noticed) and R
    // (still running) -- all three skip branches in the same scan.
    resumed.agent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(resumed.agent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 1)).toBe(true)
    })

    expect(settlementNotices(resumed.agent).filter(notice => notice.sender === d.childId)).toHaveLength(0)
    expect(settlementNotices(resumed.agent).filter(notice => notice.sender === n.childId)).toHaveLength(1)
    expect(settlementNotices(resumed.agent).filter(notice => notice.sender === r.childId)).toHaveLength(0)

    rHold.resolve(undefined)
    await waitNoActivation(fresh, r.childId)
    await resumed.dispose()
  })

  it('discovers an old-process sibling even when a new sibling was live-tracked first, before any pre-step', async () => {
    const aHold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('A done'), gate: aHold.promise }])
    const { ctx, root } = await setupWith(adapter)
    await ctx.plugin(SessionProjectionRegistry)
    const parentId = SessionId('discovery-live-first-parent')
    const host = await ctx.agents.create({ sessionId: parentId, agentOptions: { provider: 'mock', model: 'mock' } })

    // A settles durably in the OLD process, its push lost -- same
    // drain+lose-push+flush+dispose mechanism as the restart test above.
    const a = await ctx.subagents.startContinuable(startSpec(host.agent))
    await vi.waitFor(() => { expect(ctx.agents.get(a.childId)).toBeDefined() })
    const drained = ctx.subagents.drainContinuableDescendants([host.agent])
    aHold.resolve(undefined)
    await drained
    expect(settlementNotices(host.agent)).toHaveLength(1)
    await ctx.sessions.flush(host.agent.session)
    await host.dispose()

    // A genuinely new process.
    const fresh = new Context()
    await mountAgentLoopTestDependencies(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root: root! })
    await fresh.plugin(SessionProjectionRegistry)
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(SubagentRuntime)
    await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })

    const bHold = Promise.withResolvers<undefined>()
    fresh.llm.registerAdapter(['mock'], new GatedAdapter([
      { chunks: textResponse('B done'), gate: bHold.promise },
      { chunks: textResponse('parent ack') },
    ]))

    const resumed = await fresh.agents.resume({
      resumeSessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    // Before the parent has taken a single pre-step in this fresh process, a
    // NEW child B is started directly (service-API use, as this spec file
    // does throughout, not through a parent turn) and settles, live-tracking
    // this parent's outstanding entry via `trackOutstandingSettlement` --
    // bootstrapping `outstandingByParent.get(parentId)` to a defined (but
    // A-less) map well before `discoverOutstandingSettlements` has ever run
    // for this parent.
    const b = await fresh.subagents.startContinuable(startSpec(resumed.agent))
    await vi.waitFor(() => { expect(fresh.agents.get(b.childId)).toBeDefined() })
    bHold.resolve(undefined)
    await waitNoActivation(fresh, b.childId)

    // The parent's first pre-step in this fresh process: discovery must
    // still run here -- despite `outstandingByParent` already holding a
    // live-tracked entry for this parent -- and find A on disk, merging
    // alongside whatever B's own live tracking already left behind.
    resumed.agent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(settlementNotices(resumed.agent).some(notice => notice.sender === a.childId)).toBe(true)
      expect(settlementNotices(resumed.agent).some(notice => notice.sender === b.childId)).toBe(true)
    })

    expect(settlementNotices(resumed.agent).filter(notice => notice.sender === a.childId)).toHaveLength(1)
    expect(settlementNotices(resumed.agent).filter(notice => notice.sender === b.childId)).toHaveLength(1)

    await resumed.dispose()
  })

  it('drops a redelivery attempt without throwing when the agents-fiber reload window finds the manager unset', async () => {
    const adapter = new GatedAdapter([{ chunks: textResponse('parent turn during the reload window') }])
    const { ctx, parent } = await setupWith(adapter)

    // Seed a process-local outstanding entry directly, the same way
    // `redeliveredSettlementsOf` seeds its own memo: this isolates the
    // branch under test from how an entry ordinarily gets there (a real
    // settlement's live push, or discovery), both already covered by the
    // other tests in this block, so this one test is solely about what
    // happens once `continuations` is unset while something is outstanding.
    const fakeChildId = SessionId('reload-window-fake-child')
    const outstandingByParent = (ctx.subagents as unknown as {
      outstandingByParent: Map<SessionId, Map<SessionId, { outcome: string; pushInFlight: boolean }>>
    }).outstandingByParent
    const discoveredParents = (ctx.subagents as unknown as { discoveredParents: Set<SessionId> }).discoveredParents
    discoveredParents.add(parent.id)
    outstandingByParent.set(parent.id, new Map([[fakeChildId, { outcome: 'completed', pushInFlight: false }]]))

    const warnings: string[] = []
    ctx.logger.warn = (text: string) => { warnings.push(text) }

    const restore = clearContinuationsBinding(ctx)
    try {
      parent.followup(createUserMessage({ content: message('go'), source: { kind: 'user' } }))
      await vi.waitFor(() => {
        expect(parent.session.events.some(event => event.type === 'turn/end' && event.data.turn === 1)).toBe(true)
      })
    } finally {
      restore()
    }

    // No throw propagated out of the step and into the turn: it closed out
    // `completed`, not `error`.
    const turnEnd = parent.session.events.find(
      (event): event is SessionEvent<'turn/end'> => event.type === 'turn/end' && event.data.turn === 1,
    )
    expect(turnEnd?.data.reason.kind).toBe('completed')
    // A clean no-op: unlike every OTHER way this per-entry loop can fail
    // (caught per entry and logged as a redelivery-failed warning), the
    // manager being unset during this window returns before the loop ever
    // starts, so nothing here is logged either.
    expect(warnings).toEqual([])
    // Nothing was synthesized for the synthetic entry, and the window left
    // the bookkeeping exactly as it found it.
    expect(settlementNotices(parent)).toHaveLength(0)
    expect(outstandingByParent.get(parent.id)?.has(fakeChildId)).toBe(true)
  })
})

describe('continuable lifecycle observation', () => {
  it('emits one paired start/end per residency epoch', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    parkParent(ctx, parent)
    const starts: SubagentRunInfo[] = []
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/start', (info) => { starts.push(info) })
    ctx.on('subagent/end', (info) => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })

    // A cold resume is a NEW epoch with its own pair.
    await followup(ctx, parent, started.childId, message('again'))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(2) })

    expect(starts).toHaveLength(2)
    expect(starts.map(info => info.id)).toEqual([started.childId, started.childId])
    expect(starts.map(info => info.provider)).toEqual(['spawn', 'spawn'])
    // Each end pairs its own start's runId.
    expect(ends.map(info => info.runId)).toEqual(starts.map(info => info.runId))
    // Both epochs ran their own scripted response; neither exhausted the corpus.
    expect(ends.map(info => info.stopReason)).toEqual(['completed', 'completed'])
  })
})

describe('continuable public API', () => {
  it('exposes no host authority, residency query, cancellation, steering, or report operation', async () => {
    const { ctx } = await setup([])
    const subagents: Record<string, unknown> = ctx.subagents as unknown as Record<string, unknown>
    for (const absent of [
      'activationState',
      'cancel',
      'kill',
      'report',
      'resume',
      'steer',
      'steerContinuable',
      'userAuthority',
    ]) {
      expect(subagents[absent]).toBeUndefined()
    }
    // No steering tool and no report tool are registered by this seam.
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('report')
    expect(names).not.toContain('steer_subagent')
  })

  it('keeps one-shot runs free of a steering capability', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    expect('steer' in run).toBe(false)
    await run.result
    await run.dispose()
  })

  it('reports a caller-signal abort before acceptance without delivering', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const controller = new AbortController()
    controller.abort('caller gave up')
    await expect(followup(ctx, parent, started.childId, message('aborted'), controller.signal))
      .rejects.toThrow()

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'aborted')).toBe(false)
  })

  it('does not cancel an accepted turn when the caller signal aborts afterwards', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    const controller = new AbortController()
    await followup(ctx, parent, started.childId, message('survives'), controller.signal)
    // After acceptance the manager owns the Activation independently.
    controller.abort('caller gave up')

    releaseFirst.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'survives')).toBe(true)
  })
})

describe('SubagentRuntime.registerContinuableSetup', () => {
  it('composes a contribution into every fresh continuable child and revokes it on Activation disposal', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const installed: SessionId[] = []
    const disposedIds: SessionId[] = []
    const dispose = ctx.subagents.registerContinuableSetup((childCtx) => {
      installed.push((childCtx.agent as Agent).session.header.id)
      // The same real capability the package's own setup contribution installs
      // (`installReportTool` in `@deepseek-ai/dsh-subagent-tool-subagent-report`):
      // a tool registered into the child's own context, not just a closure flag.
      const disposeTool = childCtx.tools.register(defineTool({
        name: 'setup-installed-marker',
        description: 'observable marker installed by a continuable setup contribution',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {} },
          render: () => [{ type: 'text', text: 'marker' }],
        },
        execute: () => Promise.resolve({}),
      }))
      return () => {
        disposedIds.push((childCtx.agent as Agent).session.header.id)
        disposeTool()
      }
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    expect(installed).toEqual([started.childId])
    const child = await vi.waitFor(() => {
      const live = ctx.agents.get(started.childId)
      expect(live).toBeDefined()
      return live!
    })
    // Observable from the child's own Context after start, not just that the
    // contribution's callback ran: a scoped registration is visible only in
    // the registering agent's own view, so the child itself is the scope key.
    expect(child.ctx.tools.schemas(child).map(schema => schema.name)).toContain('setup-installed-marker')

    await waitNoActivation(ctx, started.childId)
    expect(disposedIds).toEqual([started.childId])

    dispose()
  })

  it('stops composing a contribution into later children once its disposer runs', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    const installed: SessionId[] = []
    const dispose = ctx.subagents.registerContinuableSetup((childCtx) => {
      installed.push((childCtx.agent as Agent).session.header.id)
      return () => {}
    })

    const first = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, first.childId)
    dispose()

    const second = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, second.childId)
    expect(installed).toEqual([first.childId])
  })
})

describe('continuable errors', () => {
  it('rejects a duplicate Activation at the agent registry collision boundary', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Drop the Activation without disposing the Agent, leaving the id live but
    // unmanaged. Materialization must not adopt it.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, unknown> }
    }).continuations
    manager.activations.delete(started.childId)

    await expect(followup(ctx, parent, started.childId, message('hello')))
      .rejects.toThrow(SubagentError)
    expect(ctx.agents.get(started.childId)).toBe(child)
    hold.resolve(undefined)
  })

  it('rejects a parent that is no longer the live registry entry', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // A stale parent reference: same id, not the exact live entry.
    const stale = { ...parent, id: parent.id } as unknown as Agent

    await expect(followup(ctx, stale, started.childId, message('stale')))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    void child
  })

  it('rejects establishing a child under a parent whose disposal already began', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    // Begin the parent Activation's teardown, then try to give it a child.
    const drained = drainManager(ctx)
    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    hold.resolve(undefined)
    await drained
  })

  it('reports a failing branch after every branch settles, without pinning the rest', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })
    // Make the grandchild's own handle disposal reject: scope teardown failure
    // propagates, unlike a contained `agent/disposed` listener throw.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { handle: { dispose: () => Promise<void> } }> }
    }).continuations
    const branch = manager.activations.get(grandchild.childId)!
    const realDispose = branch.handle.dispose.bind(branch.handle)
    branch.handle.dispose = async () => {
      await realDispose()
      throw new Error('grandchild reap failed')
    }

    const drained = drainManager(ctx)
    hold.resolve(undefined)
    await expect(drained).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    // The other branch still released, and durable sessions survive.
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.meta.id).toBe(started.childId)
  })

  it('rolls the transfer back when ownership registration fails after handle transfer', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent child'), gate: hold.promise },
      { chunks: textResponse('unused') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const outer = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(outer.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Begin the would-be parent's disposal, then race a grandchild into it. The
    // handle transfers before ownership registration rejects, so the rollback
    // must leave no Activation and no live Agent behind.
    const manager = (ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, { disposal: Promise<void> | undefined }> }
    }).continuations
    const before = new Set(ctx.agents.list().map(agent => agent.id))
    manager.activations.get(outer.childId)!.disposal = Promise.resolve()

    await expect(ctx.subagents.startContinuable(startSpec(child)))
      .rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id).filter(id => !before.has(id))).toEqual([])
    })
    hold.resolve(undefined)
  })

  it('reapplies the descriptor model route on cold resume', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('resumed')])
    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: {
        prompt: message('routed work'),
        parent,
        agentOptions: { provider: 'mock', model: 'child-model' },
      },
    })
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.events.find(event => event.type === 'subagent/descriptor')?.data)
      .toMatchObject({ agentProvider: 'mock', agentModel: 'child-model' })

    // The resumed Activation runs on the declared route, not the parent's.
    await followup(ctx, parent, started.childId, message('again'))
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)?.options.model).toBe('child-model')
    })
    await waitNoActivation(ctx, started.childId)
  })

  it('unloading the manager drains its live activations', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child'), gate: hold.promise }])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    const serviceFiber = await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    // Manager unload uses the same drain, so no child outlives its runtime.
    const disposal = serviceFiber.dispose()
    hold.resolve(undefined)
    await disposal
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })
})

describe('SubagentRuntime.interrupt', () => {
  it('aborts the current turn durably, parks accepted follow-ups, and resumes them only on a waking send', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
      { chunks: textResponse('third') },
      { chunks: textResponse('fourth') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    await followup(ctx, parent, started.childId, message('parked B'))
    await followup(ctx, parent, started.childId, message('parked C'))
    const cancelSpy = vi.spyOn(child, 'cancel')

    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })

    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    // Cancellation is cooperative: the held model call observes it on release.
    releaseFirst.resolve(undefined)
    await child.whenIdle()
    // Parked, not resumed: no second model request follows the abort, the
    // accepted follow-ups stay pending, and the same Activation stays resident.
    expect(adapter.requests).toHaveLength(1)
    expect(child.inbox.nextTurn).toHaveLength(2)
    expect(child.status).toBe('idle')
    expect(ctx.agents.get(started.childId)).toBe(child)

    // Only an explicit waking send restores the driver; the parked items then
    // run before it in the existing FIFO order.
    await followup(ctx, parent, started.childId, message('waking D'))
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'parked B', 'parked C', 'waking D'])
    const turnEnds = loaded.events
      .filter(event => event.type === 'turn/end')
      .map(event => (event).data.reason.kind)
    expect(turnEnds).toEqual(['aborted', 'completed', 'completed', 'completed'])
  })

  it('interrupts only the target while its resident descendant keeps running', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    const childCancel = vi.spyOn(child, 'cancel')
    const grandchildCancel = vi.spyOn(grandchildAgent, 'cancel')

    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })

    expect(childCancel).toHaveBeenCalledTimes(1)
    releaseChild.resolve(undefined)
    await child.whenIdle()
    // The target parks as a waiting owner; the published descendant was never
    // signalled and keeps its own turn open.
    expect(grandchildCancel).not.toHaveBeenCalled()
    expect(ctx.agents.get(started.childId)).toBe(child)
    expect(ctx.agents.get(grandchild.childId)).toBe(grandchildAgent)

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(grandchild.childId)
    const turnEnds = loaded.events
      .filter(event => event.type === 'turn/end')
      .map(event => (event).data.reason.kind)
    expect(turnEnds).toEqual(['completed'])
  })

  it('authorizes the human address against the live target\'s durable direct parent', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const cancelSpy = vi.spyOn(child, 'cancel')

    expect(() => { ctx.subagents.interrupt(started.childId, {
      kind: 'user',
      parentSessionId: SessionId('stranger'),
    }) }).toThrow(/belongs to another parent session/)
    expect(cancelSpy).not.toHaveBeenCalled()

    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    expect(cancelSpy).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('lets a deep exact live ancestor interrupt its descendant with the parent cause', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    const childCancel = vi.spyOn(child, 'cancel')
    const grandchildCancel = vi.spyOn(grandchildAgent, 'cancel')

    // Deep ancestor: the top-level parent interrupts the grandchild.
    ctx.subagents.interrupt(grandchild.childId, { kind: 'ancestor', agent: parent })
    expect(grandchildCancel).toHaveBeenCalledWith({ kind: 'parent' }, { keepInbox: true })
    // Direct ancestor: the same authority kind covers the immediate parent.
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
    expect(childCancel).toHaveBeenCalledWith({ kind: 'parent' }, { keepInbox: true })

    releaseChild.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('rejects self, sibling, stale, and unrelated ancestor callers without touching the target', async () => {
    const releaseA = Promise.withResolvers<undefined>()
    const releaseB = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('a'), gate: releaseA.promise },
      { chunks: textResponse('b'), gate: releaseB.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const targetStart = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const target = ctx.agents.get(targetStart.childId)!
    const siblingStart = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const sibling = ctx.agents.get(siblingStart.childId)!
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })
    const stale = { ...parent, id: parent.id } as unknown as Agent
    const cancelSpy = vi.spyOn(target, 'cancel')

    expect(() => { ctx.subagents.interrupt(targetStart.childId, { kind: 'ancestor', agent: target }) })
      .toThrow(/cannot interrupt itself/)
    expect(() => { ctx.subagents.interrupt(targetStart.childId, { kind: 'ancestor', agent: sibling }) })
      .toThrow(/not a live descendant/)
    expect(() => { ctx.subagents.interrupt(targetStart.childId, { kind: 'ancestor', agent: stranger }) })
      .toThrow(/not a live descendant/)
    expect(() => { ctx.subagents.interrupt(targetStart.childId, { kind: 'ancestor', agent: stale }) })
      .toThrow(/exact live ancestor/)
    // A stale caller is rejected before target lookup, even for an absent id.
    expect(() => { ctx.subagents.interrupt(SessionId('missing'), { kind: 'ancestor', agent: stale }) })
      .toThrow(/exact live ancestor/)
    expect(cancelSpy).not.toHaveBeenCalled()

    releaseA.resolve(undefined)
    releaseB.resolve(undefined)
    await waitNoActivation(ctx, targetStart.childId)
    await waitNoActivation(ctx, siblingStart.childId)
  })

  it('accepts absent and one-shot ids as no-ops without touching the one-shot Agent', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    ctx.subagents.interrupt(SessionId('missing'), { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(SessionId('missing'), { kind: 'ancestor', agent: parent })

    const run = await ctx.subagents.start('spawn', {
      label: 'one-shot work',
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    const oneShot = run.localAgent!
    const cancelSpy = vi.spyOn(oneShot, 'cancel')
    ctx.subagents.interrupt(run.id, { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(run.id, { kind: 'ancestor', agent: parent })
    expect(cancelSpy).not.toHaveBeenCalled()
    await run.result
    await run.dispose()
  })

  it('accepts an interrupt after natural completion', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
  })

  it('accepts an interrupt that lost the race with disposal without signalling twice', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('working'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const cancelSpy = vi.spyOn(child, 'cancel')

    // Scoped teardown opens the disposal transaction synchronously and issues
    // its own whole-Activation cancel before this call returns.
    const drained = ctx.subagents.drainContinuableDescendants([parent])
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    // Interrupt after the cutoff: accepted no-op, no second signal, no waiting.
    ctx.subagents.interrupt(started.childId, { kind: 'user', parentSessionId: parent.id })
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    hold.resolve(undefined)
    await drained
  })
})

describe('SubagentContinuationManager.hasLiveDescendants', () => {
  it('reports true for an immediate live continuable child (depth 1)', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child running'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const manager = continuationManager(ctx)
    expect(manager.hasLiveDescendants(parent)).toBe(false)

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    expect(manager.hasLiveDescendants(parent)).toBe(true)
    // The public `SubagentRuntime` surface is a pure pass-through onto the
    // same scan; both must agree, since nothing else re-derives this answer.
    expect(ctx.subagents.hasLiveDescendants(parent)).toBe(true)

    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    expect(manager.hasLiveDescendants(parent)).toBe(false)
  })

  it('reports true through an intermediate live parent — a depth-2 chain, not just an immediate child', async () => {
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      // The child finishes its own turn, then starts a grandchild that stays running.
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild running'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const manager = continuationManager(ctx)

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Start the grandchild immediately, without waiting for the child to go
    // idle first: an idle child with no owned children yet is 'settled' and
    // the watcher disposes it right away, so registering the grandchild as an
    // owned child before that happens is what keeps this Activation resident.
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })

    expect(manager.hasLiveDescendants(child)).toBe(true)
    expect(manager.hasLiveDescendants(parent)).toBe(true)

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
    expect(manager.hasLiveDescendants(parent)).toBe(false)
  })

  it('returns false for the root itself — the predicate is strict, since a continuable Agent may itself be a host-owned root', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child running'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const manager = continuationManager(ctx)

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })

    // The child's own Activation ancestry trivially contains itself (it seeds
    // `[handle.agent, ...parentLineage]`), so only the strict `!==` guard
    // keeps a childless child from reporting itself as its own descendant.
    expect(manager.hasLiveDescendants(child)).toBe(false)

    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('returns false when there are no Activations at all', async () => {
    const { ctx, parent } = await setup([])
    expect(continuationManager(ctx).hasLiveDescendants(parent)).toBe(false)
  })

  it('does not report a descendant of a different root as belonging to this one', async () => {
    const hold = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child running'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const manager = continuationManager(ctx)
    const otherRoot = ctx.agentLoop.create(SessionId('unrelated-parent'), { provider: 'mock', model: 'mock' })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    // The manager's Activation map is non-empty (it holds the live child of
    // `parent`), yet an unrelated root with no descendants of its own must
    // still see none — a live Activation elsewhere is not "any Activation".
    expect(manager.hasLiveDescendants(parent)).toBe(true)
    expect(manager.hasLiveDescendants(otherRoot)).toBe(false)

    hold.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })
})

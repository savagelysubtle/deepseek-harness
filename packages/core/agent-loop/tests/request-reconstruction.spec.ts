/**
 * Loop-level reconstructability: every request the loop sends is a pure function of the
 * session log — messages derive at the step/start boundary and the header is the latest
 * request/header snapshot. Each request extends its predecessor unless a logged compaction
 * replacement or header change explains the difference.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmError, ReasoningEffortId  } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelReasoningInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { TOOL_SNAPSHOT_SETTLE_MS } from '../src/constants.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter, persona = 'stable base') {
  return harnessRoutes([['mock', adapter]], persona)
}

async function harnessRoutes(
  adapters: readonly (readonly [provider: string, adapter: MockAdapter])[],
  persona = 'stable base',
) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  for (const [provider, adapter] of adapters) ctx.llm.registerAdapter([provider], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/**
 * Like {@link waitForIdle} but resolves only on the Nth `'idle'` transition
 * after attaching — for a sequence where a first turn's own conclusion and a
 * later corrective turn's conclusion could both land before (or straddle)
 * any single synchronous checkpoint the test can insert, so a fresh
 * single-shot listener attached "in between" cannot be relied on to land
 * strictly after the first and strictly before the second.
 */
function waitForIdleTimes(ctx: Context, agent: Agent, times: number): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      seen += 1
      if (seen >= times) {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Assert `previous` is a strict value-prefix of `current`. */
function expectPrefixExtension(previous: GenerateOptions, current: GenerateOptions) {
  expect(current.messages.length).toBeGreaterThan(previous.messages.length)
  expect(current.messages.slice(0, previous.messages.length)).toEqual([...previous.messages])
  expect(current.system).toEqual(previous.system)
  expect(current.tools).toEqual(previous.tools)
}

function registerEcho(ctx: Context) {
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo back',
    parameters: { text: { type: 'string' } },
    async execute(args) {
      return [{ type: 'text', text: `echo: ${String(args.text)}` }]
    },
  }))
}

function registerLate(ctx: Context) {
  ctx.tools.register(defineContentToolFixture({
    name: 'late',
    description: 'registers after the others',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'late' }]
    },
  }))
}

describe('request stability across the loop', () => {
  it('each step request within a turn append-extends the previous, frozen end to end', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'first'),
      toolCallResponse('c2', 'echo', { text: 'two' }, 'second'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    expectPrefixExtension(adapter.requests[0]!, adapter.requests[1]!)
    expectPrefixExtension(adapter.requests[1]!, adapter.requests[2]!)
    for (const request of adapter.requests) {
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.messages)).toBe(true)
    }
    // One anchoring header snapshot; no further header events (nothing changed).
    const headerEvents = agent.session.events.filter(e => e.type === 'request/header')
    expect(headerEvents).toHaveLength(1)
    expect(headerEvents[0]?.type === 'request/header' && headerEvents[0].data.reason).toBe('initial')
  })

  it('a later turn append-extends the previous turn (one conversation, one log)', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expectPrefixExtension(adapter.requests[0]!, adapter.requests[1]!)
  })

  it('logs adapter defaults, supports per-turn effort changes, and restores the effective value', async () => {
    const reasoning = {
      efforts: [
        { id: ReasoningEffortId('high'), name: 'High' },
        { id: ReasoningEffortId('max'), name: 'Max' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    }
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')], reasoning)
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('effort'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request', async ({ turn }, next) => {
      const config = await next()
      return turn === 2 ? { ...config, reasoningEffort: ReasoningEffortId('max') } : config
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual([
      ReasoningEffortId('high'),
      ReasoningEffortId('max'),
    ])
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.map(event => event.data.header.config.reasoningEffort)).toEqual([
      ReasoningEffortId('high'),
      ReasoningEffortId('max'),
    ])
    expect(headers.map(event => event.data.header.adapterDefaults)).toEqual([
      { reasoningEffort: true },
      undefined,
    ])
    expect(headers.map(event => event.data.reason)).toEqual(['initial', 'change'])

    for (const [model, effort] of [
      ['mock', ReasoningEffortId('max')],
      ['replacement', ReasoningEffortId('high')],
    ] as const) {
      const resumedAdapter = new MockAdapter([textResponse('resumed')], reasoning)
      const resumedCtx = await harness(resumedAdapter)
      const resumedHandle = await resumedCtx.agents.create({
        sessionId: SessionId(`effort-${model}`),
        seed: structuredClone(agent.session.events),
        agentOptions: { provider: 'mock', model },
      })
      send(resumedHandle.agent, 'resumed')
      await waitForIdle(resumedCtx, resumedHandle.agent)

      expect(resumedAdapter.requests[0]?.model).toBe(model)
      expect(resumedAdapter.requests[0]?.reasoningEffort).toBe(effort)
      const resumedHeaders = resumedHandle.agent.session.events.filter(event => event.type === 'request/header')
      expect(resumedHeaders.at(-1)?.data.header.config.reasoningEffort).toBe(effort)
      expect(resumedHeaders.at(-1)?.data.reason).toBe('resume')
    }
  })

  it('logs an adapter-owned maxTokens default before dispatch', async () => {
    const adapter = new MockAdapter([textResponse('bounded')], undefined, 256_000)
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('adapter-max-tokens'), {
      provider: 'mock',
      model: 'mock',
    })

    send(agent, 'use the adapter output limit')
    await waitForIdle(ctx, agent)

    expect(adapter.requests[0]?.maxTokens).toBe(256_000)
    const header = agent.session.events.find(event => event.type === 'request/header')
    expect(header?.type === 'request/header' && header.data.header.config.maxTokens).toBe(256_000)
    expect(header?.type === 'request/header' && header.data.header.adapterDefaults)
      .toEqual({ maxTokens: true })
  })

  it('rematerializes the selected adapter maxTokens default after a provider switch', async () => {
    const deepseek = new MockAdapter([textResponse('deepseek')], undefined, 256_000)
    const other = new MockAdapter([textResponse('other')], undefined, 8_192)
    const ctx = await harnessRoutes([
      ['deepseek', deepseek],
      ['other', other],
    ])
    const agent = ctx.agentLoop.create(SessionId('adapter-max-tokens-switch'), {
      provider: 'deepseek',
      model: 'deepseek-model',
    })
    ctx.on('agent/request', async ({ turn }, next) => {
      const config = await next()
      return turn === 2
        ? { ...config, provider: 'other', model: 'other-model' }
        : config
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(deepseek.requests[0]?.maxTokens).toBe(256_000)
    expect(other.requests[0]?.maxTokens).toBe(8_192)
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.map(event => event.data.header.config.maxTokens)).toEqual([256_000, 8_192])
    expect(headers.map(event => event.data.header.adapterDefaults)).toEqual([
      { maxTokens: true },
      { maxTokens: true },
    ])
  })

  it('preserves an explicit agent maxTokens cap across a provider switch', async () => {
    const deepseek = new MockAdapter([textResponse('deepseek')], undefined, 256_000)
    const other = new MockAdapter([textResponse('other')], undefined, 8_192)
    const ctx = await harnessRoutes([
      ['deepseek', deepseek],
      ['other', other],
    ])
    const agent = ctx.agentLoop.create(SessionId('explicit-max-tokens-switch'), {
      provider: 'deepseek',
      model: 'deepseek-model',
      maxTokens: 4_096,
    })
    ctx.on('agent/request', async ({ turn }, next) => {
      const config = await next()
      return turn === 2
        ? { ...config, provider: 'other', model: 'other-model' }
        : config
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(deepseek.requests[0]?.maxTokens).toBe(4_096)
    expect(other.requests[0]?.maxTokens).toBe(4_096)
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.map(event => event.data.header.config.maxTokens)).toEqual([4_096, 4_096])
    expect(headers.map(event => event.data.header.adapterDefaults)).toEqual([undefined, undefined])
  })

  it('keeps exact-model resolution, request logging, and dispatch on one adapter registration', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'stable base' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const started = Promise.withResolvers<undefined>()
    const reasoning = Promise.withResolvers<LlmModelReasoningInfo>()
    const first = new class extends MockAdapter {
      override async resolveModel(
        provider: string,
        model: string,
        _signal?: AbortSignal,
      ): Promise<LlmResolvedModelInfo> {
        started.resolve(undefined)
        return {
          provider,
          id: model,
          name: model,
          reasoning: await reasoning.promise,
        }
      }
    }([textResponse('first')])
    const second = new MockAdapter([textResponse('second')], {
      efforts: [{ id: ReasoningEffortId('max'), name: 'Max' }],
      defaultEffort: ReasoningEffortId('max'),
    })
    const disposeFirst = ctx.llm.registerAdapter(['mock'], first)
    const agent = ctx.agentLoop.create(SessionId('effort-hmr'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await started.promise
    disposeFirst()
    ctx.llm.registerAdapter(['mock'], second)
    reasoning.resolve({
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: ReasoningEffortId('high'),
    })
    await waitForIdle(ctx, agent)

    expect(first.requests.map(request => request.reasoningEffort)).toEqual([
      ReasoningEffortId('high'),
    ])
    expect(second.requests).toHaveLength(0)
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.at(-1)?.data.header.config.reasoningEffort).toBe(ReasoningEffortId('high'))
  })

  it('aborts a blocked reasoning lookup before quiescent disposal completes', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const adapter = new class extends MockAdapter {
      override resolveModel(
        _provider: string,
        _model: string,
        signal?: AbortSignal,
      ): Promise<never> {
        if (signal === undefined) return Promise.reject(new Error('missing reasoning signal'))
        started.resolve(signal)
        return new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('reasoning aborted'))
            return
          }
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('reasoning aborted'))
          }, { once: true })
        })
      }
    }([])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('reasoning-dispose'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'go')
    const signal = await started.promise
    await handle.dispose()

    expect(signal.aborted).toBe(true)
    expect(handle.agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    expect(handle.agent.session.events.some(event => event.type === 'request/header')).toBe(false)
  })

  it.each(['plain error', 'LLM error'] as const)(
    'does not swallow a %s from exact-model resolution',
    async (kind) => {
      const failure = kind === 'plain error'
        ? new Error('reasoning metadata failed')
        : new LlmError('unsupported effort', 'UNSUPPORTED_REASONING_EFFORT')
      const adapter = new class extends MockAdapter {
        override resolveModel(): Promise<never> {
          return Promise.reject(failure)
        }
      }([])
      const ctx = await harness(adapter)
      const agent = ctx.agentLoop.create(SessionId(`reasoning-${kind}`), {
        provider: 'mock',
        model: 'mock',
      })

      send(agent, 'go')
      await waitForIdle(ctx, agent)

      expect(agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
        data: {
          reason: failure instanceof LlmError
            ? { kind: 'error', error: failure.failure }
            : { kind: 'error', error: { message: failure.message, code: 'UNKNOWN' } },
        },
      })
      expect(adapter.requests).toHaveLength(0)
    },
  )

  it('lets a short-circuiting llm/stream listener own an unregistered route', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: 'stable base' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    let observed: GenerateOptions | undefined
    ctx.on('llm/stream', (options) => {
      observed = options
      return (async function* () {
        yield* textResponse('owned')
      })()
    })
    const agent = ctx.agentLoop.create(SessionId('listener-owned'), {
      provider: 'listener',
      model: 'virtual',
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(observed).toMatchObject({ provider: 'listener', model: 'virtual' })
    expect(agent.session.requestHeader()?.config).toEqual({
      provider: 'listener',
      model: 'virtual',
    })
    expect(agent.session.deriveMessages().at(-1)?.content).toContainEqual({
      type: 'text',
      text: 'owned',
    })
  })

  it('a compaction replace rewrites the resend, and the log explains it', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)

    const nodes = agent.session.surface.nodes
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[summary of turn 1]' }],
      source: { kind: 'plugin', plugin: 'test-compact' },
    }), {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[1]! },
      sourceEventSeqs: [nodes[0]!, nodes[1]!],
    })

    send(agent, 'second')
    await waitForIdle(ctx, agent)

    const second = adapter.requests[1]!
    // The rewritten history: summary replaces turn 1's user+assistant pair.
    expect(second.messages[0]!.content.some(b => b.type === 'text' && b.text.includes('[summary of turn 1]'))).toBe(true)
    // No header event beyond the anchor: the replace is itself in the log.
    expect(agent.session.events.filter(e => e.type === 'request/header')).toHaveLength(1)
  })

  it('a real system-prompt change is a full changed-header snapshot; a stable prompt logs nothing', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    // Identical assembly re-rendered per step is NOT a change.
    expect(agent.session.events.filter(e => e.type === 'request/header')).toHaveLength(1)

    ctx.systemPrompt.section({ name: 'extra', order: 2, text: 'new guidance' })
    send(agent, 'third')
    await waitForIdle(ctx, agent)

    const snapshots = agent.session.events.filter(e => e.type === 'request/header')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]?.data.reason).toBe('change')
    expect(adapter.requests[2]!.system).toContain('new guidance')
    // History is preserved across the change — only the header moved.
    expect(adapter.requests[2]!.messages.length).toBeGreaterThan(adapter.requests[1]!.messages.length)
  })

  it('an inject() during the agent/request waterfall joins the NEXT request (the step/start boundary)', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let injected = false
    ctx.on('agent/request', async (_payload, next) => {
      if (!injected) {
        injected = true
        agent.inject(createUserMessage({ content: [{ type: 'text', text: '[late context]' }], source: { kind: 'plugin', plugin: 'test' } }))
      }
      return next()
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    const first = adapter.requests[0]!
    // The inject landed in the log after the boundary: not in THIS request…
    expect(first.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('[late context]')))).toBe(false)
    expect(agent.session.events.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin')).toBe(true)

    send(agent, 'second')
    await waitForIdle(ctx, agent)
    // …but in the next one, at its logged position.
    const second = adapter.requests[1]!
    expect(second.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('[late context]')))).toBe(true)
  })

  it('a mutation attempt on the frozen request content throws into the step (loud, not silent)', async () => {
    const adapter = new MockAdapter([textResponse('one')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('llm/stream', (options, next) => {
      // The historical failure mode this design kills: a listener rewriting
      // request content in place. The freeze turns it into a loud error.
      options.messages.push(createUserMessage({
        content: [{ type: 'text', text: 'sneaky' }],
        source: { kind: 'plugin', plugin: 'test' },
      }))
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(turnEnd).toMatchObject({ data: { reason: { kind: 'error' } } })
    if (turnEnd?.type !== 'turn/end' || turnEnd.data.reason.kind !== 'error') throw new Error()
    expect(turnEnd.data.reason.error.message).toMatch(/not extensible|frozen|read only|readonly/i)
  })

  it('a fresh loop instance over a seeded log anchors with a resume snapshot and stays cache-aligned', async () => {
    const adapter = new MockAdapter([textResponse('one')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('gen1'), { provider: 'mock', model: 'mock' })
    send(agent, 'first')
    await waitForIdle(ctx, agent)

    // Second generation: a new agent whose session is seeded with the first
    // one's full log (the resume/fork path).
    const adapter2 = new MockAdapter([textResponse('two')])
    const ctx2 = await harness(adapter2)
    const handle = await ctx2.agents.create({
      sessionId: SessionId('gen2-session'),
      seed: [...agent.session.events],
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent2 = handle.agent
    send(agent2, 'second')
    await waitForIdle(ctx2, agent2)

    const snapshots = agent2.session.events.filter(e => e.type === 'request/header')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]?.data.reason).toBe('resume')
    // Identical header across the restart: byte-identical continuation.
    expect(adapter2.requests[0]!.system).toEqual(adapter.requests[0]!.system)
    expectPrefixExtension(adapter.requests[0]!, adapter2.requests[0]!)
  })

  it('a delegating listener cannot mutate the seed through next() — the fold stays log-true', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      // next() resolves the SAME frozen seed — in-place shaping after
      // delegation is unrepresentable, so a "mutate what next() returned"
      // listener cannot desync the log from the request (nor reach the
      // session's cached header fold, which is deep-cloned away and itself
      // frozen).
      expect(Object.isFrozen(config)).toBe(true)
      expect(() => { (config as { temperature?: number }).temperature = 0.9 }).toThrow(TypeError)
      return config
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    // No changed snapshot was logged (nothing really changed), and the session's own
    // fold is immutable state.
    expect(agent.session.events.filter(e => e.type === 'request/header')).toHaveLength(1)
    expect(Object.isFrozen(agent.session.requestHeader())).toBe(true)
    expect(adapter.requests[1]!.temperature).toBeUndefined()
  })

  it('THEOREM: every request rebuilds byte-equal from the session log alone', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'calling'),
      textResponse('done'),
      textResponse('after change'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    ctx.systemPrompt.section({ name: 'extra', order: 2, text: 'now with guidance' })
    ctx.on('agent/request', async (_payload, next) => ({
      ...await next(), temperature: 0.5, maxTokens: 99, stop: ['<END>'],
    }))
    send(agent, 'again')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    const events = agent.session.events
    const stepStarts = events.filter(e => e.type === 'step/start')
    expect(stepStarts).toHaveLength(3)

    adapter.requests.forEach((request, index) => {
      const stepStart = stepStarts[index]!
      const firstChunk = events.find(e =>
        e.type === 'assistant/chunk'
        && e.data.turn === stepStart.data.turn
        && e.data.step === stepStart.data.step,
      )!
      // Messages: the entered batch is logged after step/start, so rebuild the
      // complete dispatch prefix through a completely fresh Session.
      const rebuilt = Session.create(SessionId(`rebuild-${index}`), structuredClone(events.slice(0, firstChunk.seq)))
      expect(structuredClone(request.messages)).toEqual(rebuilt.deriveMessages())

      // Header: the latest request/header snapshot up to this step's dispatch
      // (its header event sits between step/start and the first chunk).
      const header = foldRequestHeader(events.slice(0, firstChunk.seq))!
      expect(request.model).toBe(header.config.model)
      expect(request.reasoningEffort).toBe(header.config.reasoningEffort)
      expect(request.system).toEqual(header.system)
      expect(structuredClone(request.tools ?? [])).toEqual(structuredClone(header.tools ?? []))
      expect(request.temperature).toBe(header.config.temperature)
      expect(request.maxTokens).toBe(header.config.maxTokens)
      expect(request.stop).toEqual(header.config.stop)
    })
  })
})

describe('request/context capacity records', () => {
  /** Adapter advertising a per-model capacity, keyed by model id. */
  function capacityAdapter(windows: Record<string, number>, script: StreamChunk[][]): MockAdapter {
    return new class extends MockAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        const contextWindow = windows[model]
        return Promise.resolve({
          provider,
          id: model,
          name: model,
          ...contextWindow === undefined ? {} : { context: { contextWindow } },
        })
      }
    }(script)
  }

  it('records capacity once and skips it while the route is unchanged', async () => {
    const adapter = capacityAdapter({ mock: 128_000 }, [textResponse('a'), textResponse('b')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('capacity-dedup'), { provider: 'mock', model: 'mock' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    const records = agent.session.events.filter(event => event.type === 'request/context')
    expect(records).toHaveLength(1)
    expect(records[0]?.data).toEqual({ provider: 'mock', model: 'mock', contextWindow: 128_000 })
    // Log-only: not a SurfaceEventType, so it can never reach a model request
    // (the type system rejects a surfaceOp here; the session invariant also
    // requires the record to sit inside its open turn).
    expect(agent.session.surface.nodes).not.toContain(records[0]?.seq)
  })

  it('records a second capacity when the route changes mid-session', async () => {
    const adapter = capacityAdapter(
      { small: 64_000, large: 256_000 },
      [textResponse('a'), textResponse('b')],
    )
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('capacity-switch'), { provider: 'mock', model: 'small' })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    ctx.on('agent/request', ({ agent: subject }, next) => subject === agent
      ? Promise.resolve({ provider: 'mock', model: 'large' })
      : next())
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(agent.session.events
      .filter(event => event.type === 'request/context')
      .map(event => event.data.contextWindow)).toEqual([64_000, 256_000])
  })

  it('records and deduplicates a route whose adapter advertises no capacity', async () => {
    const ctx = await harness(new MockAdapter([textResponse('a'), textResponse('b')]))
    const agent = ctx.agentLoop.create(SessionId('capacity-absent'), { provider: 'mock', model: 'mock' })
    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(agent.session.events
      .filter(event => event.type === 'request/context')
      .map(event => event.data)).toEqual([{ provider: 'mock', model: 'mock' }])
  })

  it('clears a previous capacity when the next route advertises none', async () => {
    const adapter = capacityAdapter({ known: 64_000 }, [textResponse('a'), textResponse('b')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('capacity-clear'), { provider: 'mock', model: 'known' })
    let model = 'known'
    ctx.on('agent/request', ({ agent: subject }, next) => subject === agent
      ? Promise.resolve({ provider: 'mock', model })
      : next())

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    model = 'unknown'
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(agent.session.events
      .filter(event => event.type === 'request/context')
      .map(event => event.data)).toEqual([
      { provider: 'mock', model: 'known', contextWindow: 64_000 },
      { provider: 'mock', model: 'unknown' },
    ])
  })
})

describe('tool-registration race recovery (SWD-115)', () => {
  it('a wake whose only turn ended idle before a tool finished registering gets one corrective dispatch carrying the full tool set', async () => {
    // Turn 1 ends on plain text — no tool call, so no second step ever
    // happens naturally, and the agent goes idle having seen zero tools.
    const adapter = new MockAdapter([textResponse('one'), textResponse('ack')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('tool-race'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools ?? []).toHaveLength(0)

    // Attached before the fake-timer advance, since `vi.advanceTimersByTimeAsync`
    // flushes microtasks thoroughly enough that this simple mock-driven
    // corrective turn can run to completion (idle -> running -> idle) entirely
    // inside that call — a listener attached only afterward would miss it.
    const corrected = waitForIdle(ctx, agent)
    vi.useFakeTimers()
    try {
      // The "late" registration: the turn has already gone idle, so nothing
      // would naturally re-assemble and notice this without the recheck.
      registerEcho(ctx)
      await vi.advanceTimersByTimeAsync(TOOL_SNAPSHOT_SETTLE_MS)
    } finally {
      vi.useRealTimers()
    }
    // In case the corrective turn was still mid-flight when the timers were
    // switched back, let it finish under real timers before asserting on it.
    await corrected

    // The decisive evidence: a SECOND real dispatch actually went out, and it
    // carried the corrected tool set — not just a log entry claiming so.
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(['echo'])

    // The injected corrective message must not read as a user prompt.
    const userMessages = agent.session.events.filter(event => event.type === 'user/message')
    expect(userMessages).toHaveLength(2)
    expect(userMessages[0]?.data.source.kind).toBe('user')
    expect(userMessages[1]?.data.source.kind).toBe('plugin')
  })

  it('does not dispatch a corrective turn when the assembled tool set already matches what was last sent', async () => {
    const adapter = new MockAdapter([textResponse('one')])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('tool-race-healthy'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)

    // Re-emit the registry-change notification with nothing actually changed
    // (e.g. an unrelated scope's registration elsewhere) and confirm the
    // recheck stays a no-op: no extra dispatch, no injected message.
    vi.useFakeTimers()
    try {
      ctx.emit('tools/change')
      await vi.advanceTimersByTimeAsync(TOOL_SNAPSHOT_SETTLE_MS)
    } finally {
      vi.useRealTimers()
    }

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
  })

  it('does not fire an extra turn when tools/change occurs mid-turn on an already-healthy session (e.g. an MCP server connecting late) — this is the regression a log-only recheck would have introduced on every healthy seat', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'first'),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('tool-race-mid-turn'), { provider: 'mock', model: 'mock' })

    // Attached up front, before the turn even starts — same reasoning as the
    // race test above: this scripted turn can run to full completion inside
    // `vi.advanceTimersByTimeAsync`'s microtask flushing.
    const done = waitForIdle(ctx, agent)
    vi.useFakeTimers()
    try {
      send(agent, 'go')
      // `send` synchronously flips the agent to 'running' before returning
      // (wakeDriver commits the phase transition inline), so the agent is
      // already mid-turn here.
      expect(agent.status).toBe('running')
      registerLate(ctx)
      await vi.advanceTimersByTimeAsync(TOOL_SNAPSHOT_SETTLE_MS)
    } finally {
      vi.useRealTimers()
    }
    await done

    // Exactly the two calls the scripted turn itself makes — no extra
    // corrective dispatch from the mid-turn tools/change.
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    // The other half of the claim this design leans on: the turn's own
    // natural second step really did pick up the newly registered tool —
    // not just "no spurious third call", but "the second call was correct".
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(
      expect.arrayContaining(['echo', 'late']),
    )
  })

  it("BLOCKING 1: a drift found on a turn's LAST step is not lost forever -- it self-corrects once the agent actually goes idle", async () => {
    // MockAdapter's script entries resolve instantly with no real delay, so
    // driving this deterministically requires an adapter whose stream can be
    // held open under test control -- this one gates its first response so
    // the test can assert the agent is genuinely still 'running' (mid its
    // one, final step) at the exact moment the late registration lands.
    class GatedThenScriptedAdapter extends MockAdapter {
      readonly gate = Promise.withResolvers<undefined>()
      private gatedCallMade = false

      constructor(private readonly firstText: string, followingScript: ConstructorParameters<typeof MockAdapter>[0]) {
        super(followingScript)
      }

      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (this.gatedCallMade) {
          yield* super.stream(options)
          return
        }
        this.gatedCallMade = true
        this.requests.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: this.firstText }
        await this.gate.promise
        yield { type: 'block-end', index: 0, block: { type: 'text', text: this.firstText } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: this.firstText.length } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    const adapter = new GatedThenScriptedAdapter('one', [textResponse('ack')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('tool-race-final-step'), { provider: 'mock', model: 'mock' })

    // Attached before anything happens: two idle transitions are expected
    // here (turn 1 concluding, then the corrective turn concluding), and
    // fake-timer microtask flushing can drive both of them through before a
    // freshly-attached listener would ever get a chance to see the first.
    const corrected = waitForIdleTimes(ctx, agent, 2)

    vi.useFakeTimers()
    try {
      send(agent, 'go')
      // Flush microtasks (no timer involved yet) until the model call
      // actually starts streaming and pauses at the gate.
      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.requests).toHaveLength(1)
      expect(agent.status).toBe('running')

      // The late registration lands while the model is still mid-stream on
      // what will turn out to be the turn's only (and therefore last) step
      // -- exactly the ticket's own repro shape.
      registerEcho(ctx)
      await vi.advanceTimersByTimeAsync(TOOL_SNAPSHOT_SETTLE_MS)
      // The debounce fired while genuinely still running: it must have
      // deferred rather than acted -- confirm nothing was dispatched yet.
      expect(adapter.requests).toHaveLength(1)

      // Now let the step actually conclude: no tool call, so the turn ends
      // and the agent goes idle carrying a still-stale header.
      adapter.gate.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
    await corrected

    // The decisive evidence: the drift found mid-turn was NOT dropped once
    // the turn ended with no further step coming -- a second real dispatch
    // went out once the agent actually went idle, carrying the corrected
    // tool set.
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(['echo'])
  })

  it('BLOCKING 2: cancel() dropping a maintenance-latched correction does not permanently disable the recheck', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('corrected')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('tool-race-maintenance-cancel'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)

    const maintenanceGate = Promise.withResolvers<undefined>()
    let observedSignal: AbortSignal | undefined
    const maintenance = agent.runMaintenance(async (signal) => {
      observedSignal = signal
      await maintenanceGate.promise
    })

    // Drift lands while maintenance is in flight: `status` reads 'idle'
    // during maintenance, so the recheck proceeds and latches a corrective
    // wake behind the maintenance job instead of starting it immediately.
    vi.useFakeTimers()
    try {
      registerEcho(ctx)
      await vi.advanceTimersByTimeAsync(TOOL_SNAPSHOT_SETTLE_MS)
    } finally {
      vi.useRealTimers()
    }
    // Not yet dispatched: the corrective wake is latched behind maintenance,
    // not running.
    expect(adapter.requests).toHaveLength(1)

    // A real call site cancelling without keepInbox while maintenance is
    // still in flight (e.g. packages/acp/acp/src/index.ts's
    // cancel({kind:'user'}) call sites) -- this clears the inbox and the
    // wakeRequested latch together, dropping the corrective message before
    // it was ever delivered.
    agent.cancel({ kind: 'user' })
    expect(observedSignal?.aborted).toBe(true)

    const corrected = waitForIdle(ctx, agent)
    maintenanceGate.resolve(undefined)
    await maintenance
    await corrected

    // The decisive evidence: cancel() dropping the latch did not leave the
    // mechanism permanently stuck -- a real corrective dispatch still went
    // out once maintenance actually concluded, carrying the corrected tool
    // set. Without the fix, this second call never happens (0-length stays
    // at 1 forever, for the rest of the agent's life).
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(['echo'])
  })
})

/**
 * Shared setup for the disposal-races-a-latched-recheck scenario (SWD-115):
 * an agent parked in maintenance picks up a corrective tool-snapshot wake,
 * that wake is latched (maintenance can't take it directly), and then the
 * agent is disposed while the latch is still pending. Returns the evidence
 * every assertion in this describe block reads, gathered once so each `it`
 * stays focused on one invariant instead of re-deriving the race.
 */
async function raceDisposalAgainstLatchedRecheck() {
  const adapter = new MockAdapter([textResponse('one'), textResponse('would-be-corrective')])
  const ctx = await harness(adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('tool-race-dispose'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent

  send(agent, 'go')
  await waitForIdle(ctx, agent)
  expect(adapter.requests).toHaveLength(1)

  const warnCalls: unknown[][] = []
  const origWarn = agent.ctx.logger.warn.bind(agent.ctx.logger)
  agent.ctx.logger.warn = ((...args: unknown[]) => {
    warnCalls.push(args)
    origWarn(...(args as [never]))
  }) as typeof agent.ctx.logger.warn

  const maintenanceGate = Promise.withResolvers<undefined>()
  const maintenance = agent.runMaintenance(async () => {
    await maintenanceGate.promise
  })

  vi.useFakeTimers()
  try {
    registerEcho(ctx)
    await vi.advanceTimersByTimeAsync(TOOL_SNAPSHOT_SETTLE_MS)
  } finally {
    vi.useRealTimers()
  }
  // The recheck found drift and latched a corrective wake behind maintenance
  // (see agent.ts's `toolSnapshotCorrectionPending`) -- nothing has dispatched yet.
  expect(adapter.requests).toHaveLength(1)
  const preDisposeEventCount = agent.session.events.length

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)

  let disposeError: unknown
  const disposal = handle.dispose().catch((error: unknown) => { disposeError = error })
  // Resolving the gate lets maintenance conclude, which re-arms the dropped
  // latch (`toolSnapshotRecheckDeferred`) and, on the transition back to
  // idle, fires the fire-and-forget recheck again -- this time landing well
  // after dispose() itself has resolved.
  maintenanceGate.resolve(undefined)
  await maintenance.catch(() => undefined)
  await disposal
  // Give the dangling fire-and-forget chain a chance to reach its own
  // dispatch attempt before inspecting state and removing the listener.
  await new Promise(resolve => setTimeout(resolve, 50))
  process.off('unhandledRejection', onUnhandled)

  return { agent, adapter, warnCalls, unhandled, disposeError, preDisposeEventCount }
}

describe('disposal racing a latched tool-snapshot correction (SWD-115)', () => {
  it('does not dispatch a second request or grow the session once dispose has resolved', async () => {
    const { agent, adapter, disposeError, unhandled, preDisposeEventCount } =
      await raceDisposalAgainstLatchedRecheck()

    // The defect: a real second model call went out and completed against a
    // torn-down agent, growing the session, with dispose() itself reporting
    // success throughout. None of that may happen now.
    expect(disposeError).toBeUndefined()
    expect(unhandled).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)

    // The one legitimate way this can still grow: cancel() durably records
    // discarding the message the first (latched) recheck had queued, and the
    // blocked retry durably records its own queued message before the guard
    // in wakeDriver() ever lets it start a driver -- both are inert inbox
    // bookkeeping for work that never ran. What must never reappear is any
    // event only a real dispatch produces.
    const newEvents = agent.session.events.slice(preDisposeEventCount)
    expect(newEvents.every(event => event.type === 'agent/inbox/spliced')).toBe(true)
    for (const dispatchOnly of ['turn/start', 'step/start', 'assistant/message', 'request/header'] as const) {
      expect(newEvents.some(event => event.type === dispatchOnly)).toBe(false)
    }
  })

  it('surfaces the blocked dispatch with a reason naming disposal', async () => {
    const { warnCalls } = await raceDisposalAgainstLatchedRecheck()

    // The guard must not fail silently: the fire-and-forget recheck's own
    // error handling (agent.ts's runToolSnapshotRecheck) logs the rejection
    // it caught, and that rejection must be traceable to disposal by name.
    expect(warnCalls.some(args => args.some(arg => String(arg).includes('disposed')))).toBe(true)
  })
})

describe('dispatch guard on a disposed agent (SWD-115)', () => {
  it('refuses synchronously, by name, when something tries to wake a disposed agent directly', async () => {
    const adapter = new MockAdapter([textResponse('should never dispatch')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('disposed-direct-wake'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent

    await handle.dispose()

    expect(() => { send(agent, 'too late') }).toThrow(/disposed/)
    expect(adapter.requests).toHaveLength(0)
  })
})

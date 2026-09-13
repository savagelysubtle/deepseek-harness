import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as contextPressure from '@deepseek-ai/dsh-context-pressure'
import type { Config } from '@deepseek-ai/dsh-context-pressure'
import { formatPercent, resolveSpec, resolveWindowThresholds } from '@deepseek-ai/dsh-context-pressure/src/config.ts'
import { parseWarningText, renderWarningText } from '@deepseek-ai/dsh-context-pressure/src/warning.ts'
import {
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { agentEvents, AgentRegistry, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const PROVIDER = 'mock-provider'
const MODEL = 'mock-model'
const WINDOW = 100_000
const SIGNAL = new AbortController().signal

class WindowAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number | undefined) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.contextWindow === undefined ? {} : { context: { contextWindow: this.contextWindow } },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Mount one plugin fiber. `contextWindow` defaults to {@link WINDOW}; pass
 * `null` for an adapter that advertises no window — `undefined` cannot express
 * that case because it activates the parameter default.
 */
async function mount(config: Config = {}, contextWindow: number | null = WINDOW): Promise<{
  ctx: Context
  fiber: { dispose(): Promise<void> }
}> {
  return mountOn(new Context(), config, contextWindow)
}

async function mountOn(
  ctx: Context,
  config: Config,
  contextWindow: number | null,
): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([PROVIDER, MODEL], new WindowAdapter(contextWindow ?? undefined))
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(contextPressure, config)
  return { ctx, fiber }
}

function agent(session: Session): Agent {
  return {
    id: SessionId('agent'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('context-pressure must append directly to the open step') },
    cancel() { return false },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

const SEED_USAGE: TokenUsage = { inputTokens: 50_000, outputTokens: 1_000 }

/** Closed seeded turn whose usage anchor prices totalTokens deterministically at 51_000. */
function seededSession(id: string, usage: TokenUsage = SEED_USAGE): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'seed prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: PROVIDER, model: MODEL } },
    reason: 'initial',
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'seed reply' }],
      source: { provider: PROVIDER, model: MODEL },
    }),
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function openStepTurn(session: Session, turn: number, step: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
}

/** Close the open step with a routed request whose usage anchors the token meter at `inputTokens`. */
function completeStepWithUsage(session: Session, turn: number, step: number, inputTokens: number): void {
  session.append('request/header', {
    header: { config: { provider: PROVIDER, model: MODEL } },
    reason: 'resume',
  })
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'grown reply' }],
      source: { provider: PROVIDER, model: MODEL },
    }),
    usage: { inputTokens, outputTokens: 0 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

async function fire(ctx: Context, subject: Agent, turn: number, step: number, signal: AbortSignal = SIGNAL): Promise<void> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'request proposal' }],
    source: { kind: 'plugin', plugin: 'context-pressure-test' },
  })
  const decision = await agentEvents(ctx, subject).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      if (message === proposed) continue
      subject.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

function warningTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.events) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'context-pressure') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

function warningPercents(session: Session): string[] {
  return warningTexts(session)
    .map(text => parseWarningText(text)?.thresholdPercent)
    .filter((percent): percent is string => percent !== undefined)
}

describe('threshold crossing and dedup', () => {
  it('fires once per crossed threshold across many steps, smallest unwarned first', async () => {
    const { ctx } = await mount()
    const session = seededSession('crossing')
    const subject = agent(session)
    openStepTurn(session, 2, 1)

    // Seeded usage 51_000 of 100_000 crosses 25% and 50% but not 75%.
    await fire(ctx, subject, 2, 1)
    await fire(ctx, subject, 2, 2)
    await fire(ctx, subject, 2, 3)

    expect(warningPercents(session)).toEqual(['25', '50'])
    const source = session.events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'context-pressure')
    if (source?.type !== 'user/message') throw new Error('missing pressure warning')
    expect(source.data.source).toEqual({
      kind: 'plugin',
      plugin: 'context-pressure',
      form: 'snapshot',
      sections: [{ name: 'context-pressure', text: warningTexts(session)[0] }],
    })
    expect(warningTexts(session)[0]).toContain('51000 of 100000 tokens in use (51%); 49000 tokens remain.')
  })

  it('does not warn below the smallest threshold', async () => {
    const { ctx } = await mount()
    const session = seededSession('below', { inputTokens: 10_000, outputTokens: 500 })
    const subject = agent(session)
    openStepTurn(session, 2, 1)

    await fire(ctx, subject, 2, 1)
    await fire(ctx, subject, 2, 2)

    expect(warningTexts(session)).toEqual([])
  })

  it('warns with zero remaining tokens once usage meets the window', async () => {
    const { ctx } = await mount({}, 1_000)
    const session = seededSession('overflow', { inputTokens: 1_200, outputTokens: 0 })
    const subject = agent(session)
    openStepTurn(session, 2, 1)

    await fire(ctx, subject, 2, 1)

    expect(warningTexts(session)).toHaveLength(1)
    expect(warningTexts(session)[0]).toContain('1200 of 1000 tokens in use (120%); 0 tokens remain.')
  })

  it('re-arms every threshold after a newer compaction/end', async () => {
    const { ctx } = await mount({ thresholds: [0.25] })
    const session = seededSession('rearm', { inputTokens: 30_000, outputTokens: 0 })
    const subject = agent(session)
    openStepTurn(session, 2, 1)
    await fire(ctx, subject, 2, 1)
    expect(warningPercents(session)).toEqual(['25'])

    session.append('compaction/end', { compactionId: CompactionId('rearm-1'), turn: null })
    await fire(ctx, subject, 2, 2)
    await fire(ctx, subject, 2, 3)

    expect(warningPercents(session)).toEqual(['25', '25'])
  })

  it('derives warned state from a resumed log after simulated restart', async () => {
    const original = new Context()
    await mountOn(original, {}, WINDOW)
    const source = seededSession('restart-source')
    const sourceAgent = agent(source)
    openStepTurn(source, 2, 1)
    await fire(original, sourceAgent, 2, 1)
    await fire(original, sourceAgent, 2, 2)
    expect(warningPercents(source)).toEqual(['25', '50'])
    // Close the open step so the resumed log replays as a valid lifecycle.
    source.append('step/end', { turn: 2, step: 1 })
    source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const fresh = new Context()
    await mountOn(fresh, {}, WINDOW)
    const resumed = Session.create(SessionId('restart-resumed'), [...source.events])
    const resumedAgent = agent(resumed)

    // The same pressure level must stay silent after the restart.
    openStepTurn(resumed, 3, 1)
    await fire(fresh, resumedAgent, 3, 1)
    expect(warningPercents(resumed)).toEqual(['25', '50'])

    // ...while the next unwarned crossing still fires exactly once.
    completeStepWithUsage(resumed, 3, 1, 80_000)
    resumed.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    openStepTurn(resumed, 4, 1)
    await fire(fresh, resumedAgent, 4, 1)
    await fire(fresh, resumedAgent, 4, 2)
    expect(warningPercents(resumed)).toEqual(['25', '50', '75'])
  })

  it('ignores foreign text under this plugin name during folding', async () => {
    const { ctx } = await mount({ thresholds: [0.25] })
    const session = seededSession('foreign', { inputTokens: 30_000, outputTokens: 0 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'not a real warning' }],
      source: { kind: 'plugin', plugin: 'context-pressure' },
    }), { surfaceOp: 'append' })
    const subject = agent(session)
    openStepTurn(session, 2, 1)

    await fire(ctx, subject, 2, 1)

    expect(warningPercents(session)).toEqual(['25'])
  })
})

describe('routing and capacity degradation', () => {
  it('skips silently before any request/header exists', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('unrouted'))
    const subject = agent(session)
    openStepTurn(session, 1, 1)

    await fire(ctx, subject, 1, 1)

    expect(warningTexts(session)).toEqual([])
  })

  it.each([
    ['empty provider', { provider: '', model: MODEL }],
    ['empty model', { provider: PROVIDER, model: '' }],
  ] as const)('skips silently on a routed target with an %s', async (_label, partial) => {
    const { ctx } = await mount()
    const session = seededSession(`partial-${_label.replace(' ', '-')}`)
    const header = session.events.find(event => event.type === 'request/header')
    if (header?.type !== 'request/header') throw new Error('missing seeded header')
    session.append('request/header', {
      header: { config: partial },
      reason: 'change',
    })
    const subject = agent(session)
    openStepTurn(session, 2, 1)

    await fire(ctx, subject, 2, 1)

    expect(warningTexts(session)).toEqual([])
  })

  it('logs one diagnostic per unknown-window target and keeps skipping without repeating it', async () => {
    const { ctx } = await mount({}, null)
    const session = seededSession('unknown-window')
    const subject = agent(session)
    openStepTurn(session, 2, 1)
    const warn = vi.spyOn(ctx.logger, 'warn')

    await fire(ctx, subject, 2, 1)
    await fire(ctx, subject, 2, 2)

    expect(warningTexts(session)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain(`${PROVIDER}/${MODEL}`)
  })

  it('treats a rejected adapter lookup like a missing window', async () => {
    const { ctx } = await mount()
    const session = seededSession('no-adapter')
    const header = session.events.find(event => event.type === 'request/header')
    if (header?.type !== 'request/header') throw new Error('missing seeded header')
    session.append('request/header', {
      header: { config: { provider: 'ghost', model: MODEL } },
      reason: 'change',
    })
    const subject = agent(session)
    openStepTurn(session, 2, 1)
    const warn = vi.spyOn(ctx.logger, 'warn')

    await fire(ctx, subject, 2, 1)
    await fire(ctx, subject, 2, 2)

    expect(warningTexts(session)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('configuration and lifecycle', () => {
  it.each([
    ['a descending sequence', [0.5, 0.25], /thresholds\[1\] \(0\.25\) must be strictly ascending/],
    ['duplicate values', [0.5, 0.5], /thresholds\[1\] \(0\.5\) must be strictly ascending/],
    ['a zero value', [0], /thresholds\[0\] \(0\) must be a finite fraction in \(0, 1\)/],
    ['an out-of-range value', [1.5], /thresholds\[0\] \(1\.5\) must be a finite fraction in \(0, 1\)/],
    ['a boundary value', [1], /thresholds\[0\] \(1\) must be a finite fraction in \(0, 1\)/],
    ['a non-finite value', [Number.NaN], /thresholds\[0\] \(NaN\) must be a finite fraction in \(0, 1\)/],
  ] as const)('fails loud at load for %s', async (_label, thresholds, pattern) => {
    const ctx = new Context()
    await expect(mountOn(ctx, { thresholds: [...thresholds] }, WINDOW)).rejects.toThrow(pattern)
  })

  it('accepts an explicit empty threshold list as a disable switch', async () => {
    const { ctx } = await mount({ thresholds: [] })
    const session = seededSession('disabled')
    const subject = agent(session)
    openStepTurn(session, 2, 1)

    await fire(ctx, subject, 2, 1)

    expect(warningTexts(session)).toEqual([])
  })

  it('removes its listener when the plugin fiber disposes', async () => {
    const { ctx, fiber } = await mount({ thresholds: [0.25] })
    const session = seededSession('dispose', { inputTokens: 30_000, outputTokens: 0 })
    const subject = agent(session)
    openStepTurn(session, 2, 1)
    await fire(ctx, subject, 2, 1)
    expect(warningTexts(session)).toHaveLength(1)

    await fiber.dispose()
    await fire(ctx, subject, 2, 2)

    expect(warningTexts(session)).toHaveLength(1)
  })

  it('keeps the decision untouched when the signal is already aborted', async () => {
    const { ctx } = await mount({ thresholds: [0.25] })
    const session = seededSession('aborted', { inputTokens: 30_000, outputTokens: 0 })
    const subject = agent(session)
    openStepTurn(session, 2, 1)
    const abort = new AbortController()
    abort.abort()

    await fire(ctx, subject, 2, 1, abort.signal)

    expect(warningTexts(session)).toEqual([])
  })

  it('propagates a downstream rejection without appending anything', async () => {
    const { ctx } = await mount({ thresholds: [0.25] })
    const session = seededSession('rejected', { inputTokens: 30_000, outputTokens: 0 })
    const subject = agent(session)
    openStepTurn(session, 2, 1)
    ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))

    await fire(ctx, subject, 2, 1)

    expect(warningTexts(session)).toEqual([])
  })

  it('appends after an existing pre-step injector so both contributions compose', async () => {
    const { ctx } = await mount({ thresholds: [0.25] })
    const session = seededSession('ordering', { inputTokens: 30_000, outputTokens: 0 })
    const subject = agent(session)
    openStepTurn(session, 2, 1)
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        kind: 'enter',
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: 'other injector context' }],
          source: { kind: 'plugin', plugin: 'other-context' },
        })],
      }
    })

    await fire(ctx, subject, 2, 1)

    const appended = session.events.filter(event => event.type === 'user/message')
      .map(event => event.data.source.kind === 'plugin' ? event.data.source.plugin : '')
    expect(appended.slice(-2)).toEqual(['other-context', 'context-pressure'])
  })
})

describe('warning text helpers', () => {
  it('renders percents that round-trip through the parser', () => {
    expect(formatPercent(0.25)).toBe('25')
    expect(formatPercent(1 / 3)).toBe(parseWarningText(renderWarningText({
      thresholdRatio: 1 / 3,
      totalTokens: 33_333,
      contextWindow: 100_000,
    }))?.thresholdPercent ?? '')
    const parsed = parseWarningText(renderWarningText({
      thresholdRatio: 0.125,
      totalTokens: 12_500,
      contextWindow: 100_000,
    }))
    expect(parsed).toMatchObject({
      thresholdPercent: '12.5',
      usedPercent: '12.5',
      totalTokens: 12_500,
      contextWindow: 100_000,
      remainingTokens: 87_500,
    })
  })

  it('scales resolved specs to concrete windows', () => {
    const spec = resolveSpec({})
    expect(resolveWindowThresholds(spec, 800)).toEqual([
      { ratio: 0.25, percent: '25', tokens: 200 },
      { ratio: 0.5, percent: '50', tokens: 400 },
      { ratio: 0.75, percent: '75', tokens: 600 },
    ])
  })
})

describe('real Loader export path', () => {
  it('keeps namespace metadata and boots through unwrapExports with YAML config', async () => {
    expect('default' in contextPressure).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(contextPressure) as Record<string, unknown>
    expect(unwrapped).toBe(contextPressure)
    expect(unwrapped.name).toBe('context-pressure')
    expect(unwrapped.inject).toEqual(['llm', 'tokenMeter', 'agents'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')

    const plugin = loader.unwrapExports(contextPressure) as Parameters<Context['plugin']>[0]
    const booted = new Context()
    void new LlmRuntime(booted)
    void new TokenMeter(booted)
    booted.llm.registerAdapter([PROVIDER, MODEL], new WindowAdapter(WINDOW))
    await booted.plugin(AgentRegistry)
    await booted.plugin(plugin, { thresholds: [0.45] })
    const session = seededSession('loader-config', { inputTokens: 46_000, outputTokens: 0 })
    const subject = agent(session)
    openStepTurn(session, 2, 1)
    await fire(booted, subject, 2, 1)
    expect(warningPercents(session)).toEqual(['45'])
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

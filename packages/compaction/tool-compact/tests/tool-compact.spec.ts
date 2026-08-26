import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
} from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { CallId } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolCompact from '../src/index.ts'
import { settlementOf } from '../src/pending.ts'

const COMPACTION_ID = CompactionId('tool-compact-test')

const RESULT: CompactionResult = {
  compactionId: COMPACTION_ID,
  startSeq: 1,
  summarySeq: 2,
  endSeq: 3,
  summary: [{ type: 'text', text: 'summary' }],
  shadowedRange: { start: 1, end: 7 },
  shadowedSeqs: [1, 3, 7],
  shadowedTokenCount: 42,
}

/**
 * Stub backend mirroring the real manual-admission shape: compactNow claims the
 * idle phase through runMaintenance itself and maps a synchronously lost claim
 * to `ManualCompactionError('busy')`, so the harness exercises the same
 * single-claim contract the basic engine imposes.
 */
class StubCompactionEngine extends CompactionEngine {
  result: CompactionResult | null = RESULT
  failure: unknown
  operation: (() => Promise<CompactionResult | null>) | undefined
  calls: { agent: ManualCompactAgentContext; signal: AbortSignal }[] = []

  override compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.resolve(RESULT)
  }

  override compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async () => {
        this.calls.push({ agent, signal })
        if (this.operation !== undefined) return this.operation()
        if (this.failure !== undefined) throw this.failure
        if (this.result === null) return null
        agent.session.append('compaction/start', { compactionId: RESULT.compactionId, turn: null })
        agent.session.append('compaction/end', { compactionId: RESULT.compactionId, turn: null })
        return this.result
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }
}

interface Harness {
  readonly ctx: Context
  readonly engine: StubCompactionEngine
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const engine = new StubCompactionEngine(ctx)
  const plugin = await ctx.plugin(toolCompact)
  return { ctx, engine, plugin }
}

interface FakeAgent extends Agent {
  session: Session
  maintenanceCalls: number
  /** Simulate a waking send that won the idle boundary before the runner acts. */
  occupy(): void
  release(): void
}

/** A parent Agent whose `runMaintenance` refuses any claim while the phase is owned, like the real loop. */
function fakeAgent(id = 'tool-compact-agent'): FakeAgent {
  const session = Session.create(SessionId(id))
  let phase: 'idle' | 'owned' = 'idle'
  const agent = {
    id: SessionId(id),
    options: {},
    session,
    maintenanceCalls: 0,
    occupy(): void {
      phase = 'owned'
    },
    release(): void {
      phase = 'idle'
    },
    runMaintenance(this: FakeAgent, task: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
      if (phase !== 'idle') throw new Error(`agent "${String(this.id)}" already has active work`)
      this.maintenanceCalls += 1
      phase = 'owned'
      return (async () => {
        try {
          return await task(new AbortController().signal)
        } finally {
          phase = 'idle'
        }
      })()
    },
  }
  return agent as unknown as FakeAgent
}

let callCounter = 0

function callCompact(
  ctx: Context,
  agent?: Agent,
  signal: AbortSignal = new AbortController().signal,
) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`compact-${++callCounter}`),
    name: 'compact',
    arguments: {},
    ...(agent ? { agent } : {}),
  })
}

function emitStatus(ctx: Context, agent: Agent, status: 'idle' | 'running'): void {
  ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status })
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('@deepseek-ai/dsh-tool-compact registration', () => {
  it('registers one argument-free compact tool with Loader-safe exports and disposes it', async () => {
    const { ctx, plugin } = await harness()
    expect(toolCompact.name).toBe('tool-compact')
    expect(toolCompact.inject).toEqual(['tools', 'compaction'])
    expect('default' in toolCompact).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolCompact)).toBe(toolCompact)

    const schema = ctx.tools.schemas().find(entry => entry.name === 'compact')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('runs right after the current turn ends')
    const properties = (schema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(properties)).toEqual([])

    const definition = ctx.tools.get('compact')
    expect(definition?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Schedule history compaction',
      kind: 'other',
    })

    await plugin.dispose()
    expect(ctx.tools.schemas().some(entry => entry.name === 'compact')).toBe(false)
  })
})

describe('deferred compact tool', () => {
  it('accepts the schedule immediately and runs compaction at the next idle boundary', async () => {
    const { ctx, engine } = await harness()
    const agent = fakeAgent('happy-path')
    const result = await callCompact(ctx, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected compact success')
    expect(result.value).toEqual({ scheduled: true })
    expect(text(result)).toBe('Compaction scheduled; it runs when this turn ends.')
    expect(engine.calls).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'compaction/start')).toBe(false)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(1)
    expect(engine.calls[0]?.agent).toBe(agent)
    expect(agent.maintenanceCalls).toBe(1)
    expect(agent.session.events.some(event => event.type === 'compaction/start')).toBe(true)
  })

  it('dedups a second call while the schedule is pending', async () => {
    const { ctx, engine } = await harness()
    const agent = fakeAgent('dedup')
    const first = await callCompact(ctx, agent)
    const second = await callCompact(ctx, agent)
    expect(second.isError).toBe(false)
    if (second.isError || first.isError) throw new Error('expected compact successes')
    expect(first.value).toEqual({ scheduled: true })
    expect(second.value).toEqual({ scheduled: false })
    expect(text(first)).toBe('Compaction scheduled; it runs when this turn ends.')
    expect(text(second)).toBe('Compaction was already scheduled; it runs when this turn ends.')

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(1)
  })

  it('re-arms without running when a waking send has already won the idle claim', async () => {
    const { ctx, engine } = await harness()
    const agent = fakeAgent('sync-busy')
    await callCompact(ctx, agent)

    // The wake claimed the boundary before the runner could hand over.
    agent.occupy()
    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'compaction/start')).toBe(false)

    agent.release()
    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'compaction/start')).toBe(true)
  })

  it('re-arms after the claimed run rejects with a durable-lock busy', async () => {
    const { ctx, engine } = await harness()
    const agent = fakeAgent('async-busy')
    engine.operation = () =>
      Promise.reject(new ManualCompactionError('busy', 'another transaction owns the bracket'))
    await callCompact(ctx, agent)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'compaction/start')).toBe(false)

    engine.operation = undefined
    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(2)
    expect(agent.session.events.some(event => event.type === 'compaction/start')).toBe(true)
  })

  it('drops the schedule when the scheduling signal cancels before the boundary', async () => {
    const { ctx, engine } = await harness()
    const agent = fakeAgent('cancelled')
    const controller = new AbortController()
    await callCompact(ctx, agent, controller.signal)
    controller.abort()

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(0)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(0)
  })

  it.each(['changed', 'summary', 'commit', 'persistence'] as const)(
    'logs an expected %s failure and stops without re-arming',
    async (code) => {
      const { ctx, engine } = await harness()
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const agent = fakeAgent(`expected-${code}`)
      engine.failure = new ManualCompactionError(code, 'backend detail')
      await callCompact(ctx, agent)

      emitStatus(ctx, agent, 'idle')
      await flush()

      expect(warn).toHaveBeenCalledWith(expect.stringContaining(code))
      expect(engine.calls).toHaveLength(1)

      emitStatus(ctx, agent, 'idle')
      await flush()

      expect(engine.calls).toHaveLength(1)
    },
  )

  it('settles an engine-reported cancellation silently and does not re-arm', async () => {
    const { ctx, engine } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const agent = fakeAgent('engine-cancelled')
    engine.failure = new ManualCompactionError('cancelled', 'backend observed the abort')
    await callCompact(ctx, agent)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(warn).not.toHaveBeenCalled()
    expect(engine.calls).toHaveLength(1)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(1)
  })

  it('treats a failure arriving after the scheduling signal aborted as cancellation', async () => {
    const { ctx, engine } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const agent = fakeAgent('late-abort')
    const controller = new AbortController()
    engine.operation = () => {
      controller.abort()
      return Promise.reject(new Error('aborted mid-summarization'))
    }
    await callCompact(ctx, agent, controller.signal)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(warn).not.toHaveBeenCalled()
    expect(engine.calls).toHaveLength(1)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(1)
  })

  it('logs unexpected implementation failures without rethrowing or re-arming', async () => {
    const { ctx, engine } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const agent = fakeAgent('unexpected')
    engine.failure = new Error('backend exploded')
    await callCompact(ctx, agent)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('backend exploded'))
    expect(engine.calls).toHaveLength(1)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(1)
  })

  it('records nothing durable when the engine finds no compactable range', async () => {
    const { ctx, engine } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const agent = fakeAgent('nothing-to-compact')
    engine.result = null
    await callCompact(ctx, agent)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(warn).not.toHaveBeenCalled()
    expect(engine.calls).toHaveLength(1)
    expect(agent.session.events.some(event => event.type.startsWith('compaction/'))).toBe(false)

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(1)
  })

  it('runs a fresh schedule even though the previous cycle left a terminal settlement', async () => {
    const { ctx, engine } = await harness()
    const agent = fakeAgent('re-schedule')
    engine.result = null
    await callCompact(ctx, agent)
    emitStatus(ctx, agent, 'idle')
    await flush()
    expect(engine.calls).toHaveLength(1)

    engine.result = RESULT
    const second = await callCompact(ctx, agent)
    expect(second.isError).toBe(false)
    if (second.isError) throw new Error('expected second compact success')
    expect(second.value).toEqual({ scheduled: true })

    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(2)
    expect(agent.session.events.some(event => event.type === 'compaction/start')).toBe(true)
  })

  it('rejects a non-agent caller instead of arming orphan state', async () => {
    const { ctx, engine } = await harness()
    const result = await callCompact(ctx)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
    expect(engine.calls).toHaveLength(0)
  })

  it('reaches quiescence after disposal and leaves fresh state for a remount', async () => {
    const { ctx, engine, plugin } = await harness()
    const agent = fakeAgent('quiescent')
    await callCompact(ctx, agent)

    await plugin.dispose()
    emitStatus(ctx, agent, 'idle')
    await flush()

    expect(engine.calls).toHaveLength(0)

    const remounted = await ctx.plugin(toolCompact)
    try {
      const result = await callCompact(ctx, agent)
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected compact success after remount')
      expect(result.value).toEqual({ scheduled: true })

      emitStatus(ctx, agent, 'idle')
      await flush()

      expect(engine.calls).toHaveLength(1)
    } finally {
      await remounted.dispose()
    }
  })

  it('discards a busy-re-armed schedule on disposal so a remount starts with a clean admission set', async () => {
    const { ctx, engine, plugin } = await harness()
    const agent = fakeAgent('busy-disposal')
    const original = new AbortController()
    await callCompact(ctx, agent, original.signal)

    // A waking send wins the boundary; the runner loses the idle claim and re-arms.
    agent.occupy()
    emitStatus(ctx, agent, 'idle')
    await flush()
    expect(engine.calls).toHaveLength(0)

    // The scheduling call gives up while its re-armed schedule sits pending.
    original.abort()

    // Disposal must sweep the re-armed schedule even though take() removed the
    // agent from the owned set before the busy loss returned it.
    await plugin.dispose()

    const remounted = await ctx.plugin(toolCompact)
    try {
      const fresh = new AbortController()
      const result = await callCompact(ctx, agent, fresh.signal)
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected compact success after remount')
      expect(result.value).toEqual({ scheduled: true })
      expect(text(result)).toBe('Compaction scheduled; it runs when this turn ends.')

      agent.release()
      emitStatus(ctx, agent, 'idle')
      await flush()

      expect(engine.calls).toHaveLength(1)
      expect(engine.calls[0]?.agent).toBe(agent)
      expect(engine.calls[0]?.signal).toBe(fresh.signal)
      expect(agent.session.events.some(event => event.type === 'compaction/start')).toBe(true)
      expect(settlementOf(agent)).toBe('started')
    } finally {
      await remounted.dispose()
    }
  })
})

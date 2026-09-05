/**
 * Wiring coverage for the loop guard (SWD-119, second half): proves the
 * drift-tolerant detectors in loop-guard.ts are actually reachable from a
 * live turn, that a trip aborts loudly (a failing turn/end with a named,
 * stable error code) and emits `agent/loop-aborted` with the channel and the
 * repeated fragment populated, and that legitimate work — including
 * legitimate repetition — never trips it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type LoopAbortChannel } from '@deepseek-ai/dsh-agent'
import AgentLoop, { type Config as AgentLoopConfig } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter, loopGuard?: AgentLoopConfig['loopGuard']): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [], ...loopGuard === undefined ? {} : { loopGuard } })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

interface LoopAbortedSeen {
  channel: LoopAbortChannel
  reason: string
  fragment: string
  turn: number
  step: number
}

/** Subscribe to every `agent/loop-aborted` emission for this agent. */
function captureLoopAborts(ctx: Context, agent: Agent): LoopAbortedSeen[] {
  const seen: LoopAbortedSeen[] = []
  ctx.on('agent/loop-aborted', ({ agent: subject, ...rest }) => {
    if (subject === agent) seen.push(rest)
  })
  return seen
}

/** The failed turn/end reason, when the last turn ended in error. */
function lastTurnError(agent: Agent): { message: string; code: string } | undefined {
  const end = agent.session.events.findLast(event => event.type === 'turn/end')
  return end?.type === 'turn/end' && end.data.reason.kind === 'error' ? end.data.reason.error : undefined
}

/**
 * Build a reasoning stream containing `repeats` copies of a short phrase
 * whose embedded counter increments forever — the "1 bird, 2 bird, 3 bird"
 * shape of the real reasoning-channel incident. No two repeats are
 * byte-identical (the digits keep climbing), so this only trips a
 * drift-tolerant detector, never an exact-match one.
 */
function driftingReasoningResponse(repeats: number): StreamChunk[] {
  let text = ''
  for (let k = 0; k < repeats; k++) {
    const n1 = 3 * k + 1
    const n2 = 3 * k + 2
    const n3 = 3 * k + 3
    text += `Recount now: ${n1} bird, ${n2} bird, ${n3} bird. `
  }
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'reasoning-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Vocabulary pools for the realistic-but-legitimate source generator below. */
const NOUNS = [
  'session', 'request', 'tool', 'agent', 'stream', 'context', 'result', 'payload',
  'handler', 'registry', 'cursor', 'buffer', 'socket', 'worker', 'record', 'event',
]
const VERBS = [
  'create', 'resolve', 'dispatch', 'normalize', 'validate', 'enqueue', 'flush',
  'cancel', 'persist', 'materialize', 'derive', 'register', 'attach', 'detach',
]

/** Deterministic PRNG (mulberry32) so the legitimate-source fixture is stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Legitimate-looking, non-degenerate reasoning text: heavy on structural
 * keywords but with enough lexical variety that no 4-word shingle recurs on
 * the scale the drift guard cares about. Stands in for "a long response with
 * realistic, non-degenerate repetition" at the default thresholds.
 */
function legitimateReasoningResponse(lineCount: number): StreamChunk[] {
  const rng = mulberry32(7)
  const pick = <T>(pool: readonly T[]): T => pool[Math.floor(rng() * pool.length)] as T
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    const n1 = pick(NOUNS)
    const v1 = pick(VERBS)
    const n2 = pick(NOUNS)
    lines.push(`Next I will ${v1} the ${n1} against the ${n2}, then check the ${pick(NOUNS)}.`)
  }
  const text = lines.join(' ')
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'reasoning-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('loop guard wiring: reasoning/output channel', () => {
  it('aborts the turn on a drifting reasoning repetition, not just an exact repeat', async () => {
    // Lowered thresholds (still a genuine override, not the production
    // defaults) keep the fixture small; the phrase's embedded counter still
    // climbs on every repeat, so this only trips because the guard is
    // drift-tolerant — an exact-match detector would never see it.
    const adapter = new MockAdapter([driftingReasoningResponse(200)])
    const ctx = await harness(adapter, { reasoningWindowSize: 50, reasoningDriftThreshold: 5 })
    const agent = ctx.agentLoop.create(SessionId('reasoning-drift'), { provider: 'mock', model: 'mock' })
    const aborts = captureLoopAborts(ctx, agent)

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(lastTurnError(agent)?.code).toBe('LOOP_ABORTED')
    expect(aborts).toHaveLength(1)
    expect(aborts[0]?.channel).toBe('reasoning')
    // Named, human-readable reason — not a bare code.
    expect(aborts[0]?.reason).toMatch(/repeated/i)
    // The fragment quotes back the actual drifting text, digits and all —
    // proof a human can see what it was doing, not just that it aborted.
    expect(aborts[0]?.fragment).toMatch(/bird/)
    // No consolidated assistant/message for the aborted step: the loop bails
    // out of the stream mid-flight rather than finishing and discarding.
    expect(agent.session.events.some(e => e.type === 'assistant/message' && e.data.turn === 1)).toBe(false)
  })

  it('never trips on a long, legitimate, non-degenerate response at the default thresholds', async () => {
    const adapter = new MockAdapter([legitimateReasoningResponse(150), textResponse('done')])
    const ctx = await harness(adapter) // no override: production defaults
    const agent = ctx.agentLoop.create(SessionId('reasoning-legit'), { provider: 'mock', model: 'mock' })
    const aborts = captureLoopAborts(ctx, agent)

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(aborts).toHaveLength(0)
    expect(lastTurnError(agent)).toBeUndefined()
    const end = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('completed')
  }, 20_000)
})

describe('loop guard wiring: tool-call channel', () => {
  it('aborts on a repeated tool call with zero state change', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'check_status', { id: 'job-1' }),
      toolCallResponse('c2', 'check_status', { id: 'job-1' }),
      toolCallResponse('c3', 'check_status', { id: 'job-1' }),
    ])
    // Explicit override: the production default now sits above the
    // repeat-tool-reminder escalation ladder, so this wiring test pins its own
    // threshold rather than depending on a policy number that must be free to move.
    const ctx = await harness(adapter, { toolRepeatThreshold: 3 })
    ctx.tools.register(defineContentToolFixture({
      name: 'check_status',
      description: 'always reports the same stuck state',
      parameters: { id: { type: 'string', required: true } },
      async execute() {
        return [{ type: 'text', text: 'still pending' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('tool-repeat'), { provider: 'mock', model: 'mock' })
    const aborts = captureLoopAborts(ctx, agent)

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(lastTurnError(agent)?.code).toBe('LOOP_ABORTED')
    expect(aborts).toHaveLength(1)
    expect(aborts[0]?.channel).toBe('tool-call')
    expect(aborts[0]?.reason).toMatch(/check_status/)
    expect(aborts[0]?.reason).toMatch(/repeated/i)
    // The fragment names the exact repeated call so a human can see what it was doing.
    expect(aborts[0]?.fragment).toContain('check_status')
    expect(aborts[0]?.fragment).toContain('job-1')
    // Exactly 3 real tool/result events committed — no synthetic result
    // fabricated for a call that never started (the fourth model turn never
    // happens because the abort throws out of the third).
    expect(agent.session.events.filter(e => e.type === 'tool/result')).toHaveLength(3)
  })

  it('does not trip a polling tool whose result keeps changing (legitimate repetition)', async () => {
    let poll = 0
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'poll_status', { jobId: 'job-1' }),
      toolCallResponse('c2', 'poll_status', { jobId: 'job-1' }),
      toolCallResponse('c3', 'poll_status', { jobId: 'job-1' }),
      toolCallResponse('c4', 'poll_status', { jobId: 'job-1' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'poll_status',
      description: 'reports live progress',
      parameters: { jobId: { type: 'string', required: true } },
      async execute() {
        poll += 1
        return [{ type: 'text', text: `progress: ${poll}` }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('tool-poll'), { provider: 'mock', model: 'mock' })
    const aborts = captureLoopAborts(ctx, agent)

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(aborts).toHaveLength(0)
    expect(lastTurnError(agent)).toBeUndefined()
    expect(agent.session.events.filter(e => e.type === 'tool/result')).toHaveLength(4)
    const end = agent.session.events.findLast(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('completed')
  })
})

describe('loop guard wiring: configurable thresholds', () => {
  it('a tightened toolRepeatThreshold trips on the second repeat instead of the third', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'check_status', { id: 'job-1' }),
      toolCallResponse('c2', 'check_status', { id: 'job-1' }),
    ])
    const ctx = await harness(adapter, { toolRepeatThreshold: 2 })
    ctx.tools.register(defineContentToolFixture({
      name: 'check_status',
      description: 'always reports the same stuck state',
      parameters: { id: { type: 'string', required: true } },
      async execute() {
        return [{ type: 'text', text: 'still pending' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('tool-repeat-tight'), { provider: 'mock', model: 'mock' })
    const aborts = captureLoopAborts(ctx, agent)

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(aborts).toHaveLength(1)
    expect(agent.session.events.filter(e => e.type === 'tool/result')).toHaveLength(2)
  })

  it('rejects a non-positive-integer threshold override at startup', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await expect(
      ctx.plugin(AgentLoop, { agents: [], loopGuard: { toolRepeatThreshold: 0 } }),
    ).rejects.toThrow(/toolRepeatThreshold must be a positive integer/)
  })
})

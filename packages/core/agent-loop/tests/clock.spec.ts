/**
 * Presence guarantee for the unconditional per-request clock tail (SWD-113,
 * see `../src/clock.ts`): every request `ReactLoopAgent.buildRequest` (in
 * `../src/agent.ts`) dispatches must end with exactly one message satisfying
 * `isClockMessage`, on every step of a multi-step turn AND on the very first
 * request a resumed session ever dispatches. The request-reconstruction
 * invariant (`../src/invariant.ts`) now enforces this at runtime by failing
 * loud when the last message is not the clock tail; this file proves the
 * property end to end through the real loop rather than the invariant unit
 * alone.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { formatDateTime } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { isClockMessage } from '../src/clock.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

async function harness(adapter: MockAdapter, now: () => Date) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'stable base' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [], now })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
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

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
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

/** Count of messages in `messages` satisfying {@link isClockMessage}. */
function clockMessageCount(messages: GenerateOptions['messages']): number {
  return messages.filter(isClockMessage).length
}

describe('clock tail presence guarantee (SWD-113)', () => {
  it('carries the clock tail exactly once, as the last message, on every request of a multi-step turn '
    + '(user turn -> tool call -> tool result -> final answer), and the clock text advances between steps',
  async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'calling the tool'),
      textResponse('final answer'),
    ])
    let tick = new Date('2026-01-01T00:00:00Z')
    const ctx = await harness(adapter, () => tick)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('multi-step'), { provider: 'mock', model: 'mock' })

    // Bump the injected clock between the two steps of this one turn, before
    // the second step's own buildRequest() reads it -- mirrors
    // request-reconstruction.spec.ts's own clock-tail test.
    ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.step === 2) tick = new Date('2026-01-01T00:05:00Z')
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // Two dispatches: the tool-call step, then the concluding text step.
    expect(adapter.requests).toHaveLength(2)

    for (const request of adapter.requests) {
      // Exactly one clock message anywhere in the request, and it is the LAST one.
      expect(clockMessageCount(request.messages)).toBe(1)
      const last = request.messages[request.messages.length - 1]
      expect(last !== undefined && isClockMessage(last)).toBe(true)
    }

    const firstTail = adapter.requests[0]!.messages.at(-1)!
    const secondTail = adapter.requests[1]!.messages.at(-1)!
    expect(firstTail.content).toEqual([{ type: 'text', text: formatDateTime(new Date('2026-01-01T00:00:00Z'), ZONE) }])
    expect(secondTail.content).toEqual([{ type: 'text', text: formatDateTime(new Date('2026-01-01T00:05:00Z'), ZONE) }])
    // The clock genuinely advanced between steps -- not just present twice.
    expect(secondTail.content).not.toEqual(firstTail.content)

    // Never persisted: no logged user/message is the clock tail.
    expect(agent.session.events.some(e => e.type === 'user/message' && isClockMessage(e.data))).toBe(false)
  })

  it("carries the clock tail on a resumed session's very first dispatched request", async () => {
    const firstGenAdapter = new MockAdapter([textResponse('first generation answer')])
    const firstCtx = await harness(firstGenAdapter, () => new Date('2026-01-01T00:00:00Z'))
    const firstAgent = firstCtx.agentLoop.create(SessionId('resume-source'), { provider: 'mock', model: 'mock' })
    send(firstAgent, 'first generation message')
    await waitForIdle(firstCtx, firstAgent)

    // A fresh loop instance, in a fresh Context, seeded with the first
    // generation's full session log -- the resume/fork path.
    const resumedAdapter = new MockAdapter([textResponse('resumed answer')])
    const resumedCtx = await harness(resumedAdapter, () => new Date('2026-06-15T12:30:00Z'))
    const resumedHandle = await resumedCtx.agents.create({
      sessionId: SessionId('resume-target'),
      seed: [...firstAgent.session.events],
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const resumedAgent = resumedHandle.agent

    send(resumedAgent, 'resumed message')
    await waitForIdle(resumedCtx, resumedAgent)

    // The resumed instance's very first (and only) dispatch.
    expect(resumedAdapter.requests).toHaveLength(1)
    const request = resumedAdapter.requests[0]!
    expect(clockMessageCount(request.messages)).toBe(1)
    const last = request.messages[request.messages.length - 1]
    expect(last !== undefined && isClockMessage(last)).toBe(true)
    expect(last?.content).toEqual([{ type: 'text', text: formatDateTime(new Date('2026-06-15T12:30:00Z'), ZONE) }])

    // The real user message sits just before the clock tail, not replaced by it.
    const secondToLast = request.messages.at(-2)
    expect(secondToLast).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'resumed message' }],
    })
  })
})

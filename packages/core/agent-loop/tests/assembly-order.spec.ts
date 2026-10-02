/**
 * SWD-125 regression: `preStep` (`../src/agent.ts`) builds its system-prompt
 * assembly BEFORE `turn()` appends the step's own claimed messages as
 * `user/message` events, so any prompt section that reads the open turn's
 * current input off `session.events` rendered from a log one step behind on
 * the FIRST request of every turn. `turn()` now re-assembles once the
 * step's own messages are logged, before `step()` renders the system
 * prompt, so the request that follows carries the correct, up-to-date
 * content from the very first request.
 *
 * These tests mount the real `SystemPrompt` plugin and register ONE
 * TEST-ONLY section (via its public `section()` API, the same way
 * `scope-lifecycle.spec.ts` and `agent-initiator.spec.ts` in this directory
 * register their own test sections) whose text is the open turn's LATEST
 * `user/message` content. That observable stands in for any real section
 * that reads `context.agent.session.events` (e.g.
 * `packages/plan/plan-mode/src/index.ts`'s own section provider) — the
 * ordering guarantee under test applies to all of them equally.
 *
 * The re-assemble is unconditional (not gated on `decision.messages.length`):
 * an `agent/pre-step` listener can mutate `session.events` directly instead
 * of going through `decision.messages` -- `compaction-basic`'s
 * `commitCompactionBody` (`packages/compaction/compaction-basic/src/region.ts`)
 * does exactly this, appending a `user/message` via a `replace` surfaceOp --
 * so an empty `decision.messages` is never proof the log is unchanged since
 * `preStep`'s early assembly. One test below simulates that directly.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/** Name of this file's test-only section (see the file header comment). */
const TEST_SECTION_NAME = 'test:latest-user-message'

/**
 * The open turn's LATEST `user/message` text content, or `''` when there is
 * no open turn or it carries no `user/message` at all. Mirrors the
 * open-turn window walk `packages/plan/plan-mode/src/index.ts`'s
 * `foldPlanMode` and the former `founder:context` section both used:
 * scan backward for the most recent `turn/start`/`turn/end` boundary.
 * @param events - the session log, or any prefix of it.
 * @returns the latest open-turn `user/message`'s joined text content, or `''`.
 */
function openTurnLatestUserMessageText(events: readonly SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') return ''
    if (boundary?.type === 'turn/start') {
      const userMessages = events.slice(index + 1)
        .filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
          event.type === 'user/message')
      const latest = userMessages.at(-1)
      if (latest === undefined) return ''
      return latest.data.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('')
    }
  }
  return ''
}

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'stable base' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  // The test-only observable this file's assertions read off `adapter.requests[n].system`.
  ctx.systemPrompt.section({
    name: TEST_SECTION_NAME,
    order: -98.5,
    text: context => context.agent === undefined ? '' : openTurnLatestUserMessageText(context.agent.session.events),
  })
  return ctx
}

function registerEcho(ctx: Context): void {
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo back',
    parameters: { text: { type: 'string' } },
    async execute(args) {
      return [{ type: 'text', text: `echo: ${String(args.text)}` }]
    },
  }))
}

/** Send one followup message carrying `text`. */
function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
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

describe('system prompt assembly order on the first request of a turn (SWD-125)', () => {
  it('carries the claimed message on the FIRST request of the turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.system).toContain('go')
  })

  it('still carries the latest message on a second step of the same turn', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'calling the tool'),
      textResponse('final answer'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.system).toContain('go')
    expect(adapter.requests[1]?.system).toContain('go')
  })

  it('assembles the system prompt exactly twice for a one-step turn -- once in preStep, once '
    + 'after the append -- making the extra per-step cost of the fix explicit', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const assembleSpy = vi.spyOn(ctx.systemPrompt, 'assemble')
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // One step: the early pre-append read in `preStep`, and the corrective
    // re-assemble in `turn()` once this step's own message is logged.
    expect(assembleSpy).toHaveBeenCalledTimes(2)
  })

  it('reflects a session.events mutation an agent/pre-step listener makes OUTSIDE decision.messages '
    + '-- the compaction-basic checkpoint-append pattern -- even when that step\'s own inbox claim is empty',
  async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'calling the tool'),
      textResponse('final answer'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // Simulate `commitCompactionBody`: on this turn's second step, append a
    // `user/message` straight onto `session.events` (a `replace`-shaped
    // surfaceOp in the real listener; `append` here is enough to prove the
    // point), then hand back an EMPTY `messages` array -- as if this step's
    // own inbox claim were empty -- so a guard keyed on
    // `decision.messages.length` could never have caught this mutation.
    ctx.on('agent/pre-step', async ({ agent: subject, step }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || subject !== agent || step !== 2) return decision
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      return { ...decision, messages: [] }
    })

    // The ORIGINAL followup carries different text: the only possible
    // source of "checkpoint" on the second request is the listener's direct
    // append above.
    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.system ?? '').not.toContain('checkpoint')
    expect(adapter.requests[1]?.system).toContain('checkpoint')
  })

  it('leaves existing ordering untouched: turn/step boundaries still bracket exactly one logged user/message', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const types = agent.session.events.map(event => event.type)
    // turn/start -> step/start -> user/message -> ... -> step/end -> turn/end,
    // unchanged by the extra re-assemble: it reads the log, never writes it.
    expect(types.indexOf('turn/start')).toBeLessThan(types.indexOf('step/start'))
    expect(types.indexOf('step/start')).toBeLessThan(types.indexOf('user/message'))
    expect(types.indexOf('user/message')).toBeLessThan(types.indexOf('assistant/message'))
    expect(types.indexOf('step/end')).toBeGreaterThan(types.indexOf('assistant/message'))
    expect(types.at(-1)).toBe('turn/end')
    expect(types.filter(type => type === 'user/message')).toHaveLength(1)
    expect(types.filter(type => type === 'request/header')).toHaveLength(1)
  })
})

/**
 * SWD-125 regression: `preStep` (`../src/agent.ts`) builds its system-prompt
 * assembly BEFORE `turn()` appends the step's own claimed messages as
 * `user/message` events, so any prompt section that reads the open turn's
 * current input off `session.events` -- `founder:context`
 * (`@deepseek-ai/dsh-system-prompt`) chief among them -- rendered from a log
 * one step behind on the FIRST request of every turn. `turn()` now
 * re-assembles once the step's own messages are logged, before `step()`
 * renders the system prompt, so the request that follows carries the
 * correct stamp from the very first request.
 *
 * These tests mount the real `SystemPrompt` plugin -- `founder:context` is
 * registered unconditionally by its constructor, so no stand-in section is
 * needed -- and spy on `assemble()` to make the extra per-step cost
 * explicit rather than implicit.
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
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/** The fixed notice `founder:context` renders for a founder-stamped open turn. */
const FOUNDER_NOTICE = 'The current input is the founder\'s own'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'stable base' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
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

/** Send one followup message, stamped as the founder's own when `founder` is `true`. */
function send(agent: Agent, text: string, founder?: true): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: founder === true ? { kind: 'user', founder: true } : { kind: 'user' },
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

describe('founder:context on the first request of a turn (SWD-125)', () => {
  it('stamps the FIRST request when the claimed message is founder-stamped', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go', true)
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.system).toContain(FOUNDER_NOTICE)
  })

  it('does not stamp the first request for a bare (non-founder) message', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.system ?? '').not.toContain(FOUNDER_NOTICE)
  })

  it('still carries the stamp on a second step of the same founder-stamped turn', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'calling the tool'),
      textResponse('final answer'),
    ])
    const ctx = await harness(adapter)
    registerEcho(ctx)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go', true)
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.system).toContain(FOUNDER_NOTICE)
    expect(adapter.requests[1]?.system).toContain(FOUNDER_NOTICE)
  })

  it('assembles the system prompt exactly twice for a one-step turn -- once in preStep, once '
    + 'after the append -- making the extra per-step cost of the fix explicit', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const assembleSpy = vi.spyOn(ctx.systemPrompt, 'assemble')
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go', true)
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
    // founder-stamped `user/message` straight onto `session.events` (a
    // `replace`-shaped surfaceOp in the real listener; `append` here is
    // enough to prove the point), then hand back an EMPTY `messages` array
    // -- as if this step's own inbox claim were empty -- so a guard keyed on
    // `decision.messages.length` could never have caught this mutation.
    ctx.on('agent/pre-step', async ({ agent: subject, step }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || subject !== agent || step !== 2) return decision
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'user', founder: true },
      }), { surfaceOp: 'append' })
      return { ...decision, messages: [] }
    })

    // The ORIGINAL followup is deliberately NOT founder-stamped: the only
    // possible source of the notice on the second request is the listener's
    // direct append above.
    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.system ?? '').not.toContain(FOUNDER_NOTICE)
    expect(adapter.requests[1]?.system).toContain(FOUNDER_NOTICE)
  })

  it('leaves existing ordering untouched: turn/step boundaries still bracket exactly one logged user/message', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go', true)
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

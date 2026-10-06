import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { MAX_AWAIT_SETTLEMENT_DEADLINE_MS, SubagentError } from '@deepseek-ai/dsh-subagent'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'
import { DEFAULT_AWAIT_DEADLINE_MS } from '../src/await-subagent.ts'

const testToolSignal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

describe('dsh-tool-subagent-control await_subagent', () => {
  it('registers await_subagent with subagent_id required and deadline_ms optional', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'await_subagent')
    expect(schemas).toHaveLength(1)
    const parameters = schemas[0]!.parameters as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(parameters.properties ?? {}).sort()).toEqual(['deadline_ms', 'subagent_id'])
    expect(parameters.required ?? []).toEqual(['subagent_id'])
    expect(schemas[0]!.description).toContain('send_message')
    expect(schemas[0]!.description).toContain(String(MAX_AWAIT_SETTLEMENT_DEADLINE_MS))
  })

  it('returns settled promptly when the runtime resolves on the fast path', async () => {
    const { ctx, parent } = await setup()
    const settledAt = Date.UTC(2026, 9, 5, 12, 0, 0)
    const awaitSettlement = vi.spyOn(ctx.subagents, 'awaitSettlement')
      .mockResolvedValue({ status: 'settled', outcome: 'completed', settledAt })

    const result = await callTool(ctx, 'await_subagent', { subagent_id: 'child-1' }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`subagent child-1 settled: completed at ${new Date(settledAt).toISOString()}`)
    expect(awaitSettlement).toHaveBeenCalledExactlyOnceWith(
      SessionId('child-1'), parent, DEFAULT_AWAIT_DEADLINE_MS, testToolSignal,
    )
  })

  it('returns pending via the deadline-recheck path when the runtime reports pending', async () => {
    const { ctx, parent } = await setup()
    vi.spyOn(ctx.subagents, 'awaitSettlement').mockResolvedValue({ status: 'pending' })

    const result = await callTool(ctx, 'await_subagent', { subagent_id: 'child-1', deadline_ms: 50 }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'subagent child-1 has not settled yet — call list_agents to check later, or await_subagent again',
    )
  })

  it('clamps an oversized deadline to the documented maximum', async () => {
    const { ctx, parent } = await setup()
    const awaitSettlement = vi.spyOn(ctx.subagents, 'awaitSettlement').mockResolvedValue({ status: 'pending' })

    await callTool(
      ctx, 'await_subagent', { subagent_id: 'child-1', deadline_ms: MAX_AWAIT_SETTLEMENT_DEADLINE_MS * 10 }, parent,
    )

    expect(awaitSettlement).toHaveBeenCalledExactlyOnceWith(
      SessionId('child-1'), parent, MAX_AWAIT_SETTLEMENT_DEADLINE_MS, testToolSignal,
    )
  })

  it('falls back to the default deadline for a non-positive request', async () => {
    const { ctx, parent } = await setup()
    const awaitSettlement = vi.spyOn(ctx.subagents, 'awaitSettlement').mockResolvedValue({ status: 'pending' })

    await callTool(ctx, 'await_subagent', { subagent_id: 'child-1', deadline_ms: 0 }, parent)

    expect(awaitSettlement).toHaveBeenCalledExactlyOnceWith(
      SessionId('child-1'), parent, DEFAULT_AWAIT_DEADLINE_MS, testToolSignal,
    )
  })

  it('rejects a caller that is not the child\'s exact live direct parent', async () => {
    const { ctx, parent } = await setup()
    vi.spyOn(ctx.subagents, 'awaitSettlement').mockImplementation(() => {
      throw new SubagentError('subagent "stranger-child" belongs to another parent session', 'UNAUTHORIZED')
    })

    const result = await callTool(ctx, 'await_subagent', { subagent_id: 'stranger-child' }, parent)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('another parent session')
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'await_subagent', { subagent_id: 'child-1' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('unregisters with its plugin fiber alongside the other root tools (HMR safety)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'await_subagent')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'await_subagent')).toBe(false)
  })
})

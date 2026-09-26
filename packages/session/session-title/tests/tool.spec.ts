/**
 * Tool-level tests for `tool-session-title`: mounted through the real plugin
 * plus a real `ToolRuntime`, dispatched through `ctx.tools.execute` exactly as
 * a live model call would run — not a direct call into `apply`'s closure.
 * Covers the registration shape, both preflight failures (no session-title
 * service mounted, no live agent session on the call), the accepted-rename
 * success path and its rendered confirmation text, and the registration
 * disposer `apply` returns.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as toolSessionTitle from '../src/tool.ts'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

let callCounter = 0

/** A calling Agent stub over a real live session; the tool reads only `.session`. */
function agentFor(session: ReturnType<Context['sessions']['create']>): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** Mount ToolRuntime and the plugin under test, optionally with the session-title service. */
async function setup(withService: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  if (withService) await ctx.plugin(SessionTitleService, CONFIG)
  await ctx.plugin(toolSessionTitle)
  return ctx
}

/** Dispatch `session_title` through the real registry pipeline. */
function call(ctx: Context, args: unknown, agent?: Agent) {
  callCounter += 1
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${String(callCounter)}`),
    name: 'session_title',
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** Concatenate the rendered text blocks of a tool result. */
function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('tool-session-title plugin', () => {
  it('exposes its registration name and tools injection requirement', () => {
    expect(toolSessionTitle.name).toBe('tool-session-title')
    expect(toolSessionTitle.inject).toEqual(['tools'])
  })

  it('registers session_title with a single required string "title" parameter', async () => {
    const ctx = await setup(true)
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'session_title')
    expect(schema).toBeDefined()
    const parameters = schema!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(parameters.properties)).toEqual(['title'])
    expect(parameters.required).toEqual(['title'])
    expect(schema!.description).toContain('Set the title of your own conversation')
    expect(schema!.description).toContain('The title you set is pinned')
    await ctx.fiber.dispose()
  })

  it('apply() returns the exact registration disposer', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const dispose = toolSessionTitle.apply(ctx)
    expect(ctx.tools.get('session_title')).toBeDefined()
    dispose()
    expect(ctx.tools.get('session_title')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails loud when the session-title service is not mounted', async () => {
    const ctx = await setup(false)
    const session = ctx.sessions.create(SessionId('tool-no-service'))
    const result = await call(ctx, { title: 'Name it' }, agentFor(session))
    expect(result.isError).toBe(true)
    expect(text(result as never)).toMatch(
      /session_title requires the session-title service — mount @deepseek-ai\/dsh-session-title/,
    )
    await ctx.fiber.dispose()
  })

  it('fails loud when the call carries no live agent session', async () => {
    const ctx = await setup(true)
    const result = await call(ctx, { title: 'Name it' })
    expect(result.isError).toBe(true)
    expect(text(result as never)).toMatch(
      /session_title requires an agent session: only a live session can title itself/,
    )
    await ctx.fiber.dispose()
  })

  it('accepts a title, pins it with the user source, and renders the confirmation', async () => {
    const ctx = await setup(true)
    const session = ctx.sessions.create(SessionId('tool-rename-accept'))
    const result = await call(ctx, { title: '  Weekend   planning  ' }, agentFor(session))
    expect(result.isError).toBe(false)
    const value = (result as { value: { title: string } }).value
    expect(value).toEqual({ title: 'Weekend planning' })
    expect(text(result as never)).toBe('Session title set to: Weekend planning')
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Weekend planning',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    await ctx.fiber.dispose()
  })
})

/**
 * Tool-level tests for the `memory` consumer: mounted through the real
 * plugin + ToolRuntime, executed through `ctx.tools.execute` with a real
 * Session carrying a cwd — the same path a live model drives. Covers the
 * session-cwd scoping requirement, action validation, and render output.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { LocalMemoryProvider } from '../src/local.ts'
import { apply as toolMemoryApply } from '../src/tool.ts'

let callCounter = 0

/** A parent Agent backed by a real Session whose header carries the workspace cwd. */
function agentWithCwd(cwd: string): Agent {
  const session = Session.create(SessionId('memory-test'), [], {
    version: 0,
    id: SessionId('memory-test'),
    createdAt: Date.now(),
    cwd,
  })
  return { id: SessionId('memory-test'), session } as unknown as Agent
}

async function setup(): Promise<{ ctx: Context; root: string; cwd: string }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-tool-'))
  await ctx.plugin(LocalMemoryProvider, { root })
  // Tool consumes the service via ctx.get (same realm in real presets).
  await ctx.plugin({ name: 'tool-memory', inject: ['tools'], apply: toolMemoryApply }, {})
  return { ctx, root, cwd: '/tmp/fictional/tool-workspace' }
}

async function call(ctx: Context, args: unknown, cwd?: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${String(++callCounter)}`),
    name: 'memory',
    arguments: args,
    agent: agentWithCwd(cwd ?? '/tmp/fictional/tool-workspace'),
  })
}

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('memory tool', () => {
  it('registers a model-facing `memory` tool with an action-discriminated schema', async () => {
    const { ctx, root } = await setup()
    try {
      const schema = ctx.tools.schemas().find(candidate => candidate.name === 'memory')
      expect(schema).toBeDefined()
      const properties = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      expect(Object.keys(properties)).toEqual(['action', 'path', 'content', 'query'])
      expect((properties.action as { enum?: string[] }).enum).toEqual(['read', 'write', 'list', 'search'])
    } finally {
      await rm(root, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('round-trips write → list → read → search against the session cwd scope', async () => {
    const { ctx, root } = await setup()
    try {
      const content = '# Auth\n\nToken lives in SUPABASE_KEY env var.\n'
      const write = await call(ctx, { action: 'write', path: 'todo/auth.md', content })
      expect(text(write)).toBe(`Saved todo/auth.md (${String(Buffer.byteLength(content, 'utf8'))} bytes).`)

      const list = await call(ctx, { action: 'list' })
      expect(text(list)).toBe(`- todo/auth.md (${String(Buffer.byteLength(content, 'utf8'))} B)`)

      const read = await call(ctx, { action: 'read', path: 'todo/auth.md' })
      expect(text(read)).toContain('SUPABASE_KEY')

      const search = await call(ctx, { action: 'search', query: 'supabase_key' })
      expect(text(search)).toBe('[todo/auth.md:3] Token lives in SUPABASE_KEY env var.')
    } finally {
      await rm(root, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('scopes storage by the calling session cwd; another workspace does not see it', async () => {
    const { ctx, root } = await setup()
    try {
      await call(ctx, { action: 'write', path: 'private.md', content: 'workspace one note' })
      const otherList = await call(ctx, { action: 'list' }, '/tmp/fictional/other-workspace')
      expect(text(otherList)).toBe('(no memory entries yet — create one with action:"write")')
      // Execute surfaces provider errors as isError results (the loop shows
      // them to the model), so the assertion reads the captured diagnostic.
      const missedRead = await call(ctx, { action: 'read', path: 'private.md' }, '/tmp/fictional/other-workspace')
      expect(missedRead.isError).toBe(true)
      expect(text(missedRead as never)).toMatch(/no entry "private\.md"/)
    } finally {
      await rm(root, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('rejects jail escapes and missing session cwd with named diagnostics', async () => {
    const { ctx, root } = await setup()
    try {
      const escape = await call(ctx, { action: 'write', path: '../../escape.md', content: 'x' })
      expect(escape.isError).toBe(true)
      expect(text(escape as never)).toMatch(/path escapes the project scope/)
      const absolute = await call(ctx, { action: 'read', path: '/etc/passwd' })
      expect(absolute.isError).toBe(true)
      expect(text(absolute as never)).toMatch(/must be relative to the project scope/)
      // A non-agent caller has no scoped workspace at all. Must run while the
      // registry lives — a disposed fiber proxies nothing.
      const anonymous = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('call-no-agent'),
        name: 'memory',
        arguments: { action: 'list' },
      })
      expect(anonymous.isError).toBe(true)
      expect(text(anonymous as never)).toMatch(/requires an agent session with a working directory/)
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates action-specific required arguments fail loud', async () => {
    const { ctx, root } = await setup()
    try {
      const cases = [
        { args: { action: 'read' }, pattern: /requires a non-empty "path"/ },
        { args: { action: 'write', path: 'x.md' }, pattern: /requires string "content"/ },
        { args: { action: 'search' }, pattern: /requires a non-empty query/ },
        // An unknown enum value dies at schema validation, before execute
        // runs; the executor keeps its unknown-action guard for direct calls.
        { args: { action: 'append', path: 'x.md' }, pattern: /"action" must be one of/ },
      ] as const
      for (const { args, pattern } of cases) {
        const result = await call(ctx, args)
        expect(result.isError, args.action).toBe(true)
        expect(text(result), args.action).toMatch(pattern)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('reports an empty-list guidance render before any entry exists', async () => {
    const { ctx, root } = await setup()
    try {
      const empty = await call(ctx, { action: 'search', query: 'nothing-here' })
      expect(text(empty)).toBe('(no matches)')
    } finally {
      await rm(root, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })
})

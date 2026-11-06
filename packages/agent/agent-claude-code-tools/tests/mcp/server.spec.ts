import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSeatMcpServer, neverTaintTools } from '../../src/mcp/server.ts'
import { createLeadTemplate } from '../../src/mcp/template.ts'
import { DIRECTORY_SCHEMA } from '../../src/mcp/schema.ts'
import { SeatToolTemplate } from '../../src/mcp/template.ts'
import { assertTaintDeclaration, defineSeatTool, textResult } from '../../src/mcp/types.ts'
import type { SeatTool } from '../../src/mcp/types.ts'
import { callThroughServer, listThroughServer, makeContext, textOf } from './helpers.ts'

const both = ['mailbox_send', 'mailbox_directory']

function server(seat: string, context = makeContext({ seat }), tools: readonly string[] = both) {
  return { server: createSeatMcpServer({ seat, tools, template: createLeadTemplate(), context }), context }
}

describe('createSeatMcpServer', () => {
  it('builds an sdk-type server named dsh that advertises exactly the requested tools with closed schemas', async () => {
    const { server: built } = server('lead-one')
    expect(built.type).toBe('sdk')
    expect(built.name).toBe('dsh')
    const tools = await listThroughServer(built.instance)
    expect(tools.map(tool => tool.name)).toEqual(['mailbox_send', 'mailbox_directory'])
    for (const tool of tools) expect(tool.inputSchema['additionalProperties']).toBe(false)
  })

  it('exposes only the requested subset', async () => {
    const { server: built } = server('lead-one', undefined, ['mailbox_directory'])
    expect((await listThroughServer(built.instance)).map(tool => tool.name)).toEqual(['mailbox_directory'])
  })

  it('the SDK layer rejects a forged sender instead of stripping it, and nothing is published', async () => {
    const { server: built, context } = server('lead-one')
    for (const key of ['from', 'seat', 'tainted', 'chain']) {
      const result = await callThroughServer(built.instance, 'mailbox_send', { to: 'ops-lead', body: 'x', [key]: 'evil' })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain(key)
    }
    expect(context.published).toHaveLength(0)
    const ok = await callThroughServer(built.instance, 'mailbox_send', { to: 'ops-lead', body: 'x' })
    expect(ok.isError).toBeUndefined()
    expect(context.published[0]?.from).toBe('lead-one')
  })

  it('two servers in one process never share closure state or identity', async () => {
    const a = server('lead-a', makeContext({ seat: 'lead-a', sendTo: ['x-one'] }))
    const b = server('lead-b', makeContext({ seat: 'lead-b', sendTo: ['x-two'] }))
    await callThroughServer(a.server.instance, 'mailbox_send', { to: 'x-one', body: 'from a' })
    // b cannot reach a's destination list, and cannot be made to speak as a.
    const crossed = await callThroughServer(b.server.instance, 'mailbox_send', { to: 'x-one', body: 'crossed', from: 'lead-a' })
    expect(crossed.isError).toBe(true)
    const direct = await callThroughServer(b.server.instance, 'mailbox_send', { to: 'x-one', body: 'crossed' })
    expect(textOf(direct)).toContain('not in this seat\'s send_to list')
    await callThroughServer(b.server.instance, 'mailbox_send', { to: 'x-two', body: 'from b' })
    expect(a.context.published.map(m => [m.from, m.to])).toEqual([['lead-a', 'x-one']])
    expect(b.context.published.map(m => [m.from, m.to])).toEqual([['lead-b', 'x-two']])
    expect(a.server.instance).not.toBe(b.server.instance)
    expect(textOf(await callThroughServer(a.server.instance, 'mailbox_directory', {}))).not.toContain('x-two')
  })

  it('an empty tool list throws SeatMutedByPolicyError and builds nothing', () => {
    expect(() => server('lead-one', undefined, [])).toThrow(SeatMutedByPolicyError)
  })

  it('an unknown tool name throws SeatMutedByPolicyError naming it', () => {
    expect(() => server('lead-one', undefined, ['mailbox_send', 'mailbox_await'])).toThrow(/cannot provide: mailbox_await/)
  })

  it('schema conversion fails closed at construction, not at call time', () => {
    const template = createLeadTemplate()
    template.register('bad', context => defineSeatTool(context, {
      name: 'bad', description: 'unconvertible', inputSchema: z.strictObject({ when: z.date() }), taint: 'never', taintReason: 'test tool returning a constant', handler: async () => textResult(context, 'never'),
    }))
    expect(() => createSeatMcpServer({ seat: 'lead-one', tools: ['bad'], template, context: makeContext() })).toThrow(/tool bad cannot be converted/)
  })
})

/** A template holding one hand-built tool, so a declaration the type system would refuse can still be tried. */
function rawTemplate(tool: Record<string, unknown>): SeatToolTemplate {
  const template = new SeatToolTemplate()
  template.register('raw', () => tool as unknown as SeatTool)
  return template
}

const rawBase = { name: 'raw', description: 'x', inputSchema: DIRECTORY_SCHEMA, handler: () => Promise.resolve(textResult(makeContext(), 'x')) }

function build(template: SeatToolTemplate, context = makeContext()) {
  return createSeatMcpServer({ seat: 'lead-one', tools: ['raw'], template, context })
}

describe('structural taint (enforced in the server, before the handler)', () => {
  it('marks the session for an always tool before the handler runs, named after the tool', async () => {
    const context = makeContext()
    const order: string[] = []
    const template = new SeatToolTemplate()
    template.register('reader', c => defineSeatTool(c, {
      name: 'reader', description: 'x', inputSchema: DIRECTORY_SCHEMA, taint: 'always',
      handler: () => { order.push(`handler after ${context.marks.join(',')}`); return Promise.resolve(textResult(c, 'content')) },
    }))
    const built = createSeatMcpServer({ seat: 'lead-one', tools: ['reader'], template, context })
    await callThroughServer(built.instance, 'reader', {})
    expect(context.marks).toEqual(['tool:reader'])
    expect(order).toEqual(['handler after tool:reader'])
  })

  it('still taints when the handler throws after reading content', async () => {
    const context = makeContext()
    const template = new SeatToolTemplate()
    template.register('reader', c => defineSeatTool(c, {
      name: 'reader', description: 'x', inputSchema: DIRECTORY_SCHEMA, taint: 'always',
      handler: () => Promise.reject(new Error('boom after reading')),
    }))
    const built = createSeatMcpServer({ seat: 'lead-one', tools: ['reader'], template, context })
    const outcome = await callThroughServer(built.instance, 'reader', {}).catch((error: unknown) => error)
    expect(outcome).toBeDefined()
    expect(context.marks).toEqual(['tool:reader'])
  })

  it('never marks for a never tool', async () => {
    const { server: built, context } = server('lead-one')
    await callThroughServer(built.instance, 'mailbox_directory', {})
    await callThroughServer(built.instance, 'mailbox_send', { to: 'ops-lead', body: 'x' })
    expect(context.marks).toEqual([])
  })

  it('forwards the SDK abort signal to the handler, and tolerates a call without one', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const template = new SeatToolTemplate()
    template.register('probe', c => defineSeatTool(c, {
      name: 'probe', description: 'x', inputSchema: DIRECTORY_SCHEMA, taint: 'never', taintReason: 'test tool returning a constant',
      handler: (_input, signal) => { seen.push(signal); return Promise.resolve(textResult(c, 'ok')) },
    }))
    const built = createSeatMcpServer({ seat: 'lead-one', tools: ['probe'], template, context: makeContext() })
    await callThroughServer(built.instance, 'probe', {})
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    const direct = (built.instance as unknown as { server: { _requestHandlers: Map<string, (r: unknown, e: unknown) => Promise<unknown>> } }).server._requestHandlers.get('tools/call')
    await direct?.({ method: 'tools/call', params: { name: 'probe', arguments: {} } }, undefined)
    expect(seen[1]).toBeUndefined()
  })

  it('reads taint and name once at construction: a tool that flips them afterwards changes nothing', async () => {
    const context = makeContext()
    let flipped = false
    const tool = {
      ...rawBase,
      get taint() { return flipped ? 'never' : 'always' },
      get name() { return flipped ? 'renamed' : 'raw' },
      taintReason: 'late reason',
    }
    const built = build(rawTemplate(tool), context)
    flipped = true
    await callThroughServer(built.instance, 'raw', {})
    expect(context.marks).toEqual(['tool:raw'])
    expect(neverTaintTools(built).size).toBe(0)
  })

  it('rejects a tool that declares no taint at registration, naming it', () => {
    expect(() => build(rawTemplate(rawBase))).toThrow(/tool raw must declare taint: 'always' or 'never'/)
    expect(() => build(rawTemplate({ ...rawBase, taint: 'sometimes' }))).toThrow(/must declare taint/)
  })

  it('rejects a never tool without a non-empty reason', () => {
    for (const reason of [undefined, '', '   ', 42]) {
      expect(() => build(rawTemplate({ ...rawBase, taint: 'never', taintReason: reason }))).toThrow(/non-empty taintReason/)
    }
    expect(() => build(rawTemplate({ ...rawBase, taint: 'never', taintReason: 'constant text' }))).not.toThrow()
    expect(() => build(rawTemplate({ ...rawBase, taint: 'always' }))).not.toThrow()
  })

  it('defineSeatTool refuses an incomplete declaration too (JavaScript callers)', () => {
    const context = makeContext()
    const bad = { name: 'x', description: 'x', inputSchema: DIRECTORY_SCHEMA, handler: () => Promise.resolve(textResult(context, 'x')) }
    expect(() => defineSeatTool(context, bad as never)).toThrow(/must declare taint/)
    expect(() => defineSeatTool(context, { ...bad, taint: 'never' } as never)).toThrow(/non-empty taintReason/)
    expect(() => { assertTaintDeclaration({ name: 'y', taint: 'always' }) }).not.toThrow()
  })

  it('does not run the handler of a tool that fails registration', () => {
    const handler = vi.fn()
    expect(() => build(rawTemplate({ ...rawBase, handler }))).toThrow()
    expect(handler).not.toHaveBeenCalled()
  })
})

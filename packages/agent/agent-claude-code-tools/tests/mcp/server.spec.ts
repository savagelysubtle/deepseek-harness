import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSeatMcpServer } from '../../src/mcp/server.ts'
import { createLeadTemplate } from '../../src/mcp/template.ts'
import { defineSeatTool, textResult } from '../../src/mcp/types.ts'
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
      name: 'bad', description: 'unconvertible', inputSchema: z.strictObject({ when: z.date() }), handler: async () => textResult(context, 'never'),
    }))
    expect(() => createSeatMcpServer({ seat: 'lead-one', tools: ['bad'], template, context: makeContext() })).toThrow(/tool bad cannot be converted/)
  })
})

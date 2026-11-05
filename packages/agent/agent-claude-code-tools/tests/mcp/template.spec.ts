import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { describe, expect, it } from 'vitest'
import { createLeadTemplate, SeatToolTemplate } from '../../src/mcp/template.ts'
import { defineSeatTool, textResult } from '../../src/mcp/types.ts'
import { DIRECTORY_SCHEMA } from '../../src/mcp/schema.ts'
import { makeContext, textOf } from './helpers.ts'

describe('the lead template', () => {
  it('is exactly mailbox_send and mailbox_directory (check_inbox, await and tracker tools are not offered)', () => {
    expect(createLeadTemplate().names()).toEqual(['mailbox_send', 'mailbox_directory'])
  })

  it('builds the requested tools in request order', () => {
    const tools = createLeadTemplate().build('lead-one', ['mailbox_directory', 'mailbox_send'], makeContext())
    expect(tools.map(tool => tool.name)).toEqual(['mailbox_directory', 'mailbox_send'])
  })

  it('an empty tool list mutes the seat', () => {
    expect(() => createLeadTemplate().build('lead-one', [], makeContext())).toThrow(SeatMutedByPolicyError)
    expect(() => { createLeadTemplate().check('lead-one', []) }).toThrow(/lists no tools/)
  })

  it('names every tool it cannot provide', () => {
    try {
      createLeadTemplate().check('lead-one', ['mailbox_send', 'mailbox_await', 'tracker_read'])
      expect.unreachable()
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SeatMutedByPolicyError)
      expect((error as SeatMutedByPolicyError).seat).toBe('lead-one')
      expect((error as SeatMutedByPolicyError).reason).toBe('the tool template cannot provide: mailbox_await, tracker_read')
    }
  })
})

describe('SeatToolTemplate (the contributor seam)', () => {
  it('lets a later slice append a tool without editing S5 files, and refuses a duplicate', async () => {
    const template = createLeadTemplate()
    template.register('ping', context => defineSeatTool(context, {
      name: 'ping', description: 'pong', inputSchema: DIRECTORY_SCHEMA, handler: () => Promise.resolve(textResult(context, 'pong')),
    }))
    expect(template.names()).toEqual(['mailbox_send', 'mailbox_directory', 'ping'])
    const [tool] = template.build('lead-one', ['ping'], makeContext())
    expect(textOf(await (tool as { handler(i: unknown): Promise<{ content: { text: string }[] }> }).handler({}))).toBe('pong')
    expect(() => { template.register('ping', () => { throw new Error('unused') }) }).toThrow(/already registered/)
    expect(new SeatToolTemplate().names()).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CODE_TURN_ERROR_CODES } from '../src/seat-agent.ts'
import { harness, mailMessage } from './fakes.ts'

const options = vi.hoisted(() => ({ tools: ['Read'] as string[] | undefined }))

vi.mock('../src/options.ts', () => ({
  buildQueryOptions: (): Options => ({ tools: options.tools } as Options),
}))

describe('the empty-tool-list assertion on a tainted turn', () => {
  it.each([[['Read']], [undefined]])('refuses to start a tainted query whose tool list is %j, and fails the mail', async (tools) => {
    options.tools = tools
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('portal', 'm-t', { tainted: true }))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { code: string } } }
    expect(end.reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.tainted)
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-t:.*empty tool list/)])
  })
})

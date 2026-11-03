import { describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CODE_TURN_ERROR_CODES } from '../src/seat-agent.ts'
import { harness, mailMessage } from './fakes.ts'

const built = vi.hoisted(() => ({ options: {} as Record<string, unknown> }))

vi.mock('../src/options.ts', () => ({
  buildQueryOptions: (): Options => built.options,
}))

const SAFE = { tools: [], persistSession: false }

describe('the throwaway guarantee on a tainted turn', () => {
  it.each<[string, Record<string, unknown>, RegExp]>([
    ['a tool in the list', { tools: ['Read'], persistSession: false }, /empty tool list/],
    ['no tool list at all', { persistSession: false }, /empty tool list/],
    ['persistence left on', { tools: [] }, /persistSession off/],
    ['an MCP server', { ...SAFE, mcpServers: {} }, /none of mcpServers/],
    ['an allowed-tools list', { ...SAFE, allowedTools: [] }, /none of allowedTools/],
    ['an agents map', { ...SAFE, agents: {} }, /none of agents/],
    ['a plugin', { ...SAFE, plugins: [] }, /none of plugins/],
    ['inline settings', { ...SAFE, settings: {} }, /none of settings/],
    ['a resumed session', { ...SAFE, resume: '12345678-1234-4234-8234-123456789012' }, /none of resume/],
    ['several at once', { ...SAFE, mcpServers: {}, plugins: [] }, /none of mcpServers, plugins/],
  ])('refuses to start a tainted query with %s, and fails the mail', async (_label, options, message) => {
    built.options = options
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('portal', 'm-t', { tainted: true }))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { code: string; message: string } } }
    expect(end.reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.tainted)
    expect(end.reason.error.message).toMatch(message)
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-t:.*tainted mail must run with/)])
  })
})

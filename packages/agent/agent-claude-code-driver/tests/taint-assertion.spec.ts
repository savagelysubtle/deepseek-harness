import { describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CODE_TURN_ERROR_CODES } from '../src/seat-agent.ts'
import { harness, mailMessage } from './fakes.ts'

const built = vi.hoisted(() => ({ options: {} as Record<string, unknown> }))

vi.mock('../src/options.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/options.ts')>(),
  buildQueryOptions: (): Options => built.options,
}))

const SAFE = { tools: [], persistSession: false, settingSources: [], strictMcpConfig: true, permissionMode: 'dontAsk', model: 'sonnet' }

/** SDK 0.3.263 options a throwaway query must never carry, each of which the allowlist refuses by name. */
const FORBIDDEN_KEYS = [
  'hooks', 'canUseTool', 'allowDangerouslySkipPermissions', 'permissionPromptToolName', 'toolConfig', 'toolAliases', 'skills', 'agent',
  'sandbox', 'extraArgs', 'executableArgs', 'managedSettings', 'additionalDirectories', 'sessionStore', 'continue', 'resumeSessionAt',
  'forkSession', 'fallbackModel', 'debug', 'debugFile', 'mcpServers', 'allowedTools', 'agents', 'plugins', 'settings', 'resume',
]

async function refuse(options: Record<string, unknown>): Promise<{ code: string; message: string; leases: string[]; queries: number }> {
  built.options = options
  const h = await harness()
  const agent = h.agent()
  agent.followup(mailMessage('portal', 'm-t', { tainted: true }))
  await agent.whenIdle()
  const end = agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { error: { code: string; message: string } } }
  return { code: end.reason.error.code, message: end.reason.error.message, leases: h.state.leases, queries: h.queries.length }
}

describe('the throwaway guarantee on a tainted turn', () => {
  it.each<[string, Record<string, unknown>, RegExp]>([
    ['a tool in the list', { ...SAFE, tools: ['Read'] }, /empty tool list/],
    ['no tool list at all', { ...SAFE, tools: undefined }, /empty tool list/],
    ['persistence left on', { ...SAFE, persistSession: true }, /persistSession off/],
    ['a settings source', { ...SAFE, settingSources: ['user'] }, /settingSources: \[\]/],
    ['no settings sources list', { ...SAFE, settingSources: undefined }, /settingSources: \[\]/],
    ['MCP not strict', { ...SAFE, strictMcpConfig: false }, /strictMcpConfig: true/],
    ['a permission mode other than dontAsk', { ...SAFE, permissionMode: 'default' }, /permissionMode: 'dontAsk'/],
    ['a model off the allowlist', { ...SAFE, model: 'not-a-model' }, /an allowed model/],
    ['a fable model on a seat without fable_ok', { ...SAFE, model: 'fable' }, /an allowed model/],
    ['no model', { ...SAFE, model: undefined }, /an allowed model/],
  ])('refuses to start a tainted query with %s, and fails the mail', async (_label, options, message) => {
    const result = await refuse(options)
    expect(result.queries).toBe(0)
    expect(result.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.tainted)
    expect(result.message).toMatch(message)
    expect(result.leases).toEqual([expect.stringMatching(/^fail:m-t:.*tainted mail must run with/)])
  })

  it.each(FORBIDDEN_KEYS)('refuses a tainted query that carries the %s option, even when it is empty', async (key) => {
    const result = await refuse({ ...SAFE, [key]: key === 'debug' ? false : undefined })
    expect(result.queries).toBe(0)
    expect(result.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.tainted)
    expect(result.message).toContain(`no "${key}" option`)
    expect(result.leases).toEqual([expect.stringMatching(/^fail:m-t:.*tainted mail must run with/)])
  })
})

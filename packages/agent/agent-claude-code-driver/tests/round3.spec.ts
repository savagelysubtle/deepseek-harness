import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { allowlistSettings } from '../src/options.ts'
import { CLAUDE_CODE_TURN_ERROR_CODES } from '../src/seat-agent.ts'
import { harness, resultMessage, userMessage } from './fakes.ts'
import type { FakeQuery } from './fakes.ts'

interface EndData { reason: { kind: string; error: { code: string; message: string } } }

const lastEnd = (agent: { session: { events: readonly { type: string; data: unknown }[] } }): EndData =>
  agent.session.events.findLast(event => event.type === 'turn/end')?.data as EndData

const dataOf = (session: { events: readonly { type: string; data: unknown }[] }, type: string): Record<string, unknown>[] =>
  session.events.filter(event => event.type === type).map(event => event.data as Record<string, unknown>)

function answer(query: FakeQuery): void {
  query.emit(resultMessage({ user_message_uuids: query.uuids() }))
}

describe('overage gating (review 1)', () => {
  it('pauses on a rejected overage window even when isUsingOverage is true', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('work'))
    const query = await h.query(0)
    query.emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'overage', isUsingOverage: true },
      uuid: 'u', session_id: 's',
    } as unknown as SDKMessage)
    await agent.whenIdle()
    expect(dataOf(agent.session, 'claude-code/paused')[0]).toMatchObject({ reason: 'usage-exhausted' })
  })
})

describe('flush on every instance first turn (review 3)', () => {
  it('a new instance over the same in-memory session flushes again before its first prompt', async () => {
    const h = await harness()
    const first = h.agent()
    h.state.flushError = new Error('disk full')
    first.followup(userMessage('one'))
    await first.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(h.state.calls).toEqual(['flush'])

    // The binding is already in the log, so the second instance reads it back; it must still flush, and
    // while the store keeps failing it must refuse the prompt too.
    const second = h.agent({ session: first.session })
    second.followup(userMessage('two'))
    await second.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(lastEnd(second).reason.error.code).toBe(CLAUDE_CODE_TURN_ERROR_CODES.binding)
    expect(h.state.calls).toEqual(['flush', 'flush'])

    h.state.flushError = undefined
    const third = h.agent({ session: first.session })
    third.followup(userMessage('three'))
    // each turn claims one queued message: 'one', 'two' (both kept from the refused turns), then 'three'
    answer(await h.query(0))
    answer(await h.query(1))
    answer(await h.query(2))
    await third.whenIdle()
    expect(h.state.calls).toEqual(['flush', 'flush', 'flush', 'query', 'query', 'query'])
  })

  it('a later turn of the same instance does not flush again once it succeeded', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('one'))
    answer(await h.query(0))
    await agent.whenIdle()
    agent.followup(userMessage('two'))
    answer(await h.query(1))
    await agent.whenIdle()
    expect(h.state.calls).toEqual(['flush', 'query', 'query'])
  })
})

describe('attested binary path (review 5)', () => {
  it('runs the attested real path the check returns, and the configured path when no attestation is wired', async () => {
    const h = await harness()
    ;(h.deps as { attestedBinary?: (seat: string) => string }).attestedBinary = seat => `/attested/real/${seat}`
    const agent = h.agent({ seat: 'tester' })
    agent.followup(userMessage('hello'))
    const query = await h.query(0)
    expect(query.options.pathToClaudeCodeExecutable).toBe('/attested/real/tester')
    answer(query)
    await agent.whenIdle()
  })
})

describe('hooks validation (review 7)', () => {
  const run = (hooks: unknown) => allowlistSettings({ hooks }, 'seat', () => undefined)
  const command = { type: 'command', command: 'echo ok' }

  it('accepts known events with plain command handlers, with matcher and timeout', () => {
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ ...command, timeout: 5 }] }], Stop: [{ hooks: [command] }] }
    expect(run(hooks)).toEqual({ hooks })
  })

  it.each([
    ['an unknown event', { Nope: [] }, /unknown hook event "Nope"/],
    ['an event that is not a list', { PreToolUse: {} }, /PreToolUse must be a list/],
    ['a group that is not an object', { PreToolUse: ['x'] }, /entries must be/],
    ['a group without a hooks list', { PreToolUse: [{ matcher: 'x' }] }, /entries must be/],
    ['a group with an extra key', { PreToolUse: [{ hooks: [], model: 'x' }] }, /entries must be/],
    ['a group with a non-string matcher', { PreToolUse: [{ matcher: 1, hooks: [] }] }, /entries must be/],
    ['a handler that is not an object', { Stop: [{ hooks: ['echo'] }] }, /handlers must be \{type: "command"/],
    ['a prompt handler', { Stop: [{ hooks: [{ type: 'prompt', prompt: 'summarise' }] }] }, /prompt, agent, http and other types are not allowed/],
    ['an agent handler', { Stop: [{ hooks: [{ type: 'agent', prompt: 'x' }] }] }, /handlers must be/],
    ['an http handler', { Stop: [{ hooks: [{ type: 'http', url: 'https://evil.example' }] }] }, /handlers must be/],
    ['a command handler that is not a string', { Stop: [{ hooks: [{ type: 'command', command: 5 }] }] }, /handlers must be/],
    ['a command handler carrying a model', { Stop: [{ hooks: [{ ...command, model: 'x' }] }] }, /handler carries "model"/],
    ['a command handler carrying a url', { Stop: [{ hooks: [{ ...command, url: 'x' }] }] }, /handler carries "url"/],
    ['a command handler with a non-numeric timeout', { Stop: [{ hooks: [{ ...command, timeout: '5' }] }] }, /timeout must be a number/],
  ])('refuses the whole settings object for %s', (_label, hooks, message) => {
    expect(() => run(hooks)).toThrow(message)
    expect(() => allowlistSettings({ hooks, permissions: { deny: ['Read'] } }, 'seat', () => undefined)).toThrow(/refusing to apply a partial policy/)
  })
})

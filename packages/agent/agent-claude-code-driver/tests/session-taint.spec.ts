/**
 * Taint is sticky per Claude session: set by a tainting tool or a policy's `markTurnTainted`, logged as
 * `claude-code/session-tainted`, restored when the log is reloaded, and never cleared by a compaction (the SDK
 * gives no way to confirm the summary dropped the tainted text). A fresh session (a host reseed) has a new log
 * and so starts clean. The same suite covers the delivered-trace set the policy's reply check reads.
 */

import { describe, expect, it } from 'vitest'
import type { PolicyQueryContext } from '../src/policy-contract.ts'
import { harness, mailMessage, resultMessage, stubPolicy, tick, userMessage } from './fakes.ts'
import type { FakeQuery, Harness } from './fakes.ts'

const init = { type: 'system', subtype: 'init', tools: [], session_id: '12345678-1234-4234-8234-123456789012', model: 'sonnet' } as never
const toolUse = (name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input: {} }] } }) as never
const compact = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 30000 } } as never

const taintRecords = (session: { events: readonly { type: string; data: unknown }[] }) =>
  session.events.filter(event => event.type === 'claude-code/session-tainted').map(event => event.data as { reason: string; version: number })

/** Capture what the policy sees at the start of every query. */
function spyPolicy(h: Harness, actOn?: (context: PolicyQueryContext) => void) {
  const seen: { tainted: boolean; traces: string[] }[] = []
  h.state.policy = {
    ...stubPolicy(),
    extend: (context) => {
      actOn?.(context)
      seen.push({ tainted: context.isTurnTainted(), traces: [...context.deliveredTraceIds()].sort() })
      return {}
    },
  }
  return seen
}

async function finishTurn(query: FakeQuery, ...before: never[]): Promise<void> {
  await tick(5)
  query.emit(init)
  for (const message of before) query.emit(message)
  query.emit(resultMessage({ user_message_uuids: query.uuids() }))
}

describe('session taint', () => {
  it('starts clean, becomes tainted when a tainting tool runs, and stays tainted on later turns', async () => {
    const h = await harness()
    const seen = spyPolicy(h)
    const agent = h.agent()
    agent.followup(userMessage('one'))
    await finishTurn(await h.query(0), toolUse('Read'))
    await agent.whenIdle()
    expect(seen).toEqual([{ tainted: false, traces: [] }])
    expect(taintRecords(agent.session)).toEqual([{ version: 1, reason: 'tool:Read', at: expect.any(Number) as number } as never])
    expect(agent.isTurnTainted()).toBe(true)
    agent.followup(userMessage('two'))
    await finishTurn(await h.query(1))
    await agent.whenIdle()
    expect(seen[1]).toEqual({ tainted: true, traces: [] })
    expect(taintRecords(agent.session)).toHaveLength(1)
  })

  it('does not taint on a tool that reads nothing untrusted', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('one'))
    await finishTurn(await h.query(0), toolUse('mcp__dsh__mailbox_send'))
    await agent.whenIdle()
    expect(taintRecords(agent.session)).toEqual([])
    expect(agent.isTurnTainted()).toBe(false)
  })

  it.each(['Grep', 'Glob', 'WebFetch', 'WebSearch'])('taints on %s', async (tool) => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(userMessage('one'))
    await finishTurn(await h.query(0), toolUse(tool))
    await agent.whenIdle()
    expect(taintRecords(agent.session).map(record => record.reason)).toEqual([`tool:${tool}`])
  })

  it('is restored when the log is loaded again, before any new turn runs', async () => {
    const h = await harness()
    const first = h.agent()
    first.followup(userMessage('one'))
    await finishTurn(await h.query(0), toolUse('Read'))
    await first.whenIdle()
    const again = h.agent({ session: first.session })
    expect(again.isTurnTainted()).toBe(true)
    const seen = spyPolicy(h)
    again.followup(userMessage('two'))
    await finishTurn(await h.query(1))
    await again.whenIdle()
    expect(seen).toEqual([{ tainted: true, traces: [] }])
    expect(taintRecords(again.session)).toHaveLength(1)
  })

  it('is cleared only by a fresh session, which has a new log', async () => {
    const h = await harness()
    const tainted = h.agent()
    tainted.markTurnTainted('read a hostile file')
    expect(h.agent({ session: h.session('reseeded') }).isTurnTainted()).toBe(false)
    expect(tainted.isTurnTainted()).toBe(true)
  })

  it('is not cleared by a compaction the driver cannot confirm dropped the tainted context', async () => {
    const h = await harness()
    const seen = spyPolicy(h)
    const agent = h.agent()
    agent.followup(userMessage('one'))
    await finishTurn(await h.query(0), toolUse('WebFetch'), compact)
    await agent.whenIdle()
    expect(agent.session.events.some(event => event.type === 'claude-code/compact')).toBe(true)
    expect(agent.isTurnTainted()).toBe(true)
    agent.followup(userMessage('two'))
    await finishTurn(await h.query(1))
    await agent.whenIdle()
    expect(seen.at(-1)?.tainted).toBe(true)
  })

  it('lets the policy mark the session through its context, once, with a cleaned reason', async () => {
    const h = await harness()
    const seen = spyPolicy(h, (context) => {
      context.markTurnTainted('mail body read\u0007 /home/steve/.ssh/key')
      context.markTurnTainted('second call is ignored')
    })
    const agent = h.agent()
    agent.followup(userMessage('one'))
    await finishTurn(await h.query(0))
    await agent.whenIdle()
    const records = taintRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]?.reason).toContain('mail body read')
    expect(records[0]?.reason).not.toContain('\u0007')
    expect(seen[0]?.tainted).toBe(true)
  })

  it('falls back to a fixed reason when the given one is empty after cleaning', () => {
    return harness().then((h) => {
      const agent = h.agent()
      agent.markTurnTainted('\u0007')
      expect(taintRecords(agent.session).map(record => record.reason)).toEqual(['unspecified'])
    })
  })

  it('marks the live turn tainted when called during a running turn, and reports a failed flush without failing the turn', async () => {
    const h = await harness()
    const seen = spyPolicy(h, (context) => {
      h.state.flushError = new Error('disk full')
      context.markTurnTainted('late')
    })
    const agent = h.agent()
    agent.followup(userMessage('one'))
    await finishTurn(await h.query(0))
    await agent.whenIdle()
    expect(seen).toHaveLength(1)
    await tick(5)
    expect(h.warnings.join('\n')).toContain('could not make the session taint durable')
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
  })

  it('does not taint the seat\'s session from a throwaway (tainted-mail) query', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('portal', 'm-t', { tainted: true }))
    await finishTurn(await h.query(0), toolUse('Read'))
    await agent.whenIdle()
    expect(taintRecords(agent.session)).toEqual([])
    expect(agent.isTurnTainted()).toBe(false)
  })

  it('reports a running throwaway turn as tainted', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('portal', 'm-t', { tainted: true }))
    const query = await h.query(0)
    await tick(5)
    expect(agent.isTurnTainted()).toBe(true)
    await finishTurn(query)
    await agent.whenIdle()
    expect(agent.isTurnTainted()).toBe(false)
  })
})

describe('delivered trace ids', () => {
  it('rebuilds the set of mailbox relay trace ids from the log and ignores everything else', async () => {
    const h = await harness()
    const seen = spyPolicy(h)
    const agent = h.agent()
    agent.followup(mailMessage('a', 'm-1', { traceId: 'trace-a' }))
    await finishTurn(await h.query(0))
    await agent.whenIdle()
    agent.followup(mailMessage('b', 'm-2', { traceId: 'trace-b' }))
    await finishTurn(await h.query(1))
    await agent.whenIdle()
    agent.followup(mailMessage('c', 'm-3', { form: 'notice', traceId: 'trace-notice' }))
    agent.followup(mailMessage('d', 'm-4', { traceId: '' }))
    agent.followup(mailMessage('e', 'm-5'))
    agent.followup(userMessage('typed'))
    for (let index = 2; index < 6; index++) {
      const query = await h.query(index)
      await finishTurn(query)
      await tick(5)
    }
    await agent.whenIdle()
    expect(seen[0]?.traces).toEqual(['trace-a'])
    expect(seen[1]?.traces).toEqual(['trace-a', 'trace-b'])
    expect(agent.deliveredTraceIds()).toEqual(new Set(['trace-a', 'trace-b']))
    expect(h.agent({ session: agent.session }).deliveredTraceIds()).toEqual(new Set(['trace-a', 'trace-b']))
  })

  it('is empty for a fresh session', async () => {
    const h = await harness()
    expect(h.agent().deliveredTraceIds().size).toBe(0)
  })
})

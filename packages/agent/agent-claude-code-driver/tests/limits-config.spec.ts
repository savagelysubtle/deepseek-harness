import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordClaudeCodeEvent } from '@deepseek-ai/dsh-agent-claude-code'
import { buildQueryOptions } from '../src/options.ts'
import { MailLog } from '../src/mail-lease.ts'
import {
  DEFAULT_CALL_WINDOW_MS, DEFAULT_MAX_BUDGET_USD, DEFAULT_MAX_CALLS_PER_WINDOW, DEFAULT_MAX_TURNS, parseSeatRow, ClaudeCodeSeatBlock,
} from '../src/seat-config.ts'
import { KILL_SWITCH_FILE_NAME, killSwitchPresent } from '../src/state.ts'
import { cleanTempDirs, harness, mailMessage, resultMessage, seatConfig, seatRow, tempDir, tick, userMessage } from './fakes.ts'
import type { FakeQuery } from './fakes.ts'

afterEach(() => { cleanTempDirs() })

describe('seat limits in the row', () => {
  it('fills sane defaults for every limit the row leaves out', () => {
    const { max_turns: _omitted, ...rest } = seatRow().claude_code
    const config = parseSeatRow({ driver: 'claude-code', claude_code: rest }, 's')
    expect(config).toMatchObject({
      maxTurns: DEFAULT_MAX_TURNS, maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
      maxCallsPerWindow: DEFAULT_MAX_CALLS_PER_WINDOW, callWindowMs: DEFAULT_CALL_WINDOW_MS,
    })
    expect([DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, DEFAULT_MAX_CALLS_PER_WINDOW, DEFAULT_CALL_WINDOW_MS])
      .toEqual([25, 5, 120, 18_000_000])
  })

  it('accepts explicit limits and refuses malformed ones with the field name', () => {
    expect(parseSeatRow(seatRow({ max_budget_usd: 0.5, call_window_ms: 60_000, max_calls_per_window: 3 }), 's'))
      .toMatchObject({ maxBudgetUsd: 0.5, callWindowMs: 60_000, maxCallsPerWindow: 3 })
    const bad: Array<[Partial<ClaudeCodeSeatBlock>, RegExp]> = [
      [{ max_budget_usd: 0 }, /max_budget_usd must be a positive number/],
      [{ max_budget_usd: -1 }, /max_budget_usd must be a positive number/],
      [{ max_budget_usd: Number.NaN }, /max_budget_usd must be a positive number/],
      [{ max_budget_usd: '5' as never }, /max_budget_usd must be a positive number/],
      [{ call_window_ms: 0 }, /call_window_ms must be a positive integer/],
      [{ call_window_ms: 1.5 }, /call_window_ms must be a positive integer/],
    ]
    for (const [override, message] of bad) expect(() => parseSeatRow(seatRow(override), 's')).toThrow(message)
  })

  it('validates the schema defaults the config catalog documents', () => {
    const block = ClaudeCodeSeatBlock({ model: 'sonnet', role: 'lead', claude_path: '/opt/claude' })
    expect(block).toMatchObject({
      max_turns: 25, max_budget_usd: 5, max_calls_per_window: 120, call_window_ms: 18_000_000,
    })
  })
})

describe('buildQueryOptions for a throwaway query', () => {
  const base = {
    seat: 's', cwd: '/w', env: { PATH: '/usr/bin' }, abortController: new AbortController(),
    spawn: () => { throw new Error('unused') },
  }

  it('forces an empty tool list and no persistence even for a coder, and carries the budget cap', () => {
    const config = seatConfig({ role: 'coder', max_budget_usd: 2 })
    const normal = buildQueryOptions({ ...base, config, binding: { kind: 'resume', sdkSessionId: 'sdk-1' } })
    expect(normal.tools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write'])
    expect(normal.persistSession).toBe(true)
    expect(normal.maxBudgetUsd).toBe(2)
    const throwaway = buildQueryOptions({ ...base, config, binding: { kind: 'first', sdkSessionId: 'sdk-2' }, throwaway: true })
    expect(throwaway.tools).toEqual([])
    expect(throwaway.persistSession).toBe(false)
    expect(throwaway.maxBudgetUsd).toBe(2)
    expect(throwaway.disallowedTools).toEqual(['Bash', 'AskUserQuestion'])
  })
})

describe('killSwitchPresent', () => {
  it('is false when the file is absent or its parent is not a directory, true when it exists or cannot be examined', () => {
    const dir = tempDir('cc-ks-')
    const flag = join(dir, KILL_SWITCH_FILE_NAME)
    expect(KILL_SWITCH_FILE_NAME).toBe('claude-code-kill-switch')
    expect(killSwitchPresent(flag)).toBe(false)
    writeFileSync(join(dir, 'plain'), '')
    expect(killSwitchPresent(join(dir, 'plain', KILL_SWITCH_FILE_NAME))).toBe(false)
    writeFileSync(flag, '')
    expect(killSwitchPresent(flag)).toBe(true)
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, KILL_SWITCH_FILE_NAME), '')
    chmodSync(locked, 0o000)
    try {
      // Cannot be examined (permission denied): the switch fails closed.
      expect(killSwitchPresent(join(locked, KILL_SWITCH_FILE_NAME))).toBe(true)
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})

describe('MailLog and the admission default', () => {
  it('ignores records of other event types that happen to carry a message id', async () => {
    const h = await harness()
    const session = h.session()
    recordClaudeCodeEvent(session, 'claude-code/refused', { reason: 'admission', messageId: 'r-1', detail: 'x', at: 1 })
    expect(new MailLog(session).get('r-1')).toBeUndefined()
  })

  it('uses the default admission when the deps carry no admit hook', async () => {
    const h = await harness()
    ;(h.deps as { admit: undefined }).admit = undefined
    const agent = h.agent()
    agent.followup(mailMessage('portal', 'm-d', { chain: ['portal'] }))
    expect(agent.session.events.filter(event => event.type === 'claude-code/refused')).toHaveLength(1)
    agent.followup(mailMessage('seat', 'm-s'))
    const query = await h.query(0)
    query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    await agent.whenIdle()
  })

  it('pushes typed and mailbox steering together once the mailbox claims are durable', async () => {
    const h = await harness()
    const agent = h.agent()
    agent.followup(mailMessage('start', 'm-a'))
    const query: FakeQuery = await h.query(0)
    await tick(5)
    agent.inject(userMessage('typed note'))
    agent.inject(mailMessage('mailbox note', 'm-b'))
    agent.steer(userMessage('typed push'))
    await tick(10)
    expect(query.consumed).toHaveLength(4)
    query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    await agent.whenIdle()
    expect(h.state.leases.sort()).toEqual(['settle:m-a', 'settle:m-b'])
  })
})

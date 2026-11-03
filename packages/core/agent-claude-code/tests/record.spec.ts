import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  CLAUDE_CODE_EVENT_TYPES, recordClaudeCodeEvent, redactLongRuns, redactPaths, redactTokens,
  sanitizeFreeText, sanitizeLabel,
} from '../src/index.ts'
import type {} from '../src/types.ts'

async function newSession(): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx.sessions.create(SessionId('cc-record'))
}

const TOKEN = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdef'

describe('claude-code event vocabulary', () => {
  it('lists all eight event types and every one is a known session event type', () => {
    expect([...CLAUDE_CODE_EVENT_TYPES].sort()).toEqual([
      'claude-code/compact', 'claude-code/fleet-refused', 'claude-code/paused', 'claude-code/rate-limited',
      'claude-code/resume-failed', 'claude-code/session-bound', 'claude-code/steer', 'claude-code/turn-completed',
    ])
    for (const type of CLAUDE_CODE_EVENT_TYPES) expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
  })
})

describe('recordClaudeCodeEvent', () => {
  it('appends a versioned allowlisted session-bound event', async () => {
    const session = await newSession()
    const ok = recordClaudeCodeEvent(session, 'claude-code/session-bound', {
      sessionId: 'dsh-1', sdkSessionId: 'c0ffee00-0000-4000-8000-000000000000',
      model: 'claude-haiku-4-5-20251001', driver: 'claude-code', at: 5,
      extra: 'dropped', prompt: 'secret prompt',
    } as never)
    expect(ok).toBe(true)
    const event = session.events.at(-1)!
    expect(event.type).toBe('claude-code/session-bound')
    expect(event.data).toEqual({
      version: 1, sessionId: 'dsh-1', sdkSessionId: 'c0ffee00-0000-4000-8000-000000000000',
      model: 'claude-haiku-4-5-20251001', driver: 'claude-code', at: 5,
    })
  })

  it('turns missing SDK numbers into 0 and keeps per-model usage', async () => {
    const session = await newSession()
    recordClaudeCodeEvent(session, 'claude-code/session-bound', {
      sessionId: 'dsh-1', sdkSessionId: 'sdk-1', model: 'm', driver: 'claude-code', at: 1,
    })
    expect(recordClaudeCodeEvent(session, 'claude-code/turn-completed', {
      turnIndex: 1, outcome: 'error_max_turns', isError: true, model: 'haiku',
      usage: { inputTokens: 10, outputTokens: Number.NaN, cacheReadInputTokens: null },
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 3, estimatedCostUsd: 0.25 } },
      stopReason: 'tool_use',
    })).toBe(true)
    expect(session.events.at(-1)!.data).toEqual({
      version: 1, turnIndex: 1, outcome: 'error_max_turns', isError: true, model: 'haiku',
      numTurns: 0, durationMs: 0, durationApiMs: 0, estimatedCostUsd: 0,
      usage: { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 3, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          estimatedCostUsd: 0.25, webSearchRequests: 0,
        },
      },
      stopReason: 'tool_use',
    })
  })

  it('records steer, compact, rate-limited and fleet-refused with allowlisted fields', async () => {
    const session = await newSession()
    recordClaudeCodeEvent(session, 'claude-code/session-bound', {
      sessionId: 'dsh-1', sdkSessionId: 'sdk-1', model: 'm', driver: 'claude-code', at: 1,
    })
    expect(recordClaudeCodeEvent(session, 'claude-code/steer', { kind: 'interrupt-push', reason: 'urgent\nmail', at: 2 })).toBe(true)
    expect(recordClaudeCodeEvent(session, 'claude-code/compact', { preTokens: 150000, trigger: 'auto', at: 3 })).toBe(true)
    expect(recordClaudeCodeEvent(session, 'claude-code/rate-limited', {
      source: 'http', retryAfterMs: 1500, breakerTripped: true, at: 4, body: 'leak', headers: { a: 'b' },
    } as never)).toBe(true)
    expect(recordClaudeCodeEvent(session, 'claude-code/fleet-refused', {
      reason: 'founder-reserve', limit: 0.3, observed: 0.31, at: 5,
    })).toBe(true)
    const [steer, compact, limited, refused] = session.events.slice(-4).map(event => event.data)
    expect(steer).toEqual({ version: 1, kind: 'interrupt-push', reason: 'urgent mail', at: 2 })
    expect(compact).toEqual({ version: 1, preTokens: 150000, trigger: 'auto', at: 3 })
    expect(limited).toEqual({ version: 1, source: 'http', retryAfterMs: 1500, breakerTripped: true, at: 4 })
    expect(refused).toEqual({ version: 1, reason: 'founder-reserve', limit: 0.3, observed: 0.31, at: 5 })
  })

  it('records resume-failed and paused with allowlisted fields and drops invalid ones', async () => {
    const session = await newSession()
    recordClaudeCodeEvent(session, 'claude-code/session-bound', {
      sessionId: 'dsh-1', sdkSessionId: 'sdk-1', model: 'm', driver: 'claude-code', at: 0,
    })
    expect(recordClaudeCodeEvent(session, 'claude-code/resume-failed', {
      sdkSessionId: 'sdk-1', reason: 'transcript-missing', at: 1, path: '/home/steve/.claude/x',
    } as never)).toBe(true)
    expect(recordClaudeCodeEvent(session, 'claude-code/paused', {
      reason: 'usage-exhausted', until: 1_800_000_000_000.9, at: 2,
    })).toBe(true)
    expect(recordClaudeCodeEvent(session, 'claude-code/paused', { reason: 'rate-limit', at: 3 })).toBe(true)
    expect(recordClaudeCodeEvent(session, 'claude-code/resume-failed', { sdkSessionId: '', reason: 'transcript-missing', at: 1 })).toBe(false)
    expect(recordClaudeCodeEvent(session, 'claude-code/resume-failed', { sdkSessionId: 'a', reason: 'nope' as never, at: 1 })).toBe(false)
    expect(recordClaudeCodeEvent(session, 'claude-code/paused', { reason: 'nope' as never, at: 1 })).toBe(false)
    const [failed, paused, bare] = session.events.slice(-3).map(event => event.data)
    expect(failed).toEqual({ version: 1, sdkSessionId: 'sdk-1', reason: 'transcript-missing', at: 1 })
    expect(paused).toEqual({ version: 1, reason: 'usage-exhausted', until: 1_800_000_000_000, at: 2 })
    expect(bare).toEqual({ version: 1, reason: 'rate-limit', at: 3 })
  })

  it('redacts tokens and paths, strips control characters, and caps free text', async () => {
    const session = await newSession()
    recordClaudeCodeEvent(session, 'claude-code/session-bound', {
      sessionId: 'dsh-1', sdkSessionId: 'sdk-1', model: 'm', driver: 'claude-code', at: 1,
    })
    recordClaudeCodeEvent(session, 'claude-code/steer', {
      kind: 'push', reason: `token ${TOKEN} in /home/steve/.claude/.credentials.json\u0007\u001b[2J ${'x'.repeat(400)}`, at: 2,
    })
    const reason = (session.events.at(-1)!.data as { reason: string }).reason
    expect(reason).not.toContain('sk-ant')
    expect(reason).not.toContain('/home/steve')
    expect(reason).not.toMatch(/[\u0000-\u001f]/)
    expect(reason.length).toBeLessThanOrEqual(200)
    expect(reason).toContain('[redacted]')
    expect(reason).toContain('[path]')
  })

  it('redacts credential-shaped strings of several vendors', () => {
    for (const secret of [
      TOKEN, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'Bearer abcdefghijklmnop1234',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
      'access_token=abcdef0123456789abcdef', 'password=hunter2hunter2', 'secret: s3cr3tvalue',
      'xoxb-1234567890-abcdefghij', 'AKIAIOSFODNN7EXAMPLE', '"token":"abc123def456"',
      '"api_key": "abc123def456"',
    ]) {
      expect(redactTokens(`before ${secret} after`)).toBe('before [redacted] after')
    }
    expect(redactLongRuns(`x ${'A'.repeat(48)} y`)).toBe('x [redacted] y')
    expect(sanitizeLabel(`id-${TOKEN}`)).not.toContain('sk-ant')
    expect(sanitizeFreeText(42)).toBe('')
  })

  it('keeps long identifiers intact but still redacts vendor tokens inside them', async () => {
    const longId = `named-session-${'a1b2c3d4'.repeat(4)}-salt` // 46+ chars, cwd-salted shape
    expect(longId.length).toBeGreaterThan(40)
    expect(sanitizeLabel(longId)).toBe(longId)
    const session = await newSession()
    recordClaudeCodeEvent(session, 'claude-code/session-bound', {
      sessionId: longId, sdkSessionId: longId, model: 'claude-sonnet-5-5', driver: 'claude-code', at: 1,
    })
    expect(session.events.at(-1)!.data).toMatchObject({ sessionId: longId, sdkSessionId: longId, model: 'claude-sonnet-5-5' })
    expect(sanitizeFreeText(longId)).toBe('[redacted]')
  })

  it('redacts only real paths, not dates, relative fragments, URL tails, or model ids', () => {
    for (const keep of ['2026/11/02', 'a/b/c', 'https://example.com/a/b/c', 'claude-sonnet-5-5', 'read 3/4 files', '/tmp']) {
      expect(redactPaths(keep)).toBe(keep)
      expect(sanitizeFreeText(keep)).toBe(keep)
    }
    expect(redactPaths('see /home/steve/x.ts now')).toBe('see [path] now')
    expect(redactPaths('in ~/proj/src/a.ts')).toBe('in [path]')
    expect(redactPaths('(../up/one)')).toBe('([path])')
    expect(sanitizeFreeText('failed at /home/steve/.claude/x')).toBe('failed at [path]')
  })

  it('never throws on circular, getter-throwing, hostile or non-JSON input', async () => {
    const session = await newSession()
    const circular: Record<string, unknown> = { sessionId: 'a', sdkSessionId: 'b', driver: 'claude-code' }
    circular.self = circular
    expect(() => recordClaudeCodeEvent(session, 'claude-code/session-bound', circular as never)).not.toThrow()
    expect(session.events.at(-1)!.type).toBe('claude-code/session-bound')
    const hostile = {
      get sessionId(): string { throw new Error('boom') },
      sdkSessionId: 'x',
    }
    const warn = vi.fn()
    expect(recordClaudeCodeEvent(session, 'claude-code/session-bound', hostile as never, warn)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    for (const bad of [null, undefined, 1, 'str', [], { kind: 'nope' }] as const) {
      expect(recordClaudeCodeEvent(session, 'claude-code/steer', bad as never, warn)).toBe(false)
    }
    const looping = { turnIndex: 1, outcome: 'success', modelUsage: circular }
    expect(() => recordClaudeCodeEvent(session, 'claude-code/turn-completed', looping as never)).not.toThrow()
    // a throwing warn sink cannot escape either
    expect(() => recordClaudeCodeEvent(session, 'claude-code/compact', null as never, () => { throw new Error('sink') }))
      .not.toThrow()
  })

  it('contains an append failure and reports it through warn', async () => {
    const session = await newSession()
    const warn = vi.fn()
    session.append = (() => { throw new Error('closed') })
    expect(recordClaudeCodeEvent(session, 'claude-code/steer', { kind: 'push', reason: '', at: 1 }, warn)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('closed'))
  })
})

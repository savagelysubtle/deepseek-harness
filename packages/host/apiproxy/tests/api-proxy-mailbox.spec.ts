/**
 * The mailbox wire face: non-dsh callers admit mail into served namespaces
 * through `mailbox.publish` — both addressing forms deliver, residency-held
 * targets queue, and every refusal (ambiguous halves, bad grammar, unknown
 * namespace, absent registry, terminal routing failure) rejects loud.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { acquireNamedSessionLock, deriveNamedSessionId } from '@deepseek-ai/dsh-named-sessions'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import MailboxLocal from '@deepseek-ai/dsh-mailbox-local'
import * as Bridge from '@deepseek-ai/dsh-mailbox-bridge'
import type { MailboxPublishValue } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-apiproxy-mailbox-'))
  dirs.push(dir)
  process.env.DSH_HOME = dir
  return dir
}

/** The API carrier's floor: services createApiProxy requires unconditionally. */
async function mountFloor(ctx: ContextType): Promise<void> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
}

interface MailboxEnv {
  ctx: ContextType
  liveFollowup: ReturnType<typeof vi.fn> | undefined
}

/**
 * Mount registry + SQLite store + the real bridge over a private roster.
 * With `liveTarget`, the derived session id resolves to a recording stub agent,
 * so deliveries take the in-process path.
 */
async function mountMailbox(dir: string, addresses: readonly string[], options: { liveName?: string } = {}): Promise<MailboxEnv> {
  const ctx = new Context()
  await mountFloor(ctx)
  await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
  await ctx.plugin(MailboxLocal, { path: join(dir, 'mailbox.db') })
  let liveFollowup: ReturnType<typeof vi.fn> | undefined
  if (options.liveName !== undefined) {
    // The registry pins agent.id to session.id, so the stub carries the
    // DERIVED id on both sides; deliveries only exercise the recording fns.
    // Founder model routes every delivery through steer(), so record there.
    const sessionId = deriveNamedSessionId(options.liveName)
    const session = { id: sessionId, events: [], header: { seedLength: 0 } } as never
    liveFollowup = vi.fn()
    const agent = {
      id: sessionId,
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      followup: vi.fn(),
      steer: liveFollowup,
    } as unknown as Agent
    ctx.agents.register(agent)
  }
  await ctx.plugin(Bridge, { addresses: [...addresses], pollIntervalMs: 3_600_000, admitFromNamespaces: ['console'] })
  return { ctx, liveFollowup }
}

// One proxy per context: createApiProxy registers its question provider at
// construction, so repeat calls would collide with the first registration.
const proxies = new WeakMap<object, ReturnType<typeof createApiProxy>>()
const api = (ctx: ContextType) => {
  const existing = proxies.get(ctx)
  if (existing !== undefined) return existing
  const created = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  proxies.set(ctx, created)
  return created
}

type PublishResult =
  | { ok: true; value: MailboxPublishValue }
  | { ok: false; error: { code: string; message: string; details: { reason: string } } }

async function publish(ctx: ContextType, rpcId: string, payload: Record<string, unknown>): Promise<PublishResult> {
  const response = await api(ctx).mailbox.publish({ rpcId: `${rpcId}` as never, payload: payload as never })
  return response.result as unknown as PublishResult
}

describe('mailbox.publish over the host API', () => {
  it('delivers a namespace+name publish into a live target', async () => {
    const { ctx, liveFollowup } = await mountMailbox(tempDir(), ['webceo:ceo'], { liveName: 'ceo' })
    expect(liveFollowup).toBeDefined()

    const result = await publish(ctx, 'mb-happy', {
      namespace: 'webceo', name: 'ceo', from: 'console:human', subject: 'hello seat',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.disposition).toBe('delivered')
    expect(result.value.messageId).toBeTruthy()
    expect(liveFollowup).toHaveBeenCalledTimes(1)
    const message = liveFollowup!.mock.calls[0]?.[0] as { source: { kind: string; form: string; address: string; messageId: string } }
    expect(message.source).toMatchObject({
      kind: 'mailbox', form: 'relay', address: 'webceo:ceo', messageId: result.value.messageId,
    })
  })

  it('carries a blocking mark through to the stored and delivered turn, forwarding none without it', async () => {
    const dir = tempDir()
    const { ctx, liveFollowup } = await mountMailbox(dir, ['webceo:ceo'], { liveName: 'ceo' })
    expect(liveFollowup).toBeDefined()

    const flagged = await publish(ctx, 'mb-blocking', {
      namespace: 'webceo', name: 'ceo', from: 'console:human', subject: 'halt', blocking: true,
    })
    const plain = await publish(ctx, 'mb-unmarked', {
      namespace: 'webceo', name: 'ceo', from: 'console:human', subject: 'carry on',
    })
    expect(flagged.ok).toBe(true)
    if (!flagged.ok || !plain.ok) return
    expect(flagged.value.disposition).toBe('delivered')
    expect(plain.value.disposition).toBe('delivered')
    expect(liveFollowup).toHaveBeenCalledTimes(2)
    const flaggedTurn = liveFollowup!.mock.calls[0]?.[0] as { content: readonly [{ text: string }] }
    expect(flaggedTurn.content[0]?.text).toContain('[BLOCKING]')
    const plainTurn = liveFollowup!.mock.calls[1]?.[0] as { content: readonly [{ text: string }] }
    expect(plainTurn.content[0]?.text).not.toContain('[BLOCKING]')
    // The durable end-state encodes the mark exactly as the provider writes it.
    const db = new DatabaseSync(join(dir, 'mailbox.db'))
    try {
      const rows = db.prepare('SELECT id, blocking FROM messages ORDER BY created_at').all() as Array<{ id: string; blocking: number | null }>
      expect(rows).toEqual([
        { id: flagged.value.messageId, blocking: 1 },
        { id: plain.value.messageId, blocking: null },
      ])
    } finally {
      db.close()
    }
  })

  it('queues while residency holds the target elsewhere', async () => {
    const dir = tempDir()
    const { ctx } = await mountMailbox(dir, ['webceo:ceo'])
    // Same DSH_HOME, so this is exactly the artifact the route's own
    // acquisition attempt will lose to.
    const lock = acquireNamedSessionLock('ceo')
    try {
      const result = await publish(ctx, 'mb-defer', { address: 'webceo:ceo', from: 'console:human' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.disposition).toBe('queued')
    } finally {
      lock.release()
    }
  })

  it('rejects ambiguous, incomplete, unserved, and malformed addressing loud before storing', async () => {
    const { ctx } = await mountMailbox(tempDir(), ['webceo:ceo'])

    const ambiguous = await publish(ctx, 'mb-amb', { address: 'webceo:ceo', namespace: 'webceo', name: 'ceo', from: 'console:c' })
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.error.code).toBe('mailbox-rejected')

    const incomplete = await publish(ctx, 'mb-half', { namespace: 'webceo', from: 'console:c' })
    expect(incomplete.ok).toBe(false)

    const unserved = await publish(ctx, 'mb-stranger', { address: 'stranger:seat', from: 'console:c' })
    expect(unserved.ok).toBe(false)
    if (!unserved.ok) expect(unserved.error.details.reason).toContain('not served')

    const malformed = await publish(ctx, 'mb-bad', { address: 'no separator', from: 'console:c' })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.error.details.reason).toContain('invalid mailbox address')
  })

  it('rejects a terminal routing failure loud with the recorded reason', async () => {
    // No session-persistence backend composed at all: cold-resume cannot work,
    // and the absent agent registry hit defers the route into that failure.
    const { ctx } = await mountMailbox(tempDir(), ['webceo:ghost'])

    const failed = await publish(ctx, 'mb-fail', { address: 'webceo:ghost', from: 'console:c' })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.details.reason).toContain('cold-resume requires')
  })

  it('refuses when no mailbox registry is composed', async () => {
    const ctx = new Context()
    await mountFloor(ctx)
    const refused = await publish(ctx, 'mb-none', { address: 'webceo:ceo', from: 'console:c' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.details.reason).toContain('no mailbox registry')
  })
})

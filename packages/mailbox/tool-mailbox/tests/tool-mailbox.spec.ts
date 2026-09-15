/**
 * The mailbox tools' identity guarantees: the send schema exposes no `from`
 * and the runtime fills the trusted session name; checkInbox takes no address
 * argument and drains only the calling seat's own queue, settling each
 * receipt; await holds the turn until a reply, a refusal, or the deadline,
 * and reports which; an anonymous run fails loud instead of guessing an
 * identity.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import type { MailboxLease, MailboxRegistry as MailboxRegistryShape } from '@deepseek-ai/dsh-mailbox'
import MailboxLocal from '@deepseek-ai/dsh-mailbox-local'
import * as tool from '../src/index.ts'
import { AWAIT_MAX_DEADLINE_MS, AWAIT_MIN_DEADLINE_MS, AWAIT_POLL_INTERVAL_MS, clampAwaitDeadlineMs, mailboxAwaitTool, mailboxCheckInboxTool, mailboxSendTool } from '../src/tools.ts'
import { deriveNamedSessionId } from '@deepseek-ai/dsh-named-sessions'
import { resolveMailboxIdentity, resolveMailboxIdentityWithRegistry } from '../src/identity.ts'
import * as invariant from '../src/invariant.ts'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-mailbox-'))
  dirs.push(dir)
  return dir
}

const testSignal = new AbortController().signal
let callCounter = 0

/** Mount the real registries plus the plugin under test over one fresh queue file. */
async function setup(
  sessionName: string | undefined,
  extraConfig: Record<string, unknown> = {},
): Promise<{ ctx: Context; dbPath: string }> {
  const dbPath = join(tempDir(), 'mailbox.db')
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
  await ctx.plugin(MailboxLocal, { path: dbPath })
  await ctx.plugin(tool, { ...sessionName === undefined ? {} : { sessionName }, ...extraConfig })
  await ctx.plugin(invariant)
  return { ctx, dbPath }
}

/** Execute one registered tool through the real registry pipeline. */
function call(ctx: Context, name: string, args: unknown = {}) {
  callCounter += 1
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`call-${callCounter}`),
    name,
    arguments: args,
  })
}

/**
 * Call any registered tool through the REAL registry, as the agent whose
 * derived session id resolves to `seat`. A served roster puts identity
 * resolution into multi-seat mode (see `identity.ts`), which requires a
 * matching agent id rather than the mount-time session name — this stands
 * in for the many-seat host's own agent-loop plumbing. Module-scoped (not
 * nested in one describe) because both mailbox_send and mailbox_await need
 * it under the same seat identity to prove the BLOCKING-1 refusal handoff.
 */
function callAs(ctx: Context, seat: string, name: string, args: unknown) {
  callCounter += 1
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`call-${callCounter}`),
    name,
    arguments: args,
    agent: { id: String(deriveNamedSessionId(seat)) } as never,
  })
}

/** Read one address's rows straight out of the store the plugin opened. */
interface StoredRow {
  from_address: string
  state: string
  subject: string | null
  payload: string | null
  blocking: number | null
  trace_id: string | null
}

function storedRows(dbPath: string, address: string): StoredRow[] {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare('SELECT from_address, state, subject, payload, blocking, trace_id FROM messages WHERE to_address = ? ORDER BY created_at').all(address) as never
  } finally {
    db.close()
  }
}

describe('mailbox tool schemas', () => {
  it('exposes mailbox_send with to/subject/body/blocking and NO from', async () => {
    const { ctx } = await setup('batman')
    const schema = ctx.tools.schemas().find(entry => entry.name === 'mailbox_send')
    expect(schema).toBeDefined()
    const parameters = schema!.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual(['blocking', 'body', 'replyToTraceId', 'subject', 'to'])
    expect(Object.keys(parameters.properties)).not.toContain('from')
    expect(parameters.required).toEqual(['to', 'subject', 'body'])
    expect(schema!.description).toContain('filled in by the runtime')
    expect(schema!.description).toContain('replyToTraceId')
    await ctx.fiber.dispose()
  })

  it('exposes mailbox_check_inbox with no parameters at all', async () => {
    const { ctx } = await setup('batman')
    const schema = ctx.tools.schemas().find(entry => entry.name === 'mailbox_check_inbox')
    expect(schema).toBeDefined()
    const parameters = schema!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(parameters.properties).toEqual({})
    expect(parameters.required).toBeUndefined()
    expect(schema!.description).toContain('own address')
    await ctx.fiber.dispose()
  })
})

describe('mailbox_send', () => {
  it('publishes with the trusted session name as the sender and a correlation id on the row', async () => {
    const { ctx, dbPath } = await setup('batman')
    const result = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'patrol', body: 'meet at the cave' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_send success')
    const value = result.value as { messageId: string; to: string; from: string; traceId: string; deliveryState: string }
    expect(value).toEqual({
      messageId: expect.any(String),
      to: 'alfred',
      from: 'batman',
      traceId: expect.any(String),
      deliveryState: 'pending',
    })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Stored for alfred') }])
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('delivery pending — not yet confirmed') }])
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(`mailbox_await traceId ${value.traceId}`) }])
    const rows = storedRows(dbPath, 'alfred')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ from_address: 'batman', state: 'pending', subject: 'patrol', blocking: null, trace_id: value.traceId })
    expect(JSON.parse(rows[0]!.payload ?? '')).toBe('meet at the cave')
    await ctx.fiber.dispose()
  })

  it('threads a reply onto the awaited trace when the caller supplies replyToTraceId', async () => {
    const { ctx, dbPath } = await setup('alfred')
    const result = await call(ctx, 'mailbox_send', {
      to: 'batman', subject: 'answer', body: 'gate code is 4-1', replyToTraceId: 'awaited-trace',
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_send success')
    // The result hands back the thread's id, not a fresh one: the replying
    // seat's own later await correlates on the same chain.
    expect(result.value).toEqual({
      messageId: expect.any(String),
      to: 'batman',
      from: 'alfred',
      traceId: 'awaited-trace',
      deliveryState: 'pending',
    })
    const rows = storedRows(dbPath, 'batman')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ from_address: 'alfred', state: 'pending', subject: 'answer', trace_id: 'awaited-trace' })
    await ctx.fiber.dispose()
  })

  it('round-trips the blocking mark onto the stored row', async () => {
    const { ctx, dbPath } = await setup('batman')
    await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'stuck', body: 'need the gate code', blocking: true })
    const rows = storedRows(dbPath, 'alfred')
    expect(rows[0]?.blocking).toBe(1)
    await ctx.fiber.dispose()
  })

  it('rejects a destination that violates the address grammar before any write', async () => {
    const { ctx } = await setup('batman')
    const result = await call(ctx, 'mailbox_send', { to: 'no separator', subject: 's', body: 'b' })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected mailbox_send failure')
    expect(result.error.message).toContain('invalid mailbox address')
    await ctx.fiber.dispose()
  })
})

describe('mailbox_send — known recipient admission (SWD-140)', () => {
  it('still delivers to a seat on the served roster exactly as before — the common case is unchanged', async () => {
    const { ctx, dbPath } = await setup('batman', { addresses: ['batman', 'alfred'] })
    const result = await callAs(ctx, 'batman', 'mailbox_send', { to: 'alfred', subject: 'patrol', body: 'meet at the cave' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_send success')
    expect((result.value as { deliveryState: string }).deliveryState).toBe('pending')
    expect(storedRows(dbPath, 'alfred')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('refuses a destination outside the served roster BEFORE anything is stored, naming the problem', async () => {
    const { ctx, dbPath } = await setup('batman', { addresses: ['batman', 'alfred'] })
    const result = await callAs(ctx, 'batman', 'mailbox_send', { to: 'robin', subject: 'patrol', body: 'come help' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a graceful refusal, not a tool error')
    const value = result.value as { deliveryState: string; refusalReason?: string }
    expect(value.deliveryState).toBe('refused')
    expect(value.refusalReason).toContain('"robin" is not a known seat')
    expect(value.refusalReason).toContain('batman, alfred')
    // The proof that matters: no row was ever written for the refused address.
    expect(storedRows(dbPath, 'robin')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('reaches the sender as a refusal, not as pending — the model must not mistake it for queued mail', async () => {
    const { ctx } = await setup('batman', { addresses: ['batman', 'alfred'] })
    const result = await callAs(ctx, 'batman', 'mailbox_send', { to: 'robin', subject: 's', body: 'b' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a graceful refusal')
    expect((result.value as { deliveryState: string }).deliveryState).toBe('refused')
    // Stringified rather than narrowed per-block: content is a ContentBlock
    // union, and this only needs to prove the rendered text reads as a
    // refusal, not extract a typed field.
    const rendered = JSON.stringify(result.content)
    expect(rendered).toContain('REFUSED')
    expect(rendered).not.toContain('Stored for')
    await ctx.fiber.dispose()
  })

  it('refuses a capitalisation-only mismatch — the exact shape of the incident this check exists to catch', async () => {
    const { ctx, dbPath } = await setup('batman', { addresses: ['batman', 'robin'] })
    const bad = await callAs(ctx, 'batman', 'mailbox_send', { to: 'Robin', subject: 'patrol', body: 'come help' })
    expect(bad.isError).toBe(false)
    if (bad.isError) throw new Error('expected a graceful refusal')
    const badValue = bad.value as { deliveryState: string; refusalReason?: string }
    expect(badValue.deliveryState).toBe('refused')
    expect(badValue.refusalReason).toContain('"Robin" is not a known seat')
    expect(badValue.refusalReason).toMatch(/capitalisation/i)
    expect(storedRows(dbPath, 'Robin')).toHaveLength(0)
    // The correctly-cased seat remains reachable — this is a strict match,
    // not a ban on the underlying name.
    const good = await callAs(ctx, 'batman', 'mailbox_send', { to: 'robin', subject: 'patrol', body: 'come help' })
    expect(good.isError).toBe(false)
    if (good.isError) throw new Error('expected success')
    expect((good.value as { deliveryState: string }).deliveryState).toBe('pending')
    await ctx.fiber.dispose()
  })

  it('does not check any roster when this process mounts none — the single-seat headless shape is unaffected', async () => {
    // No `addresses` configured at all: the tool has no local roster to
    // judge against — a single-seat process never mounts a bridge, so there
    // is nothing here to compare a destination to. This documents the
    // deliberate scope boundary rather than a gap nobody noticed; the mount
    // still warns once about it (see the "mount-time visibility" describe
    // block below).
    const { ctx, dbPath } = await setup('batman')
    const result = await call(ctx, 'mailbox_send', { to: 'anyone-at-all', subject: 's', body: 'b' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_send success')
    expect((result.value as { deliveryState: string }).deliveryState).toBe('pending')
    expect(storedRows(dbPath, 'anyone-at-all')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('a send refused before storage ends a same-process mailbox_await IMMEDIATELY, not after burning the deadline', async () => {
    // BLOCKING FIX proof: without recordPreStorageRefusal/takePreStorageRefusal,
    // this traceId has no row anywhere the store could ever find, so the
    // await loop would poll silently until AWAIT_MAX_DEADLINE_MS elapsed and
    // report "untraceable" — a five-minute hang ending in a misleading
    // answer, in place of the mail-parks-forever defect this ticket removes.
    const { ctx } = await setup('batman', { addresses: ['batman', 'alfred'] })
    const sent = await callAs(ctx, 'batman', 'mailbox_send', { to: 'robin', subject: 's', body: 'b' })
    expect(sent.isError).toBe(false)
    if (sent.isError) throw new Error('expected a graceful refusal')
    const sentValue = sent.value as { deliveryState: string; traceId: string }
    expect(sentValue.deliveryState).toBe('refused')

    vi.useFakeTimers()
    try {
      const pending = callAs(ctx, 'batman', 'mailbox_await', { traceId: sentValue.traceId, deadlineMs: AWAIT_MAX_DEADLINE_MS })
      // Zero real time advanced: an immediate refusal must resolve on its
      // own promise chain, needing no poll-interval tick at all. Advancing
      // by the full deadline would also "pass" a version that falls through
      // to a timeout that happens to look similar; zero proves it never
      // reached the poll-sleep at all.
      await vi.advanceTimersByTimeAsync(0)
      const result = await pending
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected a graceful await outcome')
      const value = result.value as { outcome: string; refusalReason?: string; waitedMs: number }
      expect(value.outcome).toBe('refused')
      expect(value.refusalReason).toContain('"robin" is not a known seat')
      expect(value.waitedMs).toBeLessThan(AWAIT_POLL_INTERVAL_MS)
    } finally {
      vi.useRealTimers()
    }
    await ctx.fiber.dispose()
  })

  it('never calls the underlying publish for a refused destination', async () => {
    const publish = vi.fn(async () => 'should-not-be-called')
    const send = mailboxSendTool(
      { publish, lookupByTraceId: async () => [] } as unknown as MailboxRegistryShape,
      { addresses: ['batman', 'alfred'] },
    )
    const args = { to: 'robin', subject: 's', body: 'b' }
    const value = (await send.execute(args, {
      signal: testSignal,
      callId: CallId('call-refused'),
      name: 'mailbox_send',
      arguments: args,
      agent: { id: String(deriveNamedSessionId('batman')) },
      token: Symbol('token') as never,
      rootCallId: CallId('call-refused'),
      deferContext: () => {},
    } as never)) as { deliveryState: string; refusalReason?: string; messageId: string }
    expect(publish).not.toHaveBeenCalled()
    expect(value.deliveryState).toBe('refused')
    expect(value.refusalReason).toContain('not a known seat')
  })
})

describe('mailbox tools mount — no-roster visibility (SWD-140 BLOCKING 3)', () => {
  it('warns once at mount when addresses is absent — the disabled check must never be silent', async () => {
    const dbPath = join(tempDir(), 'mailbox.db')
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
    await ctx.plugin(MailboxLocal, { path: dbPath })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // No `addresses` at all: this is the single-seat headless shape, where
    // the roster-gated refusal has nothing to check against.
    await ctx.plugin(tool, { sessionName: 'batman' })
    await ctx.plugin(invariant)
    expect(warn).toHaveBeenCalledTimes(1)
    const [message] = warn.mock.calls[0] as [string]
    expect(message).toContain('known-recipient refusal is INACTIVE')
    expect(message).toContain('addresses')
    await ctx.fiber.dispose()
  })

  it('warns once at mount when addresses is an empty array — empty is absent, not "nobody yet"', async () => {
    const dbPath = join(tempDir(), 'mailbox.db')
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
    await ctx.plugin(MailboxLocal, { path: dbPath })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(tool, { sessionName: 'batman', addresses: [] })
    await ctx.plugin(invariant)
    expect(warn).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('stays silent at mount when a served roster is configured — the common case logs nothing new', async () => {
    const { ctx } = await setup('batman', { addresses: ['batman', 'alfred'] })
    // setup() already completed the mount before this spy attaches, so this
    // proves only that nothing warns AFTER mount for a healthy roster — the
    // mount-time assertion lives in the two tests above, which spy first.
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await callAs(ctx, 'batman', 'mailbox_send', { to: 'alfred', subject: 's', body: 'b' })
    expect(warn).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

describe('mailbox_send delivery state', () => {
  /** One store row as the post-admission read sees it. */
  function row(id: string, state: 'pending' | 'claimed' | 'done' | 'failed', failureReason?: string) {
    return { id, state, from: 'batman', to: 'alfred', sentAt: 1, subject: 's', ...(failureReason === undefined ? {} : { failureReason }) }
  }

  /** Build the send tool over a fake registry whose post-admission read returns `rows`. */
  function sendWithRead(rows: readonly ReturnType<typeof row>[]) {
    return mailboxSendTool({
      publish: async () => 'msg-1',
      lookupByTraceId: async () => rows,
    } as unknown as MailboxRegistryShape, { sessionName: 'batman' })
  }

  const args = { to: 'alfred', subject: 's', body: 'b' }

  /** Run one execute through the direct-constructed tool. */
  async function runOnce(send: ReturnType<typeof sendWithRead>) {
    return send.execute(args, {
      signal: testSignal,
      callId: CallId('call-send-state'),
      name: 'mailbox_send',
      arguments: args,
      token: Symbol('token') as never,
      rootCallId: CallId('call-send-state'),
      deferContext: () => {},
    } as never)
  }

  it('reports accepted when the row already settled done', async () => {
    const send = sendWithRead([row('msg-1', 'done')])
    const value = await runOnce(send)
    expect(value).toEqual({
      messageId: 'msg-1',
      to: 'alfred',
      from: 'batman',
      traceId: expect.any(String),
      deliveryState: 'accepted',
    })
    const blocks = send.output!.render(args, value as never)
    expect((blocks[0] as { text: string }).text).toContain('Delivered to alfred')
  })

  it('reports refused with the recorded terminal reason', async () => {
    const send = sendWithRead([row('msg-1', 'failed', 'org-registry-denied')])
    const value = await runOnce(send)
    expect(value).toEqual({
      messageId: 'msg-1',
      to: 'alfred',
      from: 'batman',
      traceId: expect.any(String),
      deliveryState: 'refused',
      refusalReason: 'org-registry-denied',
    })
    const blocks = send.output!.render(args, value as never)
    expect((blocks[0] as { text: string }).text).toContain('REFUSED')
    expect((blocks[0] as { text: string }).text).toContain('org-registry-denied')
  })

  it('reports refused with a fallback reason when the failed row recorded none', async () => {
    const value = (await runOnce(sendWithRead([row('msg-1', 'failed')]))) as { deliveryState: string; refusalReason?: string }
    expect(value.deliveryState).toBe('refused')
    expect(value.refusalReason).toEqual(expect.stringContaining('recorded no reason'))
  })

  it('reports pending for a fresh row and folds claimed into pending', async () => {
    expect(((await runOnce(sendWithRead([row('msg-1', 'pending')]))) as { deliveryState: string }).deliveryState).toBe('pending')
    expect(((await runOnce(sendWithRead([row('msg-1', 'claimed')]))) as { deliveryState: string }).deliveryState).toBe('pending')
  })

  it('reports pending when the post-admission read finds no row', async () => {
    const send = sendWithRead([])
    const value = (await runOnce(send)) as { deliveryState: string; refusalReason?: string }
    expect(value.deliveryState).toBe('pending')
    expect(value.refusalReason).toBeUndefined()
    const blocks = send.output!.render(args, value as never)
    expect((blocks[0] as { text: string }).text).toContain('delivery pending — not yet confirmed')
  })
})

describe('mailbox_check_inbox', () => {
  it('drains only the calling seat\'s own address and settles each receipt done', async () => {
    const { ctx, dbPath } = await setup('alfred')
    const registry = ctx.mailbox
    await registry.publish({ to: 'alfred' as never, from: 'batman', subject: 'for alfred', payload: 'cave, 9pm' })
    await registry.publish({ to: 'carol' as never, from: 'batman', subject: 'for carol' })
    // A subject-only notice: the drained entry carries an empty body and the
    // renderer prints the header alone.
    await registry.publish({ to: 'alfred' as never, from: 'yoda', subject: 'note only' })

    const result = await call(ctx, 'mailbox_check_inbox')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_check_inbox success')
    expect(result.value).toEqual({
      messages: [
        {
          messageId: expect.any(String),
          from: 'batman',
          subject: 'for alfred',
          body: 'cave, 9pm',
          claimedAt: expect.any(Number),
        },
        {
          messageId: expect.any(String),
          from: 'yoda',
          subject: 'note only',
          body: '',
          claimedAt: expect.any(Number),
        },
      ],
      count: 2,
    })
    expect(result.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('1. from batman: for alfred'),
    }])
    expect(result.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('\n\n2. from yoda: note only'),
    }])
    // Alfred's mail is delivered (never claimable again); Carol's is untouched.
    expect(storedRows(dbPath, 'alfred')[0]?.state).toBe('done')
    expect(storedRows(dbPath, 'carol')[0]?.state).toBe('pending')

    const again = await call(ctx, 'mailbox_check_inbox')
    if (again.isError) throw new Error('expected second drain success')
    expect(again.value).toEqual({ messages: [], count: 0 })
    expect(again.content).toEqual([{ type: 'text', text: 'Inbox empty — no pending mail for this seat.' }])
    await ctx.fiber.dispose()
  })

  it('projects a non-string payload body as its JSON text and keeps the blocking mark', async () => {
    const { ctx } = await setup('alfred')
    await ctx.mailbox.publish({ to: 'alfred' as never, from: 'robin', blocking: true, payload: { op: 'task', detail: 'scan the docks' } })
    const result = await call(ctx, 'mailbox_check_inbox')
    if (result.isError) throw new Error('expected mailbox_check_inbox success')
    expect(result.value).toEqual({
      messages: [{
        messageId: expect.any(String),
        from: 'robin',
        blocking: true,
        body: JSON.stringify({ op: 'task', detail: 'scan the docks' }, null, 2),
        claimedAt: expect.any(Number),
      }],
      count: 1,
    })
    await ctx.fiber.dispose()
  })

  it('fails loud when a claimed message carries no provider id', async () => {
    // A stub registry hands back an id-less lease — the contract the tool
    // owes every provider is that this surfaces as a loud failure, never a
    // forged settlement envelope.
    const lease = {
      message: { from: 'ghost', payload: 'body' },
      leaseRef: 'ref' as never,
      claimedAt: 1,
    } as unknown as MailboxLease
    const stub = {
      claim: async () => [lease],
      settle: async () => {
        throw new Error('settle must not run for an id-less claim')
      },
    } as unknown as MailboxRegistryShape
    const checkInbox = mailboxCheckInboxTool(stub, { sessionName: 'alfred' })
    await expect(checkInbox.execute({}, {
      signal: testSignal,
      callId: CallId('call-stub'),
      name: 'mailbox_check_inbox',
      arguments: {},
      token: Symbol('token') as never,
      rootCallId: CallId('call-stub'),
      deferContext: () => {},
    } as never)).rejects.toThrow(/no provider id/)
  })
})

describe('mailbox_await', () => {
  /**
   * Drain one address the way the bridge does — claim, then settle the
   * outcome the bridge records — so tests can stage delivered and refused
   * rows without running the bridge itself.
   */
  async function drainOnce(ctx: Context, address: string, outcome: 'done' | { readonly failed: string }): Promise<boolean> {
    const leases = await ctx.mailbox.claim({ addresses: [address as never], limit: 10, staleClaimMs: 60_000 })
    if (leases.length === 0) return false
    for (const lease of leases) {
      if (lease.message.id === undefined) throw new Error('claim returned an id-less message')
      await ctx.mailbox.settle(lease.leaseRef, outcome === 'done'
        ? { state: 'done', result: { deliveredAt: Date.now(), messageId: lease.message.id } }
        : { state: 'failed', result: { reason: outcome.failed } })
    }
    return true
  }

  /** The traceId of a successful send, for correlating an await. */
  function sentTraceId(send: { isError: boolean; value?: unknown; error?: { message: string } }): string {
    if (send.isError) throw new Error(`expected mailbox_send success: ${send.error?.message ?? ''}`)
    return (send.value as { traceId: string }).traceId
  }

  it('exposes optional deadlineMs and traceId and teaches the timeout contract', async () => {
    const { ctx } = await setup('batman')
    const schema = ctx.tools.schemas().find(entry => entry.name === 'mailbox_await')
    expect(schema).toBeDefined()
    const parameters = schema!.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(parameters.properties).sort()).toEqual(['deadlineMs', 'traceId'])
    expect(parameters.required).toBeUndefined()
    expect(schema!.description).toContain('sleep-poll')
    expect(schema!.description).toContain('A timeout is a normal outcome')
    expect(schema!.description).toContain('traceId')
    await ctx.fiber.dispose()
  })

  it('returns an already-queued reply immediately, settled done like a drain', async () => {
    const { ctx, dbPath } = await setup('alfred')
    await ctx.mailbox.publish({ to: 'alfred' as never, from: 'batman', subject: 'answer', payload: 'gate code is 4-1' })
    const result = await call(ctx, 'mailbox_await', { deadlineMs: AWAIT_MAX_DEADLINE_MS })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_await success')
    expect(result.value).toEqual({
      outcome: 'reply',
      messages: [{ messageId: expect.any(String), from: 'batman', subject: 'answer', body: 'gate code is 4-1', claimedAt: expect.any(Number) }],
      count: 1,
      waitedMs: expect.any(Number),
    })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Reply arrived after') }])
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('1. from batman: answer') }])
    expect(storedRows(dbPath, 'alfred')[0]?.state).toBe('done')
    await ctx.fiber.dispose()
  })

  it('catches a threaded reply the bridge already delivered as a turn, instead of timing out', async () => {
    const { ctx, dbPath } = await setup('batman')
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'request', body: 'status?' })
    const traceId = sentTraceId(send)
    // The exact field failure: the peer replies threaded, the bridge wins the
    // row — claims it, steers the reply into this seat's live turn, settles it
    // done — and the await starts only after its own send's result round trip.
    // A detection that only claimed could never see this row again.
    await ctx.mailbox.publish({ to: 'batman' as never, from: 'alfred', subject: 'answer', payload: 'all clear', traceId })
    expect(await drainOnce(ctx, 'batman', 'done')).toBe(true)
    const started = Date.now()
    const result = await call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MAX_DEADLINE_MS })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_await success')
    expect(result.value).toEqual({
      outcome: 'reply',
      messages: [{ messageId: expect.any(String), from: 'alfred', subject: 'answer', body: 'all clear', claimedAt: expect.any(Number) }],
      count: 1,
      waitedMs: expect.any(Number),
    })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('1. from alfred: answer') }])
    // Back well inside one poll interval — the reply was read, never waited out.
    expect(Date.now() - started).toBeLessThan(AWAIT_POLL_INTERVAL_MS)
    // Detection is a read: the delivered row stays exactly as the bridge left it.
    expect(storedRows(dbPath, 'batman')[0]?.state).toBe('done')
    await ctx.fiber.dispose()
  })

  it('catches an unthreaded reply the bridge delivered, reading inbound mail since the awaited send', async () => {
    const { ctx } = await setup('batman')
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'request', body: 'status?' })
    const traceId = sentTraceId(send)
    // The peer replied without carrying the thread — the documented cost is
    // that any inbound mail since the send ends the wait, and the benefit is
    // that a bridge-pre-empted reply still does.
    await ctx.mailbox.publish({ to: 'batman' as never, from: 'alfred', subject: 'answer', payload: 'all clear' })
    expect(await drainOnce(ctx, 'batman', 'done')).toBe(true)
    const result = await call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MAX_DEADLINE_MS })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_await success')
    expect(result.value).toMatchObject({ outcome: 'reply', count: 1 })
    expect((result.value as { messages: Array<{ from: string; subject?: string }> }).messages[0])
      .toMatchObject({ from: 'alfred', subject: 'answer' })
    await ctx.fiber.dispose()
  })

  it('returns a reply the bridge currently holds claimed, without disturbing its lease', async () => {
    const { ctx, dbPath } = await setup('batman')
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'request', body: 'status?' })
    const traceId = sentTraceId(send)
    await ctx.mailbox.publish({ to: 'batman' as never, from: 'alfred', subject: 'answer', payload: 'soon', traceId })
    // Mid-flight: a fresh claim the bridge holds, inside the staleness bound,
    // not yet steered or settled. The wait reads its content and returns it
    // without claiming or settling — the lease is the bridge's to finish.
    const leases = await ctx.mailbox.claim({ addresses: ['batman' as never], limit: 1, staleClaimMs: 60_000 })
    expect(leases).toHaveLength(1)
    const result = await call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MAX_DEADLINE_MS })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_await success')
    expect(result.value).toMatchObject({ outcome: 'reply', count: 1, messages: [{ from: 'alfred', subject: 'answer' }] })
    expect(storedRows(dbPath, 'batman')[0]?.state).toBe('claimed')
    await ctx.fiber.dispose()
  })

  it('does not end a traced wait on inbound mail delivered before the awaited send', async () => {
    const { ctx } = await setup('batman')
    // Older delivered mail is the model's to reason about — it was in the
    // conversation before the send — so the read anchor is the send's own
    // admission time, not the store's beginning.
    await ctx.mailbox.publish({ to: 'batman' as never, from: 'robin', subject: 'older', payload: 'earlier' })
    expect(await drainOnce(ctx, 'batman', 'done')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 2))
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'request', body: 'status?' })
    const traceId = sentTraceId(send)
    // The awaited send itself was delivered — the timeout diagnosis is about
    // the send, not the old mail.
    expect(await drainOnce(ctx, 'alfred', 'done')).toBe(true)
    vi.useFakeTimers()
    try {
      const pending = call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MIN_DEADLINE_MS })
      await vi.advanceTimersByTimeAsync(AWAIT_MIN_DEADLINE_MS + 1)
      const result = await pending
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected mailbox_await success')
      expect(result.value).toMatchObject({ outcome: 'timeout', sentState: 'delivered' })
    } finally {
      vi.useRealTimers()
    }
    await ctx.fiber.dispose()
  })

  it('ends an untraced wait on mail the bridge delivered mid-wait', async () => {
    const { ctx } = await setup('batman')
    vi.useFakeTimers()
    try {
      const pending = call(ctx, 'mailbox_await', { deadlineMs: AWAIT_MAX_DEADLINE_MS })
      await vi.advanceTimersByTimeAsync(AWAIT_POLL_INTERVAL_MS)
      // Delivered — claimed, steered, settled done — by the bridge during the
      // wait: the read half catches what the claim half can no longer see.
      await ctx.mailbox.publish({ to: 'batman' as never, from: 'alfred', subject: 'fyi', payload: 'mid-wait' })
      expect(await drainOnce(ctx, 'batman', 'done')).toBe(true)
      await vi.advanceTimersByTimeAsync(AWAIT_POLL_INTERVAL_MS)
      const result = await pending
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected mailbox_await success')
      expect(result.value).toMatchObject({ outcome: 'reply', count: 1, messages: [{ from: 'alfred', subject: 'fyi' }] })
    } finally {
      vi.useRealTimers()
    }
    await ctx.fiber.dispose()
  })

  it('ends immediately with the refusal reason instead of waiting out the deadline', async () => {
    const { ctx, dbPath } = await setup('batman')
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'request', body: 'approve the leave' })
    const traceId = sentTraceId(send)
    // The bridge's drain-time refusal: the recipient's row settles terminally failed.
    expect(await drainOnce(ctx, 'alfred', { failed: 'sender-not-admitted' })).toBe(true)
    const started = Date.now()
    const result = await call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MAX_DEADLINE_MS })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_await success')
    expect(result.value).toEqual({
      outcome: 'refused',
      messages: [],
      count: 0,
      refusalReason: 'sender-not-admitted',
      waitedMs: expect.any(Number),
    })
    // Back well inside one poll interval — the refusal was read, never waited out.
    expect(Date.now() - started).toBeLessThan(AWAIT_POLL_INTERVAL_MS)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Reason: sender-not-admitted') }])
    expect(storedRows(dbPath, 'alfred')[0]?.state).toBe('failed')
    await ctx.fiber.dispose()
  })

  it('returns the refusal ahead of unrelated queued mail and leaves that mail pending', async () => {
    const { ctx, dbPath } = await setup('batman')
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'request', body: 'approve the leave' })
    const traceId = sentTraceId(send)
    await ctx.mailbox.publish({ to: 'batman' as never, from: 'alfred', subject: 'unrelated', payload: 'fyi' })
    expect(await drainOnce(ctx, 'alfred', { failed: 'sender-not-admitted' })).toBe(true)
    const result = await call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MAX_DEADLINE_MS })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_await success')
    expect(result.value).toMatchObject({ outcome: 'refused', count: 0 })
    expect(storedRows(dbPath, 'batman')).toHaveLength(1)
    expect(storedRows(dbPath, 'batman')[0]).toMatchObject({ subject: 'unrelated', state: 'pending' })
    await ctx.fiber.dispose()
  })

  it('times out reporting a send that was delivered but never answered', async () => {
    const { ctx, dbPath } = await setup('batman')
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'request', body: 'status?' })
    const traceId = sentTraceId(send)
    expect(await drainOnce(ctx, 'alfred', 'done')).toBe(true)
    vi.useFakeTimers()
    try {
      const pending = call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MIN_DEADLINE_MS })
      // Run out the clamped-minimum wait: the poll sleep fires, the next tick
      // sees no reply and an expired deadline, and the wait reports.
      await vi.advanceTimersByTimeAsync(AWAIT_MIN_DEADLINE_MS + 1)
      const result = await pending
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected mailbox_await success')
      expect(result.value).toEqual({
        outcome: 'timeout',
        messages: [],
        count: 0,
        sentState: 'delivered',
        deliveredAt: expect.any(Number),
        waitedMs: expect.any(Number),
      })
      expect((result.value as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(AWAIT_MIN_DEADLINE_MS)
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('WAS delivered') }])
      expect(storedRows(dbPath, 'alfred')[0]?.state).toBe('done')
      vi.useRealTimers()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out reporting a send the transport never picked up', async () => {
    const { ctx, dbPath } = await setup('batman')
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'request', body: 'status?' })
    const traceId = sentTraceId(send)
    vi.useFakeTimers()
    try {
      const pending = call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MIN_DEADLINE_MS })
      await vi.advanceTimersByTimeAsync(AWAIT_MIN_DEADLINE_MS + 1)
      const result = await pending
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected mailbox_await success')
      expect(result.value).toEqual({
        outcome: 'timeout',
        messages: [],
        count: 0,
        sentState: 'pending',
        waitedMs: expect.any(Number),
      })
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('NEVER picked up') }])
      expect(storedRows(dbPath, 'alfred')[0]?.state).toBe('pending')
      vi.useRealTimers()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out with no diagnosis when no traceId correlates the send', async () => {
    const { ctx } = await setup('batman')
    vi.useFakeTimers()
    try {
      const pending = call(ctx, 'mailbox_await', { deadlineMs: AWAIT_MIN_DEADLINE_MS })
      await vi.advanceTimersByTimeAsync(AWAIT_MIN_DEADLINE_MS + 1)
      const result = await pending
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected mailbox_await success')
      expect(result.value).toEqual({
        outcome: 'timeout',
        messages: [],
        count: 0,
        sentState: 'unknown',
        waitedMs: expect.any(Number),
      })
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('no traceId was supplied') }])
      vi.useRealTimers()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('wakes on a reply that lands mid-wait and settles it done', async () => {
    const { ctx, dbPath } = await setup('alfred')
    const send = await call(ctx, 'mailbox_send', { to: 'batman', subject: 'question', body: 'gate code?' })
    const traceId = sentTraceId(send)
    vi.useFakeTimers()
    try {
      const pending = call(ctx, 'mailbox_await', { traceId, deadlineMs: AWAIT_MAX_DEADLINE_MS })
      // Tick one finds nothing and arms the poll sleep; the reply lands; the
      // next tick claims, settles, and ends the wait.
      await vi.advanceTimersByTimeAsync(AWAIT_POLL_INTERVAL_MS + 1)
      await ctx.mailbox.publish({ to: 'alfred' as never, from: 'batman', subject: 'answer', payload: 'it is 4-1' })
      await vi.advanceTimersByTimeAsync(AWAIT_POLL_INTERVAL_MS + 1)
      const result = await pending
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected mailbox_await success')
      expect(result.value).toEqual({
        outcome: 'reply',
        messages: [{ messageId: expect.any(String), from: 'batman', subject: 'answer', body: 'it is 4-1', claimedAt: expect.any(Number) }],
        count: 1,
        waitedMs: expect.any(Number),
      })
      expect(storedRows(dbPath, 'alfred')[0]?.state).toBe('done')
      vi.useRealTimers()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles as an aborted error promptly when the caller signal fires mid-wait', async () => {
    const { ctx } = await setup('alfred')
    const controller = new AbortController()
    const started = Date.now()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('call-abort'),
      name: 'mailbox_await',
      arguments: { deadlineMs: AWAIT_MAX_DEADLINE_MS },
    })
    // Past every microtask of the dispatch pipeline and inside the poll sleep.
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected aborted result')
    expect(result.error.message).toMatch(/abort/i)
    expect(result.error.message).not.toContain('before dispatch')
    // Reclaimed in milliseconds, not at the deadline.
    expect(Date.now() - started).toBeLessThan(5000)
    await ctx.fiber.dispose()
  })

  it('fails loud on an anonymous run like the other tools', async () => {
    const { ctx } = await setup(undefined)
    const result = await call(ctx, 'mailbox_await')
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected anonymous mailbox_await failure')
    expect(result.error.message).toContain('no trusted sender identity')
    await ctx.fiber.dispose()
  })

  it('clamps the deadline to the documented floor and ceiling', () => {
    expect(clampAwaitDeadlineMs(undefined)).toBe(tool.AWAIT_DEFAULT_DEADLINE_MS)
    expect(clampAwaitDeadlineMs(0)).toBe(AWAIT_MIN_DEADLINE_MS)
    expect(clampAwaitDeadlineMs(-5000)).toBe(AWAIT_MIN_DEADLINE_MS)
    expect(clampAwaitDeadlineMs(Number.MAX_SAFE_INTEGER)).toBe(AWAIT_MAX_DEADLINE_MS)
    expect(clampAwaitDeadlineMs(45_000)).toBe(45_000)
  })
})

describe('mailbox_directory', () => {
  /** Write a minimal valid org registry listing the given seats. */
  function writeRegistry(seats: Record<string, { lead?: boolean; test?: boolean }>): string {
    const dir = tempDir()
    const path = join(dir, 'registry.yml')
    const lines = Object.entries(seats).map(([name, flags]) => {
      const parts = ['cwd: .', ...flags.lead === true ? ['lead: true'] : [], ...flags.test === true ? ['test: true'] : []]
      return `  ${name}: { ${parts.join(', ')} }`
    })
    writeFileSync(path, `baseDir: ${dir}\nseats:\n${lines.join('\n')}\nedges: []\n`, 'utf8')
    return path
  }

  it('exposes zero parameters and teaches the discovery contract', async () => {
    const { ctx } = await setup('batman')
    const schema = ctx.tools.schemas().find(entry => entry.name === 'mailbox_directory')
    expect(schema).toBeDefined()
    expect(schema!.parameters).toEqual({ type: 'object', properties: {} })
    expect(schema!.description).toContain('bare name')
    expect(schema!.description).toContain('test seats')
    await ctx.fiber.dispose()
  })

  it('merges the served roster with the org registry and marks roles, sorted by name', async () => {
    const registryPath = writeRegistry({
      alfred: { lead: true },
      pepper: { lead: true },
      'tt-pong': { test: true },
      'web-ceo': {},
    })
    const { ctx } = await setup('batman', { addresses: ['batman', 'tt-pong'], orgRegistryPath: registryPath })
    const result = await call(ctx, 'mailbox_directory')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_directory success')
    expect(result.value).toEqual({
      seats: [
        { name: 'alfred', lead: true },
        { name: 'batman', served: true },
        { name: 'pepper', lead: true },
        { name: 'tt-pong', served: true, test: true },
        { name: 'web-ceo' },
      ],
      count: 5,
      orgRegistry: 'loaded',
    })
    const text = (result.content as Array<{ text: string }>)[0]!.text
    // A served TEST seat renders only in the never-mail group: inviting mail
    // to it under "served" would steer the model into a guaranteed refusal.
    expect(text).toContain('Served on this host: batman.')
    expect(text).toContain('Elsewhere in the org: alfred [lead], pepper [lead], web-ceo.')
    expect(text).toContain('Test seats — never mail: tt-pong.')
    await ctx.fiber.dispose()
  })

  it('degrades to the served roster when the org registry cannot load, and says so', async () => {
    const { ctx } = await setup('batman', { addresses: ['batman'], orgRegistryPath: join(tempDir(), 'absent.yml') })
    const result = await call(ctx, 'mailbox_directory')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_directory success')
    expect(result.value).toEqual({
      seats: [{ name: 'batman', served: true }],
      count: 1,
      orgRegistry: 'unavailable',
    })
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('org registry unavailable')
    await ctx.fiber.dispose()
  })

  it('works on an anonymous run — the directory is org knowledge, not identity-scoped', async () => {
    const registryPath = writeRegistry({ alfred: {} })
    const { ctx } = await setup(undefined, { addresses: ['batman'], orgRegistryPath: registryPath })
    const result = await call(ctx, 'mailbox_directory')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_directory success')
    expect(result.value).toMatchObject({ count: 2, orgRegistry: 'loaded' })
    await ctx.fiber.dispose()
  })
})

describe('identity resolution', () => {
  it('rejects a call on an anonymous run with the identity error, not a guessed sender', async () => {
    const { ctx } = await setup(undefined)
    const send = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 's', body: 'b' })
    expect(send.isError).toBe(true)
    if (!send.isError) throw new Error('expected anonymous mailbox_send failure')
    expect(send.error.message).toContain('no trusted sender identity')

    const drain = await call(ctx, 'mailbox_check_inbox')
    expect(drain.isError).toBe(true)
    if (!drain.isError) throw new Error('expected anonymous mailbox_check_inbox failure')
    expect(drain.error.message).toContain('no trusted sender identity')
    await ctx.fiber.dispose()
  })

  it('resolves a valid name and rejects blank or grammar-violating ones', () => {
    expect(resolveMailboxIdentity({ sessionName: 'batman' })).toBe('batman')
    expect(() => resolveMailboxIdentity({})).toThrow(/no trusted sender identity/)
    expect(() => resolveMailboxIdentity({ sessionName: '   ' })).toThrow(/no trusted sender identity/)
    expect(() => resolveMailboxIdentity({ sessionName: 'bad name!' })).toThrow(/invalid mailbox address/)
  })

  it('takes the identity from the calling agent, not the mount, when a roster is served', () => {
    const addresses = ['tt-ping', 'tt-pong']
    // The id is derived, never passed: a caller matches only by actually
    // running as the session that address derives to.
    const pong = String(deriveNamedSessionId('tt-pong'))
    expect(resolveMailboxIdentity({ addresses, agentSessionId: pong })).toBe('tt-pong')
    // A mount-time name loses to the roster — otherwise every session in a
    // many-seat host would send as whichever seat the mount happened to name.
    expect(resolveMailboxIdentity({ sessionName: 'tt-ping', addresses, agentSessionId: pong })).toBe('tt-pong')
    expect(() => resolveMailboxIdentity({ addresses }))
      .toThrow(/require a calling agent in a multi-seat deployment/)
    expect(() => resolveMailboxIdentity({ addresses, agentSessionId: String(deriveNamedSessionId('alfred')) }))
      .toThrow(/is not one of the addresses this deployment serves/)
  })

  it('resolves a recorded registry binding when derivation misses', async () => {
    // An operator-composer session the UI minted carries a non-derived id:
    // the recorded binding is what makes it a seat without renaming the world
    // around it. Derivation is tried first; the recording is the fallback.
    const dir = tempDir()
    const registryPath = join(dir, 'registry.yml')
    writeFileSync(
      registryPath,
      `baseDir: ${dir}\nseats:\n  Ms-pepper-potts: { cwd: ., sessionId: session-operator-minted }\nedges: []\n`,
      'utf8',
    )
    const sources = { addresses: ['Ms-pepper-potts'], agentSessionId: 'session-operator-minted', orgRegistryPath: registryPath }
    await expect(resolveMailboxIdentityWithRegistry(sources)).resolves.toBe('Ms-pepper-potts')
    // The derived match still wins when it exists — unchanged semantics.
    const derived = String(deriveNamedSessionId('tt-pong'))
    await expect(resolveMailboxIdentityWithRegistry({
      addresses: ['tt-pong', 'Ms-pepper-potts'], agentSessionId: derived, orgRegistryPath: registryPath,
    })).resolves.toBe('tt-pong')
    // No derivation match and no recorded binding: the same not-served error.
    await expect(resolveMailboxIdentityWithRegistry({
      addresses: ['Ms-pepper-potts'], agentSessionId: 'session-nobody', orgRegistryPath: registryPath,
    })).rejects.toThrow(/is not one of the addresses this deployment serves/)
    // An absent registry cannot resolve a binding either.
    await expect(resolveMailboxIdentityWithRegistry({
      addresses: ['Ms-pepper-potts'], agentSessionId: 'session-operator-minted', orgRegistryPath: join(tempDir(), 'absent.yml'),
    })).rejects.toThrow(/could not be loaded/)

    // No orgRegistryPath in the sources: the resolver applies the bridge's own
    // default ($DSH_HOME/org/registry.yml), so a host that never configures the
    // path still binds composer-minted seats. The web-stable deployment relies
    // on exactly this — its profile sets addresses but not the registry path.
    const smokeHome = tempDir()
    mkdirSync(join(smokeHome, 'org'), { recursive: true })
    writeFileSync(
      join(smokeHome, 'org', 'registry.yml'),
      `baseDir: ${smokeHome}\nseats:\n  Ms-pepper-potts: { cwd: ., sessionId: session-via-default }\nedges: []\n`,
      'utf8',
    )
    const savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = smokeHome
    try {
      await expect(resolveMailboxIdentityWithRegistry({
        addresses: ['Ms-pepper-potts'], agentSessionId: 'session-via-default',
      })).resolves.toBe('Ms-pepper-potts')
    } finally {
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
    }
  })

  it('presents calls as pure cards derived from the args', () => {
    const send = mailboxSendTool({ publish: async () => 'x' } as unknown as MailboxRegistryShape, { sessionName: 'batman' })
    expect(send.presentCall?.({ to: 'alfred', subject: 'hi', body: 'b', blocking: true })).toEqual({
      card: 'generic',
      title: 'Send mail to alfred',
      kind: 'other',
      rawInput: { to: 'alfred', subject: 'hi' },
    })
    const drain = mailboxCheckInboxTool({ claim: async () => [] } as unknown as MailboxRegistryShape, { sessionName: 'alfred' })
    expect(drain.presentCall?.({})).toEqual({ card: 'generic', title: 'Check inbox', kind: 'other' })
    const awaiting = mailboxAwaitTool({ claim: async () => [], lookupByTraceId: async () => [] } as unknown as MailboxRegistryShape, { sessionName: 'alfred' })
    expect(awaiting.presentCall?.({})).toEqual({ card: 'generic', title: 'Await mailbox reply', kind: 'other' })
  })
})

describe('plugin config', () => {
  it('accepts an absent sessionName and rejects a non-string one', () => {
    expect(new tool.Config({})).toEqual({ addresses: [] })
    expect(() => new tool.Config({ sessionName: 42 as never })).toThrow()
  })
})

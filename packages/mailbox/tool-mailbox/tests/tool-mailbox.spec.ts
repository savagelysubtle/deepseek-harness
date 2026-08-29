/**
 * The mailbox tools' identity guarantees: the send schema exposes no `from`
 * and the runtime fills the trusted session name; checkInbox takes no address
 * argument and drains only the calling seat's own queue, settling each
 * receipt; an anonymous run fails loud instead of guessing an identity.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import type { MailboxLease, MailboxRegistry as MailboxRegistryShape } from '@deepseek-ai/dsh-mailbox'
import MailboxLocal from '@deepseek-ai/dsh-mailbox-local'
import * as tool from '../src/index.ts'
import { mailboxCheckInboxTool, mailboxSendTool } from '../src/tools.ts'
import { resolveMailboxIdentity } from '../src/identity.ts'
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
async function setup(sessionName: string | undefined): Promise<{ ctx: Context; dbPath: string }> {
  const dbPath = join(tempDir(), 'mailbox.db')
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
  await ctx.plugin(MailboxLocal, { path: dbPath })
  await ctx.plugin(tool, sessionName === undefined ? {} : { sessionName })
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

/** Read one address's rows straight out of the store the plugin opened. */
interface StoredRow {
  from_address: string
  state: string
  subject: string | null
  payload: string | null
  blocking: number | null
}

function storedRows(dbPath: string, address: string): StoredRow[] {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare('SELECT from_address, state, subject, payload, blocking FROM messages WHERE to_address = ? ORDER BY created_at').all(address) as never
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
    expect(Object.keys(parameters.properties).sort()).toEqual(['blocking', 'body', 'subject', 'to'])
    expect(Object.keys(parameters.properties)).not.toContain('from')
    expect(parameters.required).toEqual(['to', 'subject', 'body'])
    expect(schema!.description).toContain('filled in by the runtime')
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
  it('publishes with the trusted session name as the sender', async () => {
    const { ctx, dbPath } = await setup('batman')
    const result = await call(ctx, 'mailbox_send', { to: 'alfred', subject: 'patrol', body: 'meet at the cave' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected mailbox_send success')
    expect(result.value).toEqual({
      messageId: expect.any(String),
      to: 'alfred',
      from: 'batman',
    })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Stored for alfred') }])
    const rows = storedRows(dbPath, 'alfred')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ from_address: 'batman', state: 'pending', subject: 'patrol', blocking: null })
    expect(JSON.parse(rows[0]!.payload ?? '')).toBe('meet at the cave')
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
    const checkInbox = mailboxCheckInboxTool(stub, 'alfred')
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
    expect(resolveMailboxIdentity('batman')).toBe('batman')
    expect(() => resolveMailboxIdentity(undefined)).toThrow(/no trusted sender identity/)
    expect(() => resolveMailboxIdentity('   ')).toThrow(/no trusted sender identity/)
    expect(() => resolveMailboxIdentity('bad name!')).toThrow(/invalid mailbox address/)
  })

  it('presents calls as pure cards derived from the args', () => {
    const send = mailboxSendTool({ publish: async () => 'x' } as unknown as MailboxRegistryShape, 'batman')
    expect(send.presentCall?.({ to: 'alfred', subject: 'hi', body: 'b', blocking: true })).toEqual({
      card: 'generic',
      title: 'Send mail to alfred',
      kind: 'other',
      rawInput: { to: 'alfred', subject: 'hi' },
    })
    const drain = mailboxCheckInboxTool({ claim: async () => [] } as unknown as MailboxRegistryShape, 'alfred')
    expect(drain.presentCall?.({})).toEqual({ card: 'generic', title: 'Check inbox', kind: 'other' })
  })
})

describe('plugin config', () => {
  it('accepts an absent sessionName and rejects a non-string one', () => {
    expect(new tool.Config({})).toEqual({})
    expect(() => new tool.Config({ sessionName: 42 as never })).toThrow()
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMailboxDatabase, SqliteMailboxStore } from '@deepseek-ai/dsh-mailbox-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSendTool, MAX_SENDS_PER_TURN } from '../../src/mcp/send.ts'
import { makeContext, textOf } from './helpers.ts'

const good = { to: 'ops-lead', body: 'status?' }

describe('mailbox_send (a) identity comes from the closure only', () => {
  it('stamps from = the seat id and rejects an input that names a sender', async () => {
    const context = makeContext()
    const tool = createSendTool(context)
    expect((await tool.handler(good)).isError).toBeUndefined()
    expect(context.published).toHaveLength(1)
    expect(context.published[0]?.from).toBe('lead-one')
    for (const key of ['from', 'seat', 'tainted', 'chain']) {
      const result = await tool.handler({ ...good, [key]: 'someone-else' })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('invalid input')
    }
    expect(context.published).toHaveLength(1)
  })
})

describe('mailbox_send (b) destination and send_to', () => {
  it('sends only to the named destination, once', async () => {
    const context = makeContext()
    await createSendTool(context).handler({ ...good, to: 'sam' })
    expect(context.published.map(message => message.to)).toEqual(['sam'])
  })

  it('refuses a destination outside send_to and says how to see the list', async () => {
    const context = makeContext()
    const result = await createSendTool(context).handler({ ...good, to: 'stranger' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('stranger is not in this seat\'s send_to list')
    expect(context.published).toHaveLength(0)
  })

  it('refuses every send when send_to is empty, naming the stanza key', async () => {
    const context = makeContext({ sendTo: [] })
    const result = await createSendTool(context).handler(good)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('key send_to')
    expect(context.published).toHaveLength(0)
  })
})

describe('mailbox_send (c) replyToTraceId is a label, never a route', () => {
  it('accepts a delivered trace id, copies it as the trace id and still routes to `to`', async () => {
    const context = makeContext()
    const result = await createSendTool(context).handler({ ...good, to: 'sam', replyToTraceId: 'trace-1' })
    expect(result.isError).toBeUndefined()
    expect(context.published[0]).toMatchObject({ to: 'sam', traceId: 'trace-1' })
  })

  it('refuses a trace id the driver did not report as delivered', async () => {
    const context = makeContext()
    const result = await createSendTool(context).handler({ ...good, replyToTraceId: 'trace-unknown' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not the trace id of a message delivered')
    expect(context.published).toHaveLength(0)
  })

  it('tells the seat to reply without a trace id when no delivered mail carried one', async () => {
    const context = makeContext({ deliveredTraceIds: () => new Set() })
    const result = await createSendTool(context).handler({ ...good, replyToTraceId: 'trace-1' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('mailbox_send refused: the incoming mail carried no trace id; reply without one')
    expect(context.published).toHaveLength(0)
  })

  it('keeps the original refusal text when delivered ids exist but the id is not among them', async () => {
    const context = makeContext()
    const result = await createSendTool(context).handler({ ...good, replyToTraceId: 'trace-unknown' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('mailbox_send refused: replyToTraceId is not the trace id of a message delivered to this seat')
    expect(context.published).toHaveLength(0)
  })

  it('still sends when no replyToTraceId is given and the delivered set is empty', async () => {
    const context = makeContext({ deliveredTraceIds: () => new Set() })
    const result = await createSendTool(context).handler(good)
    expect(result.isError).toBeUndefined()
    expect(context.published).toHaveLength(1)
  })

  it('mints a fresh trace id for an ordinary send', async () => {
    const context = makeContext()
    await createSendTool(context).handler(good)
    expect(context.published[0]?.traceId).toBe('fresh-trace')
  })
})

describe('mailbox_send (d) blocking', () => {
  it('refuses blocking without allow_blocking and publishes nothing', async () => {
    const context = makeContext()
    const result = await createSendTool(context).handler({ ...good, blocking: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('allow_blocking')
    expect(context.published).toHaveLength(0)
  })

  it('allows blocking when the stanza allows it, and blocking:false always', async () => {
    const allowed = makeContext({ allowBlocking: true })
    await createSendTool(allowed).handler({ ...good, blocking: true })
    expect(allowed.published[0]?.blocking).toBe(true)
    const plain = makeContext()
    await createSendTool(plain).handler({ ...good, blocking: false })
    expect(plain.published[0]?.blocking).toBe(false)
  })
})

describe('mailbox_send (e) taint stamping labels, it never denies', () => {
  it('a tainted session stamps tainted:true and no self-hop in chain, and the send still goes', async () => {
    const context = makeContext({ isTainted: () => true })
    const result = await createSendTool(context).handler(good)
    expect(result.isError).toBeUndefined()
    expect(context.published[0]).toMatchObject({ tainted: true, from: 'lead-one' })
    expect(context.published[0]).not.toHaveProperty('chain')
  })

  it('an untainted session asserts nothing (absent means not asserted, never clean)', async () => {
    const context = makeContext()
    await createSendTool(context).handler(good)
    expect(context.published[0]).not.toHaveProperty('tainted')
    expect(context.published[0]).not.toHaveProperty('chain')
  })

  it('reads the taint at call time, not at construction', async () => {
    let tainted = false
    const context = makeContext({ isTainted: () => tainted })
    const tool = createSendTool(context)
    await tool.handler(good)
    tainted = true
    await tool.handler(good)
    expect(context.published.map(message => message.tainted)).toEqual([undefined, true])
  })
})

describe('mailbox_send (f) the real mailbox publish validation', () => {
  let dir = ''
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('stores the message with its provenance in a real SQLite mailbox', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cct-mbx-'))
    const store = new SqliteMailboxStore(openMailboxDatabase(join(dir, 'mailbox.db')))
    const context = makeContext({ isTainted: () => true, publish: input => store.publish(input) })
    const result = await createSendTool(context).handler(good)
    expect(result.isError).toBeUndefined()
    const [lease] = await store.claim({ addresses: ['ops-lead' as never], limit: 5, staleClaimMs: 60_000 })
    expect(lease?.message).toMatchObject({ to: 'ops-lead', from: 'lead-one', payload: 'status?', tainted: true, traceId: 'fresh-trace' })
    expect(lease?.message.chain).toBeUndefined()
  })

  it('stores a reply under the delivered trace id and the store accepts it (shared trace ids are allowed)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cct-mbx-'))
    const store = new SqliteMailboxStore(openMailboxDatabase(join(dir, 'mailbox.db')))
    await store.publish({ to: 'lead-one' as never, from: 'ops-lead', payload: 'question?', traceId: 'trace-1' })
    const context = makeContext({ publish: input => store.publish(input) })
    const result = await createSendTool(context).handler({ ...good, replyToTraceId: 'trace-1' })
    expect(result.isError).toBeUndefined()
    const [lease] = await store.claim({ addresses: ['ops-lead' as never], limit: 5, staleClaimMs: 60_000 })
    expect(lease?.message).toMatchObject({ to: 'ops-lead', from: 'lead-one', traceId: 'trace-1' })
    // both rows share the id: the store keeps one row per message, not one per trace id.
    expect((await store.lookupByTraceId('trace-1')).map(entry => entry.from).sort()).toEqual(['lead-one', 'ops-lead'])
  })

  it('surfaces a publish rejection as an error result, not a throw', async () => {
    const context = makeContext({ publish: () => Promise.reject(new Error('mailbox publish: boom')) })
    const result = await createSendTool(context).handler(good)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('mailbox_send refused: the mailbox rejected the message')
    expect(textOf(result)).not.toContain('boom')
    expect(context.warnings).toEqual(['agent-claude-code-tools: seat "lead-one": mailbox_send publish failed: Error: mailbox publish: boom'])
  })
})

describe('mailbox_send (g) the result text', () => {
  it('is short and names only the seat it was sent to', async () => {
    const context = makeContext()
    const text = textOf(await createSendTool(context).handler({ ...good, to: 'sam' }))
    expect(text).toBe('Sent to sam. Trace id fresh-trace.')
    expect(text).not.toContain('ops-lead')
    expect(text.length).toBeLessThan(120)
  })

  it('scrubs what it says', async () => {
    const scrub = vi.fn((text: string) => text.toUpperCase())
    const text = textOf(await createSendTool(makeContext({ scrub })).handler(good))
    expect(scrub).toHaveBeenCalled()
    expect(text).toBe('SENT TO OPS-LEAD. TRACE ID FRESH-TRACE.')
  })
})

describe('mailbox_send per-turn cap', () => {
  it('sends up to the cap and refuses the next naming it; a new closure starts again', async () => {
    const context = makeContext()
    const tool = createSendTool(context)
    for (let sent = 0; sent < MAX_SENDS_PER_TURN; sent += 1) {
      expect((await tool.handler(good)).isError).toBeUndefined()
    }
    expect(MAX_SENDS_PER_TURN).toBe(20)
    const refused = await tool.handler(good)
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('20 messages')
    expect(context.published).toHaveLength(MAX_SENDS_PER_TURN)
    expect((await createSendTool(context).handler(good)).isError).toBeUndefined()
  })

  it('does not count refused sends', async () => {
    const context = makeContext()
    const tool = createSendTool(context)
    for (let attempt = 0; attempt < 25; attempt += 1) await tool.handler({ ...good, to: 'stranger' })
    expect((await tool.handler(good)).isError).toBeUndefined()
  })
})

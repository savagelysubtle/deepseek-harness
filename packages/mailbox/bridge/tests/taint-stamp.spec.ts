/**
 * Additive-only provenance stamping in `relaySource`: taint can be set by a
 * hop, never cleared, and a message that carries neither provenance field
 * from a seat sender produces the exact source it did before the fields
 * existed.
 */

import { describe, expect, it } from 'vitest'
import { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import type { MailboxMessage, MailboxMessageId } from '@deepseek-ai/dsh-mailbox'
import { relaySource } from '../src/index.ts'

const TARGET = formatMailboxAddress('target')

function lease(extra: Partial<MailboxMessage> = {}) {
  const message: MailboxMessage = { id: 'm-1' as MailboxMessageId, to: TARGET, from: 'alice', sentAt: 1, ...extra }
  return { message, leaseRef: 'r' as never, claimedAt: 2 }
}

describe('relaySource provenance stamping', () => {
  it('seat sender with no assertion stays absent (differential: exact pre-change source)', () => {
    expect(relaySource(lease(), 'seat')).toStrictEqual({
      kind: 'mailbox', form: 'relay', address: TARGET, from: 'alice', messageId: 'm-1', senderClass: 'seat',
    })
  })

  it('stamps nothing extra on the other optional fields either', () => {
    const source = relaySource(lease({ subject: 's', blocking: true, traceId: 't' }), 'seat')
    expect(Object.keys(source).sort()).toEqual(['address', 'blocking', 'form', 'from', 'kind', 'messageId', 'senderClass', 'subject', 'traceId'])
  })

  it('an unverified sender asserts taint and starts the chain', () => {
    expect(relaySource(lease(), 'unverified')).toMatchObject({ tainted: true, chain: ['alice'] })
  })

  it('a forged tainted:false or empty chain from an unverified sender still reads tainted', () => {
    expect(relaySource(lease({ tainted: false, chain: [] }), 'unverified')).toMatchObject({ tainted: true, chain: ['alice'] })
  })

  it('incoming taint stays true through a seat hop and the chain grows by one', () => {
    expect(relaySource(lease({ tainted: true, chain: ['x', 'y'] }), 'seat')).toMatchObject({ tainted: true, chain: ['x', 'y', 'alice'] })
  })

  it('a seat-asserted clean message stays false, never upgraded or cleared', () => {
    expect(relaySource(lease({ tainted: false }), 'seat')).toMatchObject({ tainted: false, chain: ['alice'] })
  })

  it('an incoming chain alone grows by this hop without inventing a taint verdict', () => {
    const source = relaySource(lease({ chain: ['x'] }), 'seat')
    expect(source).toMatchObject({ chain: ['x', 'alice'] })
    expect('tainted' in source).toBe(false)
  })

  it('a chain-only message from an unverified sender asserts taint and grows the chain', () => {
    expect(relaySource(lease({ chain: ['x'] }), 'unverified')).toMatchObject({ tainted: true, chain: ['x', 'alice'] })
  })

  it('does not mutate the incoming chain', () => {
    const incoming = ['x'] as const
    relaySource(lease({ chain: incoming }), 'seat')
    expect(incoming).toEqual(['x'])
  })
})

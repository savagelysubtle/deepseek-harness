import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  defaultAdmission, externalHops, frameMailText, isTaintedMail, mailboxMessageId, MAIL_FRAME_FOOTER, MAIL_FRAME_HEADER,
} from '../src/admission.ts'
import { mailMessage, userMessage } from './fakes.ts'

const withSource = (source: unknown): UserMessage => ({ ...userMessage('x'), source } as unknown as UserMessage)

describe('mailboxMessageId', () => {
  it('reads the id of mailbox mail only', () => {
    expect(mailboxMessageId(mailMessage('hi', 'm-1'))).toBe('m-1')
    expect(mailboxMessageId(userMessage('hi'))).toBeUndefined()
    expect(mailboxMessageId(withSource({ kind: 'mailbox', messageId: '' }))).toBeUndefined()
    expect(mailboxMessageId(withSource({ kind: 'mailbox', messageId: 7 }))).toBeUndefined()
    expect(mailboxMessageId(withSource(null))).toBeUndefined()
  })
})

describe('external hops and taint', () => {
  it('treats seat-only mail and mail without chain metadata as clean', () => {
    expect(externalHops(mailMessage('hi', 'm'))).toEqual([])
    expect(externalHops(withSource({ kind: 'mailbox', messageId: 'm' }))).toEqual([])
    expect(externalHops(userMessage('typed'))).toEqual([])
    expect(isTaintedMail(mailMessage('hi', 'm'))).toBe(false)
  })

  it('counts an unverified sender and every non-seat hop of the chain as external', () => {
    expect(externalHops(mailMessage('x', 'm', { senderClass: 'unverified' }))).toEqual(['unverified'])
    expect(externalHops(mailMessage('x', 'm', { chain: ['seat', 'portal', { class: 'stripe' }, { class: 'twilio' }, 'web-form'] })))
      .toEqual(['portal', 'stripe', 'twilio', 'web-form'])
    expect(externalHops(mailMessage('x', 'm', { chain: [{ class: 'seat' }, {}, 7, '  '] }))).toEqual(['unknown', 'unknown', 'unknown'])
    expect(externalHops(mailMessage('x', 'm', { senderClass: 5 }))).toEqual(['unknown'])
    expect(externalHops(mailMessage('x', 'm', { chain: 'portal' }))).toEqual(['unknown'])
    expect(externalHops(mailMessage('x', 'm', { chain: [{ class: 'a'.repeat(200) }] }))[0]).toHaveLength(60)
  })

  it('cuts a very long chain and treats the cut as one more unknown hop', () => {
    const chain = Array.from({ length: 40 }, () => 'portal')
    const hops = externalHops(mailMessage('x', 'm', { chain }))
    expect(hops).toHaveLength(33)
    expect(hops.at(-1)).toBe('unknown')
  })

  it('marks mail tainted by an explicit flag or by any external hop', () => {
    expect(isTaintedMail(mailMessage('x', 'm', { tainted: true }))).toBe(true)
    expect(isTaintedMail(mailMessage('x', 'm', { chain: ['portal'] }))).toBe(true)
    expect(isTaintedMail(mailMessage('x', 'm', { tainted: false }))).toBe(false)
  })

  it('survives a source whose properties throw', () => {
    const hostile = withSource({
      get kind(): never { throw new Error('boom') },
      get chain(): never { throw new Error('boom') },
    })
    expect(mailboxMessageId(hostile)).toBeUndefined()
    expect(externalHops(hostile)).toEqual([])
  })
})

describe('defaultAdmission', () => {
  const base = { seat: 's', path: 'send' as const, tainted: false, turnTainted: false }

  it('allows mail with no external hop and denies any external hop naming the classes', () => {
    expect(defaultAdmission({ ...base, externalHops: [] })).toEqual({ allow: true })
    const denied = defaultAdmission({ ...base, externalHops: ['portal', 'twilio'] })
    expect(denied).toMatchObject({ allow: false })
    expect((denied as { reason: string }).reason).toContain('portal, twilio')
  })
})

describe('frameMailText', () => {
  it('wraps the body between the fixed header and footer', () => {
    expect(frameMailText('hello')).toBe(`${MAIL_FRAME_HEADER}\nhello\n${MAIL_FRAME_FOOTER}`)
  })

  it.each(['/model opus', '/clear', '/compact', '/anything-else now', '/'])('never lets %j begin the prompt', (body) => {
    const prompt = frameMailText(body)
    expect(prompt.startsWith('/')).toBe(false)
    expect(prompt.startsWith(MAIL_FRAME_HEADER)).toBe(true)
    expect(prompt).toContain(`\n${body}\n`)
  })
})

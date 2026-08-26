/** Address grammar: round-trips, rejections, and segment rules. */

import { describe, expect, it } from 'vitest'
import {
  formatMailboxAddress,
  MAILBOX_SEGMENT_PATTERN_SOURCE,
  parseMailboxAddress,
} from '../src/address.ts'

describe('mailbox address grammar', () => {
  it('round-trips a formatted address through parse', () => {
    const address = formatMailboxAddress('web-designs', 'operations')
    expect(parseMailboxAddress(address)).toBe(address)
  })

  it('parses a valid raw address into its segments', () => {
    expect(parseMailboxAddress('ceo-web:operations')).toBe('ceo-web:operations')
    expect(parseMailboxAddress('a.1_b:x-y-name')).toBe('a.1_b:x-y-name')
  })

  it.each([
    ['', 'missing separator'],
    ['nonamespace', 'expected "<namespace>:<name>"'],
    [':leading', 'invalid mailbox namespace'],
    ['trailing:', 'invalid mailbox name'],
    ['has space:name', 'invalid mailbox namespace'],
    ['ns:sl/ash', 'invalid mailbox name'],
    ['ns:double:colon', 'invalid mailbox name'],
    [`ns:${'x'.repeat(65)}`, 'invalid mailbox name'],
    [`${'x'.repeat(65)}:name`, 'invalid mailbox namespace'],
  ])('rejects %j loudly', (raw) => {
    expect(() => parseMailboxAddress(raw)).toThrow()
  })

  it('keeps the documented segment grammar in sync with the session-name grammar', () => {
    // Both halves reuse the named-session vocabulary so bridge-side id
    // derivation needs no second encoding; this pins the coupling.
    expect(MAILBOX_SEGMENT_PATTERN_SOURCE).toBe('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  })
})

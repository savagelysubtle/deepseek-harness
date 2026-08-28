/** Address grammar: round-trips, rejections, and the seat-name coupling. */

import { describe, expect, it } from 'vitest'
import {
  formatMailboxAddress,
  MAILBOX_SEGMENT_PATTERN_SOURCE,
  parseMailboxAddress,
} from '../src/address.ts'

describe('mailbox address grammar', () => {
  it('round-trips a formatted address through parse', () => {
    const address = formatMailboxAddress('operations')
    expect(parseMailboxAddress(address)).toBe(address)
  })

  it('accepts bare seat names', () => {
    expect(parseMailboxAddress('batman')).toBe('batman')
    expect(parseMailboxAddress('a.1_b')).toBe('a.1_b')
  })

  it.each([
    ['', 'must match'],
    ['has space', 'must match'],
    ['sl/ash', 'must match'],
    ['double:colon', 'must match'],
    ['batman:alfred', 'must match'],
    [`${'x'.repeat(65)}`, 'must match'],
  ])('rejects %j loudly', (raw) => {
    expect(() => parseMailboxAddress(raw)).toThrow()
  })

  it('keeps the address grammar identical to the session-name grammar', () => {
    // One name names one seat across the deployment, so a derived session id
    // can be computed from an address with no second encoding.
    expect(MAILBOX_SEGMENT_PATTERN_SOURCE).toBe('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  })
})

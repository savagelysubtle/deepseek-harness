/**
 * Seat driver pure module: driver key, log classifier, mail admission, and
 * the row hash. No filesystem; nothing here reads ~/.dsh.
 */

import { describe, expect, it } from 'vitest'
import {
  admitsMail,
  DEFAULT_SEAT_DRIVER,
  recordedSeatDriver,
  SEAT_DRIVER_KEYS,
  seatDriverKey,
  seatRoutingProjection,
  seatRowHash,
} from '../src/index.ts'
import type { OrgRegistrySeat, SeatBinding } from '../src/index.ts'

const ev = (...types: string[]): { type: string }[] => types.map(type => ({ type }))

describe('seatDriverKey', () => {
  it('defaults to the in-process loop and reads an explicit driver', () => {
    expect(SEAT_DRIVER_KEYS).toEqual(['default', 'claude-code'])
    expect(DEFAULT_SEAT_DRIVER).toBe('default')
    expect(seatDriverKey({})).toBe('default')
    expect(seatDriverKey({ driver: 'default' })).toBe('default')
    expect(seatDriverKey({ driver: 'claude-code' })).toBe('claude-code')
  })
})

describe('recordedSeatDriver', () => {
  it('reads claude-code/session-bound as claude-code', () => {
    expect(recordedSeatDriver(ev('user/message', 'claude-code/session-bound', 'assistant/message'))).toBe('claude-code')
    expect(recordedSeatDriver(ev('claude-code/session-bound'))).toBe('claude-code')
  })

  it('reads request/header with no session-bound as default', () => {
    expect(recordedSeatDriver(ev('request/header', 'user/message'))).toBe('default')
  })

  it('reads assistant/message with no session-bound as default', () => {
    expect(recordedSeatDriver(ev('user/message', 'assistant/message'))).toBe('default')
  })

  it('makes no claim about a log nobody answered', () => {
    expect(recordedSeatDriver(ev('user/message', 'user/message'))).toBeUndefined()
    expect(recordedSeatDriver([])).toBeUndefined()
  })

  it('reads session-bound plus request/header as mixed, in either order', () => {
    expect(recordedSeatDriver(ev('request/header', 'claude-code/session-bound'))).toBe('mixed')
    expect(recordedSeatDriver(ev('claude-code/session-bound', 'request/header'))).toBe('mixed')
  })

  it('ignores a spoofed <other>/session-bound', () => {
    expect(recordedSeatDriver(ev('foo/session-bound'))).toBeUndefined()
    expect(recordedSeatDriver(ev('foo/session-bound', 'request/header'))).toBe('default')
    expect(recordedSeatDriver(ev('codex/session-bound', 'assistant/message'))).toBe('default')
  })

  it('accepts any iterable', () => {
    expect(recordedSeatDriver(new Set(ev('claude-code/session-bound')))).toBe('claude-code')
    expect(recordedSeatDriver((function* () { yield { type: 'request/header' } })())).toBe('default')
  })
})

describe('admitsMail', () => {
  const row = { admit_from: ['alfred'], admit_sender_classes: ['seat'] } as const

  it('admits nobody by default', () => {
    for (const bare of [{}, { admit_from: [] }, { admit_sender_classes: ['seat'] as const }]) {
      const verdict = admitsMail(bare, { from: 'alfred', classes: ['seat'] })
      expect(verdict.allow).toBe(false)
      if (!verdict.allow) expect(verdict.reason).toContain('admit_from')
    }
    const empty = admitsMail({ admit_from: [] }, { from: 'alfred', classes: ['seat'] })
    expect(empty.allow).toBe(false)
    expect('reason' in empty ? empty.reason : '').toContain('admits nobody')
  })

  it('denies a listed sender whose class is not listed, naming the class', () => {
    const verdict = admitsMail({ admit_from: ['alfred'] }, { from: 'alfred', classes: ['seat'] })
    expect(verdict).toEqual({ allow: false, reason: 'sender class "seat" is not in admit_sender_classes' })
    const other = admitsMail(row, { from: 'alfred', classes: ['seat', 'unverified'] })
    expect(other).toEqual({ allow: false, reason: 'sender class "unverified" is not in admit_sender_classes' })
  })

  it('denies an unlisted sender, naming the sender', () => {
    expect(admitsMail(row, { from: 'mallory', classes: ['seat'] })).toEqual({
      allow: false, reason: 'sender "mallory" is not in admit_from',
    })
  })

  it('fails closed on an empty classes array, naming it', () => {
    expect(admitsMail(row, { from: 'alfred', classes: [] })).toEqual({ allow: false, reason: 'no sender class supplied' })
    // An unlisted sender is still refused for the sender first.
    expect(admitsMail(row, { from: 'mallory', classes: [] })).toEqual({
      allow: false, reason: 'sender "mallory" is not in admit_from',
    })
  })

  it('allows a listed sender with every class listed', () => {
    expect(admitsMail(row, { from: 'alfred', classes: ['seat'] })).toEqual({ allow: true })
    expect(admitsMail({ admit_from: ['a'], admit_sender_classes: ['seat', 'unverified'] }, { from: 'a', classes: ['seat', 'unverified'] }))
      .toEqual({ allow: true })
  })
})

describe('seatRowHash', () => {
  const base: OrgRegistrySeat = {
    cwd: '/work/claudie',
    sessionId: 'named-claudie',
    test: true,
    driver: 'claude-code',
    admit_from: ['alfred', 'batman'],
    admit_sender_classes: ['seat', 'unverified'],
    tools: { allow: ['read', 'grep'], deny: ['bash'] },
  }

  it('is a sha256 hex digest and deterministic', () => {
    expect(seatRowHash(base)).toMatch(/^[0-9a-f]{64}$/)
    expect(seatRowHash(base)).toBe(seatRowHash({ ...base }))
  })

  it('is stable across object key order and list order', () => {
    const shuffled: OrgRegistrySeat = {
      tools: { deny: ['bash'], allow: ['grep', 'read'] },
      admit_sender_classes: ['unverified', 'seat'],
      admit_from: ['batman', 'alfred'],
      driver: 'claude-code',
      test: true,
      sessionId: 'named-claudie',
      cwd: '/work/claudie',
    }
    expect(seatRowHash(shuffled)).toBe(seatRowHash(base))
  })

  it('ignores fields outside the security projection', () => {
    expect(seatRowHash({ ...base, department: 'ops', lead: true, invalid: 'ignored' })).toBe(seatRowHash(base))
  })

  it('treats an absent driver as the default driver', () => {
    const { driver: _driver, ...bare } = base
    expect(seatRowHash({ ...bare, driver: 'default' })).toBe(seatRowHash(bare))
  })

  it.each<[string, OrgRegistrySeat]>([
    ['driver', { ...base, driver: 'default' }],
    ['sessionId', { ...base, sessionId: 'named-other' }],
    ['cwd', { ...base, cwd: '/work/elsewhere' }],
    ['admit_from', { ...base, admit_from: ['alfred'] }],
    ['admit_sender_classes', { ...base, admit_sender_classes: ['seat'] }],
    ['test', { ...base, test: false }],
    ['tools.allow', { ...base, tools: { allow: ['read'], deny: ['bash'] } }],
    ['tools.deny', { ...base, tools: { allow: ['read', 'grep'], deny: ['write'] } }],
    ['tools presence', (({ tools: _tools, ...rest }) => rest)(base)],
  ])('changes when %s changes', (_field, changed) => {
    expect(seatRowHash(changed)).not.toBe(seatRowHash(base))
  })

  it('distinguishes allow from deny with the same names', () => {
    expect(seatRowHash({ ...base, tools: { allow: ['x'] } })).not.toBe(seatRowHash({ ...base, tools: { deny: ['x'] } }))
  })

  it('projects absent values explicitly and sorts lists', () => {
    expect(seatRoutingProjection({ cwd: 'c' })).toEqual({
      driver: 'default', sessionId: null, cwd: 'c', admit_from: [], admit_sender_classes: [], test: null, tools: null,
    })
    expect(seatRoutingProjection(base).admit_from).toEqual(['alfred', 'batman'])
  })
})

describe('SeatBinding', () => {
  it('pairs the seat, the row hash and the frozen row', () => {
    const row: OrgRegistrySeat = { cwd: 'c', driver: 'claude-code', admit_from: ['a'] }
    const binding: SeatBinding = { seat: 'claudie', rowHash: seatRowHash(row), row }
    expect(binding.rowHash).toBe(seatRowHash(binding.row))
  })
})

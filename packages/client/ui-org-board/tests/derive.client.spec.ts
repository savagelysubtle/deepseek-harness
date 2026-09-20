/**
 * Pure data-shaping coverage: the drift split, the roster-label helpers, and
 * seat badge derivation. No React, no store — every branch is reachable by
 * plain function calls.
 */
import { describe, expect, it } from 'vitest'
import type { OrgDriftResult, OrgDriftRow, OrgRegistryView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  driftLists, missingRosterLabels, seatBadges, seatNamesOf, seatServedStatus, servedRosterLabels, unservedByName,
  type SeatServedStatus,
} from '../src/client/derive.ts'

/** Minimal mustache-style interpolation, matching the real dictionary's `{name}` templating. */
function t(key: string, params?: Record<string, unknown>): string {
  if (params === undefined) return key
  const entries = Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')
  return `${key}(${entries})`
}

const ROW_UNSERVED_BOTH: OrgDriftRow = {
  seat: 'batman', registered: true, servedByMailboxBridge: false, servedByToolMailbox: false,
}
const ROW_UNSERVED_ONE: OrgDriftRow = {
  seat: 'robin', registered: true, servedByMailboxBridge: true, servedByToolMailbox: false,
}
const ROW_UNREGISTERED: OrgDriftRow = {
  seat: 'ghost', registered: false, servedByMailboxBridge: true, servedByToolMailbox: true,
}

describe('driftLists', () => {
  it('returns undefined for a failed drift report', () => {
    const failed: OrgDriftResult = { ok: false, reason: 'registry unreadable' }
    expect(driftLists(failed)).toBeUndefined()
  })

  it('splits a successful report into registered (unserved) vs. not-registered (unregistered)', () => {
    const ok: OrgDriftResult = { ok: true, rows: [ROW_UNSERVED_BOTH, ROW_UNSERVED_ONE, ROW_UNREGISTERED] }
    const lists = driftLists(ok)
    expect(lists?.unserved).toEqual([ROW_UNSERVED_BOTH, ROW_UNSERVED_ONE])
    expect(lists?.unregistered).toEqual([ROW_UNREGISTERED])
  })

  it('splits an empty (clean) report into two empty lists', () => {
    const ok: OrgDriftResult = { ok: true, rows: [] }
    expect(driftLists(ok)).toEqual({ unserved: [], unregistered: [] })
  })
})

describe('missingRosterLabels', () => {
  it('names both rosters when neither serves the seat', () => {
    expect(missingRosterLabels(ROW_UNSERVED_BOTH, t)).toEqual(['roster.mailboxBridge', 'roster.toolMailbox'])
  })

  it('names only the roster that does not serve the seat', () => {
    expect(missingRosterLabels(ROW_UNSERVED_ONE, t)).toEqual(['roster.toolMailbox'])
  })
})

describe('servedRosterLabels', () => {
  it('names every roster that does serve the address', () => {
    expect(servedRosterLabels(ROW_UNREGISTERED, t)).toEqual(['roster.mailboxBridge', 'roster.toolMailbox'])
  })

  it('names nothing when no roster serves it (unreachable in real drift rows, still a valid input)', () => {
    const none: OrgDriftRow = { seat: 'x', registered: false, servedByMailboxBridge: false, servedByToolMailbox: false }
    expect(servedRosterLabels(none, t)).toEqual([])
  })
})

describe('unservedByName', () => {
  it('indexes rows by seat name', () => {
    const map = unservedByName([ROW_UNSERVED_BOTH, ROW_UNSERVED_ONE])
    expect(map.get('batman')).toBe(ROW_UNSERVED_BOTH)
    expect(map.get('robin')).toBe(ROW_UNSERVED_ONE)
    expect(map.get('nobody')).toBeUndefined()
  })

  it('is empty when given undefined (drift unavailable)', () => {
    expect(unservedByName(undefined).size).toBe(0)
  })
})

describe('seatNamesOf', () => {
  it('returns registry seat keys in declaration order', () => {
    const registry: OrgRegistryView = {
      baseDir: '/org',
      seats: { batman: { cwd: '/org/a' }, alfred: { cwd: '/org/b' } },
      edges: [],
      callUp: [],
    }
    expect(seatNamesOf(registry)).toEqual(['batman', 'alfred'])
  })
})

describe('seatBadges', () => {
  it('emits no badges for a plain, fully-served, non-call-up seat', () => {
    expect(seatBadges('robin', { cwd: '/x' }, [], undefined, t)).toEqual([])
  })

  it('emits every badge when every condition holds, in a fixed order', () => {
    const badges = seatBadges('alfred', { cwd: '/x', lead: true, test: true }, ['alfred'], ROW_UNSERVED_BOTH, t)
    expect(badges.map(b => b.kind)).toEqual(['lead', 'test', 'unserved', 'callUp'])
  })

  it('emits only the lead badge when only lead is set', () => {
    const badges = seatBadges('alfred', { cwd: '/x', lead: true }, [], undefined, t)
    expect(badges).toEqual([{ kind: 'lead', label: t('badge.lead') }])
  })

  it('emits only the test badge when only test is set', () => {
    const badges = seatBadges('batman', { cwd: '/x', test: true }, [], undefined, t)
    expect(badges).toEqual([{ kind: 'test', label: t('badge.test') }])
  })

  it('emits only the call-up badge when only call-up membership holds', () => {
    const badges = seatBadges('robin', { cwd: '/x' }, ['robin'], undefined, t)
    expect(badges).toEqual([{ kind: 'callUp', label: t('badge.callUp') }])
  })
})

describe('seatServedStatus', () => {
  const cases: readonly [string, OrgDriftRow | undefined, SeatServedStatus][] = [
    ['no row at all: both rosters already serve it', undefined, 'served'],
    ['a row whose two served booleans agree (both false): served by neither', ROW_UNSERVED_BOTH, 'unserved'],
    ['a row whose two served booleans disagree: served by exactly one', ROW_UNSERVED_ONE, 'split'],
  ]

  it.each(cases)('%s -> %s', (_description, row, expected) => {
    expect(seatServedStatus(row)).toBe(expected)
  })

  it('disagreeing in the other direction (mailbox-bridge only) is still split, not order-dependent', () => {
    const row: OrgDriftRow = {
      seat: 'ghost', registered: true, servedByMailboxBridge: true, servedByToolMailbox: false,
    }
    expect(seatServedStatus(row)).toBe('split')
  })
})

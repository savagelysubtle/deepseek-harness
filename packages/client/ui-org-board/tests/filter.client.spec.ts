/** The toolbar filter's matcher: name substring plus the lead / test / unserved flag words. */
import { describe, expect, it } from 'vitest'
import { seatMatchesFilter, type SeatFlags } from '../src/client/filter.ts'

const NONE: SeatFlags = { lead: false, test: false, unserved: false }

describe('seatMatchesFilter', () => {
  it('matches everything for an empty or whitespace-only query', () => {
    expect(seatMatchesFilter('alfred', NONE, '')).toBe(true)
    expect(seatMatchesFilter('alfred', NONE, '   ')).toBe(true)
  })

  it('matches a case-insensitive substring of the name', () => {
    expect(seatMatchesFilter('Ms-Pepper-Potts', NONE, 'pepper')).toBe(true)
    expect(seatMatchesFilter('alfred', NONE, '  FRE ')).toBe(true)
    expect(seatMatchesFilter('alfred', NONE, 'robin')).toBe(false)
  })

  it('matches the word lead only for a lead seat', () => {
    expect(seatMatchesFilter('x', { ...NONE, lead: true }, 'lead')).toBe(true)
    expect(seatMatchesFilter('x', NONE, 'lead')).toBe(false)
  })

  it('matches the word test only for a test seat', () => {
    expect(seatMatchesFilter('x', { ...NONE, test: true }, 'Test')).toBe(true)
    expect(seatMatchesFilter('x', NONE, 'test')).toBe(false)
  })

  it('matches the word unserved only for an unserved seat', () => {
    expect(seatMatchesFilter('x', { ...NONE, unserved: true }, 'unserved')).toBe(true)
    expect(seatMatchesFilter('x', NONE, 'unserved')).toBe(false)
  })

  it('a flag word does not match a seat that carries a different flag', () => {
    expect(seatMatchesFilter('x', { ...NONE, lead: true }, 'test')).toBe(false)
    expect(seatMatchesFilter('x', { ...NONE, test: true }, 'unserved')).toBe(false)
  })
})

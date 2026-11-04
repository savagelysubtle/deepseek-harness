/**
 * The verifying seat source: it opens a seat only on a row the bridge bound and still holds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { seatRowHash } from '@deepseek-ai/dsh-mailbox'
import { createSeatSource } from '../src/index.ts'
import { binding, cleanTempDirs, fakeRows, row, world } from './helpers.ts'

afterEach(() => {
  vi.restoreAllMocks()
  cleanTempDirs()
})

const request = (seatBinding: ReturnType<typeof binding> | undefined) => ({ sessionId: SessionId('named-ops'), hint: undefined, binding: seatBinding })

describe('claudeCodeSeatSource.resolve', () => {
  it('resolves a binding that matches the bridge\'s current row', () => {
    const w = world()
    const rows = fakeRows({ ops: row(w) })
    const source = createSeatSource(() => rows)
    const bound = binding('ops', row(w))
    expect(source.resolve(request(bound))).toEqual({ seat: 'ops', row: bound.row })
  })

  it('refuses a stale binding after the registry row changed', () => {
    const w = world()
    const rows = fakeRows({ ops: row(w) })
    const source = createSeatSource(() => rows)
    const bound = binding('ops', row(w))
    rows.table['ops'] = row(w, { admit_from: [] })
    expect(() => source.resolve(request(bound))).toThrow(/stale binding/)
  })

  it('refuses a forged binding whose row does not match its own hash', () => {
    const w = world()
    const rows = fakeRows({ ops: row(w) })
    const source = createSeatSource(() => rows)
    const honest = binding('ops', row(w))
    const widened = { ...honest, row: row(w, { admit_from: ['peer', 'web-bot'] }) }
    expect(seatRowHash(widened.row)).not.toBe(widened.rowHash)
    expect(() => source.resolve(request(widened))).toThrow(/forged or corrupted/)
  })

  it('refuses a request that carries no binding, so no other caller can open a Claude Code seat', () => {
    const w = world()
    const source = createSeatSource(() => fakeRows({ ops: row(w) }))
    expect(() => source.resolve(request(undefined))).toThrow(/no seat binding .* opened only by the mailbox bridge/)
  })

  it('refuses when the bridge\'s row service is not mounted', () => {
    const w = world()
    const source = createSeatSource(() => undefined)
    expect(() => source.resolve(request(binding('ops', row(w))))).toThrow(/mailboxSeatRows service is not available/)
  })

  it('refuses a seat the bridge no longer holds a valid row for', () => {
    const w = world()
    const source = createSeatSource(() => fakeRows({}))
    expect(() => source.resolve(request(binding('ghost', row(w))))).toThrow(/seat "ghost" has no current valid registry row/)
  })

  it('refuses a row that selects another driver', () => {
    const w = world()
    const other = row(w, { driver: 'default' })
    const source = createSeatSource(() => fakeRows({ ops: other }))
    expect(() => source.resolve(request(binding('ops', other)))).toThrow(/selects driver "default", not "claude-code"/)
    const bare = { cwd: w.cwd }
    const bareSource = createSeatSource(() => fakeRows({ ops: bare }))
    expect(() => bareSource.resolve(request(binding('ops', bare)))).toThrow(/selects driver "default"/)
  })
})

describe('claudeCodeSeatSource.hasRow', () => {
  it('says whether the bridge currently routes a seat to the driver, and nothing when it cannot tell', () => {
    const w = world()
    const rows = fakeRows({ ops: row(w), plain: row(w, { driver: 'default' }) })
    const source = createSeatSource(() => rows)
    expect(source.hasRow?.('ops')).toBe(true)
    expect(source.hasRow?.('plain')).toBe(false)
    expect(source.hasRow?.('ghost')).toBe(false)
    expect(createSeatSource(() => undefined).hasRow?.('ops')).toBeUndefined()
  })
})

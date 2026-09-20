/**
 * Pure org-registry document editor coverage: every refusal (duplicate seat
 * name, bad seat-name grammar, unknown seat, self-edge, a duplicate edge in
 * EITHER stored direction), removeSeat's edge/callUp cascade, setSeatTools
 * omitting the `tools` key entirely when cleared, and immutability of the
 * input document across every call. No RPC, no React, no store.
 */
import { describe, expect, it } from 'vitest'
import type { OrgRegistryDocument, OrgRegistryDocumentSeat } from '@deepseek-ai/dsh-api-remotes/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addEdge, addSeat, removeEdge, removeSeat, SEAT_NAME_PATTERN, setSeatTools,
} from '../src/client/edit.ts'

/**
 * The seat-name grammar is duplicated into `edit.ts` rather than imported,
 * because the mailbox package reaches for `node:crypto`/`node:fs` and this
 * package runs in a browser. A copy that nothing checks is exactly the defect
 * this board exists to remove, so this reads the source of truth off disk and
 * fails the moment the two stop agreeing. It reads the file rather than
 * importing it so the guard costs this package no dependency at all.
 */
describe('seat-name grammar', () => {
  it('still matches the mailbox address grammar it was copied from', () => {
    const addressSource = readFileSync(
      join(import.meta.dirname, '../../../mailbox/mailbox/src/address.ts'), 'utf8',
    )
    const declared = /MAILBOX_SEGMENT_PATTERN_SOURCE = '([^']+)'/.exec(addressSource)
    if (declared?.[1] === undefined) {
      throw new Error('could not find MAILBOX_SEGMENT_PATTERN_SOURCE in address.ts -- did it move or get renamed?')
    }
    expect(SEAT_NAME_PATTERN.source).toBe(declared[1])
  })
})

/** Look up a seat expected to exist, failing loud (never `!`) when the fixture is wrong. */
function seatOf(doc: OrgRegistryDocument, name: string): OrgRegistryDocumentSeat {
  const seat = doc.seats[name]
  if (seat === undefined) throw new Error(`expected seat ${name} to exist`)
  return seat
}

/** A small document with a pre-existing edge and callUp entry to cascade over. */
function baseDocument(): OrgRegistryDocument {
  return {
    baseDir: '/org',
    seats: {
      alfred: { cwd: '/org/alfred', lead: true },
      batman: { cwd: '/org/batman' },
      robin: { cwd: '/org/robin', tools: { allow: ['read'] } },
    },
    edges: [['alfred', 'batman'], ['batman', 'robin']],
    callUp: ['alfred'],
  }
}

describe('addSeat', () => {
  it('adds a new seat with exactly the given cwd', () => {
    const doc = baseDocument()
    const outcome = addSeat(doc, 'lucius', '/org/lucius')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.document.seats.lucius).toEqual({ cwd: '/org/lucius' })
    // Every other seat is carried over untouched.
    expect(outcome.document.seats.alfred).toEqual(doc.seats.alfred)
    expect(outcome.document.edges).toBe(doc.edges)
    expect(outcome.document.callUp).toBe(doc.callUp)
  })

  it('refuses a name that already exists', () => {
    const doc = baseDocument()
    const outcome = addSeat(doc, 'alfred', '/org/other')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected refusal')
    expect(outcome.reason).toContain('alfred')
  })

  it('refuses a name failing the seat-name (mailbox address) pattern', () => {
    const doc = baseDocument()
    const outcome = addSeat(doc, 'not a valid name!', '/org/x')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected refusal')
    expect(outcome.reason).toContain('not a valid name!')
  })

  it('refuses a name starting with a character outside the grammar (leading dot)', () => {
    const doc = baseDocument()
    const outcome = addSeat(doc, '.hidden', '/org/x')
    expect(outcome.ok).toBe(false)
  })

  it('never mutates the input document', () => {
    const doc = baseDocument()
    const before = JSON.parse(JSON.stringify(doc)) as OrgRegistryDocument
    addSeat(doc, 'lucius', '/org/lucius')
    expect(doc).toEqual(before)
  })
})

describe('removeSeat', () => {
  it('refuses an unknown seat', () => {
    const doc = baseDocument()
    const outcome = removeSeat(doc, 'ghost')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected refusal')
    expect(outcome.reason).toContain('ghost')
  })

  it('removes the seat and cascades every edge naming it', () => {
    const doc = baseDocument()
    const outcome = removeSeat(doc, 'batman')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.document.seats.batman).toBeUndefined()
    expect(outcome.document.edges).toEqual([])
    expect(outcome.cascadedEdges).toEqual([['alfred', 'batman'], ['batman', 'robin']])
  })

  it('cascades a removed seat out of callUp, reporting it', () => {
    const doc = baseDocument()
    const outcome = removeSeat(doc, 'alfred')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.document.callUp).toEqual([])
    expect(outcome.cascadedCallUp).toEqual(['alfred'])
    // alfred's one edge (to batman) is cascaded too.
    expect(outcome.cascadedEdges).toEqual([['alfred', 'batman']])
    expect(outcome.document.edges).toEqual([['batman', 'robin']])
  })

  it('reports empty cascade lists for a seat with no edges and no callUp membership', () => {
    const doc = baseDocument()
    const outcome = removeSeat(doc, 'robin')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.cascadedCallUp).toEqual([])
    expect(outcome.cascadedEdges).toEqual([['batman', 'robin']])
  })

  it('never mutates the input document', () => {
    const doc = baseDocument()
    const before = JSON.parse(JSON.stringify(doc)) as OrgRegistryDocument
    removeSeat(doc, 'batman')
    expect(doc).toEqual(before)
  })
})

describe('addEdge', () => {
  it('adds a new undirected edge between two known, distinct seats', () => {
    const doc = baseDocument()
    const outcome = addEdge(doc, 'alfred', 'robin')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.document.edges).toEqual([...doc.edges, ['alfred', 'robin']])
  })

  it('refuses an unknown "from" seat', () => {
    const doc = baseDocument()
    const outcome = addEdge(doc, 'ghost', 'robin')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected refusal')
    expect(outcome.reason).toContain('ghost')
  })

  it('refuses an unknown "to" seat', () => {
    const doc = baseDocument()
    const outcome = addEdge(doc, 'robin', 'ghost')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected refusal')
    expect(outcome.reason).toContain('ghost')
  })

  it('refuses a self-edge', () => {
    const doc = baseDocument()
    const outcome = addEdge(doc, 'robin', 'robin')
    expect(outcome.ok).toBe(false)
  })

  it('refuses a duplicate edge in the SAME stored direction', () => {
    const doc = baseDocument()
    // ['alfred', 'batman'] is already stored.
    const outcome = addEdge(doc, 'alfred', 'batman')
    expect(outcome.ok).toBe(false)
  })

  it('refuses a duplicate edge in the OPPOSITE direction from how it is stored (edges are undirected)', () => {
    const doc = baseDocument()
    // ['alfred', 'batman'] is stored; the reverse pair must also refuse.
    const outcome = addEdge(doc, 'batman', 'alfred')
    expect(outcome.ok).toBe(false)
  })

  it('never mutates the input document', () => {
    const doc = baseDocument()
    const before = JSON.parse(JSON.stringify(doc)) as OrgRegistryDocument
    addEdge(doc, 'alfred', 'robin')
    expect(doc).toEqual(before)
  })
})

describe('removeEdge', () => {
  it('removes an edge stored in exactly the given direction', () => {
    const doc = baseDocument()
    const outcome = removeEdge(doc, 'alfred', 'batman')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.document.edges).toEqual([['batman', 'robin']])
  })

  it('removes an edge stored in the OPPOSITE direction from the call (edges are undirected)', () => {
    const doc = baseDocument()
    // Stored as ['alfred', 'batman']; ask to remove the reverse pair.
    const outcome = removeEdge(doc, 'batman', 'alfred')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.document.edges).toEqual([['batman', 'robin']])
  })

  it('refuses when no edge connects the pair', () => {
    const doc = baseDocument()
    const outcome = removeEdge(doc, 'alfred', 'robin')
    expect(outcome.ok).toBe(false)
  })

  it('never mutates the input document', () => {
    const doc = baseDocument()
    const before = JSON.parse(JSON.stringify(doc)) as OrgRegistryDocument
    removeEdge(doc, 'alfred', 'batman')
    expect(doc).toEqual(before)
  })
})

describe('setSeatTools', () => {
  it('refuses an unknown seat', () => {
    const doc = baseDocument()
    const outcome = setSeatTools(doc, 'ghost', ['read'], undefined)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected refusal')
    expect(outcome.reason).toContain('ghost')
  })

  it('sets a non-empty allow list', () => {
    const doc = baseDocument()
    const outcome = setSeatTools(doc, 'batman', ['read', 'write'], undefined)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(seatOf(outcome.document, 'batman').tools).toEqual({ allow: ['read', 'write'] })
  })

  it('sets a non-empty deny list', () => {
    const doc = baseDocument()
    const outcome = setSeatTools(doc, 'batman', undefined, ['shell'])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(seatOf(outcome.document, 'batman').tools).toEqual({ deny: ['shell'] })
  })

  it('sets both allow and deny together', () => {
    const doc = baseDocument()
    const outcome = setSeatTools(doc, 'batman', ['read'], ['shell'])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(seatOf(outcome.document, 'batman').tools).toEqual({ allow: ['read'], deny: ['shell'] })
  })

  it('clearing both allow and deny to undefined OMITS the tools key entirely (never {} or an empty list)', () => {
    const doc = baseDocument()
    const outcome = setSeatTools(doc, 'robin', undefined, undefined)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect('tools' in seatOf(outcome.document, 'robin')).toBe(false)
    expect(Object.keys(seatOf(outcome.document, 'robin'))).not.toContain('tools')
  })

  it('clearing both allow and deny to EMPTY arrays also omits the tools key (an empty list is not a legal tools value)', () => {
    const doc = baseDocument()
    const outcome = setSeatTools(doc, 'robin', [], [])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect('tools' in seatOf(outcome.document, 'robin')).toBe(false)
  })

  it('preserves the seat\'s other fields (cwd, lead) when replacing tools', () => {
    const doc = baseDocument()
    const outcome = setSeatTools(doc, 'alfred', ['read'], undefined)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.document.seats.alfred).toEqual({ cwd: '/org/alfred', lead: true, tools: { allow: ['read'] } })
  })

  it('never mutates the input document', () => {
    const doc = baseDocument()
    const before = JSON.parse(JSON.stringify(doc)) as OrgRegistryDocument
    setSeatTools(doc, 'robin', undefined, undefined)
    setSeatTools(doc, 'batman', ['read'], ['shell'])
    expect(doc).toEqual(before)
  })
})

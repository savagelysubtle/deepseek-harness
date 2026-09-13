import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
// Side-effect only: merges the `turnStatus` key so the SWD-120 fixtures below
// build a projectionValues.turnStatus shape that type-checks.
import type {} from '@deepseek-ai/dsh-session-turn-status/client'
import { deriveSubagentTree, sessionEndStatus } from '../src/client/tree.ts'

const sid = (id: string) => id as SessionId
const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 0, ...overrides,
})
const byId = (...items: SessionSummary[]): SessionListState['byId'] =>
  Object.fromEntries(items.map(item => [item.id, item]))

describe('deriveSubagentTree', () => {
  it('nests direct and transitive subagent-origin descendants of the given root', () => {
    const root = summary('root')
    const a = summary('a', { origin: 'subagent', parentId: sid('root') })
    const b = summary('b', { origin: 'subagent', parentId: sid('a') })
    const tree = deriveSubagentTree(byId(root, a, b), sid('root'))
    expect(tree).toEqual([
      { summary: a, children: [{ summary: b, children: [] }] },
    ])
  })

  it('excludes an ordinary fork of the root — a parentId without subagent origin', () => {
    const root = summary('root')
    const fork = summary('fork', { parentId: sid('root') })
    expect(deriveSubagentTree(byId(root, fork), sid('root'))).toEqual([])
  })

  it('excludes a subagent whose parent lies outside the root\'s own tree', () => {
    const root = summary('root')
    const other = summary('other')
    const stray = summary('stray', { origin: 'subagent', parentId: sid('other') })
    expect(deriveSubagentTree(byId(root, other, stray), sid('root'))).toEqual([])
  })

  it('orders running subagents first, then most-recently-updated, then id', () => {
    const root = summary('root')
    const idle = summary('idle', { origin: 'subagent', parentId: sid('root'), updatedAt: 300 })
    const runningOld = summary('running-old', {
      origin: 'subagent', parentId: sid('root'), running: true, updatedAt: 100,
    })
    const runningNew = summary('running-new', {
      origin: 'subagent', parentId: sid('root'), running: true, updatedAt: 200,
    })
    const tieA = summary('tie-a', { origin: 'subagent', parentId: sid('root'), updatedAt: 300 })
    const tree = deriveSubagentTree(byId(root, idle, runningOld, runningNew, tieA), sid('root'))
    expect(tree.map(node => node.summary.id)).toEqual([
      sid('running-new'), sid('running-old'), sid('idle'), sid('tie-a'),
    ])
  })

  it('stops a malformed cycle from re-entering the root instead of looping or duplicating it', () => {
    // A -> B -> (corrupted) R: R is fed back in as B's own "child", simulating
    // a parentId chain that loops on the root itself. The root's id starts
    // pre-visited, so R is filtered out as B's child rather than re-descended.
    const root = summary('root', { origin: 'subagent', parentId: sid('b') })
    const a = summary('a', { origin: 'subagent', parentId: sid('root') })
    const b = summary('b', { origin: 'subagent', parentId: sid('a') })
    const tree = deriveSubagentTree(byId(root, a, b), sid('root'))
    expect(tree).toEqual([
      { summary: a, children: [{ summary: b, children: [] }] },
    ])
  })
})

describe('sessionEndStatus', () => {
  it('is undefined when the deployment composes no turnStatus projection', () => {
    expect(sessionEndStatus(summary('s'))).toBeUndefined()
  })

  it('reports an open turn on a session that is no longer running as interrupted (the crash gotcha)', () => {
    const row = summary('s', { projectionValues: { turnStatus: { open: true, cause: null } } })
    expect(sessionEndStatus(row)).toBe('interrupted')
  })

  it('keeps an open turn on a still-running session as the ordinary running rendering', () => {
    const row = summary('s', {
      running: true, projectionValues: { turnStatus: { open: true, cause: null } },
    })
    expect(sessionEndStatus(row)).toBeUndefined()
  })

  it('maps a closed turn\'s cause to stopped, interrupted, or error', () => {
    const closed = (cause: NonNullable<
      NonNullable<SessionSummary['projectionValues']>['turnStatus']
    >['cause']): SessionSummary => summary('s', { projectionValues: { turnStatus: { open: false, cause } } })
    expect(sessionEndStatus(closed({ kind: 'aborted', cause: { kind: 'user' } }))).toBe('stopped')
    expect(sessionEndStatus(closed({ kind: 'interrupted' }))).toBe('interrupted')
    expect(sessionEndStatus(closed({ kind: 'error', code: 'E', message: 'm' }))).toBe('error')
  })

  it('falls back to undefined for an ordinary completion cause', () => {
    const row = summary('s', {
      projectionValues: { turnStatus: { open: false, cause: { kind: 'completed' } } },
    })
    expect(sessionEndStatus(row)).toBeUndefined()
  })
})

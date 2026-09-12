// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentsView } from '../src/client/AgentsView.tsx'
import { en, type AgentsKey } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 0, ...overrides,
})

/** Minimal mustache-style interpolation, matching the shape the real locale
 * service applies to `{name}` placeholders — enough to assert rendered text
 * without pulling in that package's own machinery. */
function translate(key: LocaleKeysOf<'agents'>, params?: Record<string, unknown>): string {
  const template = en[key as AgentsKey] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : `{${name}}`
  })
}

function sessionsOf(...items: SessionSummary[]) {
  const state: SessionListState = {
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current: undefined,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  return bindSnapshotSelector(createSnapshotStore(state))
}

function renderView(rootId: string, ...items: SessionSummary[]) {
  const props = {
    sessionId: sid(rootId),
    useSessions: sessionsOf(...items),
    t: translate,
  } as unknown as ConvViewProps & { t: typeof translate }
  return render(<AgentsView {...props} />)
}

describe('AgentsView', () => {
  it('says plainly that nothing is running rather than rendering a blank panel', () => {
    renderView('root', summary('root'))
    expect(screen.getByText('No subagents are running under this conversation.')).toBeTruthy()
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('renders the subagent tree with running-first ordering and per-row status', () => {
    renderView(
      'root',
      summary('root'),
      summary('idle-child', { origin: 'subagent', parentId: sid('root'), displayTitle: 'Idle child' }),
      summary('running-child', {
        origin: 'subagent', parentId: sid('root'), running: true, displayTitle: 'Running child', updatedAt: 1,
      }),
    )
    const tree = screen.getByRole('tree', { name: "This conversation's subagents" })
    expect(tree).toBeTruthy()
    // DisclosureRow renders its own (always-empty, `title=""`) title span
    // alongside ours; filter blanks rather than matching on the coincidental
    // CSS-module class-name substring the two share.
    const titles = [...tree.querySelectorAll('[class*="title"]')]
      .map(el => el.textContent)
      .filter(text => text !== '')
    expect(titles).toEqual(['Running child', 'Idle child'])
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Idle')).toBeTruthy()
  })

  it('nests a subagent under its own subagent parent and toggles the branch closed and open', () => {
    const view = renderView(
      'root',
      summary('root'),
      summary('parent', { origin: 'subagent', parentId: sid('root'), displayTitle: 'Parent agent' }),
      summary('child', { origin: 'subagent', parentId: sid('parent'), displayTitle: 'Child agent' }),
    )
    expect(screen.getByText('Child agent')).toBeTruthy()

    const toggle = view.container.querySelector('[aria-expanded="true"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByText('Child agent')).toBeNull()

    fireEvent.click(view.container.querySelector('[aria-expanded="false"]') as HTMLButtonElement)
    expect(screen.getByText('Child agent')).toBeTruthy()
  })

  it('renders every SWD-120 end status and the completed/idle fallback', () => {
    renderView(
      'root',
      summary('root'),
      summary('stopped', { origin: 'subagent', parentId: sid('root'), displayTitle: 'Agent A', projectionValues: { turnStatus: { open: false, cause: { kind: 'aborted', cause: { kind: 'user' } } } } }),
      summary('interrupted', { origin: 'subagent', parentId: sid('root'), displayTitle: 'Agent B', projectionValues: { turnStatus: { open: false, cause: { kind: 'interrupted' } } } }),
      summary('errored', { origin: 'subagent', parentId: sid('root'), displayTitle: 'Agent C', projectionValues: { turnStatus: { open: false, cause: { kind: 'error', code: 'E', message: 'm' } } } }),
      summary('completed', { origin: 'subagent', parentId: sid('root'), displayTitle: 'Agent D', completed: true }),
      summary('idle', { origin: 'subagent', parentId: sid('root'), displayTitle: 'Agent E' }),
    )
    expect(screen.getByText('Agent A').closest('[class*="rowWrapper"]')?.textContent).toContain('Stopped')
    expect(screen.getByText('Agent B').closest('[class*="rowWrapper"]')?.textContent).toContain('Interrupted')
    expect(screen.getByText('Agent C').closest('[class*="rowWrapper"]')?.textContent).toContain('Error')
    expect(screen.getByText('Agent D').closest('[class*="rowWrapper"]')?.textContent).toContain('Completed')
    expect(screen.getByText('Agent E').closest('[class*="rowWrapper"]')?.textContent).toContain('Idle')
  })

  it('gives a leaf row no disclosure toggle', () => {
    const view = renderView(
      'root',
      summary('root'),
      summary('leaf', { origin: 'subagent', parentId: sid('root'), displayTitle: 'Leaf agent' }),
    )
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatConversationViewNode, ConversationEventInput, ConversationNodeDefinition,
  ConversationViewDefinition, SessionId, SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkflowRunPanel, type WorkflowRunPanelProps } from '../src/client/WorkflowRunPanel.tsx'
import { en, zh } from '../src/client/locales.ts'
import { workflowRunDefinition, type WorkflowRunChatData } from '../src/client/workflow-definition.ts'

afterEach(cleanup)

const PARENT_ID = 'parent' as SessionId
const HEADLESS_REASON = "Approval node 'ship' rejected: this session is headless. "
  + 'Remedy: run with an approval answerer (Workflows UI) or change policy to ask.'

interface ChatSnapshot { readonly nodes: ReadonlyMap<string, ChatConversationViewNode> }

class Defs {
  entries(): readonly ConversationNodeDefinition[] { return [workflowRunDefinition] }
  fallbackEntry(): undefined { return undefined }
}
class Views {
  entries(): readonly ConversationViewDefinition[] { return [view] }
}
const view: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    const snap = (): ChatSnapshot => ({ nodes })
    return {
      empty: snap(),
      replace: ({ nodes: values }) => { nodes = new Map(values.map(n => [n.key, n])); return snap() },
      apply: ({ upserts }) => { nodes = new Map(nodes); for (const n of upserts) nodes.set(n.key, n); return snap() },
    }
  },
}

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: seq * 100, type, data } as ConversationEventInput['event'], view: undefined }
}

function build(entries: readonly ConversationEventInput[]): WorkflowRunChatData {
  const value = new ConversationNodeAssembler(new Defs(), new Views())
  value.replaceWindow(entries, false)
  value.flush()
  const first = [...(value.snapshot('chat') as ChatSnapshot).nodes.values()][0]
  return first?.data as WorkflowRunChatData
}

const R = 'run-1'
const at_ = (seq: number, state: string, time: number): ConversationEventInput =>
  at(seq, 'tool-workflow/approval', { runId: R, nodeId: 'ship', kind: 'approval', approvalId: 'ap-1', state, at: time })
const start = (): ConversationEventInput[] => [
  at(1, 'turn/start', { turn: 1 }),
  at(2, 'tool-workflow/run-start', { runId: R, name: 'ship-it' }),
]

function props(data: WorkflowRunChatData, locale: Record<string, string> = zh): WorkflowRunPanelProps {
  const sessions = { ids: [], byId: {}, current: PARENT_ID, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined } as unknown as SessionListState
  return {
    node: { key: 'k', kind: 'workflow-run', id: R, target: 'chat', anchorSeq: 2, location: { kind: 'unresolved' }, visibility: 'visible', data },
    sessionId: PARENT_ID,
    useSessions: (selector: (s: SessionListState) => unknown) => selector(sessions),
    openSession: vi.fn(),
    t: makeTranslate(locale),
  } as unknown as WorkflowRunPanelProps
}

describe('node-end and gate-report projection', () => {
  it('leaves plain runs untouched and maps node statuses, duration and exit code', () => {
    const plain = build(start())
    expect(plain.nodes).toBeUndefined()
    expect(plain.gateReport).toBeUndefined()
    const data = build([
      ...start(),
      at(3, 'tool-workflow/node-end', { runId: R, nodeId: 'a', kind: 'bash', status: 'success', exitCode: 0, durationMs: 12 }),
      at(4, 'tool-workflow/node-end', { runId: R, nodeId: 'b', kind: 'prompt', status: 'failed' }),
      at(5, 'tool-workflow/node-end', { runId: R, nodeId: 'c', kind: 'bash', status: 'skipped' }),
      at(6, 'tool-workflow/node-end', { runId: R, nodeId: 'd', kind: 'bash', status: 'cancelled' }),
      at(7, 'tool-workflow/node-end', { runId: R, nodeId: 'e', kind: 'bash', status: 'interrupted' }),
      at(8, 'tool-workflow/node-end', { runId: R, nodeId: 'a', kind: 'bash', status: 'failed', exitCode: 1, truncated: true }),
    ])
    expect(data.nodes?.map(n => [n.nodeId, n.status])).toEqual([
      ['a', 'failed'], ['b', 'failed'], ['c', 'skipped'], ['d', 'cancelled'], ['e', 'interrupted'],
    ])
    expect(data.nodes?.[0]).toMatchObject({ exitCode: 1, truncated: true })
  })

  it('shows a started node as running and lets node-end replace it, later records winning', () => {
    const running = build([...start(), at(3, 'tool-workflow/node-start', { runId: R, nodeId: 'a', kind: 'prompt', at: 1000 })])
    expect(running.nodes).toEqual([{ nodeId: 'a', kind: 'prompt', status: 'running', startedAt: 1000 }])
    const data = build([
      ...start(),
      at(3, 'tool-workflow/node-start', { runId: R, nodeId: 'a', kind: 'prompt', at: 1000 }),
      at(4, 'tool-workflow/node-end', { runId: R, nodeId: 'a', kind: 'prompt', status: 'success', durationMs: 5, truncated: false }),
      at(5, 'tool-workflow/node-end', { runId: R, nodeId: 'a', kind: 'prompt', status: 'success', durationMs: 5, truncated: true }),
    ])
    expect(data.nodes).toEqual([
      { nodeId: 'a', kind: 'prompt', status: 'done', durationMs: 5, startedAt: 1000, truncated: true },
    ])
  })

  it('tolerates out-of-order events: a late start never reopens a settled node', () => {
    const data = build([
      ...start(),
      at(3, 'tool-workflow/node-end', { runId: R, nodeId: 'a', kind: 'bash', status: 'failed', exitCode: 1 }),
      at(4, 'tool-workflow/node-start', { runId: R, nodeId: 'a', kind: 'bash', at: 50 }),
    ])
    expect(data.nodes).toEqual([{ nodeId: 'a', kind: 'bash', status: 'failed', exitCode: 1, startedAt: 50 }])
  })

  it('marks a still-running node interrupted once the run has ended', () => {
    const data = build([
      ...start(),
      at(3, 'tool-workflow/node-start', { runId: R, nodeId: 'a', kind: 'bash', at: 1 }),
      at(4, 'tool-workflow/run-end', { runId: R, stopReason: 'cancelled' }),
    ])
    expect(data.nodes?.[0]?.status).toBe('interrupted')
  })

  it('ignores node and approval events whose run has no run-start', () => {
    const value = new ConversationNodeAssembler(new Defs(), new Views())
    value.replaceWindow([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool-workflow/node-start', { runId: 'ghost', nodeId: 'a', kind: 'bash', at: 1 }),
      at(3, 'tool-workflow/approval', { runId: 'ghost', nodeId: 'a', kind: 'bash', approvalId: 'p', state: 'pending', at: 1 }),
      at(4, 'tool-workflow/gate-report', { runId: 'ghost', rows: [] }),
    ], false)
    value.flush()
    expect([...(value.snapshot('chat') as ChatSnapshot).nodes.values()]).toHaveLength(0)
  })

  it.each([
    ['pending', undefined],
    ['allowed', undefined],
    ['rejected', 'denied by reviewer'],
    ['expired', 'no answer within 5 ms'],
    ['unavailable', HEADLESS_REASON],
    ['cancelled', 'run cancelled'],
  ] as const)('projects the %s approval state with its reason', (state, reason) => {
    const data = build([
      ...start(),
      at(3, 'tool-workflow/approval', {
        runId: R, nodeId: 'ship', kind: 'approval', approvalId: 'ap-1', state, at: 10, ...reason === undefined ? {} : { reason },
      }),
    ])
    expect(data.nodes?.[0]).toMatchObject({ nodeId: 'ship', kind: 'approval', approval: state, status: 'running' })
    expect(data.nodes?.[0]?.reason).toBe(reason)
  })

  it('orders two approvals on one node by at, with arrival order breaking ties', () => {
    const ap = (seq: number, id: string, state: string, time: number, reason: string): ConversationEventInput =>
      at(seq, 'tool-workflow/approval', { runId: R, nodeId: 'ship', kind: 'approval', approvalId: id, state, at: time, reason })
    const tie = build([...start(), ap(3, 'a', 'allowed', 5, 'first'), ap(4, 'b', 'rejected', 5, 'second')])
    expect(tie.nodes?.[0]).toMatchObject({ approval: 'rejected', reason: 'second' })
    const skewed = build([...start(), ap(3, 'a', 'allowed', 9, 'later clock'), ap(4, 'b', 'rejected', 5, 'earlier clock')])
    expect(skewed.nodes?.[0]).toMatchObject({ approval: 'allowed', reason: 'later clock' })
    // A decision takes the arrival position of the decision, not of its pending record.
    const replaced = build([
      ...start(),
      ap(3, 'a', 'pending', 5, 'p'), ap(4, 'b', 'allowed', 5, 'b-decided'), ap(5, 'a', 'rejected', 5, 'a-decided'),
    ])
    expect(replaced.nodes?.[0]).toMatchObject({ approval: 'rejected', reason: 'a-decided' })
  })

  it('reads the real kind from an approval event', () => {
    const withKind = build([...start(), at(3, 'tool-workflow/approval', { runId: R, nodeId: 'n', kind: 'prompt', approvalId: 'x', state: 'pending', at: 1 })])
    expect(withKind.nodes?.[0]?.kind).toBe('prompt')
  })

  it('caps long reasons and renders markup as inert text in node and gate rows', () => {
    const markup = '<img src=x onerror=alert(1)><script>boom()</script>'
    const long = 'x'.repeat(10_000)
    const data = build([
      ...start(),
      at(3, 'tool-workflow/approval', { runId: R, nodeId: 'ship', kind: 'approval', approvalId: 'a', state: 'rejected', reason: markup, at: 1 }),
      at(4, 'tool-workflow/gate-report', { runId: R, rows: [{ nodeId: 'ship', gateKind: 'approval', outcome: 'fired-block', reason: long }] }),
    ])
    expect(data.gateReport?.[0]?.reason).toHaveLength(501)
    expect(data.gateReport?.[0]?.reason?.endsWith('…')).toBe(true)
    const { container } = render(<WorkflowRunPanel {...props(data, en)} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[data-node-reason]')?.textContent).toBe(markup)
    expect(container.querySelector('[data-gate-reason]')?.textContent).toHaveLength(501)
    const capped = build([
      ...start(),
      at(3, 'tool-workflow/approval', { runId: R, nodeId: 'n', kind: 'approval', approvalId: 'a', state: 'rejected', reason: long, at: 1 }),
    ])
    expect(capped.nodes?.[0]?.reason).toHaveLength(501)
  })

  it('walks pending to decided, keeps decisions final, and falls back to the gate reason', () => {
    const approval = (seq: number, state: string, at: number): ConversationEventInput =>
      at_(seq, state, at)
    const data = build([
      ...start(),
      approval(3, 'pending', 1),
      approval(4, 'allowed', 2),
      approval(5, 'pending', 3),
      approval(6, 'rejected', 4),
    ])
    expect(data.nodes?.[0]?.approval).toBe('allowed')
    const decidedFirst = build([...start(), approval(3, 'rejected', 4), approval(4, 'pending', 1)])
    expect(decidedFirst.nodes?.[0]?.approval).toBe('rejected')
    const withGate = build([
      ...start(),
      approval(3, 'unavailable', 1),
      at(4, 'tool-workflow/gate-report', {
        runId: R, rows: [{ nodeId: 'ship', gateKind: 'approval', outcome: 'fired-block', reason: HEADLESS_REASON }],
      }),
    ])
    expect(withGate.nodes?.[0]?.reason).toBe(HEADLESS_REASON)
  })
})

describe('node and approval rendering', () => {
  it('renders status text, meta, truncation and approval rows with verbatim remedy', () => {
    const data = build([
      ...start(),
      at(3, 'tool-workflow/node-end', { runId: R, nodeId: 'build', kind: 'bash', status: 'failed', exitCode: 2, durationMs: 340, truncated: true }),
      at(4, 'tool-workflow/node-end', { runId: R, nodeId: 'ship', kind: 'approval', status: 'failed' }),
      at(5, 'tool-workflow/approval', { runId: R, nodeId: 'ship', kind: 'approval', approvalId: 'ap-1', state: 'unavailable', reason: HEADLESS_REASON, at: 9 }),
      at(6, 'tool-workflow/gate-report', {
        runId: R, rows: [{ nodeId: 'ship', gateKind: 'approval', outcome: 'fired-block', reason: HEADLESS_REASON }],
      }),
      at(7, 'tool-workflow/run-end', { runId: R, stopReason: 'error' }),
    ])
    const { container } = render(<WorkflowRunPanel {...props(data, en)} />)
    const build_ = container.querySelector('[data-node-id="build"]')
    expect(build_?.getAttribute('data-node-status')).toBe('failed')
    expect(build_?.querySelector('[data-node-status-text]')?.textContent).toBe('Failed')
    expect(build_?.querySelector('[data-node-meta]')?.textContent).toBe('exit 2 · 340 ms')
    expect(build_?.querySelector('[data-node-truncated]')?.textContent).toBe('Output truncated')
    expect(build_?.hasAttribute('data-approval-state')).toBe(false)
    const ship = container.querySelector('[data-node-id="ship"]')
    expect(ship?.getAttribute('data-approval-state')).toBe('unavailable')
    expect(ship?.querySelector('[data-approval-text]')?.textContent).toBe('Approval: unavailable')
    expect(ship?.querySelector('[data-node-reason]')?.textContent).toBe(HEADLESS_REASON)
    expect(container.textContent).not.toContain('No members started')
  })

  it('renders every approval state label in zh and en', () => {
    for (const approval of ['pending', 'allowed', 'rejected', 'expired', 'unavailable', 'cancelled'] as const) {
      const data: WorkflowRunChatData = {
        name: 'w', status: 'failed', phases: [],
        nodes: [{ nodeId: 'n', kind: 'approval', status: approval === 'allowed' ? 'done' : approval === 'pending' ? 'running' : 'failed', approval }],
      }
      for (const locale of [zh, en]) {
        const { container, unmount } = render(<WorkflowRunPanel {...props(data, locale)} />)
        expect(container.querySelector('[data-approval-state]')?.getAttribute('data-approval-state')).toBe(approval)
        expect(container.querySelector('[data-approval-text]')?.textContent).toBe(locale[`approval.${approval}`])
        unmount()
      }
    }
  })
})

describe('gate report table', () => {
  const rows = [
    { nodeId: 'a', gateKind: 'when', outcome: 'fired-pass' },
    { nodeId: 'b', gateKind: 'approval', outcome: 'fired-block', reason: HEADLESS_REASON },
    { nodeId: 'c', gateKind: 'when', outcome: 'skipped' },
    { nodeId: 'd', gateKind: 'when', outcome: 'not-reached', reason: 'upstream failed' },
    { nodeId: 'e', gateKind: 'trigger_rule', outcome: 'never-evaluated' },
  ]
  const finished = (rs: readonly unknown[]): WorkflowRunChatData => build([
    ...start(),
    at(3, 'tool-workflow/gate-report', { runId: R, rows: rs }),
    at(4, 'tool-workflow/run-end', { runId: R, stopReason: 'completed' }),
  ])

  it('renders one row per gate with a text badge for each of the five outcomes', () => {
    const { container } = render(<WorkflowRunPanel {...props(finished(rows), en)} />)
    expect(container.querySelector('caption')?.textContent).toBe('Workflow gate report')
    const trs = [...container.querySelectorAll('[data-gate-row]')]
    expect(trs.map(tr => tr.getAttribute('data-gate-outcome'))).toEqual(rows.map(r => r.outcome))
    expect(trs.map(tr => tr.querySelector('[data-gate-badge]')?.textContent)).toEqual([
      'Fired: pass', 'Fired: block', 'Skipped', 'Not reached', 'Never evaluated',
    ])
    expect(trs[1]?.querySelector('[data-gate-reason]')?.textContent).toBe(HEADLESS_REASON)
    expect(container.querySelectorAll('th[scope="col"]')).toHaveLength(4)
  })

  it('passes an unknown outcome token through verbatim', () => {
    const { container } = render(<WorkflowRunPanel {...props(finished([{ nodeId: 'a', gateKind: 'k', outcome: 'weird' }]), en)} />)
    fireEvent.click(container.querySelector('[data-gate-toggle]') as HTMLElement)
    expect(container.querySelector('[data-gate-badge]')?.textContent).toBe('weird')
  })

  it('defaults collapsed when nothing blocked, expanded on a block, and the toggle is remembered', () => {
    const clean = render(<WorkflowRunPanel {...props(finished([rows[0]!]), en)} />)
    const gate = (): Element | null => clean.container.querySelector('[data-gate-report]')
    expect(gate()?.getAttribute('data-gate-report-open')).toBe('false')
    expect(clean.container.querySelector('table')).toBeNull()
    const toggle = clean.container.querySelector('[data-gate-toggle]') as HTMLElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Gate report (1)')
    fireEvent.click(toggle)
    expect(gate()?.getAttribute('data-gate-report-open')).toBe('true')
    expect(clean.container.querySelector('table')).not.toBeNull()
    // A rerender with new data for the same run id keeps the remembered choice.
    clean.rerender(<WorkflowRunPanel {...props(finished([rows[0]!, rows[2]!]), en)} />)
    expect(gate()?.getAttribute('data-gate-report-open')).toBe('true')
    fireEvent.click(clean.container.querySelector('[data-gate-toggle]') as HTMLElement)
    expect(gate()?.getAttribute('data-gate-report-open')).toBe('false')
    clean.unmount()

    const blocked = render(<WorkflowRunPanel {...props(finished(rows), en)} />)
    expect(blocked.container.querySelector('[data-gate-report]')?.getAttribute('data-gate-report-open')).toBe('true')
    fireEvent.click(blocked.container.querySelector('[data-gate-toggle]') as HTMLElement)
    expect(blocked.container.querySelector('table')).toBeNull()
  })

  it('shows the empty notice for a declared-gate-free report and omits the section when absent', () => {
    const empty = render(<WorkflowRunPanel {...props(finished([]), en)} />)
    fireEvent.click(empty.container.querySelector('[data-gate-toggle]') as HTMLElement)
    expect(empty.container.textContent).toContain('No gates declared')
    empty.unmount()
    const none = render(<WorkflowRunPanel {...props(build([...start(), at(3, 'tool-workflow/run-end', { runId: R, stopReason: 'completed' })]), en)} />)
    expect(none.container.querySelector('[data-gate-report]')).toBeNull()
  })

  it('keeps zh and en key sets paired', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

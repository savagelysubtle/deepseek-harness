// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ApprovalBadge, GateReport, NodeList, runDetailToNodeData } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe('runDetailToNodeData', () => {
  it.each([
    ['running', 'running'], ['success', 'done'], ['failed', 'failed'],
    ['skipped', 'skipped'], ['cancelled', 'cancelled'], ['mystery', 'interrupted'],
  ])('maps node status %s to %s', (status, expected) => {
    const { nodes } = runDetailToNodeData({ nodes: [{ nodeId: 'a', kind: 'bash', status }], gates: [], approvals: [] })
    expect(nodes[0]?.status).toBe(expected)
  })

  it.each(['pending', 'allowed', 'rejected', 'expired', 'unavailable', 'cancelled'])('keeps approval state %s', (state) => {
    const { nodes } = runDetailToNodeData({
      nodes: [{ nodeId: 'ship', kind: 'approval', status: 'running' }], gates: [],
      approvals: [{ nodeId: 'ship', state, reason: 'why', at: 1 }],
    })
    expect(nodes[0]).toMatchObject({ approval: state, reason: 'why' })
  })

  it('maps fields, truncated flag, latest approval, error fallback, orphan approvals and caps', () => {
    const view = runDetailToNodeData({
      nodes: [
        { nodeId: 'a', kind: 'bash', status: 'failed', exitCode: 2, durationMs: 9, startedAt: 5, truncated: true, error: 'boom' },
        { nodeId: 'b', kind: 'prompt', status: 'success', truncated: false },
        { nodeId: 'ship', kind: 'approval', status: 'failed' },
      ],
      gates: [{ nodeId: 'a', gateKind: 'when', outcome: 'fired-block' }],
      approvals: [
        { nodeId: 'ship', state: 'pending', at: 1 },
        { nodeId: 'ship', state: 'rejected', reason: 'x'.repeat(900), at: 2 },
        { nodeId: 'orphan', state: 'weird', at: 3 },
      ],
    })
    expect(view.nodes[0]).toEqual({
      nodeId: 'a', kind: 'bash', status: 'failed', exitCode: 2, durationMs: 9, startedAt: 5, truncated: true, reason: 'boom',
    })
    expect(view.nodes[1]).toEqual({ nodeId: 'b', kind: 'prompt', status: 'done' })
    expect(view.nodes[2]).toMatchObject({ approval: 'rejected' })
    expect(view.nodes[2]?.reason).toHaveLength(501)
    expect(view.nodes[3]).toEqual({ nodeId: 'orphan', kind: 'approval', status: 'failed', approval: 'unavailable' })
    expect(view.gateReport).toEqual([{ nodeId: 'a', gateKind: 'when', outcome: 'fired-block' }])
  })

  it('renders through the exported components with the stable selectors', () => {
    const t = makeTranslate(en)
    const view = runDetailToNodeData({
      nodes: [{ nodeId: 'ship', kind: 'approval', status: 'failed', truncated: true }],
      gates: [{ nodeId: 'ship', gateKind: 'approval', outcome: 'fired-block' }],
      approvals: [{ nodeId: 'ship', state: 'expired', reason: 'timed out', at: 1 }],
    })
    const { container } = render(
      <>
        <NodeList nodes={view.nodes} t={t} />
        <GateReport rows={view.gateReport} open onToggle={() => {}} t={t} />
        <ApprovalBadge state="pending" t={t} />
      </>,
    )
    expect(container.querySelector('[data-node-id="ship"]')?.getAttribute('data-approval-state')).toBe('expired')
    expect(container.querySelector('[data-node-truncated]')).not.toBeNull()
    expect(container.querySelector('[data-gate-outcome="fired-block"]')).not.toBeNull()
    expect(container.querySelector('[data-approval-badge="pending"]')?.textContent).toBe('Approval: pending')
  })
})

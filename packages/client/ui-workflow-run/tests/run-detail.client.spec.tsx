// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
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

  it('collapses attempts to one row per node showing the latest, earlier ones kept aside', () => {
    const view = runDetailToNodeData({
      nodes: [
        { nodeId: 'a', kind: 'prompt', status: 'failed', attempt: 1, durationMs: 10, error: 'stalled once' },
        { nodeId: 'b', kind: 'bash', status: 'success' },
        { nodeId: 'a', kind: 'prompt', status: 'success', attempt: 2, durationMs: 30 },
      ],
      gates: [], approvals: [],
    })
    expect(view.nodes.map(n => n.nodeId)).toEqual(['a', 'b'])
    expect(view.nodes[0]).toEqual({
      nodeId: 'a', kind: 'prompt', status: 'done', durationMs: 30, attempt: 2, attempts: 2,
      earlier: [{ attempt: 1, status: 'failed', durationMs: 10, reason: 'stalled once' }],
    })
    expect(view.nodes[1]?.attempts).toBeUndefined()
    expect(view.nodes[1]?.earlier).toBeUndefined()
  })

  it('renders the attempt label, expandable earlier attempts and the failure as plain text', () => {
    const t = makeTranslate(en)
    const view = runDetailToNodeData({
      nodes: [
        { nodeId: 'a', kind: 'prompt', status: 'failed', attempt: 1, durationMs: 10 },
        {
          nodeId: 'a', kind: 'prompt', status: 'failed', attempt: 2,
          failure: { code: 'NODE_STALLED', message: 'no output for 60 s after 2 attempts <b>x</b>', remedy: 'raise idle_timeout_s' },
        },
        { nodeId: 'solo', kind: 'bash', status: 'success' },
      ],
      gates: [], approvals: [],
    })
    const { container } = render(<NodeList nodes={view.nodes} t={t} />)
    const a = container.querySelector('[data-node-id="a"]')
    expect(a?.querySelector('[data-node-attempt]')?.textContent).toBe('attempt 2 of 2')
    expect(a?.querySelector('[data-node-failure-code]')?.textContent).toBe('NODE_STALLED')
    expect(a?.querySelector('[data-node-failure-message]')?.textContent).toContain('<b>x</b>')
    expect(a?.querySelector('b')).toBeNull()
    expect(a?.querySelector('[data-node-failure-remedy]')?.textContent).toBe('Remedy: raise idle_timeout_s')
    expect(a?.querySelector('[data-node-earlier-attempt]')).toBeNull()
    fireEvent.click(a?.querySelector('[data-node-earlier-toggle]') as HTMLElement)
    expect(a?.querySelector('[data-node-earlier-attempt="1"]')?.textContent).toBe('Attempt 1: Failed · 10 ms')
    expect(container.querySelectorAll('[data-workflow-node]')).toHaveLength(2)
    const solo = container.querySelector('[data-node-id="solo"]')
    expect(solo?.querySelector('[data-node-attempt]')).toBeNull()
    expect(solo?.querySelector('[data-node-earlier-toggle]')).toBeNull()
    expect(solo?.querySelector('[data-node-failure-code]')).toBeNull()
  })

  it('trusts the producer attempts count when only the last attempt row exists', () => {
    const view = runDetailToNodeData({
      nodes: [{ nodeId: 'a', kind: 'prompt', status: 'success', attempts: 3 }], gates: [], approvals: [],
    })
    expect(view.nodes[0]).toMatchObject({ attempt: 3, attempts: 3 })
    expect(view.nodes[0]?.earlier).toBeUndefined()
  })

  it('shows a failure code once and its message once, dropping the repeated plain error line', () => {
    const t = makeTranslate(en)
    const message = 'the command did not finish within 500 ms'
    const view = runDetailToNodeData({
      nodes: [{
        nodeId: 'slow', kind: 'bash', status: 'failed', error: `NODE_TIMEOUT: ${message}`,
        failure: { code: 'NODE_TIMEOUT', message, remedy: 'raise timeoutMs' },
      }],
      gates: [], approvals: [],
    })
    const { container } = render(<NodeList nodes={view.nodes} t={t} />)
    const card = container.querySelector('[data-node-id="slow"]')
    expect(card?.querySelector('[data-node-reason]')).toBeNull()
    const text = card?.textContent ?? ''
    expect(text.split('NODE_TIMEOUT').length - 1).toBe(1)
    expect(text.split(message).length - 1).toBe(1)
  })
})

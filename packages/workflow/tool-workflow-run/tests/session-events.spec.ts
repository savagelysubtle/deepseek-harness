import { afterEach, describe, expect, it } from 'vitest'
import { COMPLETED, DEMO, setup, startTrusted } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const dataOf = (harness: Harness, type: string): Record<string, unknown>[] =>
  harness.session.events.filter(e => e.type === type).map(e => e.data as unknown as Record<string, unknown>)

const ask = (harness: Harness) =>
  harness.engine.runs[0]!.request.approver!({ approvalId: 'engine-id', nodeId: 'ask', message: 'Ship it?', signal: new AbortController().signal })

describe('tool-workflow/node-start, node-end truncated and approval records', () => {
  it('records node-start with a time, and node-end carries the engine truncation flag', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const run = h.engine.runs[0]!
    run.nodeStart({ nodeId: 'build', kind: 'bash', gateKind: 'bash' })
    run.nodeEnd({ nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0, truncated: true })
    run.settle(COMPLETED)
    await started.done
    const [start] = dataOf(h, 'tool-workflow/node-start')
    expect(start).toMatchObject({ runId: started.runId, nodeId: 'build', kind: 'bash' })
    expect(typeof start!.at).toBe('number')
    expect(dataOf(h, 'tool-workflow/node-end')[0]).toMatchObject({ nodeId: 'build', truncated: true })
  })

  it('an agent node whose output hit the 8192-character tail gets a corrected node-end at run end', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const run = h.engine.runs[0]!
    run.nodeStart({ nodeId: 'build', kind: 'prompt' })
    run.nodeEnd({ nodeId: 'build', kind: 'prompt', status: 'success' })
    run.settle({
      value: { status: 'completed', nodes: [{ id: 'build', status: 'success', output: 'x'.repeat(8192) }] },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    await started.done
    const ends = dataOf(h, 'tool-workflow/node-end')
    expect(ends.map(e => e.truncated)).toEqual([false, true])
  })

  it('records pending then the decision, with a control-stripped reason of at most 500 characters', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const pending = ask(h)
    await expect.poll(() => h!.ctx.workflowRuns.pendingApprovals().length).toBe(1)
    const waiting = h.ctx.workflowRuns.pendingApprovals()[0]!
    await h.ctx.workflowRuns.answerApproval(started.runId, waiting.approvalId, 'reject', `no\u0007\n${'y'.repeat(900)}`)
    expect(await pending).toBe('rejected')
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
    const rows = dataOf(h, 'tool-workflow/approval')
    expect(rows.map(r => r.state)).toEqual(['pending', 'rejected'])
    expect(rows[0]).toMatchObject({ runId: started.runId, nodeId: 'ask', kind: 'approval', approvalId: waiting.approvalId })
    expect(rows[1]).toMatchObject({ kind: 'approval' })
    const reason = rows[1]!.reason as string
    expect(reason.length).toBeLessThanOrEqual(500)
    expect(reason).not.toMatch(/[\u0000-\u001f]/)
    expect(reason.startsWith('no yyy')).toBe(true)
  })

  it('an approval nobody can answer is recorded once, as rejected, with the remedy', async () => {
    h = await setup({ ui: false })
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    expect(await ask(h)).toBe('rejected')
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
    const rows = dataOf(h, 'tool-workflow/approval')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'rejected', nodeId: 'ask' })
    expect(rows[0]!.reason).toContain('Remedy')
  })

  it('a chat grant is recorded as allowed', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    h.openTurn()
    const started = await startTrusted(h)
    const pending = ask(h)
    await expect.poll(() => h!.approval!.requests.length).toBe(1)
    h.approval!.requests[0]!.resolve('allowed-once')
    expect(await pending).toBe('allowed-once')
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
    expect(dataOf(h, 'tool-workflow/approval').map(r => r.state)).toEqual(['pending', 'allowed'])
  })
})

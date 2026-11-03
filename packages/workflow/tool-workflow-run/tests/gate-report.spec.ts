import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { COMPLETED, DEMO, setup, startTrusted } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const MANIFEST = [{ nodeId: 'build', gateKind: 'bash' }, { nodeId: 'ask', gateKind: 'approval' }]

async function begin() {
  h = await setup()
  await h.writeWorkflow('demo', DEMO)
  const started = await startTrusted(h)
  const store = await h.ctx.workflowRuns.storeFor(h.workspace)
  return { started, run: h.engine.runs[0]!, store, h }
}

describe('gate report on every terminal path', () => {
  it('completed: pass rows from recorded gates; store end record, session events in order', async () => {
    const { started, run, store, h: hh } = await begin()
    run.nodeStart({ nodeId: 'build', kind: 'bash', gateKind: 'bash' })
    run.nodeEnd({ nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0, durationMs: 5 })
    run.gate({ nodeId: 'build', gateKind: 'bash', outcome: 'fired-pass' })
    run.nodeStart({ nodeId: 'ask', kind: 'approval', gateKind: 'approval' })
    run.nodeEnd({ nodeId: 'ask', kind: 'approval', status: 'success' })
    run.gate({ nodeId: 'ask', gateKind: 'approval', outcome: 'fired-pass' })
    run.settle(COMPLETED)
    const outcome = await started.done
    expect(outcome.status).toBe('completed')
    expect(outcome.report).toEqual([
      { nodeId: 'build', gateKind: 'bash', outcome: 'fired-pass' },
      { nodeId: 'ask', gateKind: 'approval', outcome: 'fired-pass' },
    ])
    const detail = await store.getRun(started.runId)
    expect(detail.status).toBe('completed')
    expect(detail.end?.report).toEqual(outcome.report)
    const types = hh.session.events.map(e => e.type).filter(t => t.startsWith('tool-workflow/'))
    expect(types).toEqual([
      'tool-workflow/run-start', 'tool-workflow/node-start', 'tool-workflow/node-end', 'tool-workflow/node-start', 'tool-workflow/node-end',
      'tool-workflow/gate-report', 'tool-workflow/run-end',
    ])
    const report = hh.session.events.find(e => e.type === 'tool-workflow/gate-report')!.data as unknown as { runId: string; rows: unknown[] }
    expect(report.runId).toBe(started.runId)
    expect(report.rows).toHaveLength(2)
    expect((hh.session.events.find(e => e.type === 'tool-workflow/run-start')!.data as { runId: string }).runId).toBe(started.runId)
  })

  it('failed: gates the script never reached read not-reached', async () => {
    const { started, run } = await begin()
    run.nodeStart({ nodeId: 'build', kind: 'bash', gateKind: 'bash' })
    run.nodeEnd({ nodeId: 'build', kind: 'bash', status: 'failed', exitCode: 2 })
    run.gate({ nodeId: 'build', gateKind: 'bash', outcome: 'fired-block' })
    run.settle({ value: { status: 'failed', nodes: [] }, stopReason: 'completed', agentsStarted: 0 })
    const outcome = await started.done
    expect(outcome.status).toBe('failed')
    expect(outcome.report).toEqual([
      { nodeId: 'build', gateKind: 'bash', outcome: 'fired-block' },
      { nodeId: 'ask', gateKind: 'approval', outcome: 'not-reached' },
    ])
  })

  it('cancelled: cancel() ends the run cancelled with a complete report', async () => {
    const { started, run, store } = await begin()
    const { found, outcome } = await h!.ctx.workflowRuns.cancel(started.runId, 'stop please', { workspace: h!.workspace })
    expect(found).toBe(true)
    expect(outcome?.status).toBe('cancelled')
    expect(run.cancels).toContain('stop please')
    expect(outcome?.report.map(r => r.outcome)).toEqual(['not-reached', 'not-reached'])
    expect((await store.getRun(started.runId)).end?.status).toBe('cancelled')
  })

  it('worker death: the engine-synthesized gates arrive, the run is interrupted, the report is complete', async () => {
    const { started, run, store } = await begin()
    run.nodeStart({ nodeId: 'build', kind: 'bash', gateKind: 'bash' })
    run.nodeEnd({ nodeId: 'build', kind: 'bash', status: 'interrupted', synthesized: true })
    run.gate({ nodeId: 'build', gateKind: 'bash', outcome: 'not-reached', synthesized: true })
    run.gate({ nodeId: 'ask', gateKind: 'approval', outcome: 'not-reached', synthesized: true })
    run.settle({ value: null, stopReason: 'error', error: 'workflow worker exited before the run settled (exit code 1)', agentsStarted: 0 })
    const outcome = await started.done
    expect(outcome.status).toBe('interrupted')
    expect(outcome.report.map(r => r.outcome)).toEqual(['not-reached', 'not-reached'])
    const detail = await store.getRun(started.runId)
    expect(detail.end?.status).toBe('interrupted')
    expect(detail.nodes.find(n => n.nodeId === 'build' && n.status === 'cancelled')?.error).toContain('interrupted')
  })

  it('an engine error that is not a worker death is a failed run', async () => {
    const { started, run } = await begin()
    run.settle({ value: null, stopReason: 'error', error: 'script threw', agentsStarted: 0 })
    const outcome = await started.done
    expect(outcome).toMatchObject({ status: 'failed', error: 'script threw' })
  })

  it('dispose of the service interrupts running runs and still closes their record', async () => {
    const { started, store } = await begin()
    await (h!.ctx.workflowRuns as unknown as { shutdown(): Promise<void> }).shutdown()
    const outcome = await started.done
    expect(outcome.status).toBe('interrupted')
    expect((await store.getRun(started.runId)).end?.status).toBe('interrupted')
  })

  it('node-end session events carry kind, status and exit code; unknown manifest is the compiler manifest', async () => {
    const { started, run, store } = await begin()
    run.nodeStart({ nodeId: 'build', kind: 'bash' })
    run.nodeEnd({ nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0, durationMs: 3 })
    run.settle(COMPLETED)
    await started.done
    const ev = h!.session.events.find(e => e.type === 'tool-workflow/node-end')!
    expect(ev.data).toMatchObject({ nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0, durationMs: 3 })
    expect((await store.getRun(started.runId)).header.manifest.gates).toEqual(MANIFEST)
  })
})

describe('known session event types', () => {
  it('lists the two new tool-workflow events in the generated vocabulary', () => {
    const known = readFileSync(new URL('../../../core/session/src/known-event-types.ts', import.meta.url), 'utf8')
    expect(known).toContain("'tool-workflow/node-end',")
    expect(known).toContain("'tool-workflow/gate-report',")
  })
})

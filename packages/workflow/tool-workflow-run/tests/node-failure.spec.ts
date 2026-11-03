import { afterEach, describe, expect, it } from 'vitest'
import { COMPLETED, DEMO, setup, startTrusted } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const REMEDY = "raise idleTimeoutMs for this node or check the agent's output"
const MESSAGE = 'the agent produced no output for 1000 ms (idleTimeoutMs) after 2 attempts (1 retry)'

async function runWith(end: (run: NonNullable<Harness['engine']['runs'][number]>) => void) {
  h = await setup()
  await h.writeWorkflow('demo', DEMO)
  const started = await startTrusted(h)
  end(h.engine.runs[0]!)
  h.engine.runs[0]!.settle(COMPLETED)
  await started.done
  const store = await h.ctx.workflowRuns.storeFor(h.workspace)
  return (await store.getRun(started.runId)).nodeStates
}

describe('node failure persistence', () => {
  it('writes the coded failure on the final record of a stalled node, and not on the closed earlier attempt', async () => {
    const states = await runWith((run) => {
      run.nodeStart({ nodeId: 'think', kind: 'prompt' })
      run.nodeEnd({ nodeId: 'think', kind: 'prompt', status: 'failed', attempts: 2, error: `NODE_STALLED: ${MESSAGE}`, failure: { code: 'NODE_STALLED', message: MESSAGE, remedy: REMEDY } })
    })
    const think = states.filter(s => s.nodeId === 'think')
    expect(think.map(s => s.attempt)).toEqual([1, 2])
    expect(think[1]!.record.failure).toEqual({ code: 'NODE_STALLED', message: MESSAGE, remedy: REMEDY })
    expect(think[0]!.record.failure).toBeUndefined()
  })

  it('puts the code in the model-facing gate reason, since the message carries no prefix', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const run = h.engine.runs[0]!
    run.nodeStart({ nodeId: 'think', kind: 'prompt' })
    run.nodeEnd({ nodeId: 'think', kind: 'prompt', status: 'failed', attempts: 2, error: `NODE_STALLED: ${MESSAGE}`, failure: { code: 'NODE_STALLED', message: MESSAGE, remedy: REMEDY } })
    run.settle(COMPLETED)
    const outcome = await started.done
    expect(outcome.reasons['think']).toBe(`NODE_STALLED: ${MESSAGE}; remedy: ${REMEDY}`)
  })

  it('writes no failure for a node that merely did not complete', async () => {
    const states = await runWith((run) => {
      run.nodeStart({ nodeId: 'think', kind: 'prompt' })
      run.nodeEnd({ nodeId: 'think', kind: 'prompt', status: 'failed', error: 'the agent did not complete' })
    })
    expect(states[0]!.record.error).toBe('the agent did not complete')
    expect(states[0]!.record.failure).toBeUndefined()
  })
})

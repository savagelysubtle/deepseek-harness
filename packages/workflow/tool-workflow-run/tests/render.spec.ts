import { describe, expect, it } from 'vitest'
import { renderOutcome } from '../src/report.ts'
import type { RunOutcome } from '../src/types.ts'

const base: RunOutcome = {
  runId: 'r1', name: 'stall', hash: 'abcdef012345', status: 'failed', report: [], nodes: [], reasons: {},
}

describe('renderOutcome: node failure reasons', () => {
  it('shows the attempts and the NODE_STALLED code on the node line and the remedy in the reasons', () => {
    const text = renderOutcome({
      ...base,
      nodes: [{ nodeId: 'think', kind: 'prompt', status: 'failed', attempts: 2, failureCode: 'NODE_STALLED' }],
      reasons: { think: "NODE_STALLED: no output for 1000 ms; remedy: raise idleTimeoutMs for this node or check the agent's output" },
    }, 10_000)
    expect(text).toContain('- think (prompt): failed after 2 attempts [NODE_STALLED]')
    expect(text).toContain('think: NODE_STALLED: no output for 1000 ms; remedy: raise idleTimeoutMs')
  })

  it('leaves an ordinary node line unchanged', () => {
    const text = renderOutcome({ ...base, nodes: [{ nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0, attempts: 1 }] }, 10_000)
    expect(text).toContain('- build (bash): success exit 0')
    expect(text).not.toContain('attempts')
  })
})

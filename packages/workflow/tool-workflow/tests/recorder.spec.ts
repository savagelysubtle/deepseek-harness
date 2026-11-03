import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
import type { WorkflowRun } from '@deepseek-ai/dsh-workflow'
import { createWorkflowRecorder } from '../src/index.ts'
import * as ToolWorkflowInvariant from '../src/invariant.ts'

async function setup(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ToolWorkflowInvariant)
  return { ctx, session: ctx.sessions.create(SessionId('recorder')) }
}

const engineRun = { id: WorkflowRunId('engine-1'), meta: { name: 'demo', description: 'd' } } as unknown as WorkflowRun
const info = { id: engineRun.id } as never
const types = (session: Session): string[] => session.events.map(e => e.type).filter(t => t.startsWith('tool-workflow/'))

describe('exported workflow recorder', () => {
  it('uses a custom record id and projects node-end only when asked', async () => {
    const { ctx, session } = await setup()
    const recorder = createWorkflowRecorder(ctx)
    recorder.start(session, engineRun, { recordId: 'store-run-9', nodes: true })
    const emit = (...args: unknown[]): void => { (ctx as unknown as { emit(...a: unknown[]): void }).emit(...args) }
    emit('workflow/node-end', info, { nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0, durationMs: 12 })
    emit('workflow/node-start', info, { nodeId: 'build', kind: 'bash' })
    recorder.nodeEnd(engineRun.id, { nodeId: 'agent', kind: 'prompt', status: 'success', truncated: true })
    recorder.approval(engineRun.id, { nodeId: 'ask', kind: 'approval', approvalId: 'a1', state: 'pending', at: 5 })
    recorder.finish(engineRun.id, 'completed')
    const nodeEnd = session.events.find(e => e.type === 'tool-workflow/node-end')
    expect(nodeEnd?.data).toMatchObject({ runId: 'store-run-9', nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0, durationMs: 12, truncated: false })
    expect(session.events.find(e => e.type === 'tool-workflow/node-start')?.data).toMatchObject({ runId: 'store-run-9', nodeId: 'build', kind: 'bash' })
    expect(session.events.filter(e => e.type === 'tool-workflow/node-end')[1]?.data).toMatchObject({ nodeId: 'agent', truncated: true })
    expect(session.events.find(e => e.type === 'tool-workflow/approval')?.data).toMatchObject({ runId: 'store-run-9', state: 'pending', at: 5 })
    expect(types(session)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/node-end', 'tool-workflow/node-start', 'tool-workflow/node-end', 'tool-workflow/approval', 'tool-workflow/run-end',
    ])
  })

  it('does not project node-end by default (the plain workflow tool is unchanged)', async () => {
    const { ctx, session } = await setup()
    const recorder = createWorkflowRecorder(ctx)
    recorder.start(session, engineRun)
    ;(ctx as unknown as { emit(...args: unknown[]): void }).emit('workflow/node-end', info, { nodeId: 'build', kind: 'bash', status: 'success' })
    recorder.finish(engineRun.id, 'completed')
    expect(types(session)).toEqual(['tool-workflow/run-start', 'tool-workflow/run-end'])
    expect(session.events.find(e => e.type === 'tool-workflow/run-start')?.data).toMatchObject({ runId: 'engine-1' })
  })

  it('writes the gate report before run-end and nothing after abandon', async () => {
    const { ctx, session } = await setup()
    const recorder = createWorkflowRecorder(ctx)
    recorder.start(session, engineRun, { recordId: 'r1' })
    recorder.gateReport(engineRun.id, [{ nodeId: 'ask', gateKind: 'approval', outcome: 'fired-block', reason: 'headless' }])
    recorder.finish(engineRun.id, 'error')
    expect(types(session)).toEqual(['tool-workflow/run-start', 'tool-workflow/gate-report', 'tool-workflow/run-end'])
    recorder.gateReport(engineRun.id, [])
    expect(types(session)).toHaveLength(3)
  })
})

describe('invariant: node-end and gate-report', () => {
  it('accepts both inside an open run and rejects them outside one or malformed', async () => {
    const { session } = await setup()
    const runId = WorkflowRunId('inv')
    expect(() => session.append('tool-workflow/node-end', { runId, nodeId: 'a', kind: 'bash', status: 'success', truncated: false })).toThrow(InvariantError)
    session.append('tool-workflow/run-start', { runId, name: 'inv' })
    session.append('tool-workflow/node-end', { runId, nodeId: 'a', kind: 'bash', status: 'success', truncated: false })
    session.append('tool-workflow/gate-report', { runId, rows: [{ nodeId: 'a', gateKind: 'bash', outcome: 'fired-pass' }] })
    expect(() => session.append('tool-workflow/gate-report', { runId, rows: [{ nodeId: '', gateKind: 'bash', outcome: 'x' }] })).toThrow(InvariantError)
    expect(() => session.append('tool-workflow/gate-report', { runId, rows: 'no' as never })).toThrow(InvariantError)
    expect(() => session.append('tool-workflow/node-end', { runId, nodeId: 'a', kind: 'bash', status: 'success', truncated: 'no' as never })).toThrow(InvariantError)
    session.append('tool-workflow/node-start', { runId, nodeId: 'b', kind: 'prompt', at: 1 })
    expect(() => session.append('tool-workflow/node-start', { runId, nodeId: 'b', kind: 'prompt', at: 'x' as never })).toThrow(InvariantError)
    session.append('tool-workflow/approval', { runId, nodeId: 'ask', kind: 'approval', approvalId: 'a1', state: 'pending', at: 2 })
    session.append('tool-workflow/approval', { runId, nodeId: 'ask', kind: 'approval', approvalId: 'a1', state: 'unavailable', reason: 'x', at: 3 })
    expect(() => session.append('tool-workflow/approval', { runId, nodeId: 'ask', kind: 'approval', approvalId: 'a1', state: 'maybe' as never, at: 3 })).toThrow(InvariantError)
    expect(() => session.append('tool-workflow/approval', { runId, nodeId: 'ask', kind: 'approval', approvalId: 'a1', state: 'rejected', reason: 'r'.repeat(501), at: 3 })).toThrow(InvariantError)
    expect(() => session.append('tool-workflow/approval', { runId, nodeId: 'ask', approvalId: 'a1', state: 'allowed', at: 3 } as never)).toThrow(InvariantError)
    session.append('tool-workflow/run-end', { runId, stopReason: 'completed' })
    expect(() => session.append('tool-workflow/approval', { runId, nodeId: 'ask', kind: 'approval', approvalId: 'a1', state: 'allowed', at: 4 })).toThrow(InvariantError)
    expect(() => session.append('tool-workflow/gate-report', { runId, rows: [] })).toThrow(InvariantError)
  })
})

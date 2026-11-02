import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowRunStore } from '@deepseek-ai/dsh-workflow-run-store'
import { ApprovalBroker, immediateRejectionReason, WriteQueue } from '../src/index.ts'
import type { BrokerRun } from '../src/broker.ts'
import { COMPLETED, DEMO, setup, startTrusted } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined; vi.useRealTimers() })

const ask = (h0: Harness, signal = new AbortController().signal) =>
  h0.engine.runs[0]!.request.approver!({ approvalId: 'engine-id', nodeId: 'ask', message: 'Ship it?', signal })

describe('approval broker over the real store', () => {
  it('writes the approval to the store first and answers from the UI path without any chat question', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const pending = ask(h)
    await expect.poll(() => h!.ctx.workflowRuns.pendingApprovals().length).toBe(1)
    const waiting = h.ctx.workflowRuns.pendingApprovals()[0]!
    expect(waiting).toMatchObject({ runId: started.runId, nodeId: 'ask', message: 'Ship it?' })
    expect(h.approval!.requests).toHaveLength(0)
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    expect((await store.getRun(started.runId)).approvals[0]).toMatchObject({ state: 'pending', nodeId: 'ask' })
    expect(await h.ctx.workflowRuns.answerApproval(started.runId, waiting.approvalId, 'allow')).toBe('allowed')
    expect(await pending).toBe('allowed-once')
    expect((await store.getRun(started.runId)).approvals[0]!.state).toBe('allowed')
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })

  it('mirrors to ctx.approval only while the parent has an open turn; the chat answer wins', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    h.openTurn()
    const started = await startTrusted(h)
    const pending = ask(h)
    await expect.poll(() => h!.approval!.requests.length).toBe(1)
    expect(h.approval!.requests[0]).toMatchObject({ toolName: 'workflow:approval' })
    h.approval!.requests[0]!.resolve('allowed-once')
    expect(await pending).toBe('allowed-once')
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    expect((await store.getRun(started.runId)).approvals[0]).toMatchObject({ state: 'allowed', reason: 'approved in chat' })
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })

  it('first answer wins: a UI rejection cancels the chat question and a late chat grant is ignored', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    h.openTurn()
    const started = await startTrusted(h)
    const pending = ask(h)
    await expect.poll(() => h!.approval!.requests.length).toBe(1)
    const waiting = h.ctx.workflowRuns.pendingApprovals()[0]!
    await h.ctx.workflowRuns.answerApproval(started.runId, waiting.approvalId, 'reject', 'not now')
    expect(await pending).toBe('rejected')
    expect(h.approval!.requests[0]!.signal?.aborted).toBe(true)
    h.approval!.requests[0]!.resolve('allowed-once')
    await new Promise(r => setTimeout(r, 20))
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    expect((await store.getRun(started.runId)).approvals[0]).toMatchObject({ state: 'rejected', reason: 'not now' })
    expect(await h.ctx.workflowRuns.answerApproval(started.runId, waiting.approvalId, 'allow')).toBeUndefined()
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })

  it('cancels a waiting approval when the run is aborted', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const controller = new AbortController()
    const pending = ask(h, controller.signal)
    await expect.poll(() => h!.ctx.workflowRuns.pendingApprovals().length).toBe(1)
    controller.abort()
    expect(await pending).toBe('cancelled')
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })
})

describe('headless and policy never', () => {
  const REMEDY = 'Remedy: run with an approval answerer (Workflows UI) or change policy to ask.'

  it('rejects immediately when headless, with the reason in the store and the report', async () => {
    h = await setup({ config: { headless: true } })
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const run = h.engine.runs[0]!
    expect(await ask(h)).toBe('rejected')
    const reason = immediateRejectionReason('ask', 'headless')
    expect(reason).toBe(`Approval node 'ask' rejected: this session is headless. ${REMEDY}`)
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    expect((await store.getRun(started.runId)).approvals[0]).toMatchObject({ state: 'rejected', reason })
    run.gate({ nodeId: 'ask', gateKind: 'approval', outcome: 'fired-block' })
    run.settle({ value: { status: 'failed', nodes: [] }, stopReason: 'completed', agentsStarted: 0 })
    const outcome = await started.done
    expect(outcome.report.find(r => r.nodeId === 'ask')).toMatchObject({ outcome: 'fired-block', reason })
    expect(outcome.reasons['ask']).toBe(reason)
  })

  it("rejects immediately under the 'never' policy", async () => {
    h = await setup()
    h.approval!.policyOverride = 'never'
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    expect(await ask(h)).toBe('rejected')
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    expect((await store.getRun(started.runId)).approvals[0]).toMatchObject({
      state: 'rejected', reason: `Approval node 'ask' rejected: policy is 'never'. ${REMEDY}`,
    })
    expect(h.approval!.requests).toHaveLength(0)
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })

  it('puts the reason in the tool result text', async () => {
    h = await setup({ config: { headless: true } })
    await h.writeWorkflow('demo', DEMO)
    const first = await startTrusted(h)
    h.engine.runs[0]!.settle(COMPLETED)
    await first.done
    const pending = h.execute({ name: 'demo' })
    await expect.poll(() => h!.engine.runs.length).toBe(2)
    const run = h.engine.runs[1]!
    expect(await run.request.approver!({ approvalId: 'x', nodeId: 'ask', message: 'Ship it?',
      signal: new AbortController().signal })).toBe('rejected')
    run.gate({ nodeId: 'ask', gateKind: 'approval', outcome: 'fired-block' })
    run.settle({ value: { status: 'failed', nodes: [] }, stopReason: 'completed', agentsStarted: 0 })
    const result = await pending
    expect(result.isError).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain("Approval node 'ask' rejected: this session is headless.")
    expect(text).toContain('Remedy: run with an approval answerer')
    expect(text).toContain('ask [approval]: fired-block')
  })
})

describe('approval wait cap (fake timers, stubbed store)', () => {
  function stubRun() {
    const decisions: { state: string; reason?: string }[] = []
    const store = {
      recordApproval: () => Promise.resolve({ approvalId: 'a1', nodeId: 'ask', state: 'pending' }),
      decideApproval: (_run: string, _id: string, d: { state: string; reason?: string }) => {
        decisions.push(d)
        return Promise.resolve({ decided: true, approval: { state: d.state, ...d.reason === undefined ? {} : { reason: d.reason } } })
      },
    } as unknown as WorkflowRunStore
    const run: BrokerRun = {
      runId: 'r1', store, parent: { session: { events: [] } } as unknown as Agent,
      ready: Promise.resolve(), queue: new WriteQueue(), reasons: new Map(),
    }
    return { run, decisions }
  }

  it('expires an unanswered approval at the cap and rejects the node with the reason', async () => {
    vi.useFakeTimers()
    const { run, decisions } = stubRun()
    const events: string[] = []
    const broker = new ApprovalBroker({
      approvalWaitMs: 5_000, headless: false, hasListeners: () => true, emit: e => events.push(e.type), warn: () => {},
    })
    const approver = broker.createApprover(run)
    let outcome: string | undefined
    void approver({ approvalId: 'e', nodeId: 'ask', message: 'm', signal: new AbortController().signal }).then((o) => { outcome = o })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2)
    expect(outcome).toBe('rejected')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.state).toBe('expired')
    expect(decisions[0]!.reason).toContain('no answer within 5000 ms')
    expect(run.reasons.get('ask')).toContain('expired')
    expect(events).toEqual(['approval-pending', 'approval-decided'])
  })
})

describe('approval broker: no answerer and unrecorded decisions', () => {
  function stubStore(opts: { failDecide?: boolean } = {}) {
    const decisions: { state: string; reason?: string }[] = []
    const store = {
      recordApproval: () => Promise.resolve({ approvalId: 'a1', nodeId: 'ask', state: 'pending' }),
      decideApproval: (_run: string, _id: string, d: { state: string; reason?: string }) => {
        if (opts.failDecide === true) return Promise.reject(new Error('disk full'))
        decisions.push(d)
        return Promise.resolve({ decided: true, approval: { state: d.state, ...d.reason === undefined ? {} : { reason: d.reason } } })
      },
    } as unknown as WorkflowRunStore
    const run: BrokerRun = {
      runId: 'r1', store, parent: { session: { events: [] } } as unknown as Agent,
      ready: Promise.resolve(), queue: new WriteQueue(), reasons: new Map(),
    }
    return { run, decisions }
  }
  const request = { approvalId: 'e', nodeId: 'ask', message: 'm', signal: new AbortController().signal }

  it('rejects at once with the remedy when there is no chat turn and nobody listens', async () => {
    const { run, decisions } = stubStore()
    const broker = new ApprovalBroker({ approvalWaitMs: 3_600_000, headless: false, emit: () => {}, warn: () => {} })
    expect(await broker.createApprover(run)(request)).toBe('rejected')
    expect(decisions[0]?.state).toBe('rejected')
    expect(run.reasons.get('ask')).toBe(immediateRejectionReason('ask', 'no-answerer'))
    expect(run.reasons.get('ask')).toContain('nobody is connected to answer it')
    expect(run.reasons.get('ask')).toContain('Remedy:')
  })

  it('rejects at once when the chat mirror comes back unavailable and nobody listens', async () => {
    const { run } = stubStore()
    const events = [{ type: 'turn/start' }]
    const parent = { session: { events } } as unknown as Agent
    const approval = { overrideOf: () => undefined, config: { policy: 'ask' }, request: () => Promise.resolve('unavailable') }
    const broker = new ApprovalBroker({
      approvalWaitMs: 3_600_000, headless: false, emit: () => {}, warn: () => {},
      getApproval: () => approval as never,
    })
    expect(await broker.createApprover({ ...run, parent })(request)).toBe('rejected')
    expect(run.reasons.get('ask')).toContain('nobody is connected to answer it')
  })

  it('keeps waiting when a UI listens, and a chat-unavailable answer leaves the store path open', async () => {
    const { run } = stubStore()
    const broker = new ApprovalBroker({ approvalWaitMs: 3_600_000, headless: false, hasListeners: () => true, emit: () => {},
      warn: () => {} })
    let outcome: string | undefined
    void broker.createApprover(run)(request).then((o) => { outcome = o })
    await expect.poll(() => broker.pendingApprovals().length).toBe(1)
    expect(outcome).toBeUndefined()
    await broker.answer('r1', 'a1', 'reject')
    await expect.poll(() => outcome).toBe('rejected')
  })

  it('never proceeds on an allow the store could not record', async () => {
    const { run } = stubStore({ failDecide: true })
    const broker = new ApprovalBroker({ approvalWaitMs: 3_600_000, headless: false, hasListeners: () => true, emit: () => {},
      warn: () => {} })
    let outcome: string | undefined
    void broker.createApprover(run)(request).then((o) => { outcome = o })
    await expect.poll(() => broker.pendingApprovals().length).toBe(1)
    await broker.answer('r1', 'a1', 'allow', 'ok')
    await expect.poll(() => outcome).toBe('unavailable')
  })

  it('strips control and direction characters from a human reason and caps it at 500 characters', async () => {
    const { run, decisions } = stubStore()
    const broker = new ApprovalBroker({ approvalWaitMs: 3_600_000, headless: false, hasListeners: () => true, emit: () => {},
      warn: () => {} })
    void broker.createApprover(run)(request)
    await expect.poll(() => broker.pendingApprovals().length).toBe(1)
    await broker.answer('r1', 'a1', 'reject', `bad\u202e\u009b\nline ${'x'.repeat(900)}`)
    const reason = decisions[0]?.reason ?? ''
    expect(reason.length).toBeLessThanOrEqual(500)
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
    expect(reason.startsWith('bad line')).toBe(true)
  })
})

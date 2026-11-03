import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKFLOW_ATTACH_TTL_MS } from '../src/index.ts'
import type { WorkflowFailure } from '../src/index.ts'
import { COMPLETED, DEMO, setupRemote } from './support.ts'
import type { Remote } from './support.ts'

let h: Remote | undefined
afterEach(async () => { await h?.cleanup(); h = undefined; vi.useRealTimers() })

const failed = (value: unknown): WorkflowFailure => {
  expect(value).toMatchObject({ ok: false })
  return value as WorkflowFailure
}
const noLeak = (value: unknown): void => {
  const text = JSON.stringify(value)
  expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/)
  expect(text).not.toMatch(/node_modules|\/tmp\/|\/home\/|\/mnt\/|wfrun-|wfremote-/)
}

describe('reads', () => {
  it('lists, reads and validates', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    await h.writeWorkflow('broken', 'version: 1\nname: broken\nnodes: nope\n')
    const listed = await h.service.list(h.agent())
    if (!listed.ok) throw new Error(listed.message)
    expect(listed.workflows.map(w => [w.name, w.valid])).toEqual([['broken', false], ['demo', true]])
    expect(listed.workflows[1]).toMatchObject({ description: 'A demo workflow.', nodeCount: 2 })
    const read = await h.service.read(h.agent(), { name: 'demo' })
    expect(read).toMatchObject({ ok: true, name: 'demo', text: DEMO })
    const checked = await h.service.validate({ text: DEMO, name: 'demo' })
    expect(checked).toMatchObject({ ok: true })
    expect('graph' in checked && checked.graph?.nodes.map(n => n.id)).toEqual(['build', 'ask'])
    expect('layout' in checked && Object.keys(checked.layout?.positions ?? {})).toEqual(['build', 'ask'])
    expect(await h.service.validate({ text: 'nodes: nope', name: 'demo' })).toMatchObject({ ok: false })
  })

  it('answers invalid arguments and missing things with a located failure, never a throw or a path', async () => {
    h = await setupRemote()
    const a = h.agent()
    const results = [
      await h.service.read(a, { name: '../x' }),
      await h.service.read(a, { name: 'nope' }),
      await h.service.validate({ text: 'x', name: 'Bad Name' }),
      await h.service.dryRun(a, { name: 'nope' }),
      await h.service.runs(a, { limit: 0 }),
      await h.service.runs(a, { limit: 1000 }),
      await h.service.runs(a, { name: '../x' }),
      await h.service.runDetail(a, { runId: '../../etc' }),
      await h.service.runDetail(a, { runId: 'no-such-run' }),
      await h.service.nodeOutput(a, { runId: 'r', nodeId: 'UP', offset: 0, limit: 10 }),
      await h.service.nodeOutput(a, { runId: 'r', nodeId: 'n', offset: -1, limit: 10 }),
      await h.service.nodeOutput(a, { runId: 'r', nodeId: 'n', offset: 0, limit: 10_000_000 }),
      await h.service.nodeOutput(a, { runId: 'no-such-run', nodeId: 'n', offset: 0, limit: 10 }),
      await h.service.approve(a, { runId: 'x y', approvalId: 'a' }),
      await h.service.cancel(a, { runId: '../x' }),
      await h.service.run(a, { name: 'demo', trustHash: 'zz' }),
      await h.service.run(a, { name: 'demo', trustChallenge: 'zz' }),
      await h.service.resume(a, { runId: '../x' }),
      await h.service.attachUi(a, { leaseId: 'bad' }),
      await h.service.detachUi(a, { leaseId: 'bad' }),
      await h.service.save(a, { name: 'x/y', text: 't', expectedToken: null }),
      await h.service.list(h.agent('nocwd', null)),
    ]
    for (const result of results) {
      failed(result)
      noLeak(result)
    }
    expect(failed(results[results.length - 1]).error).toBe('NO_WORKSPACE')
    expect(failed(results[8]).error).toBe('NOT_FOUND')
  })

  it('reports an unavailable runner for run control but still serves file reads', async () => {
    h = await setupRemote({ engine: false })
    await h.writeWorkflow('demo', DEMO)
    expect(await h.service.read(h.agent(), { name: 'demo' })).toMatchObject({ ok: true })
  })
})

describe('dryRun', () => {
  it('describes the plan and spawns nothing: no shell call, no engine run, no store record', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const plan = await h.service.dryRun(h.agent(), { name: 'demo', inputs: { topic: 'x' } })
    if (!plan.ok) throw new Error(plan.message)
    expect(plan).toMatchObject({ name: 'demo', trusted: false, plan: ['build', 'ask'] })
    expect(plan.trustChallenge).toMatch(/^[0-9a-f]+$/)
    expect(plan.confirmText).toContain('echo building')
    expect(plan.trust.bashCommands[0]).toMatchObject({ nodeId: 'build', command: 'echo building $inputs.topic' })
    expect(plan.manifest).toEqual([{ nodeId: 'build', gateKind: 'bash' }, { nodeId: 'ask', gateKind: 'approval' }])
    expect(h.shell.runCalls).toEqual([])
    expect(h.engine.runs).toHaveLength(0)
    const runs = await h.service.runs(h.agent(), {})
    expect(runs).toMatchObject({ ok: true, runs: [] })
  })

  it('rejects inputs that do not match the declaration', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    expect(failed(await h.service.dryRun(h.agent(), { name: 'demo', inputs: { nope: 1 } })).error).toBe('INVALID_INPUT')
  })
})

describe('run, cancel, approve and the trust challenge over the Remote methods', () => {
  const trustedRun = async (r: Remote) => {
    const agent = r.agent()
    const plan = await r.service.dryRun(agent, { name: 'demo' })
    if (!plan.ok) throw new Error(plan.message)
    const started = await r.service.run(agent, { name: 'demo', trustHash: plan.trustKey, ...plan.trustChallenge === undefined ? {} : { trustChallenge: plan.trustChallenge } })
    if (!started.ok) throw new Error(started.message)
    return { agent, runId: started.runId }
  }

  it('refuses the trust key without its challenge, and a replayed challenge', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const agent = h.agent()
    const plan = await h.service.dryRun(agent, { name: 'demo' })
    if (!plan.ok) throw new Error(plan.message)
    expect(failed(await h.service.run(agent, { name: 'demo', trustHash: plan.trustKey })).error).toBe('TRUST_REQUIRED')
    expect(failed(await h.service.run(agent, { name: 'demo' })).error).toBe('TRUST_REQUIRED')
    // A wrong key spends the challenge; the right key with the same challenge is then a replay.
    expect(failed(await h.service.run(agent, { name: 'demo', trustHash: '0'.repeat(64), trustChallenge: plan.trustChallenge! })).error).toBe('TRUST_REQUIRED')
    expect(failed(await h.service.run(agent, { name: 'demo', trustHash: plan.trustKey, trustChallenge: plan.trustChallenge! })).error).toBe('TRUST_REQUIRED')
    expect(h.engine.runs).toHaveLength(0)
  })

  it('a plan from superseded content cannot run; a fresh dryRun after the edit can', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const agent = h.agent()
    const old = await h.service.dryRun(agent, { name: 'demo' })
    if (!old.ok) throw new Error(old.message)
    // Edit and save the file through the service, after the human reviewed the old plan.
    const read = await h.service.read(agent, { name: 'demo' })
    if (!read.ok) throw new Error(read.message)
    const saved = await h.service.save(agent, { name: 'demo', text: `${DEMO}# changed after review\n`, expectedToken: read.token })
    expect(saved).toMatchObject({ ok: true })
    const refused = failed(await h.service.run(agent, { name: 'demo', trustHash: old.trustKey, trustChallenge: old.trustChallenge! }))
    expect(refused.error).toBe('TRUST_REQUIRED')
    expect(refused.remedy).toMatch(/review the commands again/i)
    expect(h.engine.runs).toHaveLength(0)
    const fresh = await h.service.dryRun(agent, { name: 'demo' })
    if (!fresh.ok) throw new Error(fresh.message)
    expect(fresh.trustKey).not.toBe(old.trustKey)
    const started = await h.service.run(agent, { name: 'demo', trustHash: fresh.trustKey, trustChallenge: fresh.trustChallenge! })
    expect(started).toMatchObject({ ok: true })
    expect(h.engine.runs).toHaveLength(1)
  })

  it('a challenge from one session cannot be used by another', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const plan = await h.service.dryRun(h.agent('alice'), { name: 'demo' })
    if (!plan.ok) throw new Error(plan.message)
    const stolen = await h.service.run(h.agent('mallory'), { name: 'demo', trustHash: plan.trustKey, trustChallenge: plan.trustChallenge! })
    expect(failed(stolen).error).toBe('TRUST_REQUIRED')
    expect(h.engine.runs).toHaveLength(0)
  })

  it('starts with a valid confirmation, then cancel from another workspace is refused and from this one works', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const { agent, runId } = await trustedRun(h)
    expect(h.engine.runs).toHaveLength(1)
    const otherWorkspace = await h.scratch()
    const foreign = failed(await h.service.cancel(h.agent('other', otherWorkspace), { runId }))
    expect(foreign.error).toBe('NOT_FOUND')
    expect(h.engine.runs[0]!.cancels).toHaveLength(0)
    // Same workspace, another session: the run belongs to the session that started it.
    expect(failed(await h.service.cancel(h.agent('someone-else'), { runId })).error).toBe('NOT_FOUND')
    expect(h.engine.runs[0]!.cancels).toHaveLength(0)
    expect(await h.service.cancel(agent, { runId })).toMatchObject({ ok: true, status: 'cancelled' })
    expect(h.engine.runs[0]!.cancels).toEqual(['cancelled from the Workflows UI'])
    const detail = await h.service.runDetail(agent, { runId })
    expect(detail).toMatchObject({ ok: true, status: 'cancelled' })
  })

  it('an approval can be answered only from the workspace that owns the run, first answer wins', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const { agent, runId } = await trustedRun(h)
    const attached = await h.service.attachUi(agent, {})
    expect(attached).toMatchObject({ ok: true })
    const pending = h.engine.runs[0]!.request.approver!({ approvalId: 'e', nodeId: 'ask', message: 'Ship it?', signal: new AbortController().signal })
    await expect.poll(() => h!.ctx.workflowRuns.pendingApprovals().length).toBe(1)
    const listed = await h.service.pendingApprovals(agent)
    if (!listed.ok) throw new Error(listed.message)
    expect(listed.approvals).toHaveLength(1)
    const approvalId = listed.approvals[0]!.approvalId
    const other = h.agent('other', await h.scratch())
    expect(await h.service.pendingApprovals(other)).toEqual({ ok: true, approvals: [] })
    expect(failed(await h.service.approve(other, { runId, approvalId })).error).toBe('NOT_FOUND')
    expect(failed(await h.service.reject(other, { runId, approvalId })).error).toBe('NOT_FOUND')
    expect(await h.service.reject(agent, { runId, approvalId, reason: 'nope' })).toEqual({ ok: true, state: 'rejected' })
    expect(await pending).toBe('rejected')
    expect(failed(await h.service.approve(agent, { runId, approvalId })).error).toBe('NOT_PENDING')
    h.engine.runs[0]!.settle(COMPLETED)
  })
})

describe('attachUi leases', () => {
  it('opens a lease, keeps approvals waiting while it lives, and a lapse restores the fast reject', async () => {
    h = await setupRemote({ ui: false })
    await h.writeWorkflow('demo', DEMO)
    const agent = h.agent()
    const plan = await h.service.dryRun(agent, { name: 'demo' })
    if (!plan.ok) throw new Error(plan.message)
    await h.service.run(agent, { name: 'demo', trustHash: plan.trustKey, trustChallenge: plan.trustChallenge! })
    const ask = () => h!.engine.runs[0]!.request.approver!({ approvalId: 'e', nodeId: 'ask', message: 'q', signal: new AbortController().signal })
    // No lease: fails closed at once, even though the service itself subscribes to run events.
    expect(await ask()).toBe('rejected')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const lease = await h.service.attachUi(agent, {})
    if (!lease.ok) throw new Error(lease.message)
    expect(lease.ttlMs).toBe(WORKFLOW_ATTACH_TTL_MS)
    // A renewal before the lapse keeps it alive past the original deadline.
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_TTL_MS - 1000)
    expect(await h.service.attachUi(agent, { leaseId: lease.leaseId })).toMatchObject({ ok: true, leaseId: lease.leaseId })
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_TTL_MS - 1000)
    const waiting = ask()
    await vi.waitFor(() => { expect(h!.ctx.workflowRuns.pendingApprovals()).toHaveLength(1) })
    const approvalId = h.ctx.workflowRuns.pendingApprovals()[0]!.approvalId
    const runId = h.ctx.workflowRuns.pendingApprovals()[0]!.runId
    await h.service.approve(agent, { runId, approvalId })
    expect(await waiting).toBe('allowed-once')
    // Without another renewal the lease lapses on its own and the next approval fails closed.
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_TTL_MS + 1)
    expect(await ask()).toBe('rejected')
  })

  it('detach releases at once; another session cannot release or renew it; detach is idempotent', async () => {
    h = await setupRemote({ ui: false })
    const agent = h.agent()
    const lease = await h.service.attachUi(agent, {})
    if (!lease.ok) throw new Error(lease.message)
    const stranger = h.agent('stranger')
    await h.service.detachUi(stranger, { leaseId: lease.leaseId })
    const renewedByStranger = await h.service.attachUi(stranger, { leaseId: lease.leaseId })
    if (!renewedByStranger.ok) throw new Error(renewedByStranger.message)
    expect(renewedByStranger.leaseId).not.toBe(lease.leaseId)
    expect(await h.service.detachUi(agent, { leaseId: lease.leaseId })).toEqual({ ok: true })
    expect(await h.service.detachUi(agent, { leaseId: lease.leaseId })).toEqual({ ok: true })
    await h.service.detachUi(stranger, { leaseId: renewedByStranger.leaseId })
  })

  it('caps the number of leases', async () => {
    h = await setupRemote({ ui: false })
    for (let i = 0; i < 32; i += 1) expect(await h.service.attachUi(h.agent(), {})).toMatchObject({ ok: true })
    expect(failed(await h.service.attachUi(h.agent(), {})).error).toBe('LIMIT')
  })
})

describe('pushed events', () => {
  it('forwards run and approval changes as ids and status only', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const seen: { name: string; payload: Record<string, unknown> }[] = []
    const ctx = h.ctx as unknown as { on(name: string, fn: (payload: Record<string, unknown>) => void): () => void }
    for (const name of ['workflow/run-changed', 'workflow/approval-pending', 'workflow/approval-decided']) {
      ctx.on(name, (payload) => { seen.push({ name, payload }) })
    }
    const agent = h.agent()
    const plan = await h.service.dryRun(agent, { name: 'demo' })
    if (!plan.ok) throw new Error(plan.message)
    const started = await h.service.run(agent, { name: 'demo', trustHash: plan.trustKey, trustChallenge: plan.trustChallenge! })
    if (!started.ok) throw new Error(started.message)
    await h.service.attachUi(agent, {})
    const pending = h.engine.runs[0]!.request.approver!({ approvalId: 'e', nodeId: 'ask', message: 'Ship\u0007 it?', signal: new AbortController().signal })
    await expect.poll(() => h!.ctx.workflowRuns.pendingApprovals().length).toBe(1)
    const waiting = h.ctx.workflowRuns.pendingApprovals()[0]!
    await h.service.approve(agent, { runId: started.runId, approvalId: waiting.approvalId })
    await pending
    h.engine.runs[0]!.settle(COMPLETED)
    await expect.poll(() => seen.some(e => e.name === 'workflow/run-changed' && e.payload.status === 'completed')).toBe(true)
    const names = seen.map(e => e.name)
    expect(names).toContain('workflow/approval-pending')
    expect(names).toContain('workflow/approval-decided')
    const allowed = new Set(['runId', 'status', 'nodeId', 'nodeStatus', 'approvalId', 'state', 'workspaceKey'])
    for (const event of seen) for (const key of Object.keys(event.payload)) expect(allowed.has(key)).toBe(true)
    const pendingEvent = seen.find(e => e.name === 'workflow/approval-pending')!
    const key = (await h.service.list(agent) as { workspaceKey: string }).workspaceKey
    expect(pendingEvent.payload).toEqual({ runId: started.runId, approvalId: waiting.approvalId, nodeId: 'ask', workspaceKey: key })
    expect(JSON.stringify(seen)).not.toContain('Ship')
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(key).not.toBe((await h.service.list(h.agent('other', await h.scratch())) as { workspaceKey: string }).workspaceKey)
    for (const event of seen) expect(event.payload.workspaceKey).toBe(key)
    expect(seen.find(e => e.name === 'workflow/approval-decided')!.payload).toEqual({
      runId: started.runId, approvalId: waiting.approvalId, state: 'allowed', workspaceKey: key,
    })
  })
})

describe('runDetail and nodeOutput', () => {
  it('carries the real attempt count and the coded stop on the highest-attempt row only', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const agent = h.agent()
    const plan = await h.service.dryRun(agent, { name: 'demo' })
    if (!plan.ok) throw new Error(plan.message)
    const started = await h.service.run(agent, { name: 'demo', trustHash: plan.trustKey, trustChallenge: plan.trustChallenge! })
    if (!started.ok) throw new Error(started.message)
    const run = h.engine.runs[0]!
    run.nodeStart({ nodeId: 'think', kind: 'prompt' })
    run.nodeEnd({
      nodeId: 'think', kind: 'prompt', status: 'failed', attempts: 2,
      error: 'NODE_STALLED: the agent produced no output for 5000 ms (idleTimeoutMs) after 2 attempts (1 retry)',
      failure: {
        code: 'NODE_STALLED', message: 'the agent produced no output for 5000 ms (idleTimeoutMs) after 2 attempts (1 retry)',
        remedy: "raise idleTimeoutMs for this node or check the agent's output",
      },
    })
    run.nodeStart({ nodeId: 'build', kind: 'bash' })
    run.nodeEnd({ nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0 })
    run.settle(COMPLETED)
    await expect.poll(async () => (await h!.service.runDetail(agent, { runId: started.runId }) as { status?: string }).status).not.toBe('running')
    const detail = await h.service.runDetail(agent, { runId: started.runId })
    if (!detail.ok) throw new Error(detail.message)
    const think = detail.nodes.filter(n => n.nodeId === 'think')
    expect(think.map(n => n.attempt).sort()).toEqual([1, 2])
    const last = think.find(n => n.attempt === 2)!
    expect(last.attempts).toBe(2)
    expect(last.failure).toMatchObject({ code: 'NODE_STALLED', remedy: "raise idleTimeoutMs for this node or check the agent's output" })
    expect(last.failure!.message).toContain('5000 ms')
    expect(last.failure!.message.length).toBeLessThanOrEqual(500)
    const first = think.find(n => n.attempt === 1)!
    expect(first).not.toHaveProperty('attempts')
    expect(first).not.toHaveProperty('failure')
    const build = detail.nodes.find(n => n.nodeId === 'build')!
    expect(build).not.toHaveProperty('attempts')
    expect(build).not.toHaveProperty('failure')
    noLeak(detail)
  })

  it('returns exactly the persisted failure, and none for an older record whose error only looks coded', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const agent = h.agent()
    const plan = await h.service.dryRun(agent, { name: 'demo' })
    if (!plan.ok) throw new Error(plan.message)
    const started = await h.service.run(agent, { name: 'demo', trustHash: plan.trustKey, trustChallenge: plan.trustChallenge! })
    if (!started.ok) throw new Error(started.message)
    const run = h.engine.runs[0]!
    const persisted = { code: 'NODE_TIMEOUT' as const, message: 'persisted message', remedy: 'persisted remedy, not the old table' }
    run.nodeStart({ nodeId: 'slow', kind: 'prompt' })
    run.nodeEnd({ nodeId: 'slow', kind: 'prompt', status: 'failed', error: 'NODE_TIMEOUT: persisted message', failure: persisted })
    run.nodeStart({ nodeId: 'old', kind: 'prompt' })
    // An older record: the error text begins with a code but no failure was stored. Nothing is guessed from the text.
    run.nodeEnd({ nodeId: 'old', kind: 'prompt', status: 'failed', error: 'NODE_STALLED: written before failure was persisted' })
    run.settle(COMPLETED)
    await expect.poll(async () => (await h!.service.runDetail(agent, { runId: started.runId }) as { status?: string }).status).not.toBe('running')
    const detail = await h.service.runDetail(agent, { runId: started.runId })
    if (!detail.ok) throw new Error(detail.message)
    expect(detail.nodes.find(n => n.nodeId === 'slow')!.failure).toEqual(persisted)
    expect(detail.nodes.find(n => n.nodeId === 'old')).not.toHaveProperty('failure')
  })

  it('projects the run without raw output and serves output in bounded slices', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const agent = h.agent()
    const plan = await h.service.dryRun(agent, { name: 'demo' })
    if (!plan.ok) throw new Error(plan.message)
    const started = await h.service.run(agent, { name: 'demo', trustHash: plan.trustKey, trustChallenge: plan.trustChallenge! })
    if (!started.ok) throw new Error(started.message)
    const run = h.engine.runs[0]!
    run.nodeStart({ nodeId: 'build', kind: 'bash', gateKind: 'bash' })
    run.request.onBashOutput?.({ nodeId: 'build' }, 'stdout', Buffer.alloc(0))
    run.request.onBashOutput?.({ nodeId: 'build' }, 'stdout', Buffer.from('hello world\n'))
    run.nodeEnd({ nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0, durationMs: 4 })
    run.gate({ nodeId: 'build', gateKind: 'bash', outcome: 'fired-pass' })
    run.settle(COMPLETED)
    await expect.poll(async () => (await h!.service.runDetail(agent, { runId: started.runId }) as { status?: string }).status).toBe('completed')
    const detail = await h.service.runDetail(agent, { runId: started.runId })
    if (!detail.ok) throw new Error(detail.message)
    expect(detail).toMatchObject({ name: 'demo', pinnedHash: plan.hash, fileChanged: false })
    expect(detail.nodes.find(n => n.nodeId === 'build')).toMatchObject({ status: 'success', exitCode: 0, hasOutput: true })
    expect(JSON.stringify(detail)).not.toContain('hello world')
    const slice = await h.service.nodeOutput(agent, { runId: started.runId, nodeId: 'build', offset: 0, limit: 5 })
    expect(slice).toMatchObject({ ok: true, text: 'hello', nextOffset: 5, totalBytes: 11 })
    const rest = await h.service.nodeOutput(agent, { runId: started.runId, nodeId: 'build', offset: 5, limit: 100 })
    expect(rest).toMatchObject({ ok: true, text: ' world' })
    const page = await h.service.runs(agent, { name: 'demo', limit: 5 })
    expect(page).toMatchObject({ ok: true })
    if (page.ok) {
      expect(page.runs).toHaveLength(1)
      expect(JSON.stringify(page)).not.toContain('ownerPid')
    }
    const again = await h.service.list(agent)
    if (again.ok) expect(again.workflows[0]!.lastRun).toMatchObject({ runId: started.runId, status: 'completed' })
  })
})

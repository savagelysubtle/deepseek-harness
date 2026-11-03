/** WorkflowsController: lease lifecycle, workspace-key event filtering, editor, dry-run/trust flow, run actions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKFLOW_ATTACH_RENEW_MS, WORKFLOW_ATTACH_TTL_MS } from '@deepseek-ai/dsh-workflow-remote/client'
import type { WorkflowApprovalDecided, WorkflowApprovalPending, WorkflowRunChange } from '@deepseek-ai/dsh-workflow-remote/client'
import { createWorkflowApi } from '../src/client/api.ts'
import { WorkflowsController, workflowTemplate } from '../src/client/controller.ts'
import type { WorkflowEventSource } from '../src/client/controller.ts'
import {
  carrierFailure, DETAIL, fail, flush, hostValue, KEY, makeRemote, OTHER_KEY, PLAN, SESSION, TRUSTED_PLAN,
} from './fixtures.client.ts'

interface Handlers {
  runChanged(change: WorkflowRunChange): void
  approvalPending(approval: WorkflowApprovalPending): void
  approvalDecided(decision: WorkflowApprovalDecided): void
}

function setup() {
  const remote = makeRemote()
  let handlers: Handlers | undefined
  const unsubscribe = vi.fn()
  const events: WorkflowEventSource = { subscribe: (h) => { handlers = h; return unsubscribe } }
  const controller = new WorkflowsController(createWorkflowApi(remote.asRemote, SESSION), events)
  return { remote, controller, unsubscribe, emit: () => handlers! }
}

async function started() {
  const ctx = setup()
  ctx.controller.start()
  await flush()
  return ctx
}

/** Started controller with the `build` file open in the editor. */
async function ready() {
  const ctx = await started()
  await ctx.controller.selectWorkflow('build')
  await flush()
  return ctx
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('lease lifecycle', () => {
  it('attaches on start, loads the three lists, and records the workspace key', async () => {
    const { remote, controller } = await started()
    expect(remote.attachUi).toHaveBeenCalledTimes(1)
    expect(remote.attachUi).toHaveBeenCalledWith(SESSION, {})
    const state = controller.getSnapshot()
    expect(state.lease).toEqual({ state: 'attached' })
    expect(state.workspaceKey).toBe(KEY)
    expect(state.list.items).toHaveLength(2)
    expect(state.runs.items).toHaveLength(2)
    expect(state.approvals.items).toHaveLength(1)
    controller.dispose()
  })

  it('start is idempotent', async () => {
    const { remote, controller } = await started()
    controller.start()
    await flush()
    expect(remote.attachUi).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('renews the held lease every 15 seconds', async () => {
    const { remote, controller } = await started()
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS)
    }
    const renewals = remote.attachUi.mock.calls.slice(1)
    expect(renewals).toHaveLength(3)
    for (const call of renewals) expect(call).toEqual([SESSION, { leaseId: 'l'.repeat(32) }])
    expect(controller.getSnapshot().lease.state).toBe('attached')
    controller.dispose()
  })

  it('shows a failed renewal as lapsed with the Host reason and remedy, then re-attaches fresh', async () => {
    const { remote, controller } = await started()
    remote.attachUi.mockResolvedValueOnce(hostValue(fail('NOT_FOUND', { remedy: 'Reopen the panel.' })))
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS)
    const lapsed = controller.getSnapshot().lease
    expect(lapsed.state).toBe('lapsed')
    expect(lapsed.failure).toMatchObject({ error: 'NOT_FOUND', message: 'NOT_FOUND happened', remedy: 'Reopen the panel.' })
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS)
    expect(remote.attachUi.mock.calls.at(-1)).toEqual([SESSION, {}])
    expect(controller.getSnapshot().lease).toEqual({ state: 'attached' })
    controller.dispose()
  })

  it('lapses on its own when a renewal hangs past the lease ttl', async () => {
    const { remote, controller } = await started()
    remote.attachUi.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_TTL_MS + 1)
    const lease = controller.getSnapshot().lease
    expect(lease.state).toBe('lapsed')
    expect(lease.failure).toMatchObject({ error: 'LEASE_LAPSED' })
    controller.dispose()
  })

  it('says the lease is refused (not merely lapsed) on a loopback 403 and stops retrying', async () => {
    const remote = makeRemote()
    remote.attachUi.mockResolvedValue(carrierFailure('transport failure for workflow/attachUi: HTTP 403'))
    const controller = new WorkflowsController(createWorkflowApi(remote.asRemote, SESSION), { subscribe: () => () => {} })
    controller.start()
    await flush()
    const lease = controller.getSnapshot().lease
    expect(lease.state).toBe('refused')
    expect(lease.failure).toMatchObject({ error: 'LOOPBACK_ONLY', loopbackOnly: true })
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS * 4)
    expect(remote.attachUi).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('stops retrying after a renewal is refused with a loopback 403', async () => {
    const { remote, controller } = await started()
    remote.attachUi.mockResolvedValue(carrierFailure('HTTP 403'))
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS)
    expect(controller.getSnapshot().lease.state).toBe('refused')
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS * 3)
    expect(remote.attachUi).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('detaches on dispose, stops the timers and the subscription, and ignores later changes', async () => {
    const { remote, controller, unsubscribe } = await started()
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispose()
    controller.dispose()
    expect(remote.detachUi).toHaveBeenCalledTimes(1)
    expect(remote.detachUi).toHaveBeenCalledWith(SESSION, { leaseId: 'l'.repeat(32) })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const calls = remote.attachUi.mock.calls.length
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_TTL_MS * 2)
    expect(remote.attachUi).toHaveBeenCalledTimes(calls)
    controller.setTab('runs')
    expect(listener).not.toHaveBeenCalled()
  })

  it('releases a lease that arrives after the overlay already closed', async () => {
    const { remote, controller } = setup()
    controller.start()
    controller.dispose()
    await flush()
    expect(remote.detachUi).toHaveBeenCalledTimes(1)
    const refusedAfterClose = makeRemote()
    refusedAfterClose.attachUi.mockResolvedValue(carrierFailure('HTTP 403'))
    const second = new WorkflowsController(createWorkflowApi(refusedAfterClose.asRemote, SESSION), { subscribe: () => () => {} })
    second.start()
    second.dispose()
    await flush()
    expect(refusedAfterClose.detachUi).not.toHaveBeenCalled()
  })

  it('disposing before any lease exists detaches nothing', () => {
    const { remote, controller } = setup()
    controller.dispose()
    expect(remote.detachUi).not.toHaveBeenCalled()
  })
})

describe('event filtering by workspace key', () => {
  it('ignores events from another workspace, events with no key, and events before the key is known', async () => {
    const early = setup()
    early.remote.attachUi.mockImplementation(() => new Promise(() => {}))
    early.remote.list.mockImplementation(() => new Promise(() => {}))
    early.remote.runs.mockImplementation(() => new Promise(() => {}))
    early.controller.start()
    await flush()
    early.emit().runChanged({ runId: 'r1', status: 'running', workspaceKey: KEY })
    await flush()
    expect(early.remote.runs).toHaveBeenCalledTimes(1)
    early.controller.dispose()

    const { remote, controller, emit } = await started()
    const baseline = {
      runs: remote.runs.mock.calls.length, list: remote.list.mock.calls.length, pending: remote.pendingApprovals.mock.calls.length,
    }
    emit().runChanged({ runId: 'r1', status: 'running', workspaceKey: OTHER_KEY })
    emit().runChanged({ runId: 'r1', status: 'running' })
    emit().approvalPending({ runId: 'r1', approvalId: 'a', nodeId: 'n', workspaceKey: OTHER_KEY })
    emit().approvalPending({ runId: 'r1', approvalId: 'a', nodeId: 'n' })
    emit().approvalDecided({ runId: 'r1', approvalId: 'a', state: 'allowed', workspaceKey: OTHER_KEY })
    await flush()
    expect(remote.runs).toHaveBeenCalledTimes(baseline.runs)
    expect(remote.list).toHaveBeenCalledTimes(baseline.list)
    expect(remote.pendingApprovals).toHaveBeenCalledTimes(baseline.pending)
    controller.dispose()
  })

  it('refreshes runs, the workflow list and the open run for an event from its own workspace', async () => {
    const { remote, controller, emit } = await started()
    await controller.openRun('r1')
    const before = { runs: remote.runs.mock.calls.length, list: remote.list.mock.calls.length, detail: remote.runDetail.mock.calls.length }
    emit().runChanged({ runId: 'r1', status: 'running', nodeId: 'ship', nodeStatus: 'running', workspaceKey: KEY })
    await flush()
    expect(remote.runs).toHaveBeenCalledTimes(before.runs + 1)
    expect(remote.list).toHaveBeenCalledTimes(before.list + 1)
    expect(remote.runDetail).toHaveBeenCalledTimes(before.detail + 1)
    emit().runChanged({ runId: 'unrelated', status: 'running', workspaceKey: KEY })
    await flush()
    expect(remote.runDetail).toHaveBeenCalledTimes(before.detail + 1)
    controller.dispose()
  })

  it('reloads the pending approvals and the open run on approval events, coalescing a burst', async () => {
    const { remote, controller, emit } = await started()
    await controller.openRun('r1')
    const pending = remote.pendingApprovals.mock.calls.length
    const detail = remote.runDetail.mock.calls.length
    emit().approvalPending({ runId: 'r1', approvalId: 'a', nodeId: 'n', workspaceKey: KEY })
    emit().approvalDecided({ runId: 'r1', approvalId: 'a', state: 'allowed', workspaceKey: KEY })
    emit().approvalDecided({ runId: 'r1', approvalId: 'a', state: 'allowed', workspaceKey: KEY })
    await flush(20)
    expect(remote.pendingApprovals.mock.calls.length - pending).toBeLessThanOrEqual(2)
    expect(remote.pendingApprovals.mock.calls.length).toBeGreaterThan(pending)
    expect(remote.runDetail.mock.calls.length).toBeGreaterThan(detail)
    controller.dispose()
  })
})

describe('editor', () => {
  it('reads a file, validates it, and takes the declared inputs from the validation', async () => {
    const { remote, controller } = await started()
    await controller.selectWorkflow('build')
    await flush()
    const editor = controller.getSnapshot().editor!
    expect(editor).toMatchObject({ name: 'build', text: 'version: 1\nname: build\n', token: 'tok-1', loading: false, isNew: false })
    expect(editor.inputs.map(input => input.name)).toEqual(['target', 'count', 'fast'])
    expect(remote.validate).toHaveBeenCalledWith({ text: editor.text, name: 'build' })
    controller.dispose()
  })

  it('shows a read failure on the editor', async () => {
    const { remote, controller } = await started()
    remote.read.mockResolvedValue(hostValue(fail('NOT_FOUND', { remedy: 'Refresh the list.' })))
    await controller.selectWorkflow('gone')
    expect(controller.getSnapshot().editor).toMatchObject({ loading: false, failure: { error: 'NOT_FOUND' } })
    controller.dispose()
  })

  it('applies only the newest validation and a newer selection beats a slower read', async () => {
    const { remote, controller } = await started()
    await controller.selectWorkflow('build')
    await flush()
    const slow = Promise.withResolvers<unknown>()
    remote.validate.mockImplementationOnce(() => slow.promise)
    const first = controller.validate('one')
    remote.validate.mockResolvedValueOnce(hostValue({ ok: false, diagnostics: [{ severity: 'error', code: 'x', message: 'bad', line: 1, column: 1, path: [] }] }))
    await controller.validate('two')
    slow.resolve(hostValue({ ok: true, diagnostics: [] }))
    await first
    expect(controller.getSnapshot().editor!.diagnostics).toHaveLength(1)

    const slowRead = Promise.withResolvers<unknown>()
    remote.read.mockImplementationOnce(() => slowRead.promise)
    const stale = controller.selectWorkflow('broken')
    await controller.selectWorkflow('build')
    slowRead.resolve(hostValue({ ok: true, name: 'broken', text: 'OLD', token: 't' }))
    await stale
    expect(controller.getSnapshot().editor).toMatchObject({ name: 'build' })
    expect(controller.getSnapshot().editor!.text).not.toBe('OLD')
    controller.dispose()
  })

  it('validate and edit are no-ops without an open editor; a validate failure lands on the editor', async () => {
    const { remote, controller } = await started()
    await controller.validate('x')
    controller.edit('x')
    expect(remote.validate).not.toHaveBeenCalled()
    await controller.selectWorkflow('build')
    await flush()
    remote.validate.mockResolvedValueOnce(carrierFailure('HTTP 500'))
    await controller.validate('x')
    expect(controller.getSnapshot().editor!.failure).toMatchObject({ error: 'TRANSPORT' })
    controller.dispose()
  })

  it('saves with the loaded token, resets the baseline, and refreshes the list', async () => {
    const { remote, controller } = await started()
    await controller.selectWorkflow('build')
    await flush()
    controller.edit('new text')
    const listCalls = remote.list.mock.calls.length
    await controller.save('new text', 'tok-1')
    await flush()
    expect(remote.save).toHaveBeenCalledWith(SESSION, { name: 'build', text: 'new text', expectedToken: 'tok-1' })
    expect(controller.getSnapshot().editor).toMatchObject({ token: 'tok-2', savedText: 'new text', justSaved: true, conflict: false, saving: false })
    expect(remote.list.mock.calls.length).toBeGreaterThan(listCalls)
    controller.dispose()
  })

  it('shows the folder-flush warning of a save that succeeded', async () => {
    const { remote, controller } = await started()
    await controller.selectWorkflow('build')
    await flush()
    remote.save.mockResolvedValue(hostValue({ ok: true, token: 'tok-3', diagnostics: [], warning: 'Saved, but the folder was not flushed.' }))
    await controller.save('x', 'tok-1')
    expect(controller.getSnapshot().editor).toMatchObject({ token: 'tok-3', warning: 'Saved, but the folder was not flushed.', failure: undefined })
    controller.dispose()
  })

  it('raises the conflict state on a lost race, keeping the edits, and reload re-reads the file', async () => {
    const { remote, controller } = await started()
    await controller.selectWorkflow('build')
    await flush()
    controller.edit('mine')
    remote.save.mockResolvedValue(hostValue(fail('CONFLICT', { conflict: true, currentToken: 'tok-9', remedy: 'Reload the file.' })))
    await controller.save('mine', 'tok-1')
    let editor = controller.getSnapshot().editor!
    expect(editor).toMatchObject({ conflict: true, text: 'mine', saving: false, failure: { error: 'CONFLICT', remedy: 'Reload the file.' } })
    remote.read.mockResolvedValue(hostValue({ ok: true, name: 'build', text: 'theirs', token: 'tok-9' }))
    await controller.reload()
    editor = controller.getSnapshot().editor!
    expect(editor).toMatchObject({ conflict: false, text: 'theirs', token: 'tok-9' })
    controller.dispose()
  })

  it('takes diagnostics from a refused save and ignores a second save while one is running', async () => {
    const { remote, controller } = await started()
    await controller.selectWorkflow('build')
    await flush()
    const diagnostic = { severity: 'error' as const, code: 'x', message: 'bad', line: 1, column: 1, path: [] }
    const slow = Promise.withResolvers<unknown>()
    remote.save.mockImplementationOnce(() => slow.promise)
    const first = controller.save('x', 'tok-1')
    await controller.save('x', 'tok-1')
    expect(remote.save).toHaveBeenCalledTimes(1)
    slow.resolve(hostValue(fail('DIAGNOSTICS', { diagnostics: [diagnostic] })))
    await first
    expect(controller.getSnapshot().editor).toMatchObject({ diagnostics: [diagnostic], conflict: false })
    controller.dispose()
  })

  it('creates a new file from a template and saves it with a null token', async () => {
    const { remote, controller } = await started()
    expect(controller.newWorkflow('Bad Name')).toBe('invalid')
    expect(controller.newWorkflow('build')).toBe('exists')
    expect(controller.newWorkflow('fresh-one')).toBeUndefined()
    const editor = controller.getSnapshot().editor!
    expect(editor).toMatchObject({ name: 'fresh-one', isNew: true, text: workflowTemplate('fresh-one') })
    await controller.save(editor.text, editor.token)
    expect(remote.save).toHaveBeenCalledWith(SESSION, { name: 'fresh-one', text: editor.text, expectedToken: null })
    expect(controller.getSnapshot().editor).toMatchObject({ isNew: false, token: 'tok-2' })
    controller.dispose()
  })

  it('save and reload do nothing without an editor', async () => {
    const { remote, controller } = await started()
    await controller.save('x', 't')
    await controller.reload()
    expect(remote.save).not.toHaveBeenCalled()
    controller.dispose()
  })
})

describe('dry run, trust and run', () => {
  it('refuses to plan unsaved or new text, asking for a save first', async () => {
    const { remote, controller } = await ready()
    controller.edit('changed')
    await controller.dryRun()
    expect(remote.dryRun).not.toHaveBeenCalled()
    expect(controller.getSnapshot().editor!.saveFirst).toBe(true)
    controller.newWorkflow('fresh')
    await controller.dryRun()
    expect(remote.dryRun).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('dryRun, setInput, startRun and closeDryRun are no-ops without an editor or plan', async () => {
    const { remote, controller } = await started()
    await controller.dryRun()
    controller.setInput('a', 1)
    controller.setAck(true)
    await controller.startRun()
    controller.closeDryRun()
    expect(remote.dryRun).not.toHaveBeenCalled()
    expect(remote.run).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('plans the saved file and shows a plan failure', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    expect(controller.getSnapshot().dryRun).toMatchObject({ status: 'ready', plan: { name: 'build' } })
    expect(remote.dryRun).toHaveBeenCalledWith(SESSION, { name: 'build' })
    remote.dryRun.mockResolvedValue(hostValue(fail('INVALID_INPUT', { remedy: 'Give a target.' })))
    await controller.dryRun()
    expect(controller.getSnapshot().dryRun).toMatchObject({ status: 'failed', failure: { error: 'INVALID_INPUT' } })
    controller.dispose()
  })

  it('passes input values to the plan and marks the plan stale when an input changes', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    controller.setInput('target', 'prod')
    expect(controller.getSnapshot().dryRun).toMatchObject({ stale: true, inputValues: { target: 'prod' } })
    controller.setAck(true)
    await controller.startRun()
    expect(remote.run).not.toHaveBeenCalled()
    await controller.dryRun()
    expect(remote.dryRun).toHaveBeenLastCalledWith(SESSION, { name: 'build', inputs: { target: 'prod' } })
    controller.setInput('target', undefined)
    expect(controller.getSnapshot().dryRun!.inputValues).toEqual({})
    controller.dispose()
  })

  it('will not start an untrusted plan until the human confirmed, then sends the key and the challenge', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    await controller.startRun()
    expect(remote.run).not.toHaveBeenCalled()
    controller.setInput('target', 'prod')
    await controller.dryRun()
    controller.setAck(true)
    await controller.startRun()
    expect(remote.run).toHaveBeenCalledWith(SESSION, {
      name: 'build', inputs: { target: 'prod' }, trustHash: PLAN.trustKey, trustChallenge: PLAN.trustChallenge,
    })
    expect(controller.getSnapshot().dryRun).toMatchObject({ startedRunId: 'r9', starting: false })
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ tab: 'runs', detail: { runId: 'r9' } })
    controller.dispose()
  })

  it('treats a refused trusted-run attempt as spent and demands a fresh plan', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    remote.run.mockResolvedValue(hostValue(fail('TRUST_DENIED', { remedy: 'Refresh the plan.' })))
    controller.setAck(true)
    await controller.startRun()
    expect(controller.getSnapshot().dryRun).toMatchObject({ spent: true, starting: false, startFailure: { error: 'TRUST_DENIED', remedy: 'Refresh the plan.' } })
    controller.setAck(true)
    await controller.startRun()
    expect(remote.run).toHaveBeenCalledTimes(1)
    await controller.dryRun()
    expect(controller.getSnapshot().dryRun!.spent).toBe(false)
    controller.dispose()
  })

  it('runs an already-trusted plan without trust fields and a failure there is not "spent"', async () => {
    const { remote, controller } = await ready()
    remote.dryRun.mockResolvedValue(hostValue(TRUSTED_PLAN))
    await controller.dryRun()
    remote.run.mockResolvedValueOnce(hostValue(fail('WRITER_BUSY')))
    await controller.startRun()
    expect(remote.run).toHaveBeenLastCalledWith(SESSION, { name: 'build' })
    expect(controller.getSnapshot().dryRun).toMatchObject({ spent: false, startFailure: { error: 'WRITER_BUSY' } })
    await controller.startRun()
    expect(controller.getSnapshot().dryRun!.startedRunId).toBe('r9')
    controller.dispose()
  })

  it('omits the challenge key when the plan carries none and drops a plan that arrives after it was closed', async () => {
    const { remote, controller } = await ready()
    remote.dryRun.mockResolvedValue(hostValue({ ...PLAN, trustChallenge: undefined }))
    await controller.dryRun()
    controller.setAck(true)
    await controller.startRun()
    expect(remote.run).toHaveBeenCalledWith(SESSION, { name: 'build', trustHash: PLAN.trustKey })

    const slow = Promise.withResolvers<unknown>()
    remote.dryRun.mockImplementationOnce(() => slow.promise)
    const pending = controller.dryRun()
    controller.closeDryRun()
    slow.resolve(hostValue(PLAN))
    await pending
    expect(controller.getSnapshot().dryRun).toBeNull()
    controller.dispose()
  })
})

describe('runs and run actions', () => {
  it('loads more runs by cursor and shows list failures', async () => {
    const { remote, controller } = await started()
    await controller.loadMoreRuns()
    expect(remote.runs).toHaveBeenCalledTimes(1)
    remote.runs.mockResolvedValueOnce(hostValue({ ok: true, workspaceKey: KEY, runs: [{ runId: 'a', name: 'n', hash: 'h', startedAt: 1, status: 'success' }], nextCursor: 'c1' }))
    await controller.loadRuns()
    expect(controller.getSnapshot().runs.nextCursor).toBe('c1')
    remote.runs.mockResolvedValueOnce(hostValue({ ok: true, workspaceKey: KEY, runs: [{ runId: 'b', name: 'n', hash: 'h', startedAt: 1, status: 'success' }] }))
    await controller.loadMoreRuns()
    expect(remote.runs).toHaveBeenLastCalledWith(SESSION, { limit: 50, cursor: 'c1' })
    expect(controller.getSnapshot().runs.items.map(run => run.runId)).toEqual(['a', 'b'])
    expect(controller.getSnapshot().runs.nextCursor).toBeUndefined()
    remote.runs.mockResolvedValueOnce(hostValue({ ok: true, workspaceKey: KEY, runs: [], nextCursor: 'c2' }))
    await controller.loadRuns()
    remote.runs.mockResolvedValueOnce(carrierFailure('HTTP 500'))
    await controller.loadMoreRuns()
    expect(controller.getSnapshot().runs).toMatchObject({ status: 'failed', failure: { error: 'TRANSPORT' } })
    remote.list.mockResolvedValueOnce(carrierFailure('HTTP 500'))
    await controller.loadList()
    expect(controller.getSnapshot().list).toMatchObject({ status: 'failed' })
    remote.pendingApprovals.mockResolvedValueOnce(carrierFailure('HTTP 500'))
    await controller.loadApprovals()
    expect(controller.getSnapshot().approvals).toMatchObject({ status: 'failed' })
    controller.dispose()
  })

  it('opens and closes a run detail, and shows a detail failure', async () => {
    const { remote, controller } = await started()
    await controller.openRun('r1')
    expect(controller.getSnapshot().detail).toMatchObject({ runId: 'r1', status: 'ready', detail: { name: 'build' } })
    controller.closeDetail()
    expect(controller.getSnapshot().detail).toBeNull()
    remote.runDetail.mockResolvedValueOnce(hostValue(fail('NOT_FOUND')))
    await controller.openRun('gone')
    expect(controller.getSnapshot().detail).toMatchObject({ status: 'failed', failure: { error: 'NOT_FOUND' } })
    remote.runDetail.mockResolvedValueOnce(hostValue(DETAIL))
    await controller.openRun('r1')
    expect(controller.getSnapshot().detail).toMatchObject({ status: 'ready' })
    expect(controller.getSnapshot().detail!.failure).toBeUndefined()
    controller.dispose()
  })

  it('ignores a detail answer for a run that is no longer open', async () => {
    const { remote, controller } = await started()
    const slow = Promise.withResolvers<unknown>()
    remote.runDetail.mockImplementationOnce(() => slow.promise)
    const pending = controller.openRun('r1')
    controller.closeDetail()
    slow.resolve(hostValue(DETAIL))
    await pending
    expect(controller.getSnapshot().detail).toBeNull()
    controller.dispose()
  })

  it('pages node output by offset and shows an output failure', async () => {
    const { remote, controller } = await started()
    await controller.loadOutput('clean')
    expect(remote.nodeOutput).not.toHaveBeenCalled()
    await controller.openRun('r1')
    remote.nodeOutput.mockResolvedValueOnce(hostValue({ ok: true, text: 'abc', nextOffset: 3, totalBytes: 6, truncated: false }))
    await controller.loadOutput('clean')
    expect(remote.nodeOutput).toHaveBeenLastCalledWith(SESSION, { runId: 'r1', nodeId: 'clean', offset: 0, limit: 64 * 1024 })
    remote.nodeOutput.mockResolvedValueOnce(hostValue({ ok: true, text: 'def', totalBytes: 6, truncated: true }))
    await controller.loadOutput('clean')
    expect(remote.nodeOutput).toHaveBeenLastCalledWith(SESSION, { runId: 'r1', nodeId: 'clean', offset: 3, limit: 64 * 1024 })
    expect(controller.getSnapshot().detail!.outputs['clean']).toMatchObject({ text: 'abcdef', truncated: true, loading: false })
    remote.nodeOutput.mockResolvedValueOnce(carrierFailure('HTTP 403'))
    await controller.loadOutput('clean')
    expect(controller.getSnapshot().detail!.outputs['clean']).toMatchObject({ text: 'abcdef', failure: { error: 'LOOPBACK_ONLY' } })
    await controller.loadOutput('ship')
    expect(controller.getSnapshot().detail!.outputs['ship']).toMatchObject({ text: 'hello out' })
    controller.dispose()
  })

  it('approves and rejects, trimming the reason and refreshing', async () => {
    const { remote, controller } = await started()
    await controller.approve('r1', 'ap1')
    expect(remote.approve).toHaveBeenCalledWith(SESSION, { runId: 'r1', approvalId: 'ap1' })
    await controller.reject('r1', 'ap1', '   ')
    expect(remote.reject).toHaveBeenLastCalledWith(SESSION, { runId: 'r1', approvalId: 'ap1' })
    await controller.reject('r1', 'ap1', ' too risky ')
    expect(remote.reject).toHaveBeenLastCalledWith(SESSION, { runId: 'r1', approvalId: 'ap1', reason: 'too risky' })
    expect(controller.getSnapshot().actionFailure).toBeUndefined()
    controller.dispose()
  })

  it('keeps a refused approve visible with its explanation until it is dismissed', async () => {
    const { remote, controller } = await started()
    remote.approve.mockResolvedValue(carrierFailure('HTTP 403'))
    await controller.approve('r1', 'ap1')
    expect(controller.getSnapshot().actionFailure).toMatchObject({ error: 'LOOPBACK_ONLY', loopbackOnly: true })
    controller.dismissActionFailure()
    expect(controller.getSnapshot().actionFailure).toBeUndefined()
    remote.reject.mockResolvedValue(hostValue(fail('NOT_PENDING', { remedy: 'Someone answered first.' })))
    await controller.reject('r1', 'ap1', '')
    expect(controller.getSnapshot().actionFailure).toMatchObject({ error: 'NOT_PENDING', remedy: 'Someone answered first.' })
    controller.dispose()
  })

  it('cancels, and resumes into the new run', async () => {
    const { remote, controller } = await started()
    await controller.openRun('r1')
    await controller.cancel('r1')
    expect(remote.cancel).toHaveBeenCalledWith(SESSION, { runId: 'r1' })
    remote.cancel.mockResolvedValueOnce(hostValue(fail('NOT_FOUND')))
    await controller.cancel('r1')
    expect(controller.getSnapshot().actionFailure).toMatchObject({ error: 'NOT_FOUND' })
    await controller.resume('r0')
    await flush()
    expect(remote.resume).toHaveBeenCalledWith(SESSION, { runId: 'r0' })
    expect(controller.getSnapshot()).toMatchObject({ detail: { runId: 'r8' }, actionFailure: undefined })
    remote.resume.mockResolvedValueOnce(hostValue(fail('TRUST_REQUIRED', { remedy: 'Dry-run it again first.' })))
    await controller.resume('r0')
    expect(controller.getSnapshot().actionFailure).toMatchObject({ error: 'TRUST_REQUIRED' })
    controller.dispose()
  })
})

describe('trust acknowledgement is bound to the plan it was given for', () => {
  it('drops the acknowledgement when the file is edited, and refuses to run on the stale plan', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    controller.setAck(true)
    expect(controller.getSnapshot().dryRun!.ackKey).toBeDefined()
    controller.edit('changed')
    expect(controller.getSnapshot().dryRun!.stale).toBe(true)
    expect(controller.getSnapshot().dryRun!.ackKey).toBeUndefined()
    await controller.startRun()
    expect(remote.run).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('edit then save then a fresh plan does not inherit the earlier acknowledgement', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    controller.setAck(true)
    controller.edit('version: 1\nname: build\n# more\n')
    await controller.save('version: 1\nname: build\n# more\n', 'tok-1')
    expect(controller.getSnapshot().dryRun!.ackKey).toBeUndefined()
    remote.dryRun.mockResolvedValueOnce(hostValue({ ...PLAN, trustChallenge: 'c2', confirmText: 'new text' }))
    await controller.dryRun()
    expect(controller.getSnapshot().dryRun!.stale).toBe(false)
    expect(controller.getSnapshot().dryRun!.ackKey).toBeUndefined()
    await controller.startRun()
    expect(remote.run).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('a re-plan clears the acknowledgement; closing the plan does too', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    controller.setAck(true)
    await controller.dryRun()
    expect(controller.getSnapshot().dryRun!.ackKey).toBeUndefined()
    await controller.startRun()
    expect(remote.run).not.toHaveBeenCalled()
    controller.setAck(true)
    controller.closeDryRun()
    expect(controller.getSnapshot().dryRun).toBeNull()
    controller.dispose()
  })

  it('an acknowledgement for another plan identity does not authorise this one', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    controller.setAck(true)
    remote.dryRun.mockResolvedValueOnce(hostValue({ ...PLAN, trustChallenge: 'other' }))
    await controller.dryRun()
    await controller.startRun()
    expect(remote.run).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('an untrusted plan with no confirmation text cannot be acknowledged or run', async () => {
    const { remote, controller } = await ready()
    remote.dryRun.mockResolvedValue(hostValue({ ...PLAN, confirmText: undefined }))
    await controller.dryRun()
    controller.setAck(true)
    expect(controller.getSnapshot().dryRun!.ackKey).toBeUndefined()
    await controller.startRun()
    expect(remote.run).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('a spent token clears the acknowledgement', async () => {
    const { remote, controller } = await ready()
    await controller.dryRun()
    controller.setAck(true)
    remote.run.mockResolvedValue(hostValue(fail('TRUST_DENIED')))
    await controller.startRun()
    expect(controller.getSnapshot().dryRun!.spent).toBe(true)
    expect(controller.getSnapshot().dryRun!.ackKey).toBeUndefined()
    controller.dispose()
  })
})

describe('in-flight guards and the lease fence', () => {
  it('sends one run for a double click and none after the run started', async () => {
    const { remote, controller } = await started()
    await controller.selectWorkflow('build')
    await flush()
    remote.dryRun.mockResolvedValue(hostValue(TRUSTED_PLAN))
    await controller.dryRun()
    const slow = Promise.withResolvers<unknown>()
    remote.run.mockImplementationOnce(() => slow.promise)
    const first = controller.startRun()
    const second = controller.startRun()
    slow.resolve(hostValue({ ok: true, runId: 'r9' }))
    await Promise.all([first, second])
    await controller.startRun()
    expect(remote.run).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('sends one approve, one reject and one resume per double click', async () => {
    const { remote, controller } = await started()
    const slow = Promise.withResolvers<unknown>()
    remote.approve.mockImplementationOnce(() => slow.promise)
    const a = [controller.approve('r1', 'ap1'), controller.approve('r1', 'ap1')]
    expect(controller.getSnapshot().busy).toEqual(['approval:ap1'])
    slow.resolve(hostValue({ ok: true }))
    await Promise.all(a)
    expect(remote.approve).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().busy).toEqual([])

    const slowReject = Promise.withResolvers<unknown>()
    remote.reject.mockImplementationOnce(() => slowReject.promise)
    const r = [controller.reject('r1', 'ap1', ''), controller.reject('r1', 'ap1', '')]
    slowReject.resolve(hostValue({ ok: true }))
    await Promise.all(r)
    expect(remote.reject).toHaveBeenCalledTimes(1)

    const slowResume = Promise.withResolvers<unknown>()
    remote.resume.mockImplementationOnce(() => slowResume.promise)
    const s = [controller.resume('r0'), controller.resume('r0')]
    slowResume.resolve(hostValue({ ok: true, runId: 'r8' }))
    await Promise.all(s)
    expect(remote.resume).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('does not send approve or reject unless the lease is attached, and says why', async () => {
    const { remote, controller } = await started()
    remote.attachUi.mockResolvedValueOnce(hostValue(fail('NOT_FOUND', { remedy: 'Reopen the panel.' })))
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS)
    expect(controller.getSnapshot().lease.state).toBe('lapsed')
    await controller.approve('r1', 'ap1')
    await controller.reject('r1', 'ap1', '')
    expect(remote.approve).not.toHaveBeenCalled()
    expect(remote.reject).not.toHaveBeenCalled()
    expect(controller.getSnapshot().actionFailure).toMatchObject({ error: 'NOT_FOUND', remedy: 'Reopen the panel.' })
    controller.dispose()
  })

  it('releases a lease minted by a renew that resolves after dispose', async () => {
    const { remote, controller } = await started()
    const slow = Promise.withResolvers<unknown>()
    remote.attachUi.mockImplementationOnce(() => slow.promise)
    await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS)
    controller.dispose()
    remote.detachUi.mockClear()
    slow.resolve(hostValue({ ok: true, leaseId: 'n'.repeat(32), ttlMs: 45_000, workspaceKey: KEY }))
    await flush()
    expect(remote.detachUi).toHaveBeenCalledWith(SESSION, { leaseId: 'n'.repeat(32) })
  })
})

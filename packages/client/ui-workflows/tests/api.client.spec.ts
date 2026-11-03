/** createWorkflowApi: every method's request shape, and every way a call can fail folded into one result. */
import { describe, expect, it } from 'vitest'
import { WORKFLOW_LOOPBACK_ONLY_MESSAGE } from '@deepseek-ai/dsh-workflow-remote/client'
import { createWorkflowApi, isFailure, transportFailure } from '../src/client/api.ts'
import { carrierFailure, fail, hostValue, LIST, makeRemote, SESSION } from './fixtures.client.ts'

describe('createWorkflowApi', () => {
  it('forwards every method with the session first and the request shaped as the Host expects', async () => {
    const remote = makeRemote()
    const api = createWorkflowApi(remote.asRemote, SESSION)
    expect(await api.list()).toEqual(LIST)
    await api.read('build')
    await api.validate('t')
    await api.validate('t', 'build')
    await api.dryRun('build')
    await api.dryRun('build', { a: 1 })
    await api.runs({ limit: 5 })
    await api.runDetail('r1')
    await api.pendingApprovals()
    await api.save({ name: 'build', text: 't', expectedToken: null })
    await api.run({ name: 'build', trustHash: 'k', trustChallenge: 'c' })
    await api.resume('r1')
    await api.resume('r1', { trustHash: 'k', trustChallenge: 'c' })
    await api.cancel('r1')
    await api.nodeOutput('r1', 'n', 0, 10)
    await api.approve('r1', 'a')
    await api.reject('r1', 'a')
    await api.reject('r1', 'a', 'no')
    await api.attachUi()
    await api.attachUi('lease')
    await api.detachUi('lease')
    expect(remote.list).toHaveBeenCalledWith(SESSION)
    expect(remote.read).toHaveBeenCalledWith(SESSION, { name: 'build' })
    expect(remote.validate.mock.calls).toEqual([[{ text: 't' }], [{ text: 't', name: 'build' }]])
    expect(remote.dryRun.mock.calls).toEqual([[SESSION, { name: 'build' }], [SESSION, { name: 'build', inputs: { a: 1 } }]])
    expect(remote.runs).toHaveBeenCalledWith(SESSION, { limit: 5 })
    expect(remote.runDetail).toHaveBeenCalledWith(SESSION, { runId: 'r1' })
    expect(remote.pendingApprovals).toHaveBeenCalledWith(SESSION)
    expect(remote.save).toHaveBeenCalledWith(SESSION, { name: 'build', text: 't', expectedToken: null })
    expect(remote.run).toHaveBeenCalledWith(SESSION, { name: 'build', trustHash: 'k', trustChallenge: 'c' })
    expect(remote.resume.mock.calls).toEqual([[SESSION, { runId: 'r1' }], [SESSION, { runId: 'r1', trustHash: 'k', trustChallenge: 'c' }]])
    expect(remote.cancel).toHaveBeenCalledWith(SESSION, { runId: 'r1' })
    expect(remote.nodeOutput).toHaveBeenCalledWith(SESSION, { runId: 'r1', nodeId: 'n', offset: 0, limit: 10 })
    expect(remote.approve).toHaveBeenCalledWith(SESSION, { runId: 'r1', approvalId: 'a' })
    expect(remote.reject.mock.calls).toEqual([
      [SESSION, { runId: 'r1', approvalId: 'a' }],
      [SESSION, { runId: 'r1', approvalId: 'a', reason: 'no' }],
    ])
    expect(remote.attachUi.mock.calls).toEqual([[SESSION, {}], [SESSION, { leaseId: 'lease' }]])
    expect(remote.detachUi).toHaveBeenCalledWith(SESSION, { leaseId: 'lease' })
  })

  it('passes a Host failure through with its remedy, conflict flag and token', async () => {
    const remote = makeRemote()
    remote.save.mockResolvedValue(hostValue(fail('CONFLICT', { remedy: 'reload', conflict: true, currentToken: 'tok-9' })))
    const result = await createWorkflowApi(remote.asRemote, SESSION).save({ name: 'a', text: '', expectedToken: 'x' })
    expect(isFailure(result)).toBe(true)
    expect(result).toMatchObject({ ok: false, error: 'CONFLICT', remedy: 'reload', conflict: true, currentToken: 'tok-9' })
  })

  it('does not mistake an invalid draft for a failed call', async () => {
    const remote = makeRemote()
    remote.validate.mockResolvedValue(hostValue({ ok: false, diagnostics: [] }))
    const result = await createWorkflowApi(remote.asRemote, SESSION).validate('x')
    expect(isFailure(result)).toBe(false)
  })

  it('explains a carrier 403 on every privileged method as loopback-only, never a bare status', async () => {
    const remote = makeRemote()
    for (const method of (['save', 'run', 'resume', 'cancel', 'approve', 'reject', 'attachUi', 'detachUi', 'nodeOutput'] as const)) {
      remote[method].mockResolvedValue(carrierFailure(`transport failure for workflow/${method}: HTTP 403`))
    }
    const api = createWorkflowApi(remote.asRemote, SESSION)
    const results = await Promise.all([
      api.save({ name: 'a', text: '', expectedToken: null }), api.run({ name: 'a' }), api.resume('r'), api.cancel('r'),
      api.approve('r', 'a'), api.reject('r', 'a'), api.attachUi(), api.detachUi('l'), api.nodeOutput('r', 'n', 0, 1),
    ])
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: 'LOOPBACK_ONLY', loopbackOnly: true, message: WORKFLOW_LOOPBACK_ONLY_MESSAGE })
    }
  })

  it('explains a rejected call the same way as a folded one', async () => {
    const remote = makeRemote()
    remote.save.mockRejectedValue(new Error('transport failure for workflow/save: HTTP 403'))
    const result = await createWorkflowApi(remote.asRemote, SESSION).save({ name: 'a', text: '', expectedToken: null })
    expect(result).toMatchObject({ error: 'LOOPBACK_ONLY' })
  })

  it('reports a read-method 403, a 500 and a faceless error as a transport failure with a remedy', async () => {
    const remote = makeRemote()
    remote.list.mockResolvedValue(carrierFailure('transport failure for workflow/list: HTTP 403'))
    remote.read.mockResolvedValue(carrierFailure('transport failure for workflow/read: HTTP 500'))
    remote.runs.mockRejectedValue('exploded')
    remote.runDetail.mockRejectedValue({})
    const api = createWorkflowApi(remote.asRemote, SESSION)
    expect(await api.list()).toMatchObject({ error: 'TRANSPORT', message: 'The host did not complete workflow/list (HTTP 403).', remedy: expect.any(String) as string })
    expect(await api.read('a')).toMatchObject({ error: 'TRANSPORT', message: expect.stringContaining('HTTP 500') as string })
    expect(await api.runs({})).toMatchObject({ error: 'TRANSPORT', message: 'The host did not complete workflow/runs.' })
    expect(await api.runDetail('r')).toMatchObject({ error: 'TRANSPORT' })
  })
})

describe('transportFailure', () => {
  it('reads the message from an Error-shaped cause only', () => {
    expect(transportFailure('save', { message: 'HTTP 403' })).toMatchObject({ error: 'LOOPBACK_ONLY' })
    expect(transportFailure('save', { message: 5 })).toMatchObject({ error: 'TRANSPORT' })
    expect(transportFailure('save', null)).toMatchObject({ error: 'TRANSPORT' })
  })
})

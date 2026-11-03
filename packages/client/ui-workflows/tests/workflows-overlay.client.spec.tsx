// @vitest-environment jsdom
/**
 * The Workflows overlay end to end over a fake `workflow` Remote: every surface the pilot drives,
 * the 403 explanation, the conflict path, the lapsed-lease indicator, the workspace-key event
 * filter, and the trust challenge flow.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKFLOW_ATTACH_RENEW_MS, WORKFLOW_ATTACH_TTL_MS, WORKFLOW_LOOPBACK_ONLY_MESSAGE } from '@deepseek-ai/dsh-workflow-remote/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as runEn } from '@deepseek-ai/dsh-client-ui-workflow-run/src/client/locales.ts'
import { ApprovalBadge, GateReport, NodeList, NodeRow } from '@deepseek-ai/dsh-client-ui-workflow-run/src/client/WorkflowRunPanel.tsx'
import { runDetailToNodeData } from '@deepseek-ai/dsh-client-ui-workflow-run/src/client/run-detail.ts'
import { createWorkflowApi } from '../src/client/api.ts'
import type { WorkflowEventSource } from '../src/client/controller.ts'
import { WorkflowsOverlayStore } from '../src/client/store.ts'
import type { WorkflowsFace } from '../src/client/store.ts'
import { WorkflowsControl } from '../src/client/WorkflowsControl.tsx'
import type { WorkflowsControlProps } from '../src/client/WorkflowsControl.tsx'
import { WorkflowsOverlay } from '../src/client/WorkflowsOverlay.tsx'
import {
  carrierFailure, DETAIL, fail, hostValue, KEY, makeRemote, OTHER_KEY, PLAN, RUNS, SESSION, translate, TRUSTED_PLAN,
} from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const q = (selector: string): HTMLElement | null => document.querySelector(selector)
const qa = (selector: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(selector))
const click = (selector: string): void => { fireEvent.click(q(selector)!) }
const present = (selector: string) => waitFor(() => { expect(q(selector)).not.toBeNull() })
const text = (selector: string): string => q(selector)?.textContent ?? ''

function mount(remote = makeRemote()) {
  const overlay = new WorkflowsOverlayStore()
  let handlers: Parameters<WorkflowEventSource['subscribe']>[0] | undefined
  const events: WorkflowEventSource = { subscribe: (h) => { handlers = h; return () => { handlers = undefined } } }
  const face: WorkflowsFace = {
    overlay,
    runT: makeTranslate(runEn),
    runView: { ApprovalBadge, GateReport, NodeList, NodeRow, runDetailToNodeData },
    createApi: sessionId => createWorkflowApi(remote.asRemote, sessionId),
    events,
  }
  const view = render(
    <>
      <WorkflowsControl {...{ ...face, sessionId: SESSION, t: translate } as unknown as WorkflowsControlProps} />
      <WorkflowsOverlay {...{ ...face, t: translate }} />
    </>,
  )
  return { remote, overlay, view, emit: () => handlers! }
}

async function open(remote = makeRemote()) {
  const ctx = mount(remote)
  click('[data-workflows-button]')
  await present('[data-workflow-row]')
  return ctx
}

async function openEditor(remote = makeRemote()) {
  const ctx = await open(remote)
  fireEvent.click(qa('[data-workflow-row]')[0]!)
  await present('[data-editor-textarea]')
  await waitFor(() => { expect(remote.validate).toHaveBeenCalled() })
  return ctx
}

/** Open the overlay, the first file, and its dry-run plan. */
async function plan(remote = makeRemote()) {
  const ctx = await openEditor(remote)
  click('[data-dryrun]')
  await present('[data-plan-list]')
  return ctx
}

/** Open the overlay on its Runs tab. */
async function runsTab(remote = makeRemote()) {
  const ctx = await open(remote)
  click('[data-workflows-tab-button="runs"]')
  await present('[data-run-row]')
  return ctx
}

describe('open, list and lease', () => {
  it('opens for the pressing session, lists files with validity, and attaches the live-approvals lease', async () => {
    const { remote, overlay } = await open()
    expect(overlay.getSnapshot()).toEqual({ open: true, sessionId: SESSION })
    expect(remote.list).toHaveBeenCalledWith(SESSION)
    const rows = qa('[data-workflow-row]')
    expect(rows.map(row => row.dataset.workflowName)).toEqual(['build', 'broken'])
    expect(rows.map(row => row.dataset.workflowValid)).toEqual(['true', 'false'])
    expect(rows[0]!.textContent).toContain('Last run: Succeeded')
    expect(rows[1]!.textContent).toContain('3 diagnostics')
    await waitFor(() => { expect(q('[data-lease-indicator]')!.dataset.leaseState).toBe('attached') })
    expect(text('[data-lease-label]')).toBe('Live approvals attached')
    expect(q('[data-pending-approvals-count]')!.dataset.pendingApprovalsCount).toBe('1')
  })

  it('detaches the lease when the overlay closes and attaches again on reopen', async () => {
    const { remote, overlay } = await open()
    await waitFor(() => { expect(q('[data-lease-indicator]')!.dataset.leaseState).toBe('attached') })
    act(() => { overlay.close() })
    await waitFor(() => { expect(remote.detachUi).toHaveBeenCalledTimes(1) })
    expect(q('[data-workflows-overlay]')).toBeNull()
    click('[data-workflows-button]')
    await present('[data-workflow-row]')
    expect(remote.attachUi).toHaveBeenCalledTimes(2)
  })

  it('detaches the lease when the overlay unmounts', async () => {
    const { remote, view } = await open()
    await waitFor(() => { expect(q('[data-lease-indicator]')!.dataset.leaseState).toBe('attached') })
    view.unmount()
    expect(remote.detachUi).toHaveBeenCalledTimes(1)
  })

  it('shows an empty list, a loading list, and a list failure with its reason', async () => {
    const empty = makeRemote()
    empty.list.mockResolvedValue(hostValue({ ok: true, workspaceKey: KEY, workflows: [] }))
    mount(empty)
    click('[data-workflows-button]')
    await present('[data-list-empty]')
    cleanup()

    const broken = makeRemote()
    broken.list.mockResolvedValue(hostValue(fail('NO_WORKSPACE', { remedy: 'Open a project first.' })))
    mount(broken)
    click('[data-workflows-button]')
    await present('[data-failure-scope="list"]')
    expect(text('[data-failure-scope="list"] [data-failure-message]')).toBe('NO_WORKSPACE happened')
    expect(text('[data-failure-scope="list"] [data-failure-remedy]')).toContain('Open a project first.')
    click('[data-list-refresh]')
    await waitFor(() => { expect(broken.list.mock.calls.length).toBeGreaterThan(1) })
  })

  it('shows the lease as refused, with the loopback explanation, when attach is answered 403', async () => {
    const remote = makeRemote()
    remote.attachUi.mockResolvedValue(carrierFailure('transport failure for workflow/attachUi: HTTP 403'))
    mount(remote)
    click('[data-workflows-button]')
    await present('[data-lease-state="refused"]')
    expect(text('[data-lease-indicator] [data-failure-message]')).toBe(WORKFLOW_LOOPBACK_ONLY_MESSAGE)
    expect(text('[data-lease-indicator] [data-failure-remedy]')).toContain('127.0.0.1')
  })

  it('shows a lapsed lease with the reason when a renewal fails, and recovers on re-attach', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { remote } = mount()
    click('[data-workflows-button]')
    await present('[data-lease-state="attached"]')
    remote.attachUi.mockResolvedValueOnce(hostValue(fail('NOT_FOUND', { remedy: 'Re-attaching.' })))
    await act(async () => { await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS) })
    await present('[data-lease-state="lapsed"]')
    expect(text('[data-lease-label]')).toBe('Live approvals lapsed')
    expect(text('[data-lease-indicator] [data-failure-message]')).toBe('NOT_FOUND happened')
    expect(text('[data-lease-indicator] [data-failure-remedy]')).toContain('Re-attaching.')
    await act(async () => { await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS) })
    await present('[data-lease-state="attached"]')
  })

  it('shows a lapsed lease with the expiry reason when a renewal never answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { remote } = mount()
    click('[data-workflows-button]')
    await present('[data-lease-state="attached"]')
    remote.attachUi.mockImplementation(() => new Promise(() => {}))
    await act(async () => { await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_TTL_MS + 1) })
    await present('[data-lease-state="lapsed"]')
    expect(text('[data-lease-reason]')).toContain('not renewed in time')
  })
})

describe('editor', () => {
  it('loads a file into the editor and saves an edit with the optimistic token', async () => {
    const { remote } = await openEditor()
    const area = q('[data-editor-textarea]') as HTMLTextAreaElement
    expect(area.value).toBe('version: 1\nname: build\n')
    fireEvent.change(area, { target: { value: 'version: 1\nname: build\n# edited\n' } })
    await waitFor(() => { expect((q('[data-save]') as HTMLButtonElement).disabled).toBe(false) })
    click('[data-save]')
    await waitFor(() => { expect(remote.save).toHaveBeenCalledWith(SESSION, { name: 'build', text: 'version: 1\nname: build\n# edited\n', expectedToken: 'tok-1' }) })
    await present('[data-save-ok]')
    expect(q('[data-save-warning]')).toBeNull()
  })

  it('shows the save warning verbatim and treats the save as done', async () => {
    const remote = makeRemote()
    remote.save.mockResolvedValue(hostValue({ ok: true, token: 'tok-2', diagnostics: [], warning: 'Saved, but the folder was not flushed to disk.' }))
    await openEditor(remote)
    fireEvent.change(q('[data-editor-textarea]')!, { target: { value: 'changed' } })
    await waitFor(() => { expect((q('[data-save]') as HTMLButtonElement).disabled).toBe(false) })
    click('[data-save]')
    await present('[data-save-warning]')
    expect(text('[data-save-warning-text]')).toBe('Saved, but the folder was not flushed to disk.')
    expect(q('[data-dirty]')).toBeNull()
  })

  it('handles a CONFLICT: shows the conflict banner and the remedy, disables Save, and reload re-reads', async () => {
    const remote = makeRemote()
    remote.save.mockResolvedValue(hostValue(fail('CONFLICT', { conflict: true, currentToken: 'tok-9', remedy: 'Reload the file, then redo your edit.' })))
    await openEditor(remote)
    fireEvent.change(q('[data-editor-textarea]')!, { target: { value: 'mine' } })
    await waitFor(() => { expect((q('[data-save]') as HTMLButtonElement).disabled).toBe(false) })
    click('[data-save]')
    await present('[data-conflict]')
    expect(text('[data-failure-scope="editor"] [data-failure-remedy]')).toContain('Reload the file, then redo your edit.')
    expect((q('[data-save]') as HTMLButtonElement).disabled).toBe(true)
    expect(text('[data-conflict]')).toContain('Reloading discards your unsaved edits.')
    remote.read.mockResolvedValue(hostValue({ ok: true, name: 'build', text: 'theirs', token: 'tok-9' }))
    click('[data-reload]')
    await waitFor(() => { expect((q('[data-editor-textarea]') as HTMLTextAreaElement).value).toBe('theirs') })
    expect(q('[data-conflict]')).toBeNull()
  })

  it('shows a save refused with 403 as the loopback explanation and keeps the edit', async () => {
    const remote = makeRemote()
    remote.save.mockResolvedValue(carrierFailure('transport failure for workflow/save: HTTP 403'))
    await openEditor(remote)
    fireEvent.change(q('[data-editor-textarea]')!, { target: { value: 'mine' } })
    await waitFor(() => { expect((q('[data-save]') as HTMLButtonElement).disabled).toBe(false) })
    click('[data-save]')
    await present('[data-failure-scope="editor"]')
    expect(text('[data-failure-scope="editor"] [data-failure-message]')).toBe(WORKFLOW_LOOPBACK_ONLY_MESSAGE)
    expect((q('[data-editor-textarea]') as HTMLTextAreaElement).value).toBe('mine')
  })

  it('shows a read failure instead of an empty editor', async () => {
    const remote = makeRemote()
    remote.read.mockResolvedValue(hostValue(fail('NOT_FOUND', { remedy: 'Refresh the list.' })))
    await open(remote)
    fireEvent.click(qa('[data-workflow-row]')[0]!)
    await present('[data-failure-scope="editor"]')
    expect(q('[data-editor-textarea]')).toBeNull()
  })

  it('creates a new workflow: rejects a bad or taken name, then opens the template and saves it with a null token', async () => {
    const { remote } = await open()
    const field = q('[data-new-workflow-name]')!
    fireEvent.change(field, { target: { value: 'Bad Name' } })
    click('[data-new-workflow]')
    expect(q('[data-new-workflow-problem="invalid"]')).not.toBeNull()
    fireEvent.change(field, { target: { value: 'build' } })
    expect(q('[data-new-workflow-problem]')).toBeNull()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(q('[data-new-workflow-problem="exists"]')).not.toBeNull()
    fireEvent.change(field, { target: { value: 'fresh-one' } })
    fireEvent.keyDown(field, { key: 'a' })
    fireEvent.keyDown(field, { key: 'Enter' })
    await present('[data-editor-new]')
    expect((q('[data-editor-textarea]') as HTMLTextAreaElement).value).toContain('name: fresh-one')
    expect((field as HTMLInputElement).value).toBe('')
    await waitFor(() => { expect((q('[data-save]') as HTMLButtonElement).disabled).toBe(false) })
    click('[data-save]')
    await waitFor(() => { expect(remote.save).toHaveBeenCalledWith(SESSION, expect.objectContaining({ name: 'fresh-one', expectedToken: null })) })
  })

  it('asks for a save before planning unsaved edits', async () => {
    const { remote } = await openEditor()
    fireEvent.change(q('[data-editor-textarea]')!, { target: { value: 'edited' } })
    click('[data-dryrun]')
    await present('[data-save-first]')
    expect(remote.dryRun).not.toHaveBeenCalled()
    expect(q('[data-dryrun-view]')).toBeNull()
  })
})

describe('dry run and the trust flow', () => {
  it('shows the plan order, the graph, the gate manifest, every shell command, and the warnings', async () => {
    await plan()
    expect(qa('[data-plan-node]').map(node => node.dataset.nodeId)).toEqual(['clean', 'ship'])
    expect(qa('[data-graph-node]').map(node => `${node.dataset.nodeId}:${node.dataset.nodeKind}:${node.dataset.nodeGate}`)).toEqual(['clean:bash:false', 'ship:approval:true'])
    expect(qa('[data-graph-edge]').map(edge => `${edge.dataset.from}>${edge.dataset.to}`)).toEqual(['clean>ship'])
    expect(qa('[data-gate-entry]').map(entry => `${entry.dataset.gateNode}/${entry.dataset.gateKind}`)).toEqual(['ship/approval'])
    expect(text('[data-trust-command] [data-command]')).toBe('rm -rf dist')
    expect(text('[data-trust-command]')).toContain('Working directory: sub')
    expect(text('[data-trust-command]')).toContain('Sets environment: A')
    expect(text('[data-trust-agent]')).toContain('fast')
    expect(text('[data-trust-prompt-files]')).toContain('p.md')
    expect(text('[data-trust-approvals]')).toBe('Approval nodes: 1')
    expect(text('[data-plan-warning]')).toContain('careful')
  })

  it('shows the exact confirmText, gates the button behind the acknowledgement, and runs with the key and the challenge', async () => {
    const { remote } = await plan()
    expect(q('[data-trust-state]')!.dataset.trustState).toBe('untrusted')
    expect(text('[data-confirm-text]')).toBe(PLAN.confirmText)
    const run = q('[data-run-start]') as HTMLButtonElement
    expect(run.dataset.trustRun).toBe('true')
    expect(run.disabled).toBe(true)
    fireEvent.click(run)
    expect(remote.run).not.toHaveBeenCalled()
    click('[data-trust-ack]')
    expect(run.disabled).toBe(false)
    click('[data-run-start]')
    await waitFor(() => {
      expect(remote.run).toHaveBeenCalledWith(SESSION, { name: 'build', trustHash: PLAN.trustKey, trustChallenge: PLAN.trustChallenge })
    })
    await present('[data-run-detail]')
    expect(q('[data-workflows-overlay]')!.dataset.workflowsTab).toBe('runs')
    expect(remote.runDetail).toHaveBeenCalledWith(SESSION, { runId: 'r9' })
  })

  it('says why a refused start is spent and re-issues the challenge on refresh', async () => {
    const remote = makeRemote()
    remote.run.mockResolvedValue(hostValue(fail('TRUST_DENIED', { remedy: 'Refresh the plan and confirm again.' })))
    await plan(remote)
    click('[data-trust-ack]')
    click('[data-run-start]')
    await present('[data-failure-scope="run"]')
    expect(text('[data-failure-scope="run"] [data-failure-remedy]')).toContain('Refresh the plan and confirm again.')
    expect(q('[data-trust-spent]')).not.toBeNull()
    expect((q('[data-run-start]') as HTMLButtonElement).disabled).toBe(true)
    click('[data-dryrun-refresh]')
    await waitFor(() => { expect(q('[data-trust-spent]')).toBeNull() })
    expect(remote.dryRun).toHaveBeenCalledTimes(2)
    expect((q('[data-trust-ack]') as HTMLInputElement).checked).toBe(false)
  })

  it('runs a trusted plan directly with no confirm text and no trust fields', async () => {
    const remote = makeRemote()
    remote.dryRun.mockResolvedValue(hostValue(TRUSTED_PLAN))
    await plan(remote)
    expect(q('[data-trust-state]')!.dataset.trustState).toBe('trusted')
    expect(q('[data-confirm-text]')).toBeNull()
    expect(q('[data-trust-ack]')).toBeNull()
    expect(text('[data-commands-empty]')).toBe('No shell commands.')
    expect(text('[data-manifest-empty]')).toBe('No gates declared.')
    click('[data-run-start]')
    await waitFor(() => { expect(remote.run).toHaveBeenCalledWith(SESSION, { name: 'build' }) })
  })

  it('collects the declared inputs, marks the plan stale when one changes, and sends the values', async () => {
    const remote = makeRemote()
    remote.dryRun.mockResolvedValue(hostValue(TRUSTED_PLAN))
    await plan(remote)
    const fields = qa('[data-input-field]')
    expect(fields.map(field => field.dataset.inputName)).toEqual(['target', 'count', 'fast'])
    expect(fields[0]!.textContent).toContain('required')
    fireEvent.change(fields[0]!.querySelector('input')!, { target: { value: 'prod' } })
    fireEvent.change(fields[1]!.querySelector('input')!, { target: { value: '3' } })
    fireEvent.click(fields[2]!.querySelector('input')!)
    expect(q('[data-dryrun-stale]')).not.toBeNull()
    expect((q('[data-run-start]') as HTMLButtonElement).disabled).toBe(true)
    click('[data-dryrun-refresh]')
    await waitFor(() => { expect(remote.dryRun).toHaveBeenLastCalledWith(SESSION, { name: 'build', inputs: { target: 'prod', count: 3, fast: true } }) })
    await waitFor(() => { expect(q('[data-dryrun-stale]')).toBeNull() })
    fireEvent.change(qa('[data-input-field]')[1]!.querySelector('input')!, { target: { value: '' } })
    fireEvent.click(qa('[data-input-field]')[2]!.querySelector('input')!)
    click('[data-dryrun-refresh]')
    await waitFor(() => { expect(remote.dryRun).toHaveBeenLastCalledWith(SESSION, { name: 'build', inputs: { target: 'prod', fast: false } }) })
  })

  it('shows a plan failure and closes the plan', async () => {
    const remote = makeRemote()
    remote.dryRun.mockResolvedValue(hostValue(fail('INVALID_INPUT', { remedy: 'Give a value for target.' })))
    await openEditor(remote)
    click('[data-dryrun]')
    await present('[data-failure-scope="dryrun"]')
    expect(q('[data-run-start]')).toBeNull()
    click('[data-dryrun-close]')
    expect(q('[data-dryrun-view]')).toBeNull()
  })

  it('opens the same plan from the editor Run button', async () => {
    const { remote } = await openEditor()
    click('[data-run]')
    await present('[data-dryrun-view]')
    expect(remote.run).not.toHaveBeenCalled()
  })
})

describe('runs, approvals and run detail', () => {
  it('lists runs and pending approvals', async () => {
    await runsTab()
    expect(qa('[data-run-row]').map(row => `${row.dataset.runId}:${row.dataset.runStatus}`)).toEqual(['r1:running', 'r0:failed'])
    const approval = q('[data-pending-approvals] [data-approval-row]')!
    expect(approval.dataset.approvalId).toBe('ap1')
    expect(approval.textContent).toContain('Ship it?')
  })

  it('approves from the pending list', async () => {
    const { remote } = await runsTab()
    click('[data-pending-approvals] [data-approve]')
    await waitFor(() => { expect(remote.approve).toHaveBeenCalledWith(SESSION, { runId: 'r1', approvalId: 'ap1' }) })
    await waitFor(() => { expect(remote.pendingApprovals.mock.calls.length).toBeGreaterThan(1) })
    expect(q('[data-failure-scope="action"]')).toBeNull()
  })

  it('rejects with the typed reason', async () => {
    const { remote } = await runsTab()
    fireEvent.change(q('[data-pending-approvals] [data-reject-reason]')!, { target: { value: 'not today' } })
    click('[data-pending-approvals] [data-reject]')
    await waitFor(() => { expect(remote.reject).toHaveBeenCalledWith(SESSION, { runId: 'r1', approvalId: 'ap1', reason: 'not today' }) })
  })

  it('explains a refused approve (403) with the loopback message and the remedy, and can be dismissed', async () => {
    const remote = makeRemote()
    remote.approve.mockResolvedValue(carrierFailure('transport failure for workflow/approve: HTTP 403'))
    await runsTab(remote)
    click('[data-pending-approvals] [data-approve]')
    await present('[data-failure-scope="action"]')
    expect(text('[data-failure-scope="action"] [data-failure-message]')).toBe(WORKFLOW_LOOPBACK_ONLY_MESSAGE)
    expect(text('[data-failure-scope="action"] [data-failure-remedy]')).toContain('127.0.0.1')
    click('[data-failure-dismiss]')
    expect(q('[data-failure-scope="action"]')).toBeNull()
  })

  it('shows a Host refusal of a reject with its own remedy', async () => {
    const remote = makeRemote()
    remote.reject.mockResolvedValue(hostValue(fail('NOT_PENDING', { remedy: 'Another window answered first.' })))
    await runsTab(remote)
    click('[data-pending-approvals] [data-reject]')
    await present('[data-failure-scope="action"]')
    expect(text('[data-failure-scope="action"] [data-failure-remedy]')).toContain('Another window answered first.')
  })

  it('opens a run: nodes, gates, approvals, inputs, the file-changed notice, and node output', async () => {
    const { remote } = await runsTab()
    fireEvent.click(qa('[data-run-row]')[0]!)
    await present('[data-run-detail]')
    expect(q('[data-run-detail]')!.dataset.runStatus).toBe('running')
    expect(qa('[data-workflow-node]').map(node => `${node.dataset.nodeId}:${node.dataset.nodeKind}:${node.dataset.nodeStatus}`)).toEqual(['clean:bash:done', 'ship:approval:running'])
    const clean = q('[data-workflow-node][data-node-id="clean"]')!
    expect(clean.textContent).toContain('exit 0')
    expect(clean.textContent).toContain('40 ms')
    expect(clean.querySelector('[data-node-truncated]')).not.toBeNull()
    expect(text('[data-node-reason]')).toContain('boom')
    expect(q('[data-gate-report]')!.dataset.gateReportOpen).toBe('false')
    click('[data-gate-toggle]')
    expect(qa('[data-gate-row]').map(row => `${row.dataset.gateNode}:${row.dataset.gateOutcome}`)).toEqual(['ship:fired-pass'])
    expect(text('[data-run-input]')).toContain('target = prod')
    expect(q('[data-file-changed]')).not.toBeNull()
    expect(qa('[data-run-detail] [data-approval-row]').map(row => `${row.dataset.approvalId}:${row.dataset.approvalState}`)).toEqual(['ap1:pending', 'ap0:rejected'])
    expect(text('[data-approval-reason]')).toBe('nope')

    click('[data-node-output-button]')
    await present('[data-node-output]')
    expect(remote.nodeOutput).toHaveBeenCalledWith(SESSION, { runId: 'r1', nodeId: 'clean', offset: 0, limit: 65536 })
    expect(text('[data-node-output]')).toBe('hello out')
  })

  it('shows empty node output as such and a refused output read with the loopback message', async () => {
    const remote = makeRemote()
    remote.nodeOutput.mockResolvedValueOnce(hostValue({ ok: true, text: '', totalBytes: 0, truncated: false }))
    await runsTab(remote)
    fireEvent.click(qa('[data-run-row]')[0]!)
    await present('[data-node-output-button]')
    click('[data-node-output-button]')
    await present('[data-node-output]')
    expect(text('[data-node-output]')).toBe('(no output)')
    remote.nodeOutput.mockResolvedValueOnce(carrierFailure('HTTP 403'))
    click('[data-node-output-button]')
    await present('[data-failure-scope="output"]')
    expect(text('[data-failure-scope="output"] [data-failure-message]')).toBe(WORKFLOW_LOOPBACK_ONLY_MESSAGE)
  })

  it('opens the gate report by default when a gate blocked, and spells an unknown approval state verbatim', async () => {
    const remote = makeRemote()
    remote.runDetail.mockResolvedValue(hostValue({
      ...DETAIL,
      gates: [{ nodeId: 'ship', gateKind: 'approval', outcome: 'fired-block' }],
      approvals: [{ approvalId: 'ap7', nodeId: 'ship', message: 'Odd?', state: 'mystery', at: 3 }],
    }))
    await runsTab(remote)
    fireEvent.click(qa('[data-run-row]')[0]!)
    await present('[data-gate-report]')
    expect(q('[data-gate-report]')!.dataset.gateReportOpen).toBe('true')
    click('[data-gate-toggle]')
    expect(q('[data-gate-report]')!.dataset.gateReportOpen).toBe('false')
    expect(text('[data-run-detail] [data-run-approvals] [data-approval-text]')).toBe('mystery')
  })

  it('answers an approval from inside the run detail', async () => {
    const { remote } = await runsTab()
    fireEvent.click(qa('[data-run-row]')[0]!)
    await present('[data-run-detail]')
    click('[data-run-detail] [data-approve]')
    await waitFor(() => { expect(remote.approve).toHaveBeenCalledWith(SESSION, { runId: 'r1', approvalId: 'ap1' }) })
  })

  it('cancels a running run and resumes an ended one', async () => {
    const remote = makeRemote()
    await runsTab(remote)
    fireEvent.click(qa('[data-run-row]')[0]!)
    await present('[data-run-cancel]')
    expect(q('[data-run-resume]')).toBeNull()
    click('[data-run-cancel]')
    await waitFor(() => { expect(remote.cancel).toHaveBeenCalledWith(SESSION, { runId: 'r1' }) })

    remote.runDetail.mockResolvedValue(hostValue({ ...DETAIL, runId: 'r0', status: 'failed', error: 'node failed', fileChanged: false, inputs: undefined, gates: [], approvals: [] }))
    fireEvent.click(qa('[data-run-row]')[1]!)
    await present('[data-run-resume]')
    expect(text('[data-run-error]')).toContain('node failed')
    expect(q('[data-run-cancel]')).toBeNull()
    expect(q('[data-file-changed]')).toBeNull()
    click('[data-run-resume]')
    await waitFor(() => { expect(remote.resume).toHaveBeenCalledWith(SESSION, { runId: 'r0' }) })
    await waitFor(() => { expect(remote.runDetail).toHaveBeenLastCalledWith(SESSION, { runId: 'r8' }) })
  })

  it('loads more runs, closes the detail, and shows run-list and detail failures', async () => {
    const remote = makeRemote()
    remote.runs.mockResolvedValueOnce(hostValue({ ...RUNS, nextCursor: 'c1' }))
    await runsTab(remote)
    click('[data-runs-more]')
    await waitFor(() => { expect(remote.runs).toHaveBeenLastCalledWith(SESSION, { limit: 50, cursor: 'c1' }) })
    remote.runDetail.mockResolvedValueOnce(hostValue(fail('NOT_FOUND', { remedy: 'It may have been pruned.' })))
    fireEvent.click(qa('[data-run-row]')[0]!)
    await present('[data-failure-scope="detail"]')
    click('[data-detail-close]')
    expect(q('[data-run-detail]')).toBeNull()
    remote.runs.mockResolvedValue(carrierFailure('HTTP 500'))
    click('[data-runs-refresh]')
    await present('[data-failure-scope="runs"]')
  })

  it('shows empty run and approval lists, and an approvals failure', async () => {
    const remote = makeRemote()
    remote.runs.mockResolvedValue(hostValue({ ok: true, workspaceKey: KEY, runs: [] }))
    remote.pendingApprovals.mockResolvedValue(hostValue({ ok: true, approvals: [] }))
    await open(remote)
    click('[data-workflows-tab-button="runs"]')
    await present('[data-runs-empty]')
    expect(q('[data-approvals-empty]')).not.toBeNull()
    expect(q('[data-pending-approvals-count]')).toBeNull()
  })

  it('shows an approvals failure in the sidebar', async () => {
    const remote = makeRemote()
    remote.pendingApprovals.mockResolvedValue(carrierFailure('transport failure for workflow/pendingApprovals: HTTP 500'))
    await open(remote)
    click('[data-workflows-tab-button="runs"]')
    await present('[data-failure-scope="approvals"]')
  })
})

describe('pushed events are filtered by workspace key', () => {
  it('ignores another workspace and applies its own', async () => {
    const remote = makeRemote()
    const { emit } = await open(remote)
    await waitFor(() => { expect(q('[data-lease-indicator]')!.dataset.leaseState).toBe('attached') })
    click('[data-workflows-tab-button="runs"]')
    await present('[data-run-row]')
    const before = remote.runs.mock.calls.length
    remote.runs.mockResolvedValue(hostValue({
      ...RUNS, runs: [{ runId: 'r2', name: 'build', hash: 'h', startedAt: 5, status: 'running' }, ...RUNS.runs],
    }))
    act(() => { emit().runChanged({ runId: 'r2', status: 'running', workspaceKey: OTHER_KEY }) })
    await act(async () => { await Promise.resolve() })
    expect(remote.runs).toHaveBeenCalledTimes(before)
    expect(qa('[data-run-row]')).toHaveLength(2)
    act(() => { emit().runChanged({ runId: 'r2', status: 'running', workspaceKey: KEY }) })
    await waitFor(() => { expect(qa('[data-run-row]')).toHaveLength(3) })
  })

  it('shows a newly pending approval from its own workspace and ignores another one', async () => {
    const remote = makeRemote()
    const { emit } = await open(remote)
    await waitFor(() => { expect(q('[data-lease-indicator]')!.dataset.leaseState).toBe('attached') })
    remote.pendingApprovals.mockResolvedValue(hostValue({
      ok: true,
      approvals: [
        { runId: 'r1', approvalId: 'ap1', nodeId: 'ship', message: 'Ship it?' },
        { runId: 'r1', approvalId: 'ap2', nodeId: 'ship', message: 'Again?' },
      ],
    }))
    act(() => { emit().approvalPending({ runId: 'r1', approvalId: 'ap2', nodeId: 'ship', workspaceKey: OTHER_KEY }) })
    await act(async () => { await Promise.resolve() })
    expect(q('[data-pending-approvals-count]')!.dataset.pendingApprovalsCount).toBe('1')
    act(() => { emit().approvalPending({ runId: 'r1', approvalId: 'ap2', nodeId: 'ship', workspaceKey: KEY }) })
    await waitFor(() => { expect(q('[data-pending-approvals-count]')!.dataset.pendingApprovalsCount).toBe('2') })
    remote.pendingApprovals.mockResolvedValue(hostValue({ ok: true, approvals: [] }))
    act(() => { emit().approvalDecided({ runId: 'r1', approvalId: 'ap2', state: 'allowed', workspaceKey: KEY }) })
    await waitFor(() => { expect(q('[data-pending-approvals-count]')).toBeNull() })
  })
})

describe('header control', () => {
  it('reports aria-expanded from the shared store', async () => {
    const { overlay } = mount()
    const button = q('[data-workflows-button]')!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    click('[data-workflows-button]')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => { overlay.close() })
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('trust acknowledgement across re-plans (view)', () => {
  it('edit + save after ticking the box leaves the toolbar Run unable to run the next plan', async () => {
    const remote = makeRemote()
    await plan(remote)
    click('[data-trust-ack]')
    expect((q('[data-run-start]') as HTMLButtonElement).disabled).toBe(false)
    const area = q('[data-editor-textarea]') as HTMLTextAreaElement
    fireEvent.change(area, { target: { value: `${area.value}# edited\n` } })
    await present('[data-dryrun-stale]')
    expect((q('[data-run-start]') as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => { expect((q('[data-save]') as HTMLButtonElement).disabled).toBe(false) })
    click('[data-save]')
    await present('[data-save-ok]')
    remote.dryRun.mockResolvedValue(hostValue({ ...PLAN, trustChallenge: 'second', confirmText: 'second text' }))
    click('[data-run]')
    await waitFor(() => { expect(text('[data-confirm-text]')).toBe('second text') })
    expect((q('[data-trust-ack]') as HTMLInputElement).checked).toBe(false)
    expect((q('[data-run-start]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(q('[data-run-start]')!)
    expect(remote.run).not.toHaveBeenCalled()
  })

  it('a new challenge from the toolbar Dry-run unticks the box and disables Run', async () => {
    const remote = makeRemote()
    await plan(remote)
    click('[data-trust-ack]')
    remote.dryRun.mockResolvedValue(hostValue({ ...PLAN, trustChallenge: 'second', confirmText: 'second text' }))
    click('[data-dryrun]')
    await waitFor(() => { expect(text('[data-confirm-text]')).toBe('second text') })
    expect((q('[data-trust-ack]') as HTMLInputElement).checked).toBe(false)
    expect((q('[data-run-start]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a notice and no runnable button for an untrusted plan without confirmation text', async () => {
    const remote = makeRemote()
    remote.dryRun.mockResolvedValue(hostValue({ ...PLAN, confirmText: undefined }))
    await plan(remote)
    expect(text('[data-no-confirm-text]')).toContain('no confirmation text')
    expect(q('[data-trust-ack]')).toBeNull()
    expect((q('[data-run-start]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends a trusted run once on a double click and disables Run after it started', async () => {
    const remote = makeRemote()
    remote.dryRun.mockResolvedValue(hostValue(TRUSTED_PLAN))
    await plan(remote)
    const run = q('[data-run-start]')!
    fireEvent.click(run)
    fireEvent.click(run)
    await waitFor(() => { expect(remote.run).toHaveBeenCalledTimes(1) })
    await present('[data-run-detail]')
    fireEvent.click(run)
    expect(remote.run).toHaveBeenCalledTimes(1)
  })
})

describe('approvals are fenced by the lease', () => {
  it('shows the reason instead of approve and reject when the lease is refused (403)', async () => {
    const remote = makeRemote()
    remote.attachUi.mockResolvedValue(carrierFailure('transport failure for workflow/attachUi: HTTP 403'))
    await runsTab(remote)
    await present('[data-lease-state="refused"]')
    expect(q('[data-approve]')).toBeNull()
    expect(q('[data-reject]')).toBeNull()
    expect(text('[data-approval-fenced] [data-failure-message]')).toBe(WORKFLOW_LOOPBACK_ONLY_MESSAGE)
    expect(text('[data-approval-fenced] [data-failure-remedy]')).toContain('127.0.0.1')
  })

  it('removes approve and reject when the lease lapses and brings them back on re-attach', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const remote = makeRemote()
    await runsTab(remote)
    await present('[data-lease-state="attached"]')
    expect(q('[data-pending-approvals] [data-approve]')).not.toBeNull()
    remote.attachUi.mockResolvedValueOnce(hostValue(fail('NOT_FOUND', { remedy: 'Re-attaching.' })))
    await act(async () => { await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS) })
    await present('[data-lease-state="lapsed"]')
    expect(q('[data-pending-approvals] [data-approve]')).toBeNull()
    expect(q('[data-pending-approvals] [data-reject]')).toBeNull()
    expect(text('[data-pending-approvals] [data-approval-fenced]')).toContain('Re-attaching.')
    await act(async () => { await vi.advanceTimersByTimeAsync(WORKFLOW_ATTACH_RENEW_MS) })
    await waitFor(() => { expect(q('[data-pending-approvals] [data-approve]')).not.toBeNull() })
  })

  it('shows the node command from the open plan next to the approval message, as text', async () => {
    const remote = makeRemote()
    remote.dryRun.mockResolvedValue(hostValue({ ...PLAN, trust: { ...PLAN.trust, bashCommands: [{ nodeId: 'ship', field: 'approval', command: '<b>rm -rf /</b>', envKeys: [], env: {} }] } }))
    await openEditor(remote)
    click('[data-dryrun]')
    await present('[data-plan-list]')
    click('[data-workflows-tab-button="runs"]')
    await present('[data-run-row]')
    expect(text('[data-pending-approvals] [data-approval-command]')).toBe('<b>rm -rf /</b>')
    expect(q('[data-pending-approvals] [data-approval-command] b')).toBeNull()
  })

  it('says the command is unknown when no plan of that workflow is open', async () => {
    await runsTab(makeRemote())
    expect(q('[data-pending-approvals] [data-approval-command-unknown]')).not.toBeNull()
  })
})

describe('resume', () => {
  it('offers no Resume for a cancelling run', async () => {
    const remote = makeRemote()
    remote.runDetail.mockResolvedValue(hostValue({ ...DETAIL, status: 'cancelling' }))
    await open(remote)
    click('[data-workflows-tab-button="runs"]')
    await present('[data-run-row]')
    fireEvent.click(qa('[data-run-row]')[0]!)
    await present('[data-run-detail]')
    expect(q('[data-run-resume]')).toBeNull()
    expect(q('[data-run-cancel]')).toBeNull()
  })

  it('shows the Host refusal and its remedy when resuming an untrusted run (no trust path from here)', async () => {
    const remote = makeRemote()
    remote.runDetail.mockResolvedValue(hostValue({ ...DETAIL, status: 'failed', approvals: [] }))
    remote.resume.mockResolvedValue(hostValue(fail('TRUST_REQUIRED', { remedy: 'Dry-run the workflow and confirm it first.' })))
    await open(remote)
    click('[data-workflows-tab-button="runs"]')
    await present('[data-run-row]')
    fireEvent.click(qa('[data-run-row]')[1]!)
    await present('[data-run-resume]')
    click('[data-run-resume]')
    await present('[data-failure-scope="action"]')
    expect(remote.resume).toHaveBeenCalledWith(SESSION, { runId: 'r1' })
    expect(text('[data-failure-scope="action"] [data-failure-remedy]')).toContain('Dry-run the workflow and confirm it first.')
  })
})

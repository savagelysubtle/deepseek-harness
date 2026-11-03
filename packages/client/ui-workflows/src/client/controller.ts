/**
 * State machine behind the Workflows overlay: one instance per open overlay, owning the lease,
 * the event subscription, and every Remote call. Views only read the snapshot and call methods, so
 * the lifecycle (attach on open, renew on an interval, detach on close) is testable without React.
 */
import {
  WORKFLOW_ATTACH_RENEW_MS, WORKFLOW_ATTACH_TTL_MS, WORKFLOW_OUTPUT_MAX_BYTES,
} from '@deepseek-ai/dsh-workflow-remote/client'
import type {
  WorkflowApprovalDecided, WorkflowApprovalPending, WorkflowDiagnostic, WorkflowDryRunOk,
  WorkflowInputSpec, WorkflowInputValue, WorkflowInputValues, WorkflowListEntry,
  WorkflowPendingApproval, WorkflowRunChange, WorkflowRunDetailOk, WorkflowRunSummary,
} from '@deepseek-ai/dsh-workflow-remote/client'
import { isFailure } from './api.ts'
import type { UiFailure, WorkflowApi } from './api.ts'

/** Which half of the overlay is showing. */
export type WorkflowsTab = 'workflows' | 'runs'

/** Where the human-present lease stands. */
export type LeaseState = 'detached' | 'attaching' | 'attached' | 'lapsed' | 'refused'

/** The live-approvals lease as the indicator shows it. */
export interface LeaseView {
  readonly state: LeaseState
  /** Why the lease is lapsed or refused; absent otherwise. */
  readonly failure?: UiFailure | undefined
}

/** The file being edited. */
export interface EditorView {
  readonly name: string
  /** True until the first successful save; saved with `expectedToken: null`. */
  readonly isNew: boolean
  readonly loading: boolean
  readonly saving: boolean
  readonly text: string
  /** The text the Host last gave or accepted; `text !== savedText` means unsaved edits. */
  readonly savedText: string
  /** Save token of `savedText`; empty for a new file. */
  readonly token: string
  readonly diagnostics: readonly WorkflowDiagnostic[]
  readonly inputs: readonly WorkflowInputSpec[]
  readonly conflict: boolean
  /** A `save` that succeeded but could not flush the folder. */
  readonly warning?: string | undefined
  readonly justSaved: boolean
  readonly saveFirst: boolean
  readonly failure?: UiFailure | undefined
}

/** The plan for the selected workflow and the state of starting it. */
export interface DryRunView {
  readonly status: 'loading' | 'ready' | 'failed'
  readonly plan?: WorkflowDryRunOk
  readonly failure?: UiFailure | undefined
  readonly inputValues: WorkflowInputValues
  /** Inputs changed since the plan was built. */
  readonly stale: boolean
  /** The single-use trust challenge was presented to the Host once and must be re-issued. */
  readonly spent: boolean
  readonly starting: boolean
  readonly startFailure?: UiFailure | undefined
  readonly startedRunId?: string | undefined
}

/** One node's loaded output. */
export interface NodeOutputView {
  readonly text: string
  readonly nextOffset?: number
  readonly totalBytes: number
  readonly truncated: boolean
  readonly loading: boolean
  readonly failure?: UiFailure | undefined
}

/** The run whose detail is open. */
export interface RunDetailView {
  readonly runId: string
  readonly status: 'loading' | 'ready' | 'failed'
  readonly detail?: WorkflowRunDetailOk
  readonly failure?: UiFailure | undefined
  readonly outputs: Readonly<Record<string, NodeOutputView>>
}

/** A load with an outcome. */
export interface Loadable<T> {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed'
  readonly items: readonly T[]
  readonly failure?: UiFailure | undefined
}

/** Everything the overlay renders. */
export interface WorkflowsState {
  readonly tab: WorkflowsTab
  /** Opaque key of the session's workspace; pushed events are ignored unless they carry this one. */
  readonly workspaceKey: string | null
  readonly list: Loadable<WorkflowListEntry>
  readonly editor: EditorView | null
  readonly dryRun: DryRunView | null
  readonly runs: Loadable<WorkflowRunSummary> & { readonly nextCursor?: string }
  readonly approvals: Loadable<WorkflowPendingApproval>
  readonly detail: RunDetailView | null
  readonly lease: LeaseView
  /** The last approve, reject, cancel or resume that failed; shown until dismissed or superseded. */
  readonly actionFailure?: UiFailure | undefined
}

/** Pushed workflow events, subscribed as one stream. */
export interface WorkflowEventSource {
  /**
   * Subscribe to the three `workflow/*` events.
   * @param handlers - one callback per event.
   * @returns the unsubscribe function.
   */
  subscribe(handlers: {
    runChanged(change: WorkflowRunChange): void
    approvalPending(approval: WorkflowApprovalPending): void
    approvalDecided(decision: WorkflowApprovalDecided): void
  }): () => void
}

/** Workflow file names the Host accepts. */
export const WORKFLOW_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Seed text for a new file.
 * @param name - the file stem the document's `name` must equal.
 * @returns a minimal valid workflow document.
 */
export function workflowTemplate(name: string): string {
  return `version: 1\nname: ${name}\ndescription: Describe what this workflow does.\nnodes:\n  - id: step\n    kind: bash\n    bash: echo hello\n`
}

const EMPTY_LOAD = { status: 'idle', items: [] } as const
const RUNS_PAGE = 50

/** The Workflows overlay's state machine. */
export class WorkflowsController {
  private state: WorkflowsState = {
    tab: 'workflows', workspaceKey: null, list: EMPTY_LOAD, editor: null, dryRun: null,
    runs: EMPTY_LOAD, approvals: EMPTY_LOAD, detail: null, lease: { state: 'detached' },
  }
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private started = false
  private leaseId: string | undefined
  private renewTimer: ReturnType<typeof setInterval> | undefined
  private ttlTimer: ReturnType<typeof setTimeout> | undefined
  private renewing = false
  private unsubscribe: (() => void) | undefined
  private readonly refreshing = new Map<string, { dirty: boolean }>()
  private validateSeq = 0
  private readSeq = 0
  private dryRunSeq = 0
  private detailSeq = 0

  constructor(private readonly api: WorkflowApi, private readonly events: WorkflowEventSource) {}

  /** Current snapshot; stable between changes. */
  getSnapshot = (): WorkflowsState => this.state

  /** Subscribe to snapshot changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<WorkflowsState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  private setEditor(patch: Partial<EditorView>, name?: string): void {
    const editor = this.state.editor
    if (editor === null || (name !== undefined && editor.name !== name)) return
    this.set({ editor: { ...editor, ...patch } })
  }

  private setDryRun(patch: Partial<DryRunView>): void {
    const dryRun = this.state.dryRun
    if (dryRun !== null) this.set({ dryRun: { ...dryRun, ...patch } })
  }

  // ---- lifecycle -------------------------------------------------------------------------

  /** Subscribe to events, attach the lease, and load the lists. Idempotent. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.unsubscribe = this.events.subscribe({
      runChanged: (change) => { this.onRunChanged(change) },
      approvalPending: (approval) => { this.onApprovalEvent(approval.workspaceKey, approval.runId) },
      approvalDecided: (decision) => { this.onApprovalEvent(decision.workspaceKey, decision.runId) },
    })
    void this.attach()
    void this.loadList()
    void this.loadRuns()
    void this.loadApprovals()
  }

  /** Stop timers and the subscription and release the lease. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    clearInterval(this.renewTimer)
    clearTimeout(this.ttlTimer)
    this.renewTimer = undefined
    this.ttlTimer = undefined
    const leaseId = this.leaseId
    this.leaseId = undefined
    if (leaseId !== undefined) void this.api.detachUi(leaseId)
    this.listeners.clear()
  }

  // ---- lease ------------------------------------------------------------------------------

  private async attach(): Promise<void> {
    this.set({ lease: { state: 'attaching' } })
    const result = await this.api.attachUi()
    if (this.disposed) {
      if (!isFailure(result)) void this.api.detachUi(result.leaseId)
      return
    }
    this.applyLease(result)
    if (!(isFailure(result) && result.loopbackOnly === true)) {
      this.renewTimer = setInterval(() => { void this.renew() }, WORKFLOW_ATTACH_RENEW_MS)
    }
  }

  /** True once disposed; a method so flow analysis does not assume it stayed false across an await. */
  private isClosed(): boolean {
    return this.disposed
  }

  private async renew(): Promise<void> {
    if (this.renewing || this.disposed) return
    this.renewing = true
    try {
      const result = await this.api.attachUi(this.leaseId)
      if (this.isClosed()) return
      this.applyLease(result)
    } finally {
      this.renewing = false
    }
  }

  private applyLease(result: Awaited<ReturnType<WorkflowApi['attachUi']>>): void {
    clearTimeout(this.ttlTimer)
    this.ttlTimer = undefined
    if (isFailure(result)) {
      this.leaseId = undefined
      if (result.loopbackOnly === true) {
        clearInterval(this.renewTimer)
        this.renewTimer = undefined
      }
      this.set({ lease: { state: result.loopbackOnly === true ? 'refused' : 'lapsed', failure: result } })
      return
    }
    this.leaseId = result.leaseId
    // A lease the Host honoured for ttlMs but that we could not renew in time is lapsed whether or
    // not a later call reports it; the timer says so even when the renew call hangs.
    this.ttlTimer = setTimeout(() => {
      this.leaseId = undefined
      this.set({
        lease: {
          state: 'lapsed',
          failure: { ok: false, error: 'LEASE_LAPSED', message: 'The live-approvals lease expired without a renewal.' },
        },
      })
    }, result.ttlMs > 0 ? result.ttlMs : WORKFLOW_ATTACH_TTL_MS)
    this.set({ workspaceKey: result.workspaceKey, lease: { state: 'attached' } })
  }

  // ---- events -----------------------------------------------------------------------------

  private ours(key: string | undefined): boolean {
    return key !== undefined && this.state.workspaceKey !== null && key === this.state.workspaceKey
  }

  private onRunChanged(change: WorkflowRunChange): void {
    if (!this.ours(change.workspaceKey)) return
    this.refresh('runs', () => this.reloadRuns())
    this.refresh('list', () => this.reloadList())
    if (this.state.detail?.runId === change.runId) this.refresh('detail', () => this.reloadDetail(change.runId))
  }

  private onApprovalEvent(key: string | undefined, runId: string): void {
    if (!this.ours(key)) return
    this.refresh('approvals', () => this.loadApprovals())
    if (this.state.detail?.runId === runId) this.refresh('detail', () => this.reloadDetail(runId))
  }

  /** Run `load` now, or once more right after the one in flight, never concurrently. */
  private refresh(key: string, load: () => Promise<void>): void {
    const slot = this.refreshing.get(key)
    if (slot !== undefined) {
      slot.dirty = true
      return
    }
    const fresh = { dirty: false }
    this.refreshing.set(key, fresh)
    void load().finally(() => {
      this.refreshing.delete(key)
      if (fresh.dirty && !this.disposed) this.refresh(key, load)
    })
  }

  // ---- list and editor ---------------------------------------------------------------------

  /**
   * Switch between the Workflows and Runs tabs.
   * @param tab - the tab to show.
   */
  setTab(tab: WorkflowsTab): void {
    this.set({ tab })
  }

  /** Load the workflow list, showing the loading state. */
  async loadList(): Promise<void> {
    this.set({ list: { status: 'loading', items: this.state.list.items } })
    await this.reloadList()
  }

  private async reloadList(): Promise<void> {
    const result = await this.api.list()
    if (isFailure(result)) {
      this.set({ list: { status: 'failed', items: this.state.list.items, failure: result } })
      return
    }
    this.set({ workspaceKey: result.workspaceKey, list: { status: 'ready', items: result.workflows } })
  }

  /**
   * Open an existing file in the editor; only the newest selection is applied.
   * @param name - the workflow file stem.
   */
  async selectWorkflow(name: string): Promise<void> {
    const seq = ++this.readSeq
    this.set({
      tab: 'workflows', dryRun: null,
      editor: {
        name, isNew: false, loading: true, saving: false, text: '', savedText: '', token: '',
        diagnostics: [], inputs: [], conflict: false, justSaved: false, saveFirst: false,
      },
    })
    const result = await this.api.read(name)
    if (seq !== this.readSeq) return
    if (isFailure(result)) {
      this.setEditor({ loading: false, failure: result }, name)
      return
    }
    this.setEditor({ loading: false, text: result.text, savedText: result.text, token: result.token }, name)
    void this.validate(result.text)
  }

  /**
   * Start a new, unsaved file.
   * @param name - the file stem.
   * @returns an error key when the name is unusable, otherwise undefined.
   */
  newWorkflow(name: string): 'invalid' | 'exists' | undefined {
    if (!WORKFLOW_NAME.test(name)) return 'invalid'
    if (this.state.list.items.some(entry => entry.name === name)) return 'exists'
    ++this.readSeq
    const text = workflowTemplate(name)
    this.set({
      tab: 'workflows', dryRun: null,
      editor: {
        name, isNew: true, loading: false, saving: false, text, savedText: '', token: '',
        diagnostics: [], inputs: [], conflict: false, justSaved: false, saveFirst: false,
      },
    })
    void this.validate(text)
    return undefined
  }

  /** Reload the open file from disk, discarding edits (the conflict remedy). */
  async reload(): Promise<void> {
    const name = this.state.editor?.name
    if (name !== undefined) await this.selectWorkflow(name)
  }

  /**
   * Record an edit of the open file's text.
   * @param text - the new text.
   */
  edit(text: string): void {
    this.setEditor({ text, justSaved: false, saveFirst: false })
  }

  /**
   * Validate a draft; only the newest result is applied.
   * @param text - the draft text.
   */
  async validate(text: string): Promise<void> {
    const editor = this.state.editor
    if (editor === null) return
    const seq = ++this.validateSeq
    const result = await this.api.validate(text, editor.name)
    if (seq !== this.validateSeq) return
    if (isFailure(result)) {
      this.setEditor({ failure: result }, editor.name)
      return
    }
    this.setEditor({ diagnostics: result.diagnostics, inputs: result.graph?.inputs ?? [] }, editor.name)
  }

  /**
   * Save with the optimistic token; a lost race raises the conflict state instead of overwriting.
   * @param text - the text to write.
   * @param token - the token the text was loaded with.
   */
  async save(text: string, token: string): Promise<void> {
    const editor = this.state.editor
    if (editor === null || editor.saving) return
    this.setEditor({ saving: true, failure: undefined, justSaved: false })
    const result = await this.api.save({ name: editor.name, text, expectedToken: editor.isNew ? null : token })
    if (isFailure(result)) {
      this.setEditor({
        saving: false,
        failure: result,
        ...result.conflict === true || result.error === 'CONFLICT' ? { conflict: true } : {},
        ...result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics },
      }, editor.name)
      return
    }
    this.setEditor({
      saving: false, isNew: false, conflict: false, savedText: text, token: result.token,
      diagnostics: result.diagnostics, justSaved: true, warning: result.warning,
    }, editor.name)
    this.refresh('list', () => this.reloadList())
  }

  // ---- dry run and run ---------------------------------------------------------------------

  /** Build the plan for the saved file; refuses while there are unsaved edits. */
  async dryRun(): Promise<void> {
    const editor = this.state.editor
    if (editor === null || editor.loading) return
    if (editor.isNew || editor.text !== editor.savedText) {
      this.setEditor({ saveFirst: true })
      return
    }
    const seq = ++this.dryRunSeq
    const inputValues = this.state.dryRun?.inputValues ?? {}
    this.set({
      dryRun: { status: 'loading', inputValues, stale: false, spent: false, starting: false },
    })
    const result = await this.api.dryRun(editor.name, Object.keys(inputValues).length === 0 ? undefined : inputValues)
    if (seq !== this.dryRunSeq || this.state.dryRun === null) return
    if (isFailure(result)) {
      this.setDryRun({ status: 'failed', failure: result })
      return
    }
    this.setDryRun({ status: 'ready', plan: result })
  }

  /**
   * Set or clear one run input; the current plan becomes stale.
   * @param name - the declared input name.
   * @param value - the new value, or undefined to clear it.
   */
  setInput(name: string, value: WorkflowInputValue | undefined): void {
    const dryRun = this.state.dryRun
    if (dryRun === null) return
    const { [name]: _replaced, ...others } = dryRun.inputValues
    const inputValues = value === undefined ? others : { ...others, [name]: value }
    this.set({ dryRun: { ...dryRun, inputValues, stale: true } })
  }

  /**
   * Close the plan view and discard any plan still being built.
   */
  closeDryRun(): void {
    ++this.dryRunSeq
    this.set({ dryRun: null })
  }

  /**
   * Start the planned run. An untrusted plan needs `confirmed` (the human ticked the box under the
   * exact confirmation text); the key and the single-use challenge from that plan go with the call.
   * @param confirmed - whether the human acknowledged the confirmation text.
   */
  async startRun(confirmed: boolean): Promise<void> {
    const dryRun = this.state.dryRun
    const plan = dryRun?.plan
    if (dryRun === null || plan === undefined || dryRun.starting || dryRun.stale || dryRun.spent) return
    const trusted = plan.trusted
    if (!trusted && !confirmed) return
    this.setDryRun({ starting: true, startFailure: undefined })
    const inputs = Object.keys(dryRun.inputValues).length === 0 ? undefined : dryRun.inputValues
    const result = await this.api.run({
      name: plan.name,
      ...inputs === undefined ? {} : { inputs },
      ...trusted ? {} : {
        trustHash: plan.trustKey,
        ...plan.trustChallenge === undefined ? {} : { trustChallenge: plan.trustChallenge },
      },
    })
    if (this.state.dryRun === null) return
    if (isFailure(result)) {
      // The challenge is single-use: once presented, a failed attempt needs a fresh plan.
      this.setDryRun({ starting: false, startFailure: result, spent: !trusted })
      return
    }
    this.setDryRun({ starting: false, startedRunId: result.runId })
    this.refresh('runs', () => this.reloadRuns())
    this.refresh('list', () => this.reloadList())
    void this.openRun(result.runId)
  }

  // ---- runs --------------------------------------------------------------------------------

  /** Load the first page of runs, showing the loading state. */
  async loadRuns(): Promise<void> {
    this.set({ runs: { status: 'loading', items: this.state.runs.items } })
    await this.reloadRuns()
  }

  private async reloadRuns(): Promise<void> {
    const result = await this.api.runs({ limit: RUNS_PAGE })
    if (isFailure(result)) {
      this.set({ runs: { status: 'failed', items: this.state.runs.items, failure: result } })
      return
    }
    this.set({
      workspaceKey: result.workspaceKey,
      runs: { status: 'ready', items: result.runs, ...result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor } },
    })
  }

  /**
   * Append the next page of runs, when there is one.
   */
  async loadMoreRuns(): Promise<void> {
    const cursor = this.state.runs.nextCursor
    if (cursor === undefined) return
    const result = await this.api.runs({ limit: RUNS_PAGE, cursor })
    if (isFailure(result)) {
      this.set({ runs: { ...this.state.runs, status: 'failed', failure: result } })
      return
    }
    this.set({
      runs: {
        status: 'ready', items: [...this.state.runs.items, ...result.runs],
        ...result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor },
      },
    })
  }

  /** Load the approvals waiting for a human. */
  async loadApprovals(): Promise<void> {
    const result = await this.api.pendingApprovals()
    if (isFailure(result)) {
      this.set({ approvals: { status: 'failed', items: this.state.approvals.items, failure: result } })
      return
    }
    this.set({ approvals: { status: 'ready', items: result.approvals } })
  }

  /**
   * Open a run's detail.
   * @param runId - the run to show.
   */
  async openRun(runId: string): Promise<void> {
    this.set({ tab: 'runs', detail: { runId, status: 'loading', outputs: {} }, actionFailure: undefined })
    await this.reloadDetail(runId)
  }

  /**
   * Close the run detail.
   */
  closeDetail(): void {
    ++this.detailSeq
    this.set({ detail: null })
  }

  private async reloadDetail(runId: string): Promise<void> {
    const seq = ++this.detailSeq
    const result = await this.api.runDetail(runId)
    const current = this.state.detail
    if (seq !== this.detailSeq || current === null || current.runId !== runId) return
    if (isFailure(result)) {
      this.set({ detail: { ...current, status: 'failed', failure: result } })
      return
    }
    const { failure: _dropped, ...rest } = current
    this.set({ detail: { ...rest, status: 'ready', detail: result } })
  }

  /**
   * Read (more of) one node's recorded output.
   * @param nodeId - the node whose output to read.
   */
  async loadOutput(nodeId: string): Promise<void> {
    const current = this.state.detail
    if (current === null) return
    const runId = current.runId
    const previous = current.outputs[nodeId]
    const offset = previous?.nextOffset ?? 0
    const put = (view: NodeOutputView): void => {
      const latest = this.state.detail
      if (latest === null || latest.runId !== runId) return
      this.set({ detail: { ...latest, outputs: { ...latest.outputs, [nodeId]: view } } })
    }
    put({
      text: previous?.text ?? '', totalBytes: previous?.totalBytes ?? 0, truncated: previous?.truncated ?? false,
      ...previous?.nextOffset === undefined ? {} : { nextOffset: previous.nextOffset },
      loading: true,
    })
    const result = await this.api.nodeOutput(runId, nodeId, offset, WORKFLOW_OUTPUT_MAX_BYTES)
    if (isFailure(result)) {
      put({ text: previous?.text ?? '', totalBytes: previous?.totalBytes ?? 0, truncated: previous?.truncated ?? false, loading: false, failure: result })
      return
    }
    put({
      text: `${previous?.text ?? ''}${result.text}`, totalBytes: result.totalBytes, truncated: result.truncated,
      ...result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset },
      loading: false,
    })
  }

  // ---- privileged run actions ---------------------------------------------------------------

  /**
   * Dismiss the last failed run action.
   */
  dismissActionFailure(): void {
    this.set({ actionFailure: undefined })
  }

  private afterAction(runId: string): void {
    this.refresh('approvals', () => this.loadApprovals())
    this.refresh('runs', () => this.reloadRuns())
    if (this.state.detail?.runId === runId) this.refresh('detail', () => this.reloadDetail(runId))
  }

  /**
   * Allow a waiting approval; a refusal stays visible as the action failure.
   * @param runId - the run.
   * @param approvalId - the approval.
   */
  async approve(runId: string, approvalId: string): Promise<void> {
    const result = await this.api.approve(runId, approvalId)
    this.set({ actionFailure: isFailure(result) ? result : undefined })
    this.afterAction(runId)
  }

  /**
   * Reject a waiting approval.
   * @param runId - the run.
   * @param approvalId - the approval.
   * @param reason - why; blank sends none.
   */
  async reject(runId: string, approvalId: string, reason: string): Promise<void> {
    const trimmed = reason.trim()
    const result = await this.api.reject(runId, approvalId, trimmed === '' ? undefined : trimmed)
    this.set({ actionFailure: isFailure(result) ? result : undefined })
    this.afterAction(runId)
  }

  /**
   * Ask a run to stop.
   * @param runId - the run.
   */
  async cancel(runId: string): Promise<void> {
    const result = await this.api.cancel(runId)
    this.set({ actionFailure: isFailure(result) ? result : undefined })
    this.afterAction(runId)
  }

  /**
   * Resume an earlier run and open the new one.
   * @param runId - the run to resume.
   */
  async resume(runId: string): Promise<void> {
    const result = await this.api.resume(runId)
    if (isFailure(result)) {
      this.set({ actionFailure: result })
      return
    }
    this.set({ actionFailure: undefined })
    this.refresh('runs', () => this.reloadRuns())
    void this.openRun(result.runId)
  }
}

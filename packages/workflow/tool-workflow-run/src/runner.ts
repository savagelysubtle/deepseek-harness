/**
 * The host-side workflow runner, `ctx.workflowRuns`. It owns one run-store handle per workspace,
 * compiles and pins a workflow, enforces the trust and single-writer rules, starts the engine with
 * the sandboxed shell executor and the store-backed approval broker, records every node, gate and
 * approval, and closes the run with a gate report on every terminal path. The model tool and the
 * Workflows UI share this one path.
 * @module @deepseek-ai/dsh-tool-workflow-run/runner
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { createWorkflowRecorder } from '@deepseek-ai/dsh-tool-workflow'
import type { WorkflowRecorder } from '@deepseek-ai/dsh-tool-workflow'
import { WORKFLOW_NODE_ID_PATTERN, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowRun, WorkflowStartRequest, WorkflowResult } from '@deepseek-ai/dsh-workflow'
import { openStore, WorkflowStoreError, workflowStoreDir } from '@deepseek-ai/dsh-workflow-run-store'
import type { ListRunsResult, OutputSlice, RunDetail, WorkflowRunEndStatus, WorkflowRunStore } from '@deepseek-ai/dsh-workflow-run-store'
import {
  analyze, compile, describeGraph, describeTrustFacts, sha256Hex, WorkflowCompileError,
} from '@deepseek-ai/dsh-workflow-yaml'
import type { AnalyzeResult, CompiledWorkflow, Diagnostic, WorkflowDoc } from '@deepseek-ai/dsh-workflow-yaml'
import { ApprovalBroker, hasOpenTurn, WriteQueue } from './broker.ts'
import type { BrokerAnswer, PendingApprovalView } from './broker.ts'
import type { ResolvedConfig } from './config.ts'
import {
  listWorkflowNames, readPromptFiles, readWorkflowByName, readWorkflowByPath, WorkflowFileError,
} from './discover.ts'
import type { WorkflowSourceFile } from './discover.ts'
import { createShellBashExecutor, SHELL_CAPTURE_BYTES } from './executor.ts'
import { escapeUnsafe, modelFacingError } from './text.ts'
import { buildGateReport, gateKey } from './report.ts'
import { planResume, seedScript } from './resume.ts'
import { renderTrustReason, TrustStore, TrustTextError, trustKey } from './trust.ts'
import type {
  DryRunPlan, GateReportRow, RunNodeSummary, RunOutcome, StartOptions, StartRefused, StartResult, WorkflowRunsEvent,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowRuns: WorkflowRunsService
  }
}

/** The read side of a workspace's run store, as exposed on the service. */
export interface WorkflowStoreReader {
  /** The store directory. */
  readonly dir: string
  /** One run's header, nodes, gates, approvals and end record. */
  getRun(runId: string): Promise<RunDetail>
  /** Runs newest first, optionally filtered by workflow name. */
  listRuns(options?: { name?: string; limit?: number; cursor?: string }): Promise<ListRunsResult>
  /** The pinned workflow source text of a run. */
  readSource(runId: string): Promise<string>
  /** A bounded byte range of one node's output. */
  readOutput(runId: string, nodeId: string, offset: number, limit: number): Promise<OutputSlice>
}

/** How long a server-issued trust challenge stays redeemable. */
export const TRUST_CHALLENGE_TTL_MS = 5 * 60 * 1000
/** Most unredeemed trust challenges held at once; the oldest is dropped beyond it. */
const MAX_TRUST_CHALLENGES = 64

/** Open trust challenges one caller session may hold; a further `dryRun` drops that caller's oldest. */
const MAX_TRUST_CHALLENGES_PER_CALLER = 4

/** Who may cancel a run: the run must belong to this workspace (and, when given, this session). */
export interface CancelScope {
  /** The caller's workspace path; resolved through `realpath`. */
  readonly workspace: string
  /** When set, only a run started from this parent session matches. */
  readonly sessionId?: string
}

interface TrustChallenge {
  readonly key: string
  readonly workspace: string
  readonly caller: string
  readonly expiresAt: number
}

/** Options of {@link WorkflowRunsService.dryRun}. */
export interface DryRunOptions extends Pick<StartOptions, 'name' | 'path' | 'inputs'> {
  /**
   * The calling session id. When set and the content is untrusted, the plan carries a single-use
   * `trustChallenge` bound to this caller, the workspace and the trust key.
   */
  readonly caller?: string
}

/** Largest serialized `inputs` accepted (the store keeps up to this much, so resume stays sound). */
const MAX_INPUTS_BYTES = 16 * 1024
/** Characters kept of a script-returned node output when it is recorded. */
const SCRIPT_OUTPUT_TAIL = 8192
/** How long a dispose waits for cancelled runs to close their records. */
const DISPOSE_WAIT_MS = 15_000

/** Start options with a resolved workspace. */
export interface WorkspaceOptions {
  /** The workspace root; resolved through `realpath`. */
  readonly workspace: string
}

interface NodeLedgerEntry {
  readonly kind: string
  readonly startedAt: number
  status?: string
  exitCode?: number
  durationMs?: number
  /** Real agent attempts the node ran (retries included); absent for a node that ran no agent. */
  attempts?: number
  /** The supervisor stop that failed the node (stall or hard timeout), when there was one. */
  failure?: { code: string; message: string; remedy: string }
}

/** The `workflow/node-end` fields this runner reads. */
interface NodeEndPayload {
  readonly nodeId: string
  readonly kind: string
  readonly status: string
  readonly exitCode?: number
  readonly durationMs?: number
  readonly error?: string
  readonly attempts?: number
  readonly failure?: { readonly code: string; readonly message: string; readonly remedy: string }
}

interface BashBuffer {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
}

interface ActiveRun {
  readonly runId: string
  readonly name: string
  readonly hash: string
  readonly workspace: string
  readonly store: WorkflowRunStore
  readonly parent: StartOptions['parent']
  readonly queue: WriteQueue
  readonly ready: Promise<void>
  readonly nodes: Map<string, NodeLedgerEntry>
  readonly buffers: Map<string, BashBuffer>
  readonly outcomes: Map<string, string>
  readonly reasons: Map<string, string>
  readonly manifest: readonly { nodeId: string; gateKind: string }[]
  readonly resumedFrom: string | undefined
  readonly controller: AbortController
  engineRun: WorkflowRun | undefined
  storeFailure: string | undefined
  interrupted: boolean
  cancelReason: string | undefined
  done: Promise<RunOutcome>
}

/** A run's stored detail plus the pin facts the UI shows. */
export interface RunView {
  readonly detail: RunDetail
  readonly pinnedHash: string
  /** True when the live workflow file's hash differs from the hash this run is pinned to (or the file is gone). */
  readonly fileChanged: boolean
}

function resolveHome(config: ResolvedConfig): string {
  if (config.dshHome !== undefined && config.dshHome.length > 0) return config.dshHome
  const env = process.env['DSH_HOME']
  return env !== undefined && env.length > 0 ? env : join(homedir(), '.dsh')
}

function digestsOf(promptFiles: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(promptFiles ?? {}).map(([path, text]) => [path, sha256Hex(text)]))
}

function refused(error: StartRefused['error'], message: string, extra: Partial<StartRefused> = {}): StartRefused {
  return { ok: false, error, message, ...extra }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const WRITER_BUSY_REMEDY = 'Wait for it to finish, or cancel it in Workflows (Cancel button) / `workflow_run {cancel}`.'

/** Fixed, path-free text for each store failure; the detail goes to the host log only. */
const STORE_ERROR_TEXT: Readonly<Record<WorkflowStoreError['code'], string>> = {
  WRITER_BUSY: `Another workflow run is already active in this workspace. ${WRITER_BUSY_REMEDY}`,
  NOT_WRITER: 'This process does not hold the run guard for the workspace. Try again.',
  UNSUPPORTED_VERSION: 'The workflow run store was written by a newer version of the harness. Update the harness.',
  WORKSPACE_MISMATCH: 'The workflow run store belongs to a different workspace. Check the workspace and try again.',
  INVALID_ID: 'That run id is not valid. List the runs in Workflows and use one of those ids.',
  RUN_EXISTS: 'The run record could not be created. Try again.',
  RUN_NOT_FOUND: 'No such run exists in this workspace.',
  APPROVAL_NOT_FOUND: 'No such approval exists for that run.',
  OUTPUT_NOT_FOUND: 'No saved output exists for that node.',
  INVALID_INPUT: 'The run record rejected the data it was given. Check the inputs and try again.',
}

const INTERNAL_ERROR_TEXT = 'The workflow runner hit an internal error. The details are in the host log. Try again; if it repeats, report it.'

/**
 * Text for the model about a failure: fixed and path-free for store and filesystem errors, the
 * message itself only for errors whose text is written to be shown.
 */
function safeText(error: unknown): string {
  if (error instanceof WorkflowStoreError) return STORE_ERROR_TEXT[error.code]
  if (error instanceof WorkflowFileError) return error.message
  return INTERNAL_ERROR_TEXT
}

/**
 * Format diagnostics as located lines for a tool result.
 * @param diagnostics - the compile or validation diagnostics.
 * @param limit - the most lines to show.
 * @returns one `line:column severity [code] message` line per diagnostic.
 */
export function renderDiagnostics(diagnostics: readonly Diagnostic[], limit: number = 20): string {
  const shown = diagnostics.slice(0, limit).map(d => `  ${d.line}:${d.column} ${d.severity} [${d.code}] ${d.message}`)
  if (diagnostics.length > limit) shown.push(`  … and ${diagnostics.length - limit} more`)
  return shown.join('\n')
}

/**
 * The workflow runner service. See the module comment.
 */
export class WorkflowRunsService extends Service {
  private readonly stores = new Map<string, Promise<WorkflowRunStore>>()
  private readonly byEngineId = new Map<string, ActiveRun>()
  private readonly active = new Map<string, ActiveRun>()
  private readonly listeners = new Set<(event: WorkflowRunsEvent) => void>()
  private readonly challenges = new Map<string, TrustChallenge>()
  private uiAttached = 0
  private readonly recorder: WorkflowRecorder
  private readonly broker: ApprovalBroker
  private readonly home: string
  private closing = false

  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx, 'workflowRuns')
    this.home = resolveHome(config)
    this.recorder = createWorkflowRecorder(ctx)
    this.broker = new ApprovalBroker({
      approvalWaitMs: config.approvalWaitMs,
      headless: config.headless,
      getApproval: () => ctx.get('approval'),
      hasListeners: () => this.uiAttached > 0,
      emit: (event) => { this.recordApproval(event); this.publish(event) },
      warn: (message) => { ctx.logger.warn(`tool-workflow-run: ${message}`) },
    })
    ctx.on('workflow/node-start', (info, node) => {
      const run = this.byEngineId.get(info.id)
      if (run === undefined) return
      this.onNodeStart(run, node.nodeId, node.kind)
    })
    ctx.on('workflow/node-end', (info, node) => {
      const run = this.byEngineId.get(info.id)
      if (run === undefined) return
      this.onNodeEnd(run, node)
    })
    ctx.on('workflow/gate', (info, gate) => {
      const run = this.byEngineId.get(info.id)
      if (run === undefined) return
      this.onGate(run, gate.nodeId, gate.gateKind, gate.outcome)
    })
    ctx.effect(() => () => this.shutdown(), 'workflow runs teardown')
  }

  /**
   * Subscribe to run and approval changes.
   * @param listener - called synchronously with each event; a throw is contained.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (event: WorkflowRunsEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Declare that a human who can answer approvals is attached (the Workflows UI is open).
   * While at least one attachment is held, an approval waits for an answer instead of being
   * rejected at once; with none, an approval nobody can answer fails closed. Attaching is an
   * explicit act, never inferred from {@link WorkflowRunsService.subscribe}.
   * @returns the disposer that withdraws this attachment; calling it again does nothing.
   */
  attachUi(): () => void {
    this.uiAttached += 1
    let held = true
    return () => {
      if (!held) return
      held = false
      this.uiAttached -= 1
    }
  }

  /** Project an approval transition into the parent session's durable log; never throws. */
  private recordApproval(event: WorkflowRunsEvent): void {
    if (event.type === 'run-changed') return
    const run = this.active.get(event.runId)
    if (run?.engineRun === undefined) return
    const at = Date.now()
    const kind = run.nodes.get(event.nodeId)?.kind ?? 'approval'
    if (event.type === 'approval-pending') {
      this.recorder.approval(WorkflowRunId(run.engineRun.id), { nodeId: event.nodeId, kind, approvalId: event.approvalId, state: 'pending', at })
      return
    }
    const known = ['allowed', 'rejected', 'expired', 'unavailable', 'cancelled'] as const
    const state = known.find(candidate => candidate === event.state) ?? 'unavailable'
    this.recorder.approval(WorkflowRunId(run.engineRun.id), {
      nodeId: event.nodeId,
      kind,
      approvalId: event.approvalId,
      state,
      ...event.reason === undefined ? {} : { reason: event.reason },
      at,
    })
  }

  private publish(event: WorkflowRunsEvent): void {
    const workspace = event.workspace ?? this.active.get(event.runId)?.workspace
    const stamped = workspace === undefined ? event : { ...event, workspace }
    for (const listener of this.listeners) {
      try {
        listener(stamped)
      } catch (error: unknown) {
        this.ctx.logger.warn(`tool-workflow-run: a run listener threw: ${describeError(error)}`)
      }
    }
  }

  /**
   * The run store of a workspace: one handle per workspace per process.
   * @param workspace - a workspace path; resolved through `realpath`.
   * @returns the shared store handle, narrowed to its read methods (writes go through this service).
   */
  async storeFor(workspace: string): Promise<WorkflowStoreReader> {
    return await this.openStoreFor(workspace)
  }

  private async openStoreFor(workspace: string): Promise<WorkflowRunStore> {
    const real = await realpath(workspace)
    let handle = this.stores.get(real)
    if (handle === undefined) {
      handle = (async () => {
        const { dir, workspace: ws } = await workflowStoreDir(this.home, real)
        return await openStore({ dir, workspace: ws, retention: this.config.retention })
      })()
      this.stores.set(real, handle)
      handle.catch(() => { this.stores.delete(real) })
    }
    return await handle
  }

  private async trustStoreFor(workspace: string): Promise<TrustStore> {
    const real = await realpath(workspace)
    const { dir } = await workflowStoreDir(this.home, real)
    return new TrustStore(dir, real)
  }

  /**
   * Workflows present in a workspace's workflows directory.
   * @param workspace - the workspace path.
   * @returns the sorted names.
   */
  async listWorkflows(workspace: string): Promise<string[]> {
    return await listWorkflowNames(await realpath(workspace), this.config.workflowsDir)
  }

  /**
   * One run's stored detail with its pin facts.
   * @param workspace - the workspace path.
   * @param runId - the run.
   * @returns the detail, the pinned hash and whether the live file changed.
   */
  async getRunView(workspace: string, runId: string): Promise<RunView> {
    const real = await realpath(workspace)
    const store = await this.openStoreFor(real)
    const detail = await store.getRun(runId)
    let fileChanged = false
    try {
      const live = await readWorkflowByName(real, this.config.workflowsDir, detail.header.name)
      fileChanged = sha256Hex(live.text) !== detail.header.hash
    } catch {
      fileChanged = true
    }
    return { detail, pinnedHash: detail.header.hash, fileChanged }
  }

  /**
   * Approvals waiting for an answer in this process.
   * @param runId - restrict to one run.
   * @returns the waiting approvals.
   */
  pendingApprovals(runId?: string): PendingApprovalView[] {
    return this.broker.pendingApprovals(runId)
  }

  /**
   * Answer a waiting approval (the UI path).
   * @param runId - the run.
   * @param approvalId - the store approval id.
   * @param answer - allow or reject.
   * @param reason - optional human reason, recorded.
   * @returns the winning state, or undefined when nothing is waiting under that id here.
   */
  async answerApproval(runId: string, approvalId: string, answer: BrokerAnswer, reason?: string): Promise<string | undefined> {
    return await this.broker.answer(runId, approvalId, answer, reason)
  }

  /**
   * The runs this process is executing now.
   * @returns run id, name, hash, workspace realpath and parent session id of each.
   */
  activeRuns(): { runId: string; name: string; hash: string; workspace: string; sessionId: string }[] {
    return [...this.active.values()].map(r => ({
      runId: r.runId, name: r.name, hash: r.hash, workspace: r.workspace, sessionId: r.parent.session.id,
    }))
  }

  /**
   * The workspace-relative directory that holds workflow files.
   * @returns the configured directory, default `.workflows`.
   */
  workflowsDir(): string {
    return this.config.workflowsDir
  }

  /**
   * Cancel a run owned by this process, if it belongs to the caller's workspace (and session).
   * A run outside the scope answers exactly like a run that does not exist.
   * @param runId - the run.
   * @param reason - why, recorded on the run.
   * @param scope - the caller's workspace, and optionally its session.
   * @returns whether this process owns a matching run, with its eventual outcome.
   */
  async cancel(runId: string, reason: string, scope: CancelScope): Promise<{ found: boolean; outcome?: RunOutcome }> {
    const run = this.active.get(runId)
    if (run === undefined) return { found: false }
    let workspace: string
    try {
      workspace = await realpath(scope.workspace)
    } catch {
      return { found: false }
    }
    if (run.workspace !== workspace) return { found: false }
    if (scope.sessionId !== undefined && run.parent.session.id !== scope.sessionId) return { found: false }
    run.cancelReason = reason
    run.engineRun?.cancel(reason)
    run.controller.abort()
    return { found: true, outcome: await run.done }
  }

  // ------------------------------------------------------------ trust challenge

  /** Mint a single-use token that proves a plan was served to this caller for this exact content. */
  private issueChallenge(key: string, workspace: string, caller: string): string {
    const now = Date.now()
    for (const [token, entry] of this.challenges) {
      if (entry.expiresAt <= now) this.challenges.delete(token)
    }
    // A caller can only displace its own challenges: the per-caller cap is applied before the
    // global one, so one session cannot evict a human's live confirmation in another.
    const own = [...this.challenges].filter(([, entry]) => entry.caller === caller).map(([token]) => token)
    for (const token of own.slice(0, Math.max(0, own.length - (MAX_TRUST_CHALLENGES_PER_CALLER - 1)))) {
      this.challenges.delete(token)
    }
    while (this.challenges.size >= MAX_TRUST_CHALLENGES) {
      const oldest = this.challenges.keys().next().value
      if (oldest === undefined) break
      this.challenges.delete(oldest)
    }
    const token = randomBytes(24).toString('hex')
    this.challenges.set(token, { key, workspace, caller, expiresAt: now + TRUST_CHALLENGE_TTL_MS })
    return token
  }

  /**
   * Look a presented challenge up and spend it. A challenge is consumed by any presentation, so a
   * replay (or a guess after a miss) never finds it.
   */
  private redeemChallenge(token: string | undefined, workspace: string, caller: string): TrustChallenge | undefined {
    if (token === undefined) return undefined
    const entry = this.challenges.get(token)
    if (entry === undefined) return undefined
    this.challenges.delete(token)
    if (entry.expiresAt <= Date.now() || entry.workspace !== workspace || entry.caller !== caller) return undefined
    return entry
  }

  // ---------------------------------------------------------------- loading

  private async load(workspace: string, options: Pick<StartOptions, 'name' | 'path'>): Promise<WorkflowSourceFile | StartRefused> {
    try {
      if (options.path !== undefined) return await readWorkflowByPath(workspace, this.config.workflowsDir, options.path)
      return await readWorkflowByName(workspace, this.config.workflowsDir, options.name ?? '')
    } catch (error: unknown) {
      if (error instanceof WorkflowFileError) return refused('NOT_FOUND', error.message)
      throw error
    }
  }

  private compileSource(
    text: string,
    expectedName: string | undefined,
    promptFiles: Record<string, string> | undefined,
  ): { ok: true; analysis: AnalyzeResult & { doc: WorkflowDoc; hash: string }; compiled: CompiledWorkflow } | StartRefused {
    const analysis = analyze(text, expectedName === undefined ? {} : { expectedName })
    const errors = analysis.diagnostics.filter(d => d.severity === 'error')
    if (!analysis.ok || analysis.doc === undefined || analysis.hash === undefined) {
      return refused('DIAGNOSTICS', `the workflow has ${errors.length} error${errors.length === 1 ? '' : 's'}:\n${renderDiagnostics(errors)}`, {
        diagnostics: analysis.diagnostics,
        remedy: 'Fix the located problems in the YAML file and run again.',
      })
    }
    try {
      const compiled = compile(analysis.doc, { promptFiles: promptFiles ?? {} })
      return { ok: true, analysis: analysis as AnalyzeResult & { doc: WorkflowDoc; hash: string }, compiled }
    } catch (error: unknown) {
      if (error instanceof WorkflowCompileError) return refused('DIAGNOSTICS', `the workflow could not be compiled: ${error.message}`)
      throw error
    }
  }

  private validateInputs(doc: WorkflowDoc, raw: unknown): StartRefused | undefined {
    // Typed as unknown on purpose: remote callers are untrusted and may send any JSON value.
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
      return refused('INVALID_INPUT', 'inputs must be an object of input name to value')
    }
    const given = (raw ?? {}) as Readonly<Record<string, unknown>>
    const declared = new Map(doc.inputs.map(i => [i.name, i] as const))
    for (const key of Object.keys(given)) {
      if (!declared.has(key)) {
        return refused('INVALID_INPUT', `unknown input '${key.slice(0, 64)}'; declared inputs: ${[...declared.keys()].join(', ')
          || '(none)'}`)
      }
    }
    for (const spec of doc.inputs) {
      const value = given[spec.name]
      if (value === undefined || value === null || value === '') {
        if (spec.required && spec.default === undefined) return refused('INVALID_INPUT', `missing required input '${spec.name}'`)
        continue
      }
      const ok = spec.type === 'string' ? typeof value === 'string'
        : spec.type === 'number' ? typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''
          && Number.isFinite(Number(value)))
          : typeof value === 'boolean' || value === 'true' || value === 'false'
      if (!ok) return refused('INVALID_INPUT', `input '${spec.name}' must be a ${spec.type}`)
    }
    if (JSON.stringify(given).length > MAX_INPUTS_BYTES) return refused('INVALID_INPUT', `inputs are larger than ${MAX_INPUTS_BYTES} bytes`)
    return undefined
  }

  // ---------------------------------------------------------------- dry run

  /**
   * Describe a workflow without running anything: the DAG, the gate manifest and the trust facts.
   * No store is opened and no process or agent is started.
   * @param workspace - the workspace path.
   * @param options - which workflow; `caller` (the calling session id) asks for a trust challenge.
   * @returns the plan, or why none could be made.
   */
  async dryRun(workspace: string, options: DryRunOptions): Promise<DryRunPlan | StartRefused> {
    try {
      return await this.dryRunInner(workspace, options)
    } catch (error: unknown) {
      return this.internalRefusal('dry run', error)
    }
  }

  /** Log the detail of an unexpected failure and refuse with fixed text. */
  private internalRefusal(what: string, error: unknown): StartRefused {
    if (error instanceof WorkflowStoreError || error instanceof WorkflowFileError) {
      this.ctx.logger.warn(`tool-workflow-run: ${what} failed: ${describeError(error)}`)
      return refused(error instanceof WorkflowFileError ? 'NOT_FOUND' : 'START_FAILED', safeText(error))
    }
    this.ctx.logger.warn(`tool-workflow-run: ${what} failed unexpectedly: ${describeError(error)}`)
    return refused('START_FAILED', INTERNAL_ERROR_TEXT)
  }

  private async dryRunInner(workspace: string, options: DryRunOptions): Promise<DryRunPlan | StartRefused> {
    const real = await realpath(workspace)
    const file = await this.load(real, options)
    if ('ok' in file) return file
    let promptFiles: Record<string, string> | undefined
    const first = analyze(file.text, { expectedName: file.name })
    if (first.doc !== undefined) {
      const wanted = [...new Set(first.doc.nodes.flatMap(n => ((n.kind === 'prompt' || n.kind === 'loop') && n.promptFile !== undefined
        ? [n.promptFile] : [])))]
      try {
        promptFiles = await readPromptFiles(real, wanted)
      } catch (error: unknown) {
        if (error instanceof WorkflowFileError) return refused('NOT_FOUND', error.message)
        throw error
      }
    }
    const built = this.compileSource(file.text, file.name, promptFiles)
    if ('ok' in built && !built.ok) return built
    const { analysis, compiled } = built
    const inputProblem = this.validateInputs(analysis.doc, options.inputs)
    if (inputProblem !== undefined) return inputProblem
    const key = trustKey(analysis.hash, digestsOf(promptFiles))
    const trusted = await (await this.trustStoreFor(real)).isTrusted(key)
    let confirmText: string | undefined
    if (!trusted) {
      try {
        confirmText = renderTrustReason(describeTrustFacts(analysis.doc), analysis.hash, {
          workspace: real, promptDigests: digestsOf(promptFiles), tierModels: this.config.tierModels,
        })
      } catch (error: unknown) {
        if (error instanceof TrustTextError) {
          return refused('TRUST_DENIED', `workflow '${escapeUnsafe(analysis.doc.name)}' cannot be trusted: ${error.message}`, {
            remedy: 'Shorten the command (move the logic into a script file in the workspace) and run again.',
          })
        }
        throw error
      }
    }
    const challenge = !trusted && options.caller !== undefined ? this.issueChallenge(key, real, options.caller) : undefined
    return {
      ok: true,
      name: analysis.doc.name,
      hash: analysis.hash,
      trusted,
      trustKey: key,
      ...challenge === undefined ? {} : { trustChallenge: challenge },
      ...confirmText === undefined ? {} : { confirmText },
      graph: describeGraph(analysis.doc),
      manifest: compiled.manifest.map(m => ({ nodeId: m.nodeId, gateKind: m.gateKind })),
      trust: describeTrustFacts(analysis.doc),
      plan: describeGraph(analysis.doc).nodes.slice().sort((a, b) => a.layer - b.layer || a.order - b.order).map(n => n.id),
      warnings: analysis.diagnostics.filter(d => d.severity === 'warning'),
    }
  }

  // ------------------------------------------------------------------ start

  /**
   * Start (or resume) a workflow run.
   * @param options - which workflow, its inputs, the parent agent and the trust confirmation.
   * @returns a started run whose `done` settles when the record is closed, or why the start was refused.
   */
  async start(options: StartOptions): Promise<StartResult> {
    try {
      return await this.startInner(options)
    } catch (error: unknown) {
      return this.internalRefusal('start', error)
    }
  }

  private async startInner(options: StartOptions): Promise<StartResult> {
    if (this.closing) return refused('START_FAILED', 'the workflow runner is shutting down')
    const workspace = await realpath(options.parent.session.header.cwd ?? process.cwd())
    const store = await this.openStoreFor(workspace)

    let source: string
    let expectedName: string
    let inputs: Readonly<Record<string, unknown>> | undefined = options.inputs
    let resumedFrom: string | undefined
    let resumeDetail: RunDetail | undefined
    if (options.resume !== undefined) {
      resumedFrom = options.resume
      try {
        resumeDetail = await store.getRun(options.resume)
        source = await store.readSource(options.resume)
      } catch (error: unknown) {
        if (error instanceof WorkflowStoreError) {
          this.ctx.logger.warn(`tool-workflow-run: resume lookup failed: ${error.message}`)
          return refused('RESUME_REFUSED', `cannot resume run '${escapeUnsafe(options.resume.slice(0, 80))}': ${safeText(error)}`)
        }
        throw error
      }
      if (resumeDetail.status === 'running' || this.active.has(options.resume)) {
        return refused('RESUME_REFUSED', `run '${escapeUnsafe(options.resume.slice(0, 80))}' is still running`,
          { remedy: 'Cancel it first (`workflow_run {cancel}`), then resume.' })
      }
      expectedName = resumeDetail.header.name
      const stored = resumeDetail.header.inputs
      if (typeof stored === 'object' && stored !== null && (stored as { truncated?: unknown }).truncated === true) {
        return refused('RESUME_REFUSED', 'cannot resume: the original inputs were too large to be stored',
          { remedy: 'Start a fresh run with the inputs.' })
      }
      inputs = (stored ?? {}) as Record<string, unknown>
    } else {
      const file = await this.load(workspace, options)
      if ('ok' in file) return file
      source = file.text
      expectedName = file.name
    }

    const first = analyze(source, { expectedName })
    let promptFiles: Record<string, string> | undefined
    if (first.doc !== undefined) {
      const wanted = [...new Set(first.doc.nodes.flatMap(n => ((n.kind === 'prompt' || n.kind === 'loop') && n.promptFile !== undefined
        ? [n.promptFile] : [])))]
      try {
        promptFiles = await readPromptFiles(workspace, wanted)
      } catch (error: unknown) {
        if (error instanceof WorkflowFileError) return refused('NOT_FOUND', error.message)
        throw error
      }
    }
    const built = this.compileSource(source, expectedName, promptFiles)
    if ('ok' in built && !built.ok) return built
    const { analysis, compiled } = built
    const doc = analysis.doc
    const hash = analysis.hash
    const inputProblem = this.validateInputs(doc, inputs)
    if (inputProblem !== undefined) return inputProblem

    const promptHashes = digestsOf(promptFiles)

    // Resume plan: store-only.
    let script = compiled.script
    let seededGates: { nodeId: string; gateKind: string; outcome: string }[] = []
    const seeds = new Map<string, { status: 'success'; output: string; exitCode?: number }>()
    if (resumeDetail !== undefined) {
      if (hash !== resumeDetail.header.hash) return refused('RESUME_REFUSED',
        'the pinned source of that run no longer matches its recorded hash')
      const recorded = (resumeDetail.header.manifest as { promptFiles?: Record<string, string> }).promptFiles ?? {}
      for (const [path, digest] of Object.entries(promptHashes)) {
        if (recorded[path] !== digest) {
          return refused('RESUME_REFUSED', `prompt file '${path}' changed since the run being resumed started`,
            { remedy: 'Start a fresh run, or restore the prompt file.' })
        }
      }
      const plan = await planResume(store, resumeDetail, doc)
      if (!plan.ok) return refused('RESUME_REFUSED', plan.reason)
      for (const [id, seed] of plan.seeds) seeds.set(id, seed)
      seededGates = [...plan.gates]
      const seeded = seedScript(script, seeds)
      if (seeded === undefined) return refused('RESUME_REFUSED', 'cannot resume: the compiled script no longer has the node wrapper the resume needs (compiler changed)')
      script = seeded
    }

    // Optional service: without it nothing can run, and no run record may be created.
    const engine = this.ctx.get('workflowEngine')
    if (engine === undefined) {
      return refused('RUNNER_UNAVAILABLE', 'Workflow runs are not available in this composition: no workflow engine is mounted.', {
        remedy: 'Use a composition that includes the workflow engine (dsh-workflow plus a worker provider).',
      })
    }

    // Trust.
    const trust = await this.trustStoreFor(workspace)
    const key = trustKey(hash, promptHashes)
    if (!(await trust.isTrusted(key))) {
      const verdict = await this.confirmTrust(options, doc, { hash, key, workspace, promptDigests: promptHashes }, trust)
      if (verdict !== undefined) return verdict
    }

    // The shell must be mountable before a run record exists.
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      return refused('START_FAILED', 'workflow_run needs a shell executor (ctx.shell), and none is mounted in this composition')
    }
    let bashExecutor: WorkflowStartRequest['bashExecutor']
    try {
      const sandboxPolicy = this.ctx.get('sandboxPolicy')
      bashExecutor = createShellBashExecutor({
        shell,
        session: options.parent.session,
        ...sandboxPolicy === undefined ? {} : { sandboxPolicy },
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`tool-workflow-run: ${describeError(error)}`)
      return refused('START_FAILED', 'workflow_run cannot run shell commands here: the confining shell has no sandbox policy service mounted')
    }

    // Single writer + pin.
    const runId = randomUUID()
    const manifestGates = compiled.manifest.map(m => ({ nodeId: m.nodeId, gateKind: m.gateKind }))
    const liveGates = manifestGates.filter(g => !seeds.has(g.nodeId))
    try {
      await store.startRun({
        runId,
        name: doc.name,
        hash,
        source,
        parentSessionId: options.parent.session.id,
        inputs: inputs ?? {},
        manifest: {
          gates: manifestGates,
          promptFiles: promptHashes,
          ...resumedFrom === undefined ? {} : { resumedFrom, seeded: [...seeds.keys()] },
        },
      })
    } catch (error: unknown) {
      if (error instanceof WorkflowStoreError && error.code === 'WRITER_BUSY') {
        // The store's own text names the lock file and the host; the model gets fixed text and the holder facts only.
        this.ctx.logger.warn(`tool-workflow-run: writer busy: ${error.message}`)
        const holder = error.holder
        const what = holder?.workflowName === undefined ? 'another workflow run' : `workflow '${escapeUnsafe(holder.workflowName)}'`
        const run = holder?.runId === undefined ? '' : ` (run ${escapeUnsafe(holder.runId.slice(0, 80))})`
        const since = holder === undefined ? '' : `, started ${new Date(holder.startedAt).toISOString()}`
        return refused('WRITER_BUSY', `Another run is already active in this workspace: ${what}${run}${since}.`, {
          remedy: WRITER_BUSY_REMEDY,
          ...holder === undefined ? {} : {
            holder: {
              pid: holder.pid,
              startedAt: holder.startedAt,
              ...holder.runId === undefined ? {} : { runId: holder.runId },
              ...holder.workflowName === undefined ? {} : { workflowName: holder.workflowName },
            },
          },
        })
      }
      if (error instanceof WorkflowStoreError) {
        this.ctx.logger.warn(`tool-workflow-run: could not start the run record: ${error.message}`)
        return refused('START_FAILED', safeText(error))
      }
      throw error
    }

    // Past this point the run record exists: every path must end it.
    const controller = new AbortController()
    const queue = new WriteQueue()
    const ready = Promise.resolve()
    const run: ActiveRun = {
      runId, name: doc.name, hash, workspace, store, parent: options.parent, queue, ready,
      nodes: new Map(), buffers: new Map(), outcomes: new Map(), reasons: new Map(), manifest: manifestGates,
      resumedFrom, controller, engineRun: undefined, storeFailure: undefined, interrupted: false, cancelReason: undefined,
      done: Promise.resolve(undefined as unknown as RunOutcome),
    }
    try {
      for (const [nodeId, seed] of seeds) {
        const now = Date.now()
        await store.recordNode(runId, {
          nodeId, nodeKind: doc.nodes.find(n => n.id === nodeId)?.kind ?? 'prompt', status: 'success',
          ...seed.exitCode === undefined ? {} : { exitCode: seed.exitCode },
          startedAt: now, endedAt: now, durationMs: 0, attempt: 1, output: seed.output,
        })
        run.nodes.set(nodeId, { kind: doc.nodes.find(n => n.id === nodeId)?.kind ?? 'prompt', startedAt: now, status: 'success',
          ...seed.exitCode === undefined ? {} : { exitCode: seed.exitCode } })
      }
      for (const g of seededGates) {
        await store.recordGate(runId, g)
        run.outcomes.set(gateKey(g.nodeId, g.gateKind), g.outcome)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`tool-workflow-run: could not record the resumed nodes: ${describeError(error)}`)
      await store.endRun(runId, { status: 'failed', error: 'could not record the resumed nodes' }).catch(() => undefined)
      return refused('START_FAILED', `could not record the resumed nodes: ${safeText(error)}`)
    }

    const request: WorkflowStartRequest = {
      script,
      meta: compiled.meta,
      args: inputs ?? {},
      parent: options.parent,
      signal: controller.signal,
      cwd: workspace,
      approver: this.broker.createApprover({ runId, store, parent: options.parent, ready, queue, reasons: run.reasons }),
      bashEnabled: true,
      bashExecutor,
      onBashOutput: (info, stream, chunk) => { this.onBashOutput(run, info.nodeId, stream, chunk) },
      tierModels: { ...this.config.tierModels },
      gateManifest: liveGates,
      ...compiled.maxTotalAgents === undefined ? {} : { maxTotalAgents: compiled.maxTotalAgents },
    }
    let engineRun: WorkflowRun
    try {
      engineRun = engine.start(request)
    } catch (error: unknown) {
      this.ctx.logger.warn(`tool-workflow-run: the engine refused workflow '${doc.name}': ${describeError(error)}`)
      const shown = `the engine refused the workflow: ${modelFacingError(describeError(error))}`
      await store.endRun(runId, { status: 'failed', error: shown }).catch(() => undefined)
      return refused('START_FAILED', shown)
    }
    // No await between start() and registration: node events arrive on later ticks.
    run.engineRun = engineRun
    this.byEngineId.set(engineRun.id, run)
    this.active.set(runId, run)
    this.recorder.start(options.parent.session, engineRun, { recordId: runId, nodes: true })
    const onAbort = (): void => { run.cancelReason ??= 'cancelled by the caller'; engineRun.cancel(run.cancelReason) }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    run.done = this.finish(run, engineRun, doc, resumedFrom).finally(() => {
      options.signal?.removeEventListener('abort', onAbort)
    })
    this.publish({ type: 'run-changed', runId, status: 'running' })
    return { ok: true, runId, name: doc.name, hash, ...resumedFrom === undefined ? {} : { resumedFrom }, done: run.done }
  }

  /** Apply the trust rules for untrusted content. Returns a refusal, or undefined when trust was granted. */
  private async confirmTrust(
    options: StartOptions,
    doc: WorkflowDoc,
    content: { hash: string; key: string; workspace: string; promptDigests: Record<string, string> },
    trust: TrustStore,
  ): Promise<StartRefused | undefined> {
    const { hash, key } = content
    let reason: string
    try {
      reason = renderTrustReason(describeTrustFacts(doc), hash, {
        workspace: content.workspace, promptDigests: content.promptDigests, tierModels: this.config.tierModels,
      })
    } catch (error: unknown) {
      if (error instanceof TrustTextError) {
        return refused('TRUST_DENIED', `workflow '${escapeUnsafe(doc.name)}' cannot be trusted: ${error.message}`, {
          remedy: 'Shorten the command (move the logic into a script file in the workspace) and run again.',
        })
      }
      throw error
    }
    if (options.trustHash !== undefined) {
      const challenge = this.redeemChallenge(options.trustChallenge, content.workspace, options.parent.session.id)
      if (challenge === undefined) {
        return refused('TRUST_REQUIRED', 'the trust confirmation is missing, expired, already used, or was issued to another caller', {
          remedy: 'Open the Run dialog again, review the commands, and confirm.',
        })
      }
      if (options.trustHash !== key || challenge.key !== key) {
        return refused('TRUST_REQUIRED', 'the workflow or one of its prompt files changed after you confirmed it', {
          remedy: 'Review the commands again and confirm the new content.',
        })
      }
      await trust.record(key, 'ui-confirm')
      return undefined
    }
    const named = `workflow '${escapeUnsafe(doc.name)}' (hash ${hash})`
    if (this.config.trustPolicy === 'never') {
      return refused('TRUST_DENIED', `${named} has not been trusted and the trust policy is 'never'`, {
        remedy: 'Review and confirm it in the Workflows UI (Run dialog), or set trustPolicy to ask.',
      })
    }
    const approval = this.ctx.get('approval')
    if (this.config.headless || approval === undefined || !hasOpenTurn(options.parent)) {
      return refused('TRUST_REQUIRED', `${named} has not been trusted and nobody can be asked here`, {
        remedy: 'Review and confirm it in the Workflows UI (Run dialog), or run it once from an interactive session.',
      })
    }
    const outcome = await approval.request({
      agent: options.parent,
      toolName: 'workflow:trust',
      reason,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (outcome === 'allowed-once') {
      await trust.record(key, 'tool-approval')
      return undefined
    }
    const code = outcome === 'rejected' ? 'TRUST_DENIED' : 'TRUST_REQUIRED'
    return refused(code, `workflow '${escapeUnsafe(doc.name)}' was not trusted (${outcome})`, {
      remedy: 'Confirm the commands it lists, in chat or in the Workflows UI.',
    })
  }

  // ------------------------------------------------------------ run events

  private enqueueWrite(run: ActiveRun, what: string, task: () => Promise<unknown>): void {
    void run.queue.run(task).catch((error: unknown) => {
      this.ctx.logger.warn(`tool-workflow-run: could not record ${what} for run ${run.runId}: ${describeError(error)}`)
      if (run.storeFailure === undefined) {
        run.storeFailure = `the run record could not be written (${safeText(error)})`
        run.cancelReason ??= run.storeFailure
        run.engineRun?.cancel(run.storeFailure)
      }
    })
  }

  private onBashOutput(run: ActiveRun, nodeId: string | undefined, stream: 'stdout' | 'stderr', chunk: Uint8Array): void {
    if (nodeId === undefined || stream !== 'stdout' || run.nodes.get(nodeId)?.kind !== 'bash') return
    if (chunk.length === 0) {
      run.buffers.set(nodeId, { chunks: [], bytes: 0, truncated: false })
      return
    }
    const buffer = run.buffers.get(nodeId) ?? { chunks: [], bytes: 0, truncated: false }
    run.buffers.set(nodeId, buffer)
    const room = SHELL_CAPTURE_BYTES - buffer.bytes
    if (room <= 0) { buffer.truncated = true; return }
    const take = chunk.length > room ? chunk.subarray(0, room) : chunk
    if (take.length < chunk.length) buffer.truncated = true
    buffer.chunks.push(Buffer.from(take))
    buffer.bytes += take.length
  }

  private onNodeStart(run: ActiveRun, nodeId: string, kind: string): void {
    if (!WORKFLOW_NODE_ID_PATTERN.test(nodeId)) return
    const startedAt = Date.now()
    run.nodes.set(nodeId, { kind, startedAt })
    this.enqueueWrite(run, `node ${nodeId} start`, () => run.store.recordNode(run.runId,
      { nodeId, nodeKind: kind, status: 'running', startedAt, attempt: 1 }))
    this.publish({ type: 'run-changed', runId: run.runId, status: 'running', nodeId, nodeStatus: 'running' })
  }

  private onNodeEnd(
    run: ActiveRun,
    node: NodeEndPayload,
  ): void {
    const { nodeId, kind } = node
    if (!WORKFLOW_NODE_ID_PATTERN.test(nodeId)) return
    const known = run.nodes.get(nodeId)
    const entry: NodeLedgerEntry = known ?? { kind, startedAt: Date.now() }
    const status = node.status === 'interrupted' ? 'cancelled' : node.status as 'success' | 'failed' | 'skipped' | 'cancelled'
    entry.status = node.status
    if (node.exitCode !== undefined) entry.exitCode = node.exitCode
    if (node.durationMs !== undefined) entry.durationMs = node.durationMs
    const attempts = node.attempts !== undefined && node.attempts >= 1 ? node.attempts : 1
    if (node.attempts !== undefined) entry.attempts = attempts
    if (node.failure !== undefined) {
      entry.failure = node.failure
      // The gate report row for this node carries the coded reason (a block reason already recorded wins).
      if (!run.reasons.has(nodeId)) run.reasons.set(nodeId, `${node.failure.message}; remedy: ${node.failure.remedy}`)
    }
    run.nodes.set(nodeId, entry)
    let output: string | undefined
    let outputTruncated = false
    if (kind === 'bash') {
      const buffer = run.buffers.get(nodeId)
      output = buffer === undefined ? '' : Buffer.concat(buffer.chunks).toString('utf8').trim()
      outputTruncated = buffer?.truncated === true
      run.buffers.delete(nodeId)
    } else if (kind === 'approval') {
      output = status === 'success' ? 'allowed-once' : ''
    } else if (status === 'skipped' || kind === 'cancel') {
      output = ''
    } else {
      outputTruncated = true
    }
    const error = node.status === 'interrupted' ? `interrupted: ${node.error ?? 'the run ended before the node did'}` : node.error
    // Attempts before the last were each stopped and retried: close their records so none stays "running".
    for (let earlier = 1; earlier < attempts; earlier++) {
      this.enqueueWrite(run, `node ${nodeId} attempt ${earlier}`, () => run.store.recordNode(run.runId, {
        nodeId, nodeKind: kind, status: 'failed', startedAt: entry.startedAt, endedAt: Date.now(), attempt: earlier,
        error: `attempt ${earlier} of ${attempts} was stopped and retried`,
      }))
    }
    this.enqueueWrite(run, `node ${nodeId} end`, () => run.store.recordNode(run.runId, {
      nodeId, nodeKind: kind, status, startedAt: entry.startedAt, endedAt: Date.now(), attempt: attempts,
      ...node.exitCode === undefined ? {} : { exitCode: node.exitCode },
      ...node.durationMs === undefined ? {} : { durationMs: node.durationMs },
      ...output === undefined ? {} : { output },
      ...outputTruncated ? { outputTruncated: true } : {},
      ...error === undefined ? {} : { error },
      ...node.failure === undefined ? {} : { failure: node.failure },
    }))
    this.publish({ type: 'run-changed', runId: run.runId, status: 'running', nodeId, nodeStatus: node.status })
  }

  private onGate(run: ActiveRun, nodeId: string, gateKind: string, outcome: string): void {
    if (!WORKFLOW_NODE_ID_PATTERN.test(nodeId)) return
    run.outcomes.set(gateKey(nodeId, gateKind), outcome)
    this.enqueueWrite(run, `gate ${nodeId}`, () => run.store.recordGate(run.runId, { nodeId, gateKind, outcome }))
  }

  // -------------------------------------------------------------- terminal

  private statusOf(run: ActiveRun, result: WorkflowResult): WorkflowRunEndStatus {
    if (run.interrupted) return 'interrupted'
    switch (result.stopReason) {
      case 'completed': {
        const value = result.value as { status?: unknown } | null
        return value?.status === 'failed' ? 'failed' : 'completed'
      }
      case 'cancelled': return run.storeFailure === undefined ? 'cancelled' : 'failed'
      case 'error': return result.error?.startsWith('workflow worker') === true ? 'interrupted' : 'failed'
    }
  }

  /** Close one run on every terminal path: settle the engine, flush writes, report gates, end the record. */
  private async finish(run: ActiveRun, engineRun: WorkflowRun, doc: WorkflowDoc, resumedFrom: string | undefined): Promise<RunOutcome> {
    let result: WorkflowResult
    try {
      result = await engineRun.result
    } catch (error: unknown) {
      result = { value: null, stopReason: 'error', error: describeError(error), agentsStarted: 0 }
    }
    try {
      await engineRun.dispose()
    } catch (error: unknown) {
      this.ctx.logger.warn(`tool-workflow-run: dispose of run ${run.runId} failed: ${describeError(error)}`)
    }
    await run.queue.flush()
    if (result.error !== undefined) {
      this.ctx.logger.warn(`tool-workflow-run: run ${run.runId} ended with an error: ${result.error}`)
    }
    const status = this.statusOf(run, result)

    // The script's returned node outputs are the only source of agent text: record them so resume can reuse them.
    const returned = (result.value as { nodes?: unknown } | null)?.nodes
    if (result.stopReason === 'completed' && Array.isArray(returned)) {
      for (const item of returned as { id?: unknown; status?: unknown; output?: unknown; exitCode?: unknown }[]) {
        if (typeof item.id !== 'string' || item.status !== 'success' || typeof item.output !== 'string') continue
        const entry = run.nodes.get(item.id)
        if (entry === undefined || (entry.kind !== 'prompt' && entry.kind !== 'loop')) continue
        const output = item.output
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined
        if (output.length >= SCRIPT_OUTPUT_TAIL) {
          // The cut is known only now; a later node-end record replaces the earlier one for this node.
          this.recorder.nodeEnd(WorkflowRunId(engineRun.id), {
            nodeId: item.id, kind: entry.kind, status: 'success', truncated: true,
            ...exitCode === undefined ? {} : { exitCode },
            ...entry.durationMs === undefined ? {} : { durationMs: entry.durationMs },
            ...entry.attempts === undefined ? {} : { attempts: entry.attempts },
          })
        }
        await run.queue.run(() => run.store.recordNode(run.runId, {
          nodeId: item.id as string, nodeKind: entry.kind, status: 'success', startedAt: entry.startedAt, endedAt: Date.now(), attempt: entry.attempts ?? 1,
          ...exitCode === undefined ? {} : { exitCode },
          output, ...output.length >= SCRIPT_OUTPUT_TAIL ? { outputTruncated: true } : {},
        })).catch((error: unknown) => {
          this.ctx.logger.warn(`tool-workflow-run: could not record output of ${String(item.id)}: ${describeError(error)}`)
        })
      }
    }

    const report: GateReportRow[] = buildGateReport(run.manifest, run.outcomes, run.reasons)
    const error = run.storeFailure ?? (result.stopReason === 'completed'
      ? (status === 'failed' ? 'one or more nodes failed' : undefined)
      : result.error === undefined ? undefined : modelFacingError(result.error))
    try {
      await run.store.endRun(run.runId, {
        status,
        ...error === undefined ? {} : { error },
        report: report.map(({ nodeId, gateKind, outcome }) => ({ nodeId, gateKind, outcome })),
      })
    } catch (endError: unknown) {
      this.ctx.logger.warn(`tool-workflow-run: could not end run ${run.runId}: ${describeError(endError)}`)
    }
    this.recorder.gateReport(WorkflowRunId(engineRun.id), report)
    this.recorder.finish(WorkflowRunId(engineRun.id), result.stopReason)
    this.recorder.abandon(WorkflowRunId(engineRun.id))
    this.byEngineId.delete(engineRun.id)
    this.active.delete(run.runId)

    let fileChanged = false
    try {
      const live = await readWorkflowByName(run.workspace, this.config.workflowsDir, run.name)
      fileChanged = sha256Hex(live.text) !== run.hash
    } catch {
      fileChanged = true
    }
    const nodes: RunNodeSummary[] = doc.nodes.map((n) => {
      const e = run.nodes.get(n.id)
      return {
        nodeId: n.id, kind: n.kind, status: e?.status ?? 'not-run',
        ...e?.exitCode === undefined ? {} : { exitCode: e.exitCode },
        ...e?.durationMs === undefined ? {} : { durationMs: e.durationMs },
        ...e?.attempts === undefined ? {} : { attempts: e.attempts },
        ...e?.failure === undefined ? {} : { failureCode: e.failure.code },
      }
    })
    const reasons = Object.fromEntries(run.reasons)
    this.publish({ type: 'run-changed', runId: run.runId, status, workspace: run.workspace })
    return {
      runId: run.runId, name: run.name, hash: run.hash, status,
      ...error === undefined ? {} : { error },
      report, nodes, reasons,
      ...resumedFrom === undefined ? {} : { resumedFrom },
      ...fileChanged ? { fileChanged: true } : {},
    }
  }

  private async shutdown(): Promise<void> {
    this.closing = true
    const runs = [...this.active.values()]
    for (const run of runs) {
      run.interrupted = true
      run.cancelReason = 'the host is shutting down'
      run.engineRun?.cancel(run.cancelReason)
      run.controller.abort()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(runs.map(r => r.done)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, DISPOSE_WAIT_MS); timer.unref() }),
    ])
    if (timer !== undefined) clearTimeout(timer)
  }
}

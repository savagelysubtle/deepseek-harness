/**
 * Permanently-mounted Typert Remote service for the `workflow` namespace that the Workflows UI
 * talks to. It is its own package, mounted by its own Loader entry, so its Typert registration
 * is keyed to an entry that never unmounts: a package's RPC contract is withdrawn when its last
 * Loader entry unloads and the Gateway never falls back (see `@deepseek-ai/dsh-mcp-status` for
 * the same reasoning).
 *
 * Every method takes the calling session first; the Typert `agent` lookup resolves it (and fences
 * subagent sessions), and the workspace is always that session's workspace. Reads are open to any
 * caller that passes the `/api` browser-trust fence. The methods that write a file, start or stop
 * a run, answer an approval or claim a human is present are listed in `PRIVILEGED_METHODS` of
 * `@deepseek-ai/dsh-client-connection`, which pins them to loopback. Failures are ordinary
 * results (`{ok: false, error, message}`), never thrown errors, and carry no stack or host path.
 * @module @deepseek-ai/dsh-workflow-remote
 */

import { createHash, randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { modelFacingError, stripUnsafe, WorkflowFileError } from '@deepseek-ai/dsh-tool-workflow-run'
import type { StartRefused, WorkflowRunsEvent, WorkflowRunsService } from '@deepseek-ai/dsh-tool-workflow-run'
import { WorkflowStoreError } from '@deepseek-ai/dsh-workflow-run-store'
import type { NodeRecord, RunDetail } from '@deepseek-ai/dsh-workflow-run-store'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import {
  checkName, failure, fileProblemText, listWorkflows, readWorkflow, saveWorkflowFile, validateText, wireDiagnostics, wireGraph, wireLayout,
} from './files.ts'
import {
  WORKFLOW_ATTACH_TTL_MS, WORKFLOW_OUTPUT_MAX_BYTES, WORKFLOW_RUNS_MAX_LIMIT,
} from './wire.ts'
import type {
  WorkflowAnswerResult, WorkflowApproveRequest, WorkflowAttachRequest, WorkflowAttachResult, WorkflowCancelRequest, WorkflowCancelResult,
  WorkflowDetachRequest, WorkflowDetachResult, WorkflowDryRunRequest, WorkflowDryRunResult, WorkflowFailure, WorkflowGateView,
  WorkflowInputValues, WorkflowLastRun, WorkflowListResult, WorkflowNodeOutputRequest, WorkflowNodeOutputResult,
  WorkflowNodeFailureView, WorkflowNodeView,
  WorkflowPendingApprovalsResult, WorkflowReadRequest, WorkflowReadResult, WorkflowRejectRequest, WorkflowResumeRequest,
  WorkflowRunDetailRequest, WorkflowRunDetailResult, WorkflowRunRequest, WorkflowRunsRequest, WorkflowRunsResult,
  WorkflowRunStartResult, WorkflowSaveRequest, WorkflowSaveResult, WorkflowValidateRequest, WorkflowValidateResult,
} from './wire.ts'

export type * from './wire.ts'
export {
  explainWorkflowRefusal,
  WORKFLOW_APPROVAL_DECIDED_EVENT,
  WORKFLOW_APPROVAL_PENDING_EVENT,
  WORKFLOW_ATTACH_RENEW_MS,
  WORKFLOW_ATTACH_TTL_MS,
  WORKFLOW_LAYOUT,
  WORKFLOW_LIST_ENDPOINT,
  WORKFLOW_LIST_METHOD,
  WORKFLOW_LOOPBACK_ONLY_MESSAGE,
  WORKFLOW_NAMESPACE,
  WORKFLOW_OUTPUT_MAX_BYTES,
  WORKFLOW_PRIVILEGED_ENDPOINTS,
  WORKFLOW_PRIVILEGED_METHODS,
  WORKFLOW_READ_METHODS,
  WORKFLOW_RUN_CHANGED_EVENT,
  WORKFLOW_RUNS_MAX_LIMIT,
} from './wire.ts'
export { saveWorkflowFile } from './files.ts'
export type { SaveHooks } from './files.ts'

/** Default workflows directory when no runner reports another. */
const DEFAULT_WORKFLOWS_DIR = '.workflows'
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/
const NODE_ID = /^[a-z0-9_-]{1,64}$/
const APPROVAL_ID = /^[A-Za-z0-9_-]{1,80}$/
const HEX_KEY = /^[0-9a-f]{64}$/
const HEX_CHALLENGE = /^[0-9a-f]{16,128}$/
const LEASE_ID = /^[0-9a-f]{32}$/
/** Most attachment leases held at once. */
const MAX_LEASES = 32
/** How long a cancel request waits for the run to close before answering `cancelling`. */
const CANCEL_WAIT_MS = 15_000
const INTERNAL_TEXT = 'The workflow service hit an internal error. The details are in the host log. Try again; if it repeats, report it.'

interface Lease {
  readonly sessionId: string
  readonly dispose: () => void
  timer: ReturnType<typeof setTimeout>
}

/** Remote-only service publishing the `workflow` namespace. */
export class WorkflowRemoteService extends TypertRemoteService {
  private readonly leases = new Map<string, Lease>()

  constructor(ctx: Context) {
    super(ctx, 'workflowRemote', { namespace: 'workflow' })
    ctx.inject(['workflowRuns'], (runnerCtx) => {
      runnerCtx.effect(() => runnerCtx.workflowRuns.subscribe((event) => { this.forward(event) }), 'workflow-remote: run events')
    })
    ctx.effect(() => () => { this.dropLeases() }, 'workflow-remote: attachment leases')
  }

  // ------------------------------------------------------------ plumbing

  private runner(): WorkflowRunsService | undefined {
    return this.ctx.get('workflowRuns')
  }

  private workflowsDir(): string {
    return this.runner()?.workflowsDir() ?? DEFAULT_WORKFLOWS_DIR
  }

  private forward(event: WorkflowRunsEvent): void {
    try {
      if (event.type === 'run-changed') {
        this.ctx.emit('workflow/run-changed', {
          runId: event.runId,
          ...keyField(event.workspace),
          status: event.status,
          ...event.nodeId === undefined ? {} : { nodeId: event.nodeId },
          ...event.nodeStatus === undefined ? {} : { nodeStatus: event.nodeStatus },
        })
      } else if (event.type === 'approval-pending') {
        this.ctx.emit('workflow/approval-pending', {
          runId: event.runId,
          approvalId: event.approvalId,
          nodeId: event.nodeId,
          ...keyField(event.workspace),
        })
      } else {
        this.ctx.emit('workflow/approval-decided', { runId: event.runId, approvalId: event.approvalId, state: event.state, ...keyField(event.workspace) })
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`workflow-remote: could not forward ${event.type}: ${describe(error)}`)
    }
  }

  private dropLeases(): void {
    for (const lease of this.leases.values()) {
      clearTimeout(lease.timer)
      lease.dispose()
    }
    this.leases.clear()
  }

  /** Run one method body; anything unexpected becomes a fixed, path-free failure and a log line. */
  private async guard<R>(label: string, body: () => Promise<R>): Promise<R | WorkflowFailure> {
    try {
      return await body()
    } catch (error: unknown) {
      if (error instanceof WorkflowFileError) return failure('REFUSED', fileProblemText(error))
      this.ctx.logger.warn(`workflow-remote: ${label} failed: ${describe(error)}`)
      return failure('INTERNAL', INTERNAL_TEXT)
    }
  }

  private async workspaceOf(agent: Agent): Promise<string | WorkflowFailure> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd.length === 0) {
      return failure('NO_WORKSPACE', 'This session has no workspace. Open Workflows from a session that belongs to a project.')
    }
    try {
      return await realpath(cwd)
    } catch {
      return failure('NO_WORKSPACE', 'This session\'s workspace is not available on the host.')
    }
  }

  private needRunner(): WorkflowRunsService | WorkflowFailure {
    return this.runner() ?? failure('RUNNER_UNAVAILABLE', 'Workflow runs are not available in this composition.', {
      remedy: 'Enable the workflow engine and the tool-workflow-run plugin to run workflows.',
    })
  }

  private refusal(refused: StartRefused): WorkflowFailure {
    const code = refused.error
    return failure(code, modelFacingErrorKeepLines(refused.message), {
      ...refused.remedy === undefined ? {} : { remedy: modelFacingErrorKeepLines(refused.remedy) },
      ...refused.diagnostics === undefined ? {} : { diagnostics: wireDiagnostics(refused.diagnostics) },
    })
  }

  /** Map a store error to a failure; anything else is not ours to handle and propagates to the guard. */
  private storeFailure(error: unknown): WorkflowFailure {
    if (error instanceof WorkflowStoreError) {
      this.ctx.logger.warn(`workflow-remote: store error ${error.code}: ${error.message}`)
      if (error.code === 'RUN_NOT_FOUND' || error.code === 'OUTPUT_NOT_FOUND' || error.code === 'APPROVAL_NOT_FOUND') {
        return failure('NOT_FOUND', error.code === 'OUTPUT_NOT_FOUND' ? 'No saved output exists for that node.' : 'No such run exists in this workspace.')
      }
      if (error.code === 'INVALID_ID' || error.code === 'INVALID_INPUT') return failure('INVALID_INPUT', 'That run or node id is not valid.')
      return failure('INTERNAL', INTERNAL_TEXT)
    }
    throw error
  }

  // --------------------------------------------------------------- reads

  /**
   * List the calling workspace's discovered workflows with their validation status.
   * @param agent - the calling session.
   * @returns one row per workflow file, or why none could be listed.
   */
  @Remote('list')
  list(agent: Agent): Promise<WorkflowListResult> {
    return this.guard('list', async () => {
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      const lastRuns = new Map<string, WorkflowLastRun>()
      const runner = this.runner()
      if (runner !== undefined) {
        const store = await runner.storeFor(workspace)
        for (const run of (await store.listRuns({ limit: WORKFLOW_RUNS_MAX_LIMIT })).runs) {
          if (!lastRuns.has(run.name)) {
            lastRuns.set(run.name, { runId: run.runId, status: run.status, ...run.endedAt === undefined ? {} : { endedAt: run.endedAt } })
          }
        }
      }
      const workflows = await listWorkflows(workspace, this.workflowsDir(), lastRuns)
      return { ok: true as const, workflows, workspaceKey: await workspaceKeyOf(workspace) }
    })
  }

  /**
   * Read one workflow file with the token a later save presents.
   * @param agent - the calling session.
   * @param request - the workflow name.
   * @returns the text and its token.
   */
  @Remote('read')
  read(agent: Agent, request: WorkflowReadRequest): Promise<WorkflowReadResult> {
    return this.guard('read', async () => {
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      return await readWorkflow(workspace, this.workflowsDir(), request.name)
    })
  }

  /**
   * Validate draft text and describe its graph. Pure: nothing is written and nothing runs.
   * @param request - the draft and the name it will be saved under.
   * @returns diagnostics, and the graph and layout when it parsed.
   */
  @Remote('validate')
  validate(request: WorkflowValidateRequest): Promise<WorkflowValidateResult | WorkflowFailure> {
    return this.guard('validate', async (): Promise<WorkflowValidateResult | WorkflowFailure> => {
      if (typeof request.text !== 'string') return failure('INVALID_INPUT', 'The draft text must be a string.')
      if (request.name !== undefined) {
        const bad = checkName(request.name)
        if (bad !== undefined) return bad
      }
      return await Promise.resolve(validateText(request.text, request.name))
    })
  }

  /**
   * Describe what a run would do without running it: the graph, layout, gate manifest, trust
   * facts, the exact confirmation text, and (for untrusted content) a single-use challenge bound
   * to this session. Executes nothing and spawns nothing.
   * @param agent - the calling session.
   * @param request - the workflow name and input values.
   * @returns the plan, or why none could be made.
   */
  @Remote('dryRun')
  dryRun(agent: Agent, request: WorkflowDryRunRequest): Promise<WorkflowDryRunResult> {
    return this.guard('dryRun', async () => {
      const bad = checkName(request.name)
      if (bad !== undefined) return bad
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      const plan = await runner.dryRun(workspace, { name: request.name, inputs: request.inputs ?? {}, caller: agent.session.id })
      if (!plan.ok) return this.refusal(plan)
      return {
        ok: true as const,
        name: plan.name,
        hash: plan.hash,
        trusted: plan.trusted,
        trustKey: plan.trustKey,
        ...plan.trustChallenge === undefined ? {} : { trustChallenge: plan.trustChallenge },
        ...plan.confirmText === undefined ? {} : { confirmText: plan.confirmText },
        graph: wireGraph(plan.graph),
        layout: wireLayout(plan.graph),
        manifest: plan.manifest.map(m => ({ nodeId: m.nodeId, gateKind: m.gateKind })),
        plan: [...plan.plan],
        trust: {
          name: plan.trust.name,
          bashCommands: plan.trust.bashCommands.map(c => ({
            nodeId: c.nodeId, field: c.field, command: c.command, envKeys: [...c.envKeys], env: { ...c.env },
            ...c.workdir === undefined ? {} : { workdir: c.workdir },
          })),
          promptFiles: [...plan.trust.promptFiles],
          agents: plan.trust.agents.map(a => ({
            nodeId: a.nodeId,
            ...a.tier === undefined ? {} : { tier: a.tier },
            ...a.model === undefined ? {} : { model: a.model },
            ...a.provider === undefined ? {} : { provider: a.provider },
          })),
          approvalNodes: plan.trust.approvalNodes,
        },
        warnings: wireDiagnostics(plan.warnings),
      }
    })
  }

  /**
   * List the workspace's runs, newest first.
   * @param agent - the calling session.
   * @param request - optional workflow filter, page size and cursor.
   * @returns a page of run summaries.
   */
  @Remote('runs')
  runs(agent: Agent, request: WorkflowRunsRequest): Promise<WorkflowRunsResult> {
    return this.guard('runs', async () => {
      if (request.name !== undefined) {
        const bad = checkName(request.name)
        if (bad !== undefined) return bad
      }
      const limit = request.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1 || limit > WORKFLOW_RUNS_MAX_LIMIT) {
        return failure('INVALID_INPUT', `limit must be a whole number from 1 to ${WORKFLOW_RUNS_MAX_LIMIT}.`)
      }
      if (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 200)) {
        return failure('INVALID_INPUT', 'That cursor is not valid.')
      }
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      try {
        const store = await runner.storeFor(workspace)
        const page = await store.listRuns({
          limit,
          ...request.name === undefined ? {} : { name: request.name },
          ...request.cursor === undefined ? {} : { cursor: request.cursor },
        })
        return {
          ok: true as const,
          runs: page.runs.map(r => ({
            runId: r.runId,
            name: r.name,
            hash: r.hash,
            startedAt: r.startedAt,
            status: r.status,
            ...r.endedAt === undefined ? {} : { endedAt: r.endedAt },
            ...r.parentSessionId === undefined ? {} : { parentSessionId: r.parentSessionId },
          })),
          workspaceKey: await workspaceKeyOf(workspace),
          ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
        }
      } catch (error: unknown) {
        return this.storeFailure(error)
      }
    })
  }

  /**
   * One run's nodes, gates, approvals and pin facts. Node output is read separately with `nodeOutput`.
   * @param agent - the calling session.
   * @param request - the run id.
   * @returns the run's detail.
   */
  @Remote('runDetail')
  runDetail(agent: Agent, request: WorkflowRunDetailRequest): Promise<WorkflowRunDetailResult> {
    return this.guard('runDetail', async () => {
      if (!RUN_ID.test(request.runId)) return failure('INVALID_INPUT', 'That run id is not valid.')
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      try {
        const view = await runner.getRunView(workspace, request.runId)
        return projectRun(view.detail, view.pinnedHash, view.fileChanged)
      } catch (error: unknown) {
        return this.storeFailure(error)
      }
    })
  }

  /**
   * A bounded slice of one node's recorded output.
   * @param agent - the calling session.
   * @param request - run, node, byte offset and limit.
   * @returns the slice and where the next one starts.
   */
  @Remote('nodeOutput')
  nodeOutput(agent: Agent, request: WorkflowNodeOutputRequest): Promise<WorkflowNodeOutputResult> {
    return this.guard('nodeOutput', async () => {
      if (!RUN_ID.test(request.runId) || !NODE_ID.test(request.nodeId)) return failure('INVALID_INPUT', 'That run or node id is not valid.')
      if (!Number.isInteger(request.offset) || request.offset < 0) return failure('INVALID_INPUT', 'offset must be a whole number, 0 or more.')
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > WORKFLOW_OUTPUT_MAX_BYTES) {
        return failure('INVALID_INPUT', `limit must be a whole number from 1 to ${WORKFLOW_OUTPUT_MAX_BYTES}.`)
      }
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      try {
        const store = await runner.storeFor(workspace)
        const slice = await store.readOutput(request.runId, request.nodeId, request.offset, request.limit)
        return {
          ok: true as const,
          text: slice.text,
          totalBytes: slice.totalBytes,
          truncated: slice.truncated,
          ...slice.nextOffset === undefined ? {} : { nextOffset: slice.nextOffset },
        }
      } catch (error: unknown) {
        return this.storeFailure(error)
      }
    })
  }

  /**
   * The approvals waiting for a human in this workspace (this host process only).
   * @param agent - the calling session.
   * @returns the waiting approvals.
   */
  @Remote('pendingApprovals')
  pendingApprovals(agent: Agent): Promise<WorkflowPendingApprovalsResult> {
    return this.guard('pendingApprovals', async () => {
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      const mine = new Set(runner.activeRuns().filter(r => r.workspace === workspace).map(r => r.runId))
      return {
        ok: true as const,
        approvals: runner.pendingApprovals()
          .filter(a => mine.has(a.runId))
          .map(a => ({ runId: a.runId, approvalId: a.approvalId, nodeId: a.nodeId, message: stripUnsafe(a.message, 500) })),
      }
    })
  }

  // ----------------------------------------------------------- privileged

  /**
   * Write a workflow file (privileged). The name is a kebab-case file stem, the path is always
   * inside the workflows directory, the text must validate, and the write is atomic and guarded by
   * the content token.
   * @param agent - the calling session.
   * @param request - name, text and the token of the content being replaced (`null` to create).
   * @returns the new token, or why nothing was written.
   */
  @Remote('save')
  save(agent: Agent, request: WorkflowSaveRequest): Promise<WorkflowSaveResult> {
    return this.guard('save', async () => {
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      return await saveWorkflowFile(workspace, this.workflowsDir(), request)
    })
  }

  /**
   * Start a run (privileged). Untrusted content needs the `trustHash` and `trustChallenge` of the
   * plan a human reviewed through `dryRun` in this same session.
   * @param agent - the calling session; it parents the run.
   * @param request - workflow name, inputs and the trust confirmation.
   * @returns the run id, or why the run did not start.
   */
  @Remote('run')
  run(agent: Agent, request: WorkflowRunRequest): Promise<WorkflowRunStartResult> {
    return this.guard('run', async () => {
      const bad = checkName(request.name)
      if (bad !== undefined) return bad
      const trust = checkTrustFields(request.trustHash, request.trustChallenge)
      if (trust !== undefined) return trust
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      return await this.begin(runner, {
        parent: agent,
        name: request.name,
        inputs: request.inputs ?? {},
        ...request.trustHash === undefined ? {} : { trustHash: request.trustHash },
        ...request.trustChallenge === undefined ? {} : { trustChallenge: request.trustChallenge },
      })
    })
  }

  /**
   * Resume an earlier run from its pinned source (privileged).
   * @param agent - the calling session; it parents the resumed run.
   * @param request - the run to resume and, when the pinned content is no longer trusted, the trust confirmation.
   * @returns the new run id, or why it did not start.
   */
  @Remote('resume')
  resume(agent: Agent, request: WorkflowResumeRequest): Promise<WorkflowRunStartResult> {
    return this.guard('resume', async () => {
      if (!RUN_ID.test(request.runId)) return failure('INVALID_INPUT', 'That run id is not valid.')
      const trust = checkTrustFields(request.trustHash, request.trustChallenge)
      if (trust !== undefined) return trust
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      return await this.begin(runner, {
        parent: agent,
        resume: request.runId,
        ...request.trustHash === undefined ? {} : { trustHash: request.trustHash },
        ...request.trustChallenge === undefined ? {} : { trustChallenge: request.trustChallenge },
      })
    })
  }

  private async begin(runner: WorkflowRunsService, options: Parameters<WorkflowRunsService['start']>[0]): Promise<WorkflowRunStartResult> {
    const started = await runner.start(options)
    if (!started.ok) return this.refusal(started)
    started.done.catch((error: unknown) => {
      this.ctx.logger.warn(`workflow-remote: run ${started.runId} ended abnormally: ${describe(error)}`)
    })
    return { ok: true, runId: started.runId }
  }

  /**
   * Stop a run of this workspace (privileged). A run that belongs to another workspace answers as if it did not exist.
   * @param agent - the calling session.
   * @param request - the run id.
   * @returns the end status, or `cancelling` when the run is still closing.
   */
  @Remote('cancel')
  cancel(agent: Agent, request: WorkflowCancelRequest): Promise<WorkflowCancelResult> {
    return this.guard('cancel', async () => {
      if (!RUN_ID.test(request.runId)) return failure('INVALID_INPUT', 'That run id is not valid.')
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      const cancelled = runner.cancel(request.runId, 'cancelled from the Workflows UI', { workspace, sessionId: agent.session.id })
      let timer: ReturnType<typeof setTimeout> | undefined
      const settled = await Promise.race([
        cancelled,
        new Promise<'pending'>((resolve) => { timer = setTimeout(() => { resolve('pending') }, CANCEL_WAIT_MS) }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if (settled === 'pending') return { ok: true as const, status: 'cancelling' }
      if (!settled.found) return failure('NOT_FOUND', 'That run is not running for this session in this workspace.')
      return { ok: true as const, status: settled.outcome?.status ?? 'cancelling' }
    })
  }

  /**
   * Allow an approval node (privileged). The first answer from any path wins.
   * @param agent - the calling session.
   * @param request - run and approval ids.
   * @returns the state that won.
   */
  @Remote('approve')
  approve(agent: Agent, request: WorkflowApproveRequest): Promise<WorkflowAnswerResult> {
    return this.answer(agent, request.runId, request.approvalId, 'allow', undefined)
  }

  /**
   * Reject an approval node (privileged). The first answer from any path wins.
   * @param agent - the calling session.
   * @param request - run and approval ids and an optional reason.
   * @returns the state that won.
   */
  @Remote('reject')
  reject(agent: Agent, request: WorkflowRejectRequest): Promise<WorkflowAnswerResult> {
    if (request.reason !== undefined && typeof request.reason !== 'string') {
      return Promise.resolve(failure('INVALID_INPUT', 'The reason must be text.'))
    }
    return this.answer(agent, request.runId, request.approvalId, 'reject', request.reason)
  }

  private answer(agent: Agent, runId: string, approvalId: string, answer: 'allow' | 'reject', reason: string | undefined): Promise<WorkflowAnswerResult> {
    return this.guard('answer', async () => {
      if (!RUN_ID.test(runId) || !APPROVAL_ID.test(approvalId)) return failure('INVALID_INPUT', 'That run or approval id is not valid.')
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      // The run must belong to the caller's workspace: its store is the only place it can be found.
      try {
        await (await runner.storeFor(workspace)).getRun(runId)
      } catch (error: unknown) {
        return this.storeFailure(error)
      }
      const state = await runner.answerApproval(runId, approvalId, answer, reason)
      if (state === undefined) {
        return failure('NOT_PENDING', 'No such approval is waiting. It may have been answered, expired, or the host restarted.', { conflict: true })
      }
      return { ok: true as const, state }
    })
  }

  /**
   * Declare that a human who can answer approvals is looking at the Workflows UI (privileged).
   * Without any live lease an approval nobody can answer is rejected at once with a remedy
   * instead of waiting. A lease lapses by itself after `ttlMs`; renew it by calling again with its id.
   * @param agent - the calling session.
   * @param request - the lease to renew, or none to open one.
   * @returns the lease id and its time to live.
   */
  @Remote('attachUi')
  attachUi(agent: Agent, request: WorkflowAttachRequest): Promise<WorkflowAttachResult> {
    return this.guard('attachUi', async (): Promise<WorkflowAttachResult> => {
      const runner = this.needRunner()
      if ('ok' in runner) return runner
      if (request.leaseId !== undefined && !LEASE_ID.test(request.leaseId)) {
        return failure('INVALID_INPUT', 'That lease id is not valid.')
      }
      const sessionId = agent.session.id
      const workspace = await this.workspaceOf(agent)
      if (typeof workspace !== 'string') return workspace
      const workspaceKey = await workspaceKeyOf(workspace)
      const known = request.leaseId === undefined ? undefined : this.leases.get(request.leaseId)
      if (request.leaseId !== undefined && known?.sessionId === sessionId) {
        clearTimeout(known.timer)
        known.timer = this.leaseTimer(request.leaseId)
        return { ok: true, leaseId: request.leaseId, ttlMs: WORKFLOW_ATTACH_TTL_MS, workspaceKey }
      }
      if (this.leases.size >= MAX_LEASES) {
        return failure('LIMIT', 'Too many Workflows windows are attached to this host.', { remedy: 'Close another Workflows window.' })
      }
      const leaseId = randomBytes(16).toString('hex')
      this.leases.set(leaseId, { sessionId, dispose: runner.attachUi(), timer: this.leaseTimer(leaseId) })
      return { ok: true, leaseId, ttlMs: WORKFLOW_ATTACH_TTL_MS, workspaceKey }
    })
  }

  /**
   * Release an attachment lease (privileged). Releasing one that already lapsed is not an error.
   * @param agent - the calling session.
   * @param request - the lease to release.
   * @returns success.
   */
  @Remote('detachUi')
  detachUi(agent: Agent, request: WorkflowDetachRequest): Promise<WorkflowDetachResult> {
    return this.guard('detachUi', (): Promise<WorkflowDetachResult> => {
      if (!LEASE_ID.test(request.leaseId)) return Promise.resolve(failure('INVALID_INPUT', 'That lease id is not valid.'))
      const lease = this.leases.get(request.leaseId)
      if (lease?.sessionId === agent.session.id) this.releaseLease(request.leaseId)
      return Promise.resolve({ ok: true })
    })
  }

  private leaseTimer(leaseId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.releaseLease(leaseId) }, WORKFLOW_ATTACH_TTL_MS)
    timer.unref()
    return timer
  }

  private releaseLease(leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (lease === undefined) return
    this.leases.delete(leaseId)
    clearTimeout(lease.timer)
    lease.dispose()
  }
}

/** Opaque, stable key of a workspace: events carry it instead of the host path. */
function keyOfRealPath(real: string): string {
  return createHash('sha256').update(real).digest('hex').slice(0, 16)
}

async function workspaceKeyOf(workspace: string): Promise<string> {
  try {
    return keyOfRealPath(await realpath(workspace))
  } catch {
    return keyOfRealPath(workspace)
  }
}

function keyField(workspace: string | undefined): { workspaceKey?: string } {
  return workspace === undefined ? {} : { workspaceKey: keyOfRealPath(workspace) }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keep line breaks of already-sanitized runner text (diagnostic lists) while removing host paths. */
function modelFacingErrorKeepLines(text: string): string {
  return text.split('\n').map(line => modelFacingError(line, 400)).join('\n')
}

function checkTrustFields(trustHash: string | undefined, trustChallenge: string | undefined): WorkflowFailure | undefined {
  if (trustHash !== undefined && !HEX_KEY.test(trustHash)) return failure('INVALID_INPUT', 'trustHash must be the trustKey from dryRun.')
  if (trustChallenge !== undefined && !HEX_CHALLENGE.test(trustChallenge)) return failure('INVALID_INPUT', 'trustChallenge must be the one from dryRun.')
  return undefined
}

function inputsOf(raw: unknown): WorkflowInputValues | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: WorkflowInputValues = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

/** Read the persisted supervisor stop of a node record. Older records carry none: no field, no guess. */
function failureOf(record: Pick<NodeRecord, 'failure'>): WorkflowNodeFailureView | undefined {
  const f = record.failure
  if (f === undefined || (f.code !== 'NODE_STALLED' && f.code !== 'NODE_TIMEOUT')) return undefined
  return { code: f.code, message: stripUnsafe(f.message, 500), remedy: stripUnsafe(f.remedy, 500) }
}

function projectRun(detail: RunDetail, pinnedHash: string, fileChanged: boolean) {
  // The row with the highest attempt per node carries the real attempt count and the stop reason.
  const highest = new Map<string, number>()
  for (const state of detail.nodeStates) highest.set(state.nodeId, Math.max(highest.get(state.nodeId) ?? 0, state.attempt))
  const nodes: WorkflowNodeView[] = detail.nodeStates.map((state) => {
    const r = state.record
    const last = highest.get(state.nodeId) === state.attempt
    const failure = last ? failureOf(r) : undefined
    return {
      ...last && state.attempt > 1 ? { attempts: state.attempt } : {},
      ...failure === undefined ? {} : { failure },
      nodeId: r.nodeId,
      kind: r.nodeKind,
      status: r.status,
      attempt: r.attempt,
      startedAt: r.startedAt,
      truncated: r.truncated,
      hasOutput: r.output !== undefined || r.outputTail !== undefined || r.outputRef !== undefined,
      ...r.endedAt === undefined ? {} : { endedAt: r.endedAt },
      ...r.durationMs === undefined ? {} : { durationMs: r.durationMs },
      ...r.exitCode === undefined ? {} : { exitCode: r.exitCode },
      ...r.error === undefined ? {} : { error: modelFacingError(r.error) },
    }
  })
  const gateRows = detail.end?.report ?? detail.gates
  const gates: WorkflowGateView[] = gateRows.map(g => ({ nodeId: g.nodeId, gateKind: g.gateKind, outcome: g.outcome }))
  const inputs = inputsOf(detail.header.inputs)
  const manifest = detail.header.manifest as { resumedFrom?: unknown }
  return {
    ok: true as const,
    runId: detail.header.runId,
    name: detail.header.name,
    status: detail.status,
    startedAt: detail.header.startedAt,
    pinnedHash,
    fileChanged,
    nodes,
    gates,
    approvals: detail.approvals.map(a => ({
      approvalId: a.approvalId,
      nodeId: a.nodeId,
      message: stripUnsafe(a.message, 500),
      state: a.state,
      at: a.at,
      ...a.reason === undefined ? {} : { reason: stripUnsafe(a.reason, 500) },
    })),
    ...detail.end === undefined ? {} : { endedAt: detail.end.endedAt },
    ...detail.end?.error === undefined ? {} : { error: modelFacingError(detail.end.error) },
    ...inputs === undefined ? {} : { inputs },
    ...typeof manifest.resumedFrom === 'string' ? { resumedFrom: manifest.resumedFrom } : {},
  }
}

export default WorkflowRemoteService

/**
 * Typed, never-throwing view of the Host's `workflow` Remote namespace for one session. The
 * generated Remote face returns `RemoteResult<T>` where `T` is itself `{ ok: true, ... }` or a
 * `WorkflowFailure`, and a loopback-only refusal arrives as a carrier failure (or a rejection)
 * mentioning `HTTP 403`. Every call here folds all of that into one result: the success shape or a
 * {@link UiFailure}, so no view ever has to guess which layer failed or show a bare "403".
 */
// Type-only: the ctx.remote Context merge, which types `ctx.remote.workflow`.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { explainWorkflowRejection } from '@deepseek-ai/dsh-workflow-remote/client'
import type {
  WorkflowAnswerOk, WorkflowAttachOk, WorkflowCancelOk, WorkflowDetachOk, WorkflowDryRunOk,
  WorkflowErrorCode, WorkflowFailure, WorkflowInputValues, WorkflowListOk, WorkflowNodeOutputOk,
  WorkflowPendingApprovalsOk, WorkflowReadOk, WorkflowRunDetailOk, WorkflowRunRequest,
  WorkflowRunsOk, WorkflowRunsRequest, WorkflowRunStartedOk, WorkflowSaveOk, WorkflowSaveRequest,
  WorkflowValidateResult,
} from '@deepseek-ai/dsh-workflow-remote/client'

/** The generated `workflow` Remote namespace as the client context exposes it. */
export type WorkflowRemote = ClientContext['remote']['workflow']

/** Codes minted in the browser, never by the Host. */
export type ClientFailureCode = 'LOOPBACK_ONLY' | 'TRANSPORT' | 'LEASE_LAPSED'

/** A call that did not do what was asked, from the Host or from the browser's own plumbing. */
export interface UiFailure extends Omit<WorkflowFailure, 'error'> {
  /** Host code, or a browser-minted {@link ClientFailureCode}. */
  error: WorkflowErrorCode | ClientFailureCode
  /** True when the Host refused the call because this browser is not on the Host machine (loopback-only). */
  loopbackOnly?: boolean
}

/** A success shape or a failure. */
export type Outcome<T> = T | UiFailure

/** Every call the Workflows surface makes, bound to one session. */
export interface WorkflowApi {
  /** List the workspace's workflow files. */
  list(): Promise<Outcome<WorkflowListOk>>
  /** Read one file and its save token. */
  read(name: string): Promise<Outcome<WorkflowReadOk>>
  /** Validate a draft; a draft with errors is a normal `ok: false` result, not a failure. */
  validate(text: string, name?: string): Promise<Outcome<WorkflowValidateResult>>
  /** Plan a run without running it. */
  dryRun(name: string, inputs?: WorkflowInputValues): Promise<Outcome<WorkflowDryRunOk>>
  /** A page of runs. */
  runs(request: WorkflowRunsRequest): Promise<Outcome<WorkflowRunsOk>>
  /** One run's nodes, gates and approvals. */
  runDetail(runId: string): Promise<Outcome<WorkflowRunDetailOk>>
  /** Approvals waiting for a human. */
  pendingApprovals(): Promise<Outcome<WorkflowPendingApprovalsOk>>
  /** Privileged: write a file. */
  save(request: WorkflowSaveRequest): Promise<Outcome<WorkflowSaveOk>>
  /** Privileged: start a run. */
  run(request: WorkflowRunRequest): Promise<Outcome<WorkflowRunStartedOk>>
  /** Privileged: resume an earlier run. */
  resume(runId: string, trust?: { trustHash: string; trustChallenge: string }): Promise<Outcome<WorkflowRunStartedOk>>
  /** Privileged: stop a run. */
  cancel(runId: string): Promise<Outcome<WorkflowCancelOk>>
  /** Privileged: read a slice of a node's recorded output. */
  nodeOutput(runId: string, nodeId: string, offset: number, limit: number): Promise<Outcome<WorkflowNodeOutputOk>>
  /** Privileged: allow an approval. */
  approve(runId: string, approvalId: string): Promise<Outcome<WorkflowAnswerOk>>
  /** Privileged: reject an approval. */
  reject(runId: string, approvalId: string, reason?: string): Promise<Outcome<WorkflowAnswerOk>>
  /** Privileged: open (no id) or renew (with id) the human-present lease. */
  attachUi(leaseId?: string): Promise<Outcome<WorkflowAttachOk>>
  /** Privileged: release the lease. */
  detachUi(leaseId: string): Promise<Outcome<WorkflowDetachOk>>
}

/**
 * Narrow an outcome to the failure branch. A `WorkflowValidateResult` carries `ok: false` for a bad
 * draft but never an `error` code, so the code is what separates a failure from a verdict.
 * @param value - any outcome.
 * @returns true when the call itself failed.
 */
export function isFailure(value: { ok: boolean }): value is UiFailure {
  return !value.ok && 'error' in value && typeof (value as { error: unknown }).error === 'string'
}

/**
 * Explain a call that never produced a Host result.
 * @param method - the Remote method name, without the namespace.
 * @param cause - the carrier failure or rejection.
 * @returns the loopback-only explanation for a 403 on a privileged method, otherwise a transport failure.
 */
export function transportFailure(method: string, cause: unknown): UiFailure {
  const explained = explainWorkflowRejection(`workflow/${method}`, cause)
  if (explained !== undefined) return { ok: false, error: 'LOOPBACK_ONLY', message: explained, loopbackOnly: true }
  const text = typeof cause === 'string'
    ? cause
    : typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string'
      ? cause.message
      : ''
  const status = /HTTP (\d{3})/.exec(text)?.[1]
  return {
    ok: false,
    error: 'TRANSPORT',
    message: `The host did not complete workflow/${method}${status === undefined ? '' : ` (HTTP ${status})`}.`,
    remedy: 'Check the connection to dsh and try again.',
  }
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

async function call<T extends { ok: boolean }>(method: string, send: () => Promise<Settled<T | WorkflowFailure>>): Promise<T | UiFailure> {
  let settled: Settled<T | WorkflowFailure>
  try {
    settled = await send()
  } catch (error) {
    return transportFailure(method, error)
  }
  if (!settled.ok) return transportFailure(method, settled.error)
  return settled.value
}

/**
 * Bind the Remote namespace to one session.
 * @param remote - `ctx.remote.workflow`.
 * @param sessionId - the session every call is made as; the Host resolves the workspace from it.
 * @returns the never-throwing {@link WorkflowApi}.
 */
export function createWorkflowApi(remote: WorkflowRemote, sessionId: SessionId): WorkflowApi {
  return {
    list: () => call('list', () => remote.list(sessionId)),
    read: name => call('read', () => remote.read(sessionId, { name })),
    validate: (text, name) => call('validate', () => remote.validate(name === undefined ? { text } : { text, name })),
    dryRun: (name, inputs) => call('dryRun', () => remote.dryRun(sessionId, inputs === undefined ? { name } : { name, inputs })),
    runs: request => call('runs', () => remote.runs(sessionId, request)),
    runDetail: runId => call('runDetail', () => remote.runDetail(sessionId, { runId })),
    pendingApprovals: () => call('pendingApprovals', () => remote.pendingApprovals(sessionId)),
    save: request => call('save', () => remote.save(sessionId, request)),
    run: request => call('run', () => remote.run(sessionId, request)),
    resume: (runId, trust) => call('resume', () => remote.resume(sessionId, trust === undefined ? { runId } : { runId, ...trust })),
    cancel: runId => call('cancel', () => remote.cancel(sessionId, { runId })),
    nodeOutput: (runId, nodeId, offset, limit) =>
      call('nodeOutput', () => remote.nodeOutput(sessionId, { runId, nodeId, offset, limit })),
    approve: (runId, approvalId) => call('approve', () => remote.approve(sessionId, { runId, approvalId })),
    reject: (runId, approvalId, reason) =>
      call('reject', () => remote.reject(sessionId, reason === undefined ? { runId, approvalId } : { runId, approvalId, reason })),
    attachUi: leaseId => call('attachUi', () => remote.attachUi(sessionId, leaseId === undefined ? {} : { leaseId })),
    detachUi: leaseId => call('detachUi', () => remote.detachUi(sessionId, { leaseId })),
  }
}

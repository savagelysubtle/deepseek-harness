/**
 * Shared wire contract for the `workflow` Remote namespace: method and endpoint names, the
 * privileged endpoint set, the pushed event vocabulary, the request and result shapes the browser
 * consumes, and the text a loopback-only refusal is explained with. Kept intentionally small and
 * stable, since client packages build against these names and shapes directly, so a change here is
 * a cross-package contract change. Every Remote method takes the calling session first (the Typert
 * `agent` lookup resolves it from the session id and fences subagent sessions); the workspace is
 * always that session's workspace, never a caller-supplied path.
 * @module @deepseek-ai/dsh-workflow-remote/wire
 */

/** Typert namespace every Remote method below is published under. */
export const WORKFLOW_NAMESPACE = 'workflow'

/** `@Remote` export name for {@link WORKFLOW_LIST_ENDPOINT}: list the workspace's discovered workflows. */
export const WORKFLOW_LIST_METHOD = 'list'

/** Wire endpoint (`<namespace>/<method>`): list the workspace's discovered workflows. */
export const WORKFLOW_LIST_ENDPOINT = `${WORKFLOW_NAMESPACE}/${WORKFLOW_LIST_METHOD}`

/** Remote methods any caller that passes the `/api` browser-trust fence may call; none writes a file or starts a process. */
export const WORKFLOW_READ_METHODS = [
  'list',
  'read',
  'validate',
  'dryRun',
  'runs',
  'runDetail',
  'pendingApprovals',
] as const

/** Remote methods that write, run, stop, answer an approval, claim a human is present, or return raw node output. */
export const WORKFLOW_PRIVILEGED_METHODS = [
  'save',
  'run',
  'resume',
  'cancel',
  'nodeOutput',
  'approve',
  'reject',
  'attachUi',
  'detachUi',
] as const

/** A read method name. */
export type WorkflowReadMethod = typeof WORKFLOW_READ_METHODS[number]
/** A privileged method name. */
export type WorkflowPrivilegedMethod = typeof WORKFLOW_PRIVILEGED_METHODS[number]

/**
 * Wire endpoint names the loopback-only client is privileged to call. Mirrors
 * `packages/client/connection/src/index.ts`'s `PRIVILEGED_METHODS` (a test keeps the two equal).
 * The reads in {@link WORKFLOW_READ_METHODS} are deliberately absent.
 */
export const WORKFLOW_PRIVILEGED_ENDPOINTS: ReadonlySet<string> = new Set(
  WORKFLOW_PRIVILEGED_METHODS.map(method => `${WORKFLOW_NAMESPACE}/${method}`),
)

/**
 * Text for a loopback-only refusal. The connection layer answers a privileged call from a
 * non-loopback browser with a bare `403 forbidden`; a screen that shows only that is a silent
 * fence on the founder, so the UI shows this instead.
 */
export const WORKFLOW_LOOPBACK_ONLY_MESSAGE =
  'Saving, running, cancelling and approving workflows, and reading raw node output, are loopback-only: open dsh on the machine that hosts it (http://127.0.0.1) to do this.'

/**
 * Explain a refused call.
 * @param endpoint - the wire endpoint that was called, for example `workflow/save`.
 * @param status - the HTTP status the call was answered with.
 * @returns the loopback-only message for a 403 on a privileged workflow endpoint, otherwise undefined.
 */
export function explainWorkflowRefusal(endpoint: string, status: number): string | undefined {
  return status === 403 && WORKFLOW_PRIVILEGED_ENDPOINTS.has(endpoint) ? WORKFLOW_LOOPBACK_ONLY_MESSAGE : undefined
}

/** Wire event: a run started, advanced a node, or ended. */
export const WORKFLOW_RUN_CHANGED_EVENT = 'workflow/run-changed'
/** Wire event: an approval node is waiting for a human answer. */
export const WORKFLOW_APPROVAL_PENDING_EVENT = 'workflow/approval-pending'
/** Wire event: an approval was answered, rejected by the host, expired or cancelled. */
export const WORKFLOW_APPROVAL_DECIDED_EVENT = 'workflow/approval-decided'

/** Layout constants the host passes to the pure layered layout; the client sizes its nodes to match. */
export const WORKFLOW_LAYOUT = { xGap: 80, yGap: 24, nodeW: 220, nodeH: 72 } as const

/** How long a UI attachment lease stays valid without a renewal, in milliseconds. */
export const WORKFLOW_ATTACH_TTL_MS = 45_000
/** Suggested interval between attachment renewals, in milliseconds. */
export const WORKFLOW_ATTACH_RENEW_MS = 15_000
/** Largest page of the `runs` method. */
export const WORKFLOW_RUNS_MAX_LIMIT = 200
/** Largest slice of the `nodeOutput` method, in bytes. */
export const WORKFLOW_OUTPUT_MAX_BYTES = 64 * 1024

/** Why a call did not do what was asked. */
export type WorkflowErrorCode =
  | 'NO_WORKSPACE'
  | 'RUNNER_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'INVALID_NAME'
  | 'TOO_LARGE'
  | 'NOT_FOUND'
  | 'DIAGNOSTICS'
  | 'CONFLICT'
  | 'REFUSED'
  | 'TRUST_REQUIRED'
  | 'TRUST_DENIED'
  | 'WRITER_BUSY'
  | 'RESUME_REFUSED'
  | 'NOT_PENDING'
  | 'LIMIT'
  | 'START_FAILED'
  | 'INTERNAL'

/** A call that did not succeed. Always a normal result, never a thrown error; the text carries no stack and no host path. */
export interface WorkflowFailure {
  /** Always false. */
  ok: false
  /** Machine-readable reason. */
  error: WorkflowErrorCode
  /** Reader-facing text. */
  message: string
  /** What to do next, when there is something to do. */
  remedy?: string
  /** Located problems, for `DIAGNOSTICS`. */
  diagnostics?: WorkflowDiagnostic[]
  /** True when a save lost to a newer file (or to a file that already exists). */
  conflict?: boolean
  /** The file's current content token, for a conflict. */
  currentToken?: string
}

/** One located problem in a workflow file. Lines and columns are 1-based. */
export interface WorkflowDiagnostic {
  /** Error blocks a run and a save; warning does not. */
  severity: 'error' | 'warning'
  /** Stable machine code. */
  code: string
  /** Reader-facing text. */
  message: string
  /** Start line. */
  line: number
  /** Start column. */
  column: number
  /** End line, when known. */
  endLine?: number
  /** End column, when known. */
  endColumn?: number
  /** The node the problem belongs to. */
  nodeId?: string
  /** Path from the document root. */
  path: Array<string | number>
}

/** A workflow input value as the Run dialog sends it. */
export type WorkflowInputValue = string | number | boolean

/** Values for a workflow's declared inputs, by name. */
export type WorkflowInputValues = Record<string, WorkflowInputValue>

/** One declared workflow input. */
export interface WorkflowInputSpec {
  /** Input name. */
  name: string
  /** Declared type. */
  type: 'string' | 'number' | 'boolean'
  /** Whether a value must be given. */
  required: boolean
  /** Default used when none is given. */
  default?: WorkflowInputValue
  /** Description shown in the Run dialog. */
  description?: string
}

/** A node in the display graph. */
export interface WorkflowGraphNode {
  /** Node id. */
  id: string
  /** `prompt`, `bash`, `loop`, `approval` or `cancel`. */
  kind: string
  /** Column of the layered layout. */
  layer: number
  /** Order within the layer. */
  order: number
  /** Whether the node contributes a gate. */
  gate: boolean
  /** The node's `when` condition. */
  when?: string
  /** `all_success`, `one_success` or another trigger rule. */
  triggerRule: string
  /** Ids this node waits for. */
  dependsOn: string[]
  /** Model tier of an agent node. */
  tier?: string
  /** Short display label. */
  label: string
}

/** A dependency edge. */
export interface WorkflowGraphEdge {
  /** Upstream node id. */
  from: string
  /** Downstream node id. */
  to: string
  /** The downstream node's condition. */
  when?: string
}

/** One declared gate of the gate manifest. */
export interface WorkflowGateManifestEntry {
  /** Node id. */
  nodeId: string
  /** `bash`, `approval`, `done_when`, `until_bash` or `verifier`. */
  gateKind: string
}

/** The display graph of a workflow. */
export interface WorkflowGraphView {
  /** Nodes. */
  nodes: WorkflowGraphNode[]
  /** Edges. */
  edges: WorkflowGraphEdge[]
  /** Number of layers. */
  layers: number
  /** Declared gates. */
  manifest: WorkflowGateManifestEntry[]
  /** Declared inputs. */
  inputs: WorkflowInputSpec[]
}

/** A point on the layout canvas. */
export interface WorkflowPoint {
  /** Horizontal position. */
  x: number
  /** Vertical position. */
  y: number
}

/** Node positions from the pure layered layout, in the same unit as {@link WORKFLOW_LAYOUT}. */
export interface WorkflowLayoutView {
  /** Top-left corner of each node by id. */
  positions: Record<string, WorkflowPoint>
  /** Bounding box width. */
  width: number
  /** Bounding box height. */
  height: number
}

/** The most recent run of a workflow. */
export interface WorkflowLastRun {
  /** Run id. */
  runId: string
  /** `running` or an end status. */
  status: string
  /** When the run ended, in epoch milliseconds. */
  endedAt?: number
}

/** One row of the {@link WORKFLOW_LIST_ENDPOINT} result. */
export interface WorkflowListEntry {
  /** File stem under `.workflows/`, matching `^[a-z0-9]+(-[a-z0-9]+)*$`. */
  name: string
  /** The workflow's declared description, or an empty string. */
  description: string
  /** Number of nodes in the compiled graph. */
  nodeCount: number
  /** sha256 of the file content. */
  hash: string
  /** Whether the file validates without error diagnostics. */
  valid: boolean
  /** Number of diagnostics of any severity. */
  diagnosticCount: number
  /** The workflow's most recent run, when it has one. */
  lastRun?: WorkflowLastRun
}

/** The workflows of the calling workspace. */
export interface WorkflowListOk {
  /** Always true. */
  ok: true
  /** One row per workflow file. */
  workflows: WorkflowListEntry[]
  /** Opaque key of this workspace; compare it with `workspaceKey` on pushed events to ignore other workspaces. */
  workspaceKey: string
}

/** Result of `list`. */
export type WorkflowListResult = WorkflowListOk | WorkflowFailure

/** Request of `read`. */
export interface WorkflowReadRequest {
  /** Workflow name. */
  name: string
}

/** A workflow file's text with the token a later `save` presents. */
export interface WorkflowReadOk {
  /** Always true. */
  ok: true
  /** Workflow name. */
  name: string
  /** The exact file text. */
  text: string
  /** sha256 of {@link WorkflowReadOk.text}; pass it back as `expectedToken` when saving. */
  token: string
}

/** Result of `read`. */
export type WorkflowReadResult = WorkflowReadOk | WorkflowFailure

/** Request of `validate`. */
export interface WorkflowValidateRequest {
  /** The draft text; nothing is written. */
  text: string
  /** The file name the draft will be saved under; the document's `name` must equal it. */
  name?: string
}

/** Result of `validate`. */
export interface WorkflowValidateResult {
  /** Whether the draft has no error diagnostics. */
  ok: boolean
  /** Every diagnostic, errors and warnings. */
  diagnostics: WorkflowDiagnostic[]
  /** The display graph, when the draft parsed. */
  graph?: WorkflowGraphView
  /** Node positions for {@link WorkflowValidateResult.graph}. */
  layout?: WorkflowLayoutView
  /** sha256 of the draft text. */
  hash?: string
}

/** One bash command a workflow would run, shown verbatim in the trust dialog. */
export interface WorkflowTrustCommand {
  /** The node that runs it. */
  nodeId: string
  /** `bash` or `until_bash`. */
  field: string
  /** The command text. */
  command: string
  /** Working directory, when set. */
  workdir?: string
  /** Names of the environment variables it sets. */
  envKeys: string[]
  /** The environment it sets. */
  env: Record<string, string>
}

/** One agent node as the trust dialog lists it. */
export interface WorkflowTrustAgent {
  /** The node. */
  nodeId: string
  /** Model tier. */
  tier?: string
  /** Explicit model. */
  model?: string
  /** Explicit provider. */
  provider?: string
}

/** What a workflow will run, derived from the compiled document. */
export interface WorkflowTrustFacts {
  /** Workflow name. */
  name: string
  /** Every bash command. */
  bashCommands: WorkflowTrustCommand[]
  /** Prompt files read. */
  promptFiles: string[]
  /** Agent nodes. */
  agents: WorkflowTrustAgent[]
  /** Number of approval nodes. */
  approvalNodes: number
}

/** Request of `dryRun`. */
export interface WorkflowDryRunRequest {
  /** Workflow name. */
  name: string
  /** Values for the declared inputs. */
  inputs?: WorkflowInputValues
}

/** The plan of a workflow, produced without running or spawning anything. */
export interface WorkflowDryRunOk {
  /** Always true. */
  ok: true
  /** Workflow name. */
  name: string
  /** sha256 of the workflow file. */
  hash: string
  /** Whether this exact content (file and prompt files) is already trusted in this workspace. */
  trusted: boolean
  /** The key a human confirms; pass it back as `trustHash` when running untrusted content. */
  trustKey: string
  /** Single-use token issued to this session with this plan; `run` needs it with `trustHash`. Absent when already trusted. */
  trustChallenge?: string
  /** The exact confirmation text (every command verbatim, workspace, tiers); absent when already trusted. */
  confirmText?: string
  /** The display graph. */
  graph: WorkflowGraphView
  /** Node positions. */
  layout: WorkflowLayoutView
  /** Declared gates. */
  manifest: WorkflowGateManifestEntry[]
  /** Node ids in layer order. */
  plan: string[]
  /** What the workflow will run. */
  trust: WorkflowTrustFacts
  /** Warning diagnostics. */
  warnings: WorkflowDiagnostic[]
}

/** Result of `dryRun`. */
export type WorkflowDryRunResult = WorkflowDryRunOk | WorkflowFailure

/** Request of `runs`. */
export interface WorkflowRunsRequest {
  /** Restrict to one workflow. */
  name?: string
  /** Page size, 1 to {@link WORKFLOW_RUNS_MAX_LIMIT}. */
  limit?: number
  /** Cursor from the previous page. */
  cursor?: string
}

/** One run in a list. */
export interface WorkflowRunSummary {
  /** Run id. */
  runId: string
  /** Workflow name. */
  name: string
  /** sha256 of the pinned source. */
  hash: string
  /** Start time, epoch milliseconds. */
  startedAt: number
  /** End time, epoch milliseconds. */
  endedAt?: number
  /** `running` or an end status. */
  status: string
  /** The session that started it. */
  parentSessionId?: string
}

/** A page of runs, newest first. */
export interface WorkflowRunsOk {
  /** Always true. */
  ok: true
  /** The runs. */
  runs: WorkflowRunSummary[]
  /** Opaque key of this workspace (see {@link WorkflowListOk.workspaceKey}). */
  workspaceKey: string
  /** Cursor of the next page, when there is one. */
  nextCursor?: string
}

/** Result of `runs`. */
export type WorkflowRunsResult = WorkflowRunsOk | WorkflowFailure

/** Request of `runDetail`. */
export interface WorkflowRunDetailRequest {
  /** Run id. */
  runId: string
}

/** One node of a run. */
export interface WorkflowNodeView {
  /** Node id. */
  nodeId: string
  /** Node kind. */
  kind: string
  /** `running`, `success`, `failed`, `skipped` or `cancelled`. */
  status: string
  /** Attempt number. */
  attempt: number
  /** Start time, epoch milliseconds. */
  startedAt: number
  /** End time. */
  endedAt?: number
  /** Duration in milliseconds. */
  durationMs?: number
  /** Process exit code. */
  exitCode?: number
  /** Failure text, free of paths and stacks. */
  error?: string
  /** True when the complete output cannot be recovered. */
  truncated: boolean
  /** Whether any output was recorded; read it with `nodeOutput`. */
  hasOutput: boolean
}

/** One approval of a run. */
export interface WorkflowApprovalView {
  /** Approval id. */
  approvalId: string
  /** The approval node. */
  nodeId: string
  /** The question. */
  message: string
  /** `pending`, `allowed`, `rejected`, `expired` or `cancelled`. */
  state: string
  /** The recorded reason. */
  reason?: string
  /** When it was last updated, epoch milliseconds. */
  at: number
}

/** One row of a gate report. */
export interface WorkflowGateView {
  /** Node id. */
  nodeId: string
  /** Gate kind. */
  gateKind: string
  /** `fired-pass`, `fired-block`, `skipped`, `not-reached` or `never-evaluated`. */
  outcome: string
}

/** A run's header, nodes, gates, approvals and report. */
export interface WorkflowRunDetailOk {
  /** Always true. */
  ok: true
  /** Run id. */
  runId: string
  /** Workflow name. */
  name: string
  /** `running` or an end status. */
  status: string
  /** Start time. */
  startedAt: number
  /** End time. */
  endedAt?: number
  /** The hash the run is pinned to. */
  pinnedHash: string
  /** True when the live file differs from the pinned source (or is gone). */
  fileChanged: boolean
  /** The inputs the run started with, when they were stored whole. */
  inputs?: WorkflowInputValues
  /** The run this one resumed. */
  resumedFrom?: string
  /** Why the run ended badly. */
  error?: string
  /** Nodes, latest attempt state each. */
  nodes: WorkflowNodeView[]
  /** The gate report (final for an ended run, recorded so far otherwise). */
  gates: WorkflowGateView[]
  /** Approvals. */
  approvals: WorkflowApprovalView[]
}

/** Result of `runDetail`. */
export type WorkflowRunDetailResult = WorkflowRunDetailOk | WorkflowFailure

/** Request of `nodeOutput`. */
export interface WorkflowNodeOutputRequest {
  /** Run id. */
  runId: string
  /** Node id. */
  nodeId: string
  /** Starting byte offset, 0 or more. */
  offset: number
  /** Most bytes to return, 1 to {@link WORKFLOW_OUTPUT_MAX_BYTES}. */
  limit: number
}

/** A bounded slice of one node's recorded output. */
export interface WorkflowNodeOutputOk {
  /** Always true. */
  ok: true
  /** The slice. */
  text: string
  /** Offset of the next unread byte, when more remains. */
  nextOffset?: number
  /** Total recorded size in bytes. */
  totalBytes: number
  /** True when the recorded output is itself incomplete. */
  truncated: boolean
}

/** Result of `nodeOutput`. */
export type WorkflowNodeOutputResult = WorkflowNodeOutputOk | WorkflowFailure

/** One approval waiting for a human. */
export interface WorkflowPendingApproval {
  /** Run id. */
  runId: string
  /** Approval id. */
  approvalId: string
  /** The approval node. */
  nodeId: string
  /** The question. */
  message: string
}

/** The approvals waiting in this workspace. */
export interface WorkflowPendingApprovalsOk {
  /** Always true. */
  ok: true
  /** The waiting approvals. */
  approvals: WorkflowPendingApproval[]
}

/** Result of `pendingApprovals`. */
export type WorkflowPendingApprovalsResult = WorkflowPendingApprovalsOk | WorkflowFailure

/** Request of `save`. */
export interface WorkflowSaveRequest {
  /** Workflow name; the file is always `<workflows dir>/<name>.yaml`. */
  name: string
  /** The complete file text. */
  text: string
  /** The token of the content being replaced (from `read` or a previous `save`); `null` creates a new file and fails if one exists. */
  expectedToken: string | null
}

/** A file that was written. */
export interface WorkflowSaveOk {
  /** Always true. */
  ok: true
  /** Token of the written content. */
  token: string
  /** Warning diagnostics (a saved file has no errors). */
  diagnostics: WorkflowDiagnostic[]
  /** Present when the file was saved but the folder flush failed; show it, do not treat the save as failed. */
  warning?: string
}

/** Result of `save`. */
export type WorkflowSaveResult = WorkflowSaveOk | WorkflowFailure

/** Request of `run`. */
export interface WorkflowRunRequest {
  /** Workflow name. */
  name: string
  /** Values for the declared inputs. */
  inputs?: WorkflowInputValues
  /** The `trustKey` the human confirmed; required when the content is not yet trusted. */
  trustHash?: string
  /** The `trustChallenge` that came with the plan the human reviewed; required with `trustHash`. */
  trustChallenge?: string
}

/** A run that began. Follow it with the `workflow/*` events or `runDetail`. */
export interface WorkflowRunStartedOk {
  /** Always true. */
  ok: true
  /** Run id. */
  runId: string
}

/** Result of `run` and `resume`. */
export type WorkflowRunStartResult = WorkflowRunStartedOk | WorkflowFailure

/** Request of `resume`. */
export interface WorkflowResumeRequest {
  /** The earlier run to resume from its pinned source. */
  runId: string
  /** The `trustKey` the human confirmed, when the pinned content is not trusted any more. */
  trustHash?: string
  /** The challenge that came with the plan the human reviewed. */
  trustChallenge?: string
}

/** Request of `cancel`. */
export interface WorkflowCancelRequest {
  /** Run id. */
  runId: string
}

/** A run that was asked to stop. */
export interface WorkflowCancelOk {
  /** Always true. */
  ok: true
  /** The end status once the run closed, or `cancelling` when it is still closing. */
  status: string
}

/** Result of `cancel`. */
export type WorkflowCancelResult = WorkflowCancelOk | WorkflowFailure

/** Request of `approve`. */
export interface WorkflowApproveRequest {
  /** Run id. */
  runId: string
  /** Approval id. */
  approvalId: string
}

/** Request of `reject`. */
export interface WorkflowRejectRequest {
  /** Run id. */
  runId: string
  /** Approval id. */
  approvalId: string
  /** Why; capped, control characters removed, and shown as user text. */
  reason?: string
}

/** An approval that was answered (or had already been). */
export interface WorkflowAnswerOk {
  /** Always true. */
  ok: true
  /** The state that won: `allowed`, `rejected`, `expired` or `cancelled`. The first answer wins. */
  state: string
}

/** Result of `approve` and `reject`. */
export type WorkflowAnswerResult = WorkflowAnswerOk | WorkflowFailure

/** Request of `attachUi`. */
export interface WorkflowAttachRequest {
  /** The lease being renewed; omit it to open a new one. */
  leaseId?: string
}

/** A human-present lease. Renew it before {@link WORKFLOW_ATTACH_TTL_MS} elapses; it lapses on its own if the page dies. */
export interface WorkflowAttachOk {
  /** Always true. */
  ok: true
  /** The lease to renew or release. */
  leaseId: string
  /** Milliseconds until it lapses without a renewal. */
  ttlMs: number
  /** Opaque key of this workspace (see {@link WorkflowListOk.workspaceKey}). */
  workspaceKey: string
}

/** Result of `attachUi`. */
export type WorkflowAttachResult = WorkflowAttachOk | WorkflowFailure

/** Request of `detachUi`. */
export interface WorkflowDetachRequest {
  /** The lease to release. */
  leaseId: string
}

/** The lease is gone (it may already have been). */
export interface WorkflowDetachOk {
  /** Always true. */
  ok: true
}

/** Result of `detachUi`. */
export type WorkflowDetachResult = WorkflowDetachOk | WorkflowFailure

/** Payload of {@link WORKFLOW_RUN_CHANGED_EVENT}: ids and status only. */
export interface WorkflowRunChange {
  /** Run id. */
  runId: string
  /** `running` or an end status. */
  status: string
  /** The node that changed, when one did. */
  nodeId?: string
  /** That node's new status. */
  nodeStatus?: string
  /** Opaque key of the run's workspace; a client ignores events whose key is not its own. */
  workspaceKey?: string
}

/** Payload of {@link WORKFLOW_APPROVAL_PENDING_EVENT}. */
export interface WorkflowApprovalPending {
  /** Run id. */
  runId: string
  /** Approval id. */
  approvalId: string
  /** The approval node. */
  nodeId: string
  /** Opaque key of the run's workspace; a client ignores events whose key is not its own. */
  workspaceKey?: string
}

/** Payload of {@link WORKFLOW_APPROVAL_DECIDED_EVENT}. */
export interface WorkflowApprovalDecided {
  /** Run id. */
  runId: string
  /** Approval id. */
  approvalId: string
  /** The state the approval ended in. */
  state: string
  /** Opaque key of the run's workspace; a client ignores events whose key is not its own. */
  workspaceKey?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A workflow run started, advanced a node, or ended. Forwarded to clients verbatim once
     * `packages/api/remotes/src/remote-events.ts`'s allowlist names it; the payload is ids and
     * status only.
     * @param change - the run id, its status, and the node that changed.
     * @mode emit
     */
    'workflow/run-changed'(change: WorkflowRunChange): void
    /**
     * An approval node is waiting for a human answer.
     * @param approval - the run, approval and node ids; the question is read with `pendingApprovals`.
     * @mode emit
     */
    'workflow/approval-pending'(approval: WorkflowApprovalPending): void
    /**
     * An approval left the pending state.
     * @param decision - the run and approval ids and the state it ended in.
     * @mode emit
     */
    'workflow/approval-decided'(decision: WorkflowApprovalDecided): void
  }
}

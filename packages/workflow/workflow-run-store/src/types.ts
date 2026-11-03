/** Record shapes persisted in `runs.jsonl` and `index.json`. Every record carries `v: 1`. */

/** Terminal status of a run. */
export type WorkflowRunEndStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted'
/** Status of a node record. `running` is the node-start record; the rest are node-end. */
export type WorkflowNodeStatus = 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'
/** Lifecycle of an approval. Only `pending` can be decided. */
export type WorkflowApprovalState = 'pending' | 'allowed' | 'rejected' | 'expired' | 'cancelled'

/** Outcome token for a gate row: lowercase a-z, 0-9, underscore or hyphen, at most 32 chars; the store refuses other text. */
export type WorkflowGateOutcome = string
/** Outcome written for a declared gate that has no gate record. */
export const GATE_NOT_REACHED = 'not-reached'

/** One declared gate in the compiler manifest. */
export interface WorkflowManifestGate {
  readonly nodeId: string
  readonly gateKind: string
}

/** Compiler manifest persisted with the run header. Only `gates` is interpreted by the store. */
export interface WorkflowRunManifest {
  readonly gates?: readonly WorkflowManifestGate[]
  readonly [key: string]: unknown
}

/** One row of a gate report. */
export interface WorkflowGateRow {
  readonly nodeId: string
  readonly gateKind: string
  readonly outcome: WorkflowGateOutcome
}

/** Run header record. */
export interface RunHeaderRecord {
  readonly v: 1
  readonly kind: 'run'
  readonly runId: string
  readonly name: string
  readonly hash: string
  readonly workspace: string
  readonly parentSessionId?: string
  readonly startedAt: number
  /** JSON inputs, replaced by `{ truncated: true, bytes }` when larger than 16 KB. */
  readonly inputs: unknown
  readonly manifest: WorkflowRunManifest
  readonly ownerPid: number
  readonly ownerHost: string
  readonly ownerStartTime: string | null
  readonly ownerBootId: string | null
}

/** Why a node's agent was stopped by the supervisor, as persisted with the node. */
export interface NodeFailureRecord {
  /** Upper-case reason code such as `NODE_STALLED` or `NODE_TIMEOUT`. */
  readonly code: string
  /** What happened (bounded). */
  readonly message: string
  /** What to change (bounded). */
  readonly remedy: string
}

/** Node start or end record. */
export interface NodeRecord {
  readonly v: 1
  readonly kind: 'node'
  readonly runId: string
  readonly nodeId: string
  /** Short lowercase token such as `bash` or `prompt`; the store refuses free text. */
  readonly nodeKind: string
  readonly status: WorkflowNodeStatus
  readonly exitCode?: number
  readonly startedAt: number
  readonly endedAt?: number
  readonly durationMs?: number
  readonly attempt: number
  /** Last 8 KB of output. */
  readonly outputTail?: string
  /** Full output when between 8 KB and 64 KB (otherwise equal to the tail or absent). */
  readonly output?: string
  /** Spill file name inside the run directory, set when output exceeds 64 KB. */
  readonly outputRef?: string
  /** True when the complete output cannot be recovered from the store. */
  readonly truncated: boolean
  readonly error?: string
  /** Why the supervisor stopped the node's agent; absent for other failures and in records written before the field existed. */
  readonly failure?: NodeFailureRecord
  /** Why the full output is not recoverable (for example the per-run spill budget was reached). */
  readonly outputNote?: string
}

/** Gate record. */
export interface GateRecord {
  readonly v: 1
  readonly kind: 'gate'
  readonly runId: string
  readonly nodeId: string
  readonly gateKind: string
  readonly outcome: WorkflowGateOutcome
}

/** Approval record; the latest record per `approvalId` is its current state. */
export interface ApprovalRecord {
  readonly v: 1
  readonly kind: 'approval'
  readonly runId: string
  readonly approvalId: string
  readonly nodeId: string
  readonly message: string
  readonly state: WorkflowApprovalState
  readonly reason?: string
  readonly at: number
}

/** Run end record. */
export interface EndRecord {
  readonly v: 1
  readonly kind: 'end'
  readonly runId: string
  readonly status: WorkflowRunEndStatus
  readonly endedAt: number
  readonly report: readonly WorkflowGateRow[]
  readonly error?: string
}

/** Any record in `runs.jsonl`. */
export type StoreRecord = RunHeaderRecord | NodeRecord | GateRecord | ApprovalRecord | EndRecord

/** Folded one-line summary of a run, stored in `index.json`. */
export interface RunSummary {
  readonly runId: string
  readonly name: string
  readonly hash: string
  readonly startedAt: number
  readonly status: 'running' | WorkflowRunEndStatus
  readonly endedAt?: number
  readonly ownerPid: number
  readonly parentSessionId?: string
}

/** Shape of `index.json`. */
export interface IndexFile {
  readonly v: 1
  /** Full workspace realpath; a mismatch means a hash-prefix collision and the store refuses. */
  readonly workspace: string
  /** Size of `runs.jsonl` this index was folded from; a different size means the index is stale. */
  readonly logBytes: number
  /** Oldest first. */
  readonly runs: readonly RunSummary[]
  /** Damaged log lines seen by the last full read (0 when the index was current). */
  readonly skipped?: number
}

/** Input of {@link WorkflowRunStore.startRun}. */
export interface StartRunInput {
  readonly runId: string
  readonly name: string
  readonly hash: string
  /** Exact workflow source text to pin as `source.yaml`. */
  readonly source: string
  readonly parentSessionId?: string
  readonly inputs?: unknown
  readonly manifest: WorkflowRunManifest
}

/** Input of {@link WorkflowRunStore.recordNode}. */
export interface RecordNodeInput {
  readonly nodeId: string
  readonly nodeKind: string
  readonly status: WorkflowNodeStatus
  readonly exitCode?: number
  readonly startedAt: number
  readonly endedAt?: number
  readonly durationMs?: number
  readonly attempt?: number
  /** Full output text (bash stdout, agent final text). Spilled to disk when over 64 KB. */
  readonly output?: string
  /** Set when the caller already clipped `output` so the full text no longer exists anywhere. */
  readonly outputTruncated?: boolean
  readonly error?: string
  /** The supervisor stop that failed the node. Persisted only when the code is upper-case letters and underscores. */
  readonly failure?: NodeFailureRecord
}

/** Input of {@link WorkflowRunStore.recordGate}. */
export interface RecordGateInput {
  readonly nodeId: string
  readonly gateKind: string
  readonly outcome: WorkflowGateOutcome
}

/** Input of {@link WorkflowRunStore.endRun}. */
export interface EndRunInput {
  readonly status: WorkflowRunEndStatus
  readonly error?: string
  /** Defaults to the manifest gates folded with the gate records, `not-reached` for the rest. */
  readonly report?: readonly WorkflowGateRow[]
}

/** Folded state of one node attempt. */
export interface NodeState {
  readonly nodeId: string
  readonly attempt: number
  /** True while only the node-start record exists. */
  readonly running: boolean
  readonly record: NodeRecord
}

/** Result of {@link WorkflowRunStore.getRun}. */
export interface RunDetail {
  readonly header: RunHeaderRecord
  readonly status: 'running' | WorkflowRunEndStatus
  /** Every node record in write order (start and end rows). */
  readonly nodes: readonly NodeRecord[]
  /** Latest record per nodeId and attempt, in first-seen order. */
  readonly nodeStates: readonly NodeState[]
  readonly gates: readonly GateRecord[]
  /** Latest record per approval id. */
  readonly approvals: readonly ApprovalRecord[]
  readonly end?: EndRecord
  /** Damaged log lines skipped while reading (a torn final line is not counted). */
  readonly skippedLines: number
}

/** Result of {@link WorkflowRunStore.listRuns}. */
export interface ListRunsResult {
  /** Newest first. */
  readonly runs: readonly RunSummary[]
  readonly nextCursor?: string
  /** Damaged log lines seen when the index was last rebuilt. */
  readonly skippedLines: number
}

/** Result of {@link WorkflowRunStore.readOutput}. */
export interface OutputSlice {
  readonly text: string
  /** Byte offset of the next unread byte, or undefined at the end. */
  readonly nextOffset?: number
  readonly totalBytes: number
  /** True when the stored output is itself incomplete (see `NodeRecord.truncated`). */
  readonly truncated: boolean
}

/** Result of a compare-and-set approval decision. */
export interface DecideApprovalResult {
  /** True only for the call that flipped `pending` to the new state. */
  readonly decided: boolean
  /** The winning (existing) record when `decided` is false. */
  readonly approval: ApprovalRecord
}

/** Result of {@link WorkflowRunStore.sweepInterrupted}. */
export interface SweepResult {
  readonly swept: readonly string[]
  /** Set when the sweep could not take the writer lock and did nothing. */
  readonly skipped?: 'writer-busy'
}

/** Result of {@link WorkflowRunStore.prune}. */
export interface PruneResult {
  readonly removed: readonly string[]
  readonly skipped?: 'writer-busy'
}

/** Limits the store enforces. */
export const LIMITS = {
  /** Output larger than this (bytes) is spilled to `<runId>/<nodeId>.out`. */
  spillBytes: 64 * 1024,
  /** Size of `outputTail`. */
  tailBytes: 8 * 1024,
  /** Largest spill file; bigger output is clipped and flagged `truncated`. */
  maxSpillBytes: 64 * 1024 * 1024,
  /** Serialized `inputs` larger than this are replaced by a marker. */
  inputsBytes: 16 * 1024,
  /** Largest `readOutput` limit per call. */
  readOutputMaxLimit: 256 * 1024,
  /** Default retained runs per workspace. */
  retention: 200,
  maxErrorChars: 4096,
  /** Spill bytes allowed per run; further spills are refused and the node is flagged. */
  runSpillBudgetBytes: 256 * 1024 * 1024,
  approvalMessageChars: 500,
  approvalReasonChars: 500,
  nameChars: 128,
  parentSessionIdChars: 128,
  /** Serialized manifest cap. */
  manifestBytes: 64 * 1024,
  /** Temp files older than this are reaped by prune. */
  tempReapMs: 60 * 60 * 1000,
} as const

/**
 * Non-protocol wire vocabulary for the worker-thread engine: the `workerData` init payload and
 * the child-port interfaces the worker-side runtime consumes. Host/worker messages are defined in
 * `./protocol.ts`; transported child requests and results are plain JSON for structured clone.
 * @module @deepseek-ai/dsh-workflow-worker-thread/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {
  WorkflowApprovalOutcome,
  WorkflowBashOptions,
  WorkflowBashResult,
  WorkflowContinuationEvidence,
  WorkflowDoneWhen,
  WorkflowMeta,
} from '@deepseek-ai/dsh-workflow'

/**
 * The per-run limits the worker-side runtime enforces. The host keeps the
 * knobs only it can act on (`provider`, `disposeGraceMs`).
 */
export interface WorkerLimits {
  /** Concurrent `agent()` ceiling (already auto-resolved; ≥ 1). */
  maxConcurrentAgents: number
  /** Total `agent()` calls per run (the runaway-loop backstop). */
  maxTotalAgents: number
  /** Items accepted by one `parallel()`/`pipeline()` call. */
  maxItemsPerCall: number
  /** vm timeout for the script's initial synchronous slice (inside the worker). */
  syncTimeoutMs: number
}

/** The `workerData` payload one run is initialized with (host → worker, once, at spawn). */
export interface WorkerInit {
  /** The validated meta block (plain data off the start request, validated host-side). */
  meta: WorkflowMeta
  /** The plain-JS script body, exactly as the start request carried it. */
  body: string
  /** The run's `args` value; the workerData structured clone is the copy that isolates the caller. */
  args?: unknown
  /** The worker-enforced limits. */
  limits: WorkerLimits
  /**
   * Whether `bash()` (and the `agent()` `doneWhen` option) is enabled for this run. Off by
   * default: the hook runs host-side commands, so only an owner that vouches for the script
   * (a compiled, trusted workflow) turns it on. Off makes the hooks throw `UNSUPPORTED_OPTION`.
   */
  bashEnabled?: boolean
}

/** What the worker asks the host to start for one `agent()` call (options already validated worker-side). */
export interface ChildStartRequest {
  /** The child's prompt text. */
  prompt: string
  /** The structured-output schema, if the call passed one (already subset-checked). */
  schema?: ObjectJsonSchema
  /** The per-child provider override, if the call passed one. */
  provider?: string
  /** The per-child model override, if the call passed one. */
  model?: string
  /** The node the call belongs to (the `nodeId` option), used for supervision and evidence lookup. */
  nodeId?: string
  /** Model tier label (`cheap`, `standard`, `premium`); the host resolves it through `tierModels` when no model is given. */
  tier?: string
  /** Absolute child deadline in milliseconds (enforced by the child supervisor). */
  timeoutMs?: number
  /** Stall deadline in milliseconds: no child activity for this long (enforced by the child supervisor). */
  idleTimeoutMs?: number
  /** The done-when check (validated and clamped worker-side, re-validated host-side). */
  doneWhen?: WorkflowDoneWhen
}

/**
 * The JSON projection of a child's `SubagentResult` crossing the port. The
 * seam's `stopReason` union is merge-extensible, so it degrades to `string`
 * on the wire — the runtime only ever branches on `'completed'`.
 */
export interface ChildResult {
  /** The child's final assistant output blocks. */
  output: ContentBlock[]
  /** The structured value, present iff the request carried a schema AND the provider honored it. */
  structured?: unknown
  /** Why the child run ended (`'completed'` is the only value the runtime branches on). */
  stopReason: string
  /** Present when a done-when check ran: how many iterations ran and whether the cap was exhausted. */
  continuation?: {
    /** Iterations run (1 = the first run only). */
    iterations: number
    /** True when the cap ended the loop with the check still failing (the node fails with `evidence`). */
    exhausted: boolean
    /** The last failing evidence (present when `exhausted`). */
    evidence?: WorkflowContinuationEvidence
  }
}

/**
 * The worker-side handle for one started child — the RPC mirror of the
 * subagent seam's run handle, reduced to what the runtime consumes.
 */
export interface ChildHandle {
  /** The child agent's id (minted host-side by the subagent seam). */
  readonly id: string
  /**
   * Resolves with the child's terminal {@link ChildResult}; REJECTS only when
   * the host reports an infrastructure fault (`child-failed`) — a child that
   * failed for its own reasons resolves with a non-`completed` stop reason.
   */
  readonly result: Promise<ChildResult>
  /** Ask the host to dispose the child; resolves on the host's ack. */
  dispose(): Promise<void>
}

/**
 * The worker-side port the runtime starts child agents through — the seam
 * that lets the execution core stay ignorant of the thread boundary.
 */
export interface ChildPort {
  /**
   * Start one child agent on the host (the `agent()` hook's start half).
   * @param request - the prompt and validated options.
   * @returns the published child handle; rejects when synchronous start or the
   *   provider's asynchronous start fails.
   */
  startAgent(request: ChildStartRequest): Promise<ChildHandle>
}

/**
 * The worker-side port the `bash()` and `approve()` hooks use to reach the
 * host. Both calls execute host-side: the worker never spawns a process.
 */
export interface HookPort {
  /**
   * Run one validated bash call on the host.
   * @param command - the command text.
   * @param options - the validated options bag.
   * @returns the exit facts and bounded output; rejects with a rendered host-side refusal.
   */
  bash(command: string, options: WorkflowBashOptions): Promise<WorkflowBashResult>
  /**
   * Put one approval question to the host's approver.
   * @param nodeId - the approval node.
   * @param message - the question text.
   * @param timeoutMs - requested wait cap (the host clamps it).
   * @returns the closed outcome (the approval id never crosses to the worker).
   */
  approve(nodeId: string, message: string, timeoutMs?: number): Promise<WorkflowApprovalOutcome>
}

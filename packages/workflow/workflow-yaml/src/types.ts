/**
 * The normalized, validated workflow document model plus the graph and manifest shapes derived
 * from it. Everything here is plain JSON-serializable data.
 * @module @deepseek-ai/dsh-workflow-yaml/types
 */

import type { Diagnostic } from './diagnostics.ts'

/** Model tiers; `premium` requires a non-empty `justify`. */
export type WorkflowTier = 'cheap' | 'standard' | 'premium'
/** Node kinds a v1 file may use (`workflow` is reserved and rejected). */
export type WorkflowNodeKind = 'prompt' | 'bash' | 'loop' | 'approval' | 'cancel'
/** How a node decides to run from its dependencies' final statuses. */
export type TriggerRule = 'all_success' | 'one_success' | 'none_failed_min_one_success' | 'all_done'

/** Retry policy; only transient failures (stall, timeout, provider start, shell timeout) retry. */
export interface RetrySpec {
  maxAttempts: number
  delayMs: number
}

/** One declared workflow input. */
export interface InputSpec {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  default?: string | number | boolean
  description?: string
}

/** File-wide defaults a node inherits. */
export interface WorkflowDefaults {
  tier?: WorkflowTier
  timeoutMs?: number
  idleTimeoutMs?: number
  retry?: RetrySpec
  maxTotalAgents?: number
}

/** Fields every node carries. */
export interface BaseNode {
  id: string
  kind: WorkflowNodeKind
  dependsOn: string[]
  /** The `when` expression exactly as written. */
  when?: string
  triggerRule: TriggerRule
  /** Whether the node is a hard gate that appears in the gate manifest. */
  gate: boolean
  retry?: RetrySpec
  label?: string
  phase?: string
}

/** Fields shared by the agent-running kinds. */
export interface AgentFields {
  prompt?: string
  promptFile?: string
  tier?: WorkflowTier
  model?: string
  provider?: string
  outputFormat?: Record<string, unknown>
  timeoutMs?: number
  idleTimeoutMs?: number
  mutatesCheckout: boolean
  justify?: string
}

/** A `prompt` node: one child agent, optionally wrapped in a `done_when` continuation loop. */
export interface PromptNode extends BaseNode, AgentFields {
  kind: 'prompt'
  doneWhen?: string
  maxIterations: number
}

/** A `bash` node: one host-side shell command. */
export interface BashNode extends BaseNode {
  kind: 'bash'
  bash: string
  workdir?: string
  timeoutMs?: number
  env: Record<string, string>
  allowFailure: boolean
  injectFailureTo?: string
}

/** A `loop` node: run the agent until `until_bash` exits 0, bounded by `max_iterations`. */
export interface LoopNode extends BaseNode, AgentFields {
  kind: 'loop'
  untilBash: string
  maxIterations: number
  workdir?: string
  env: Record<string, string>
}

/** An `approval` node: wait for a human answer. */
export interface ApprovalNode extends BaseNode {
  kind: 'approval'
  message: string
  timeoutMs: number
}

/** A `cancel` node: stop the whole run with a reason. */
export interface CancelNode extends BaseNode {
  kind: 'cancel'
  reason: string
}

/** Any validated node. */
export type WorkflowNode = PromptNode | BashNode | LoopNode | ApprovalNode | CancelNode

/** A validated workflow document. */
export interface WorkflowDoc {
  version: 1
  name: string
  description: string
  whenToUse?: string
  inputs: InputSpec[]
  defaults: WorkflowDefaults
  nodes: WorkflowNode[]
}

/** The kinds of gate a node can contribute to the gate report. */
export type GateKind = 'bash' | 'approval' | 'done_when' | 'until_bash' | 'verifier'
/** One declared gate. */
export interface ManifestEntry {
  nodeId: string
  gateKind: GateKind
}

/** A node in the display graph. */
export interface GraphNode {
  id: string
  kind: WorkflowNodeKind
  layer: number
  order: number
  gate: boolean
  when?: string
  triggerRule: TriggerRule
  dependsOn: string[]
  tier?: WorkflowTier
  label: string
}
/** A dependency edge; `when` is the target node's condition. */
export interface GraphEdge {
  from: string
  to: string
  when?: string
}
/** The display graph. */
export interface WorkflowGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  layers: number
  manifest: ManifestEntry[]
  inputs: InputSpec[]
}

/** Options for {@link analyze}. */
export interface AnalyzeOptions {
  /** The file's basename without extension; when given the `name` field must equal it. */
  expectedName?: string
  /** Reject text over this many UTF-8 bytes. Default 262144 (256 KiB). */
  maxBytes?: number
  /**
   * Runtime hook for the resolved-model check (catalog resolution is the host's job). Return a
   * rejection reason to refuse the model id, or `undefined` to accept it. The static Fable text
   * check always runs first.
   */
  checkModel?: (model: string, context: { nodeId: string }) => string | undefined
}

/** What {@link analyze} returns. */
export interface AnalyzeResult {
  /** True when there are no error-severity diagnostics. */
  ok: boolean
  diagnostics: Diagnostic[]
  doc?: WorkflowDoc
  graph?: WorkflowGraph
  manifest?: ManifestEntry[]
  /** Where each node (and its `id` scalar) sits, for editor navigation. */
  locations?: Record<string, { line: number; column: number }>
  /** SHA-256 of the exact UTF-8 bytes, lowercase hex; absent when the text exceeded the size cap. */
  hash?: string
}

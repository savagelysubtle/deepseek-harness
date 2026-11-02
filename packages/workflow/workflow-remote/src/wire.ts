/**
 * Shared wire contract for the `workflow` Remote namespace: the namespace and method names and
 * the list-row shape the browser consumes. Kept intentionally small and stable, since client
 * packages build against these names and shapes directly, so a change here is a cross-package
 * contract change. This revision carries only the `list` method; the remaining methods, the
 * privileged endpoint set, and the pushed events land in later slices of OP-240.
 * @module @deepseek-ai/dsh-workflow-remote/wire
 */

/** Typert namespace every Remote method below is published under. */
export const WORKFLOW_NAMESPACE = 'workflow'

/** `@Remote` export name for {@link WORKFLOW_LIST_ENDPOINT}: list the workspace's discovered workflows. */
export const WORKFLOW_LIST_METHOD = 'list'

/** Wire endpoint (`<namespace>/<method>`): list the workspace's discovered workflows. */
export const WORKFLOW_LIST_ENDPOINT = `${WORKFLOW_NAMESPACE}/${WORKFLOW_LIST_METHOD}`

/**
 * Wire endpoint names the loopback-only client is privileged to call. Empty in the scaffold
 * revision because `list` is a read; the file-writing and run-starting methods join it with
 * the connection layer's `PRIVILEGED_METHODS` in the same slice.
 */
export const WORKFLOW_PRIVILEGED_ENDPOINTS: ReadonlySet<string> = new Set<string>()

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
}

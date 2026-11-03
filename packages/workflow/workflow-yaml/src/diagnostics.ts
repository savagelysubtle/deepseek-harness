/**
 * The one diagnostic shape every parse, schema, reference, cycle, `when`, path, and denylist
 * error uses, so the Host tool, the Host Remote service, and the browser editor render them the
 * same way.
 * @module @deepseek-ai/dsh-workflow-yaml/diagnostics
 */

/** One located problem in a workflow file. Lines and columns are 1-based. */
export interface Diagnostic {
  severity: 'error' | 'warning'
  /** Stable machine code, e.g. `version-missing`, `unknown-field`, `when-syntax`. */
  code: string
  message: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  /** The node the problem belongs to, when it belongs to one. */
  nodeId?: string
  /** Path from the document root, e.g. `['nodes', 2, 'when']`. */
  path: (string | number)[]
}

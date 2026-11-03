/**
 * Pure YAML workflow definitions: the parser, validator, graph compiler, and layout for
 * `.workflows/<name>.yaml` files. This package performs no I/O and registers no Cordis service,
 * so the Host tool, the Host Remote service, and the browser editor share one implementation.
 * @module @deepseek-ai/dsh-workflow-yaml
 */

/** Version a workflow file must declare in its top-level `version` field. */
export const WORKFLOW_YAML_SCHEMA_VERSION = 1

export { analyze, DEFAULT_MAX_BYTES } from './analyze.ts'
export { checkEnvName, checkModelId, checkRelativePath, checkTierTable, normalizeModelText } from './checks.ts'
export type { CheckResult } from './checks.ts'
export { compile, COMPILED_SCRIPT_CONTRACT, WorkflowCompileError } from './compile.ts'
export type { CompiledMeta, CompiledWorkflow, CompileOptions } from './compile.ts'
export type { Diagnostic } from './diagnostics.ts'
export { buildManifest, describeGraph, layout } from './graph.ts'
export type { LayoutOptions, LayoutResult } from './graph.ts'
export { sha256Hex } from './sha256.ts'
export { describeTrustFacts } from './trust.ts'
export type { TrustFacts } from './trust.ts'
export * from './types.ts'
export {
  MAX_AGENT_TIMEOUT_MS, MAX_APPROVAL_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS, MAX_DONE_WHEN_ITERATIONS, MAX_LOOP_ITERATIONS,
} from './validate.ts'

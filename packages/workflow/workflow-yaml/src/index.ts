/**
 * Pure YAML workflow definitions: the parser, validator, graph compiler, and layout for
 * `.workflows/<name>.yaml` files. This package performs no I/O and registers no Cordis
 * service, so the Host tool, the Host Remote service, and the browser editor can all share one
 * implementation. This revision is the package scaffold; the schema, diagnostics, and compiler
 * land in later slices of OP-240.
 * @module @deepseek-ai/dsh-workflow-yaml
 */

// Declaration-only: the `yaml` parser is this package's one runtime dependency.
import type {} from 'yaml'

/** Version a workflow file must declare in its top-level `version` field. */
export const WORKFLOW_YAML_SCHEMA_VERSION = 1

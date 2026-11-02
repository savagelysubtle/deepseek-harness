# @deepseek-ai/dsh-workflow-run-store

English | [中文](README.zh.md)

Durable on-disk store for YAML workflow runs (OP-240): an append-only record log, the pinned workflow source, spilled node output, and a folded index, kept outside the checkout under the dsh home. Pure Node I/O that depends on the [`@deepseek-ai/dsh-workflow`](../workflow/README.md) types only. The package root currently exports the `WorkflowRunId` type and `WORKFLOW_RUN_RECORD_VERSION`.

## Model Experience

None, as this package persists run records to disk and contributes nothing to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Scaffold only** — the writer lock, record schema, spill, retention, and recovery are not implemented yet.

# @deepseek-ai/dsh-tool-workflow-run

English | [中文](README.zh.md)

The model-facing **`workflow_run` tool** and the **`ctx.workflowRuns` service** that execute YAML workflow definitions (`.workflows/<name>.yaml`, parsed by [`@deepseek-ai/dsh-workflow-yaml`](../workflow-yaml/README.md)) over [`ctx.workflowEngine`](../workflow/README.md), recording each run through [`@deepseek-ai/dsh-workflow-run-store`](../workflow-run-store/README.md). It sits beside [`@deepseek-ai/dsh-tool-workflow`](../tool-workflow/README.md), which keeps running model-written JavaScript scripts unchanged.

This revision is the package scaffold: the plugin declares its identity and required services (`tools`, `workflowEngine`) and mounts without registering anything. The tool, the service, the trust and approval logic, and the session records land in later slices of OP-240.

## Model Experience

### workflow_run tool

#### What the model sees

Nothing yet: the scaffold registers no tool and no system-prompt section. The tool description and its usage guidance arrive with the tool itself.

##### Tool description and guidance (placeholder)

```markdown
Placeholder: the workflow_run tool description and usage guidance are written when the tool is registered.
```

#### Token effect

None while the scaffold registers nothing; the registered tool will add a fixed schema cost on each request where it is visible.

#### KV Cache effect

Independent while nothing is registered; the registered tool schema will be prefix-stable while its definition and visibility are unchanged.

## Known Limitations and Deferred Work

- **Scaffold only** — no tool or service is registered yet, so `workflow_run` and `ctx.workflowRuns` do not exist.

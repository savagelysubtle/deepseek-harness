# @deepseek-ai/dsh-tool-workflow-run

English | [中文](README.zh.md)

The model-facing **`workflow_run` tool** and the **`ctx.workflowRuns` host runner** that execute YAML workflow definitions (`<workflowsDir>/<name>.yaml`, parsed by [`@deepseek-ai/dsh-workflow-yaml`](../workflow-yaml/README.md)) over [`ctx.workflowEngine`](../workflow/README.md), recording each run through [`@deepseek-ai/dsh-workflow-run-store`](../workflow-run-store/README.md). It sits beside [`@deepseek-ai/dsh-tool-workflow`](../tool-workflow/README.md), which keeps running model-written JavaScript scripts unchanged.

## What it does

- **Tool.** Exactly one of `name`, `path`, `resume` or `cancel` is given, plus optional `inputs` and `dryRun`. `dryRun` returns the execution order, the gate manifest and every shell command, and starts nothing (no shell call, no engine start). Compile and validation errors come back as located `line:column` diagnostics, never a stack. A run is foreground; a non-completed run is returned as an error result carrying the status line, node table and gate report. The result `data` is `{ report, nodes, hash }`.
- **Runner (`ctx.workflowRuns`).** One store handle per workspace per process (directory from `workflowStoreDir(dshHome, workspace)`). Only one run per workspace may be active: a second start is refused with the holder run id, workflow name, start time and the remedy. Each start pins the source text and hash in the store, so editing the file mid-run never changes the run; `getRunView` reports `fileChanged` when the live file hash differs from the pinned one.
- **Shell.** Workflow `bash` nodes run through `ctx.shell` (not the engine's local executor), under the session sandbox policy when a confining shell (bash-sandbox) is mounted; bash-local ignores the policy and a mounted confining shell with no policy refuses to run, with 64 KB output tails; the full stdout spills into the store.
- **Trust.** The first run of an unseen or edited hash is refused until a human confirms it; the confirm text shows the workspace, every bash command (verbatim, with control and bidirectional characters escaped), the env keys (never values), each agent's tier and model, each prompt file with its sha256 and the full 64-character hash, and says the workflow runs with the same permissions as the agent's bash tool. The trust key is the YAML hash plus the prompt-file digests, is bound to the workspace, and any edit to a prompt file asks again. A confirm line too long to show safely is refused rather than truncated. Policy `ask` re-asks on hash change; policy `never` refuses any unconfirmed hash. Confirmed hashes are kept in `trust.json` in the store directory.
- **Approvals.** The store is asked first. The calling agent is also asked through `ctx.approval` only when it has an open turn (a UI-started run with an idle parent never reaches the chat). The first answer wins and the other path is cancelled. A wait ends at `approvalWaitMs`: the approval is marked expired and the node is rejected. A headless session, trust policy `never`, or a session where nobody can answer (no open turn and no connected UI) rejects immediately; the reason and remedy text appears in the tool result, the store approval record and the session gate-report row.
- **Gate report.** On every terminal path (completed, failed, cancelled, worker death, dispose) the runner builds one row per declared gate from the manifest plus the store records (`fired-pass`, `fired-block`, `skipped`, `not-reached`, `never-evaluated`) and ends the run in the store.
- **Resume.** Reads the store only. A node is skipped only when it succeeded, its output is recoverable (full output or its spill), and everything it depends on is also skipped. It refuses, with the node named, when a successful node that changes the workspace (bash, loop, or a prompt marked `mutatesCheckout`) has no recoverable output, and also when such a node succeeded but a node it depends on has no recoverable output (it would have to run a second time). Pending approvals are re-created when the resumed run reaches them.
- **Optional engine.** `ctx.workflowEngine` is not injected: a composition without it (the web preset) still mounts the runner (the `workflow_run` tool is registered only once the engine appears, so the model's tool layer stays empty), `dryRun` and the reads work, and `start` is refused with `RUNNER_UNAVAILABLE` before any trust or run record is written.
- **UI controls.** `attachUi()` is the explicit human-present signal (it returns a disposer; subscribing never counts), `cancel(runId, reason, scope)` takes a `CancelScope` (workspace, and session when given) and answers a run outside it exactly like an unknown run, and `dryRun(workspace, options)` takes `DryRunOptions` (`name`, `path`, `inputs`, `caller`) and, for untrusted content, returns a single-use `trustChallenge` (five minutes, bound to the caller, workspace and trust key; at most four open per caller) that `start` requires together with `trustHash`. Content that is already trusted ignores both.
- **Session records.** Through the recorder exported by [`@deepseek-ai/dsh-tool-workflow`](../tool-workflow/README.md): `tool-workflow/run-start`, `agent-start`, `agent-end`, `node-start`, `node-end` (with `truncated`, the real `attempts`, and a `failure` code when the watchdog or deadline stopped the agent), `approval` (pending and every decision, reason control-stripped and capped at 500 characters), `gate-report`, `run-end`, all log-only and keyed by the store run id. These are legal between turns, so an idle parent agent records them without an open turn.
- **Node failure reasons.** A prompt node whose agent the supervisor stopped fails with a coded reason instead of "the agent did not complete": `NODE_STALLED` (no output inside `idle_timeout_ms`; the message names the window and the retry count; remedy: raise `idle_timeout_ms` for this node or check the agent's output) or `NODE_TIMEOUT` (the hard `timeout_ms` limit passed; remedy: raise `timeout_ms` or split the node). The code and message reach the node record (`error`, with `attempt` set to the real attempt count and earlier attempts closed as failed), the run result's node line and reason, the gate report row and the `tool-workflow/node-end` event (`failure`, `attempts`). "The agent did not complete" is kept for a child that ended on its own without finishing.

## Config

| Key | Default | Meaning |
|---|---|---|
| `toolName` | `workflow_run` | The model-facing tool name. |
| `exposeTool` | `true` | False mounts only the `ctx.workflowRuns` service (for the Workflows UI) and registers no model tool; the web composition sets it at the global layer and mounts the tool in the `standard` preset. |
| `workflowsDir` | `.workflows` | Workspace-relative directory holding `<name>.yaml` files; must stay inside the workspace. |
| `approvalWaitMs` | `3600000` | Longest an approval waits (1 to 86400000 ms) before it expires and the node is rejected. |
| `headless` | `false` | True when no human can answer: approval nodes are rejected immediately with a reason and remedy. |
| `trustPolicy` | `ask` | `ask` confirms an unseen hash once; `never` refuses any unconfirmed hash. |
| `tierModels` | `haiku` / `sonnet` / `opus` | Model for the `cheap`, `standard` and `premium` tiers; a denied model family fails the plugin at startup. |
| `retention` | `200` | Finished runs kept per workspace before the oldest are pruned. |
| `dshHome` | `$DSH_HOME`, else `~/.dsh` | Harness home holding the run store. |
| `maxResultChars` | `50000` | Ceiling of the rendered tool-result text. |

## Model Experience

### workflow_run tool

#### What the model sees

The tool schema plus the description below. A completed run returns a status line, a node table and a gate report; a failed or cancelled run returns the same text as an error. Refusals (writer busy, untrusted hash, resume refused, bad inputs) state the reason and the remedy.

##### Tool description and guidance

```markdown
Run a workflow defined as a YAML file in the workspace workflows directory (default `.workflows/<name>.yaml`). A workflow is a graph of nodes (`prompt`, `bash`, `loop`, `approval`, `cancel`) with dependencies, optional `when` conditions, retries, and hard gates (verifier, bash, approval, done_when, until_bash). Use it only when the user asks to run a named workflow, or when a workflow file already exists for the task.

Exactly one of these selects what to do:
- `name`: the workflow file name without `.yaml` (lowercase words joined by hyphens). `path` is an alternative: a workspace-relative path to a `<name>.yaml` file inside the workflows directory.
- `resume`: a run id. Starts a new run from that run's pinned source and skips nodes that already succeeded with recoverable output. It refuses, with a reason, if a successful node that changes the workspace has no recoverable output, or depends on a node that has none.
- `cancel`: a run id owned by this process. Cancels it.

Other arguments: `inputs` (object, values for the workflow's declared inputs; unknown or missing required names are rejected before anything runs) and `dryRun` (true returns the graph, the gate manifest and every shell command the workflow would run, and starts nothing).

A run is foreground: the call returns when the whole workflow finished. The result is a status line, a node table and a gate report (one row per declared gate: fired-pass, fired-block, skipped, not-reached or never-evaluated). Only one run per workspace may be active; a second start is refused and names the holder. The first run of an unseen or edited workflow asks the user to confirm the shell commands. Approval nodes wait for a human answer (up to the configured cap) and are rejected at once when the session is headless or approvals are disabled, with a reason in the report. The run is pinned to the file content at start, so editing the file during a run changes nothing about that run. Compile or validation errors come back as located `line:column` diagnostics: fix the YAML and call again.
```

#### Token effect

A fixed schema and description cost on each request where the tool is visible (about 2 KB of description). Results are capped at `maxResultChars` and stay in context until compaction.

#### KV Cache effect

Prefix-stable while the tool name, definition and visibility are unchanged. Results are append-only and do not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- **Foreground only** — the call blocks until the workflow settles; there is no background start and poll API.
- **One active run per workspace** — enforced by the store writer lock; a second start is refused, not queued.
- **`ctx.shell` does not stream** — output sinks receive one chunk when a command finishes, so a long command shows no partial output.
- **Agent node output is recorded at the end of the run** — the engine does not forward it per node, so a run that dies early leaves agent outputs unrecoverable: a mutating one then blocks resume, a non-mutating one is re-run.
- **Trust facts live in `trust.json`** beside the store because the store has no trust record kind.
- **`mutates_checkout` is author-declared** for prompt nodes; resume idempotence is a convenience, not a security boundary.
- **The Fable model check is a cost guard, not a security boundary** — the worker-thread host refuses a node whose final model id or catalog name names the Fable family; it does not defend against a provider that hides the family behind an unrelated name.
- **Headless bundle** — the headless bundle sets `headless: true` for this tool, so approval nodes reject at once there.
- **Gate rows in the store have no reason field** — the reason is in the approval record, the session gate-report row and the tool result.
- **Remote RPC and the Workflows UI wiring** are separate slices; this package exposes the service API they call.
- **Idle parent** — verified: the real worker-thread engine and spawn provider run a workflow whose parent agent has no open turn, and the recorder appends to that idle session without tripping the session invariant. Only the chat approval mirror needs an open turn, so it is skipped when there is none.

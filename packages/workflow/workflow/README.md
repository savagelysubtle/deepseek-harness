# @deepseek-ai/dsh-workflow

English | [中文](README.zh.md)

The workflow seam (`ctx.workflowEngine`) executes a model-written orchestration script that can fan out subagents. The seam defines the script, run, result, error, and event contracts; an engine decides how to isolate and execute the script.

`@deepseek-ai/dsh-workflow-worker-thread` is the current engine and `@deepseek-ai/dsh-tool-workflow` is the model-facing consumer. A future process or sandbox engine can replace the implementation without changing the tool.

The package root is the Host face. The browser-safe `@deepseek-ai/dsh-workflow/types` subpath contains run identities, metadata, results, and observe-only lifecycle payloads without importing `Agent`, Cordis services, or Host context declarations; Host-only `WorkflowStartRequest` and `WorkflowRun` live behind the package root.

## Service and run contract

`WorkflowEngine.start(request): WorkflowRun` validates enough synchronously to reject a malformed meta block, unparseable script, unavailable provider route, or unsupported per-run limit before a run exists. Once returned, `WorkflowRun.result` never rejects: execution failures resolve with `stopReason: 'error'`, and cancellation resolves with `cancelled` within the engine's bounded grace.

A run is holder-owned. Engine-plugin unload prevents new starts but does not revoke accepted runs. The holder must call `dispose()` on every path; disposal cancels remaining work and reaches or abandons quiescence within the documented bound.

`WorkflowStartRequest` contains `{ meta, script, args?, subagentProvider?, maxTotalAgents?, parent, signal?, cwd?, bashEnabled?, approver?, bashExecutor?, onBashOutput?, tierModels?, gateManifest?, supervisor? }`. `parent` attributes every child agent to the invoking agent. `subagentProvider` optionally routes every child in that run without exposing provider choice to the script; omission uses the engine's configured provider. `maxTotalAgents` optionally lowers the engine's deployment ceiling for one run and is likewise invisible to the script. An implementation rejects invalid routes and limits synchronously. `meta` and `args` are plain data, not script fragments.

`WorkflowRun` exposes `{ id, meta, result, cancel(reason?), dispose() }`, plus the optional `pendingApprovals()` and `decideApproval(approvalId, outcome)` for engines that support `approve()`. `WorkflowResult` contains `{ value, stopReason, error?, agentsStarted }`; `value` is plain JSON data or `null`.

## Host hooks: bash, approval, supervision

These extend the seam for compiled, owner-vouched workflows; none of them is available to an ordinary `workflow` tool script unless the owner opts in.

- **`bash()` is opt-in.** `bashEnabled: true` turns on the `bash()` hook and the `agent()` `doneWhen` option; otherwise both throw `UNSUPPORTED_OPTION`. Commands run host-side through a `WorkflowBashExecutor` (default `createLocalBashExecutor()`: `bash -c` in its own process group, tree-killed on abort, timeout, cancel, worker death, or dispose; credential-shaped and `DSH_*` variables are not inherited). Upstream node outputs reach a command only as `WF_<NAME>` environment variables (`inputs`), never spliced into the command text. `env` names are screened against a denylist (`PATH`, `HOME`, `SHELL`, `TMPDIR`, `NODE_OPTIONS`, `BASH_ENV`, `IFS`, `LD_*`, `GIT_*`, `DYLD_*`, `SSH_*`, `GPG_*`, `DSH_*`, proxy, CA-bundle and shell-history names and similar; `WF_*` names are allowed because node outputs arrive that way); the worker checks it and the host checks it again. `workdir` is relative, `..` is refused, and the host contains its realpath under `cwd`. stdout and stderr are each kept to the last `WORKFLOW_BASH_OUTPUT_CAP_BYTES` (64 KB) in memory with a `truncated` flag; every chunk is also passed to `onBashOutput` so the caller can spill what the cap dropped.
- **`approve()` goes through an injected `approver`** returning `allowed-once`, `rejected`, `cancelled` or `unavailable`. No approver, a throwing approver, or a rogue return value all answer `unavailable` (fail closed). Each question gets a fresh 128-bit random `approvalId`; `decideApproval()` compares ids in constant time and the first decision wins by a synchronous compare-and-set (a second answer returns `already-decided`). Aborting the run settles every open question `cancelled`.
- **Nodes and gates.** `workflow/node-start`, `workflow/node-end` and `workflow/gate` carry node identity, status and gate outcomes (never command output). A node declares a gate with `nodeStart(id, kind, { gate })`. On every terminal path (completed, error, cancelled, worker death, grace force-settle) the engine synthesizes the missing `node-end` (`cancelled` after a cancel, otherwise `interrupted`) and the missing `gate` (`not-reached` for a node cut off mid-flight, `never-evaluated` for one that ended without evaluating it), marked `synthesized: true`, before `workflow/end`.
- **Child supervision and done-when.** `WorkflowChildSupervisor` is the plug-in point for a stall watchdog and a done-when evaluator: `register` fires before the provider start (the child session id does not exist yet), `bind` fires once published with the id that equals that child's `subagent/start` id, `evaluate` may return failure evidence, and `release` ends supervision. Evidence starts a fresh child whose prompt carries the labelled evidence; the engine enforces the cap (default 3, ceiling 8) and an exhausted child fails with `stopReason: 'done-when-exhausted'` and the last evidence. This is an engine loop, so no `turn-stop` listener is registered and the hooks bridge is never steered twice.

## Events

Workflow events are observe-only. They carry `WorkflowRunInfo` (`id` plus `meta`) rather than the live run, so listeners cannot acquire cancellation or disposal authority.

- `workflow/start` / `workflow/end` pair the run.
- `workflow/phase` and `workflow/log` expose script narration.
- `workflow/agent-start` / `workflow/agent-end` pair each child call by `seq`; a child whose async provider start rejects emits neither.
- `workflow/node-start` / `workflow/node-end` pair each node by `nodeId`, and `workflow/gate` reports each declared gate; the engine synthesizes any missing end or gate on every terminal path. `workflow/node-end` may also carry `attempts` (the real number of agent attempts the node ran, retries included) and `failure` (`{code, message, remedy}`, set only when the child supervisor stopped the node's agent: `NODE_STALLED` for no output inside the idle window, `NODE_TIMEOUT` for the hard per-node limit). Both are optional; a node that merely did not complete carries neither.

Same-process event payloads are borrowed immutable values. Every listener is independently contained: a synchronous throw or rejected returned promise is logged without starving peers or changing execution.

## Failure discipline

`WorkflowError` carries a code and a `fatal` flag. Fatal errors always escape `parallel()` and `pipeline()` instead of becoming an ordinary per-item `null`:

- `SCRIPT_PARSE` / `META_INVALID` — the workflow cannot start.
- `INVALID_ARGUMENT` / `UNSUPPORTED_OPTION` / `UNSUPPORTED_SCHEMA` — a hook call violates the engine contract.
- `AGENT_CAP` / `ITEM_CAP` — configured safety limits were exceeded.
- `AGENT_START` — the provider's async start rejected.
- `AGENT_RESULT` — a published child's result rejected with an infrastructure fault.
- `BASH_FAILED_INFRA` — a `bash()` command could not be spawned or contained (a command's own non-zero exit is a normal result).
- `RESULT_UNSERIALIZABLE` — a script/worker value is not plain JSON data.
- `CANCELLED` — cancellation owns the run and pending/future hooks reject.

A child that resolves normally with a non-completed stop reason is not an infrastructure exception: `agent()` returns `null`, allowing the script to handle an ordinary child failure.

## Model Experience

Indirectly, through `dsh-tool-workflow` and a workflow engine, which create child-agent requests and return a retained parent tool result.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Foreground collection only** — the caller owns one live run and awaits it; background start/poll, spill handles, and detached collection are deferred.
- **No journaling or resume** — scripts, child progress, and intermediate values are not checkpointed, so a process restart cannot continue a run.
- **No saved or nested workflows** — the seam starts caller-supplied scripts only, and a workflow script receives no `workflow()` hook for recursive orchestration.
- **No token-budget vocabulary** — engines cap concurrency, items, and children, but neither the request nor result accounts for model tokens across children.
- **`bashEnabled` is not a security boundary** — it only decides whether the hooks exist. A hostile script that escapes `node:vm` can reach Node directly, bash or no bash.
- **The built-in bash executor is not a sandbox** — it runs with the host process's authority and inherits `SSH_AUTH_SOCK`; a deployment that needs the sandboxed shell injects its own `bashExecutor`.
- **Continuation children count toward `maxTotalAgents`** and are not announced — a done-when iteration starts a fresh child under the same `agent()` call, so `workflow/agent-start` names only the first child.
- **A script `cancel()` sweeps as `interrupted`** — the stranded sweep reports `interrupted`, not `cancelled`, for nodes open when the script itself cancels.
- **Runs are holder-owned, not service-tracked** — unloading the engine does not discover independent live handles; every consumer must dispose the run it started.

See the [dynamic-workflows Agent Note](../../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md) for the deferred workflow API.

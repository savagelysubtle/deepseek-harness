# @deepseek-ai/dsh-workflow-worker-thread

English | [中文](README.zh.md)

This package implements `WorkflowEngine` with one Node worker thread per run. The worker executes the orchestration script; child agents remain on the host and are reached through `ctx.subagents` over a typed host/worker protocol.

The package root exports the default engine plugin and its `Config`; the worker protocol, runtime, and session modules stay private to the implementation. The operational `./worker` entry remains the engine's spawn target.

The split has one primary purpose: a synchronous script loop cannot block the harness event loop, and a script that ignores cancellation can be terminated with its worker. It is not a security sandbox.

## Trust and isolation boundary

Workflow scripts are model-written and have the same trust premise as the model's existing bash access. `node:vm` inside a worker is an API-shaping mechanism, not a security boundary: an escaped script can recover Node capabilities with the host process's privileges.

The worker still provides useful containment:

- Script CPU work and synchronous spins stay off the host event loop.
- `worker.terminate()` gives disposal a real final stop.
- The worker starts with an empty environment, except unbuilt loader plumbing, so ambient credentials do not cross through `process.env`.
- Host/worker messages use structured-clone data, with plain-JSON validation at the script boundary.

A genuinely untrusted-script sandbox would require a different engine behind the same workflow seam.

## Script contract

The workflow's `meta` is host-provided data, not evaluated script text. The engine validates its required `name` and `description`, rejects unknown fields, and parse-checks the body before returning a run.

Inside the worker, the script receives `args` and these hooks:

- `agent(prompt, { label, phase, schema, model })` starts one host-side subagent. With a schema it returns the structured value; otherwise it returns final text. An ordinary failed child yields `null`.
- `parallel(thunks)` runs thunks under the configured concurrency limit.
- `pipeline(items, ...stages)` passes `(previous, item, index)` without a cross-stage barrier.
- `phase(title)` and `log(message)` emit observer narration.
- `bash(command, { nodeId, workdir, timeoutMs, env, inputs, retry })` runs a host-side command and returns `{ exitCode, signal, timedOut, aborted, stdout, stderr, truncated, stdoutBytes, stderrBytes, durationMs }`. It exists only when the owner started the run with `bashEnabled: true`. `env` may carry `WF_*` node-output variables; `retry: { maxAttempts, delayMs }` is applied by the engine and re-runs only a command whose timeout fired.
- `approve({ nodeId, message, timeoutMs })` returns the outcome string: `allowed-once`, `rejected`, `cancelled` or `unavailable`. The wait is capped at one hour; expiry rejects.
- `cancel(reason)` cancels the run and throws the engine's `CANCELLED` error.
- `nodeStart(nodeId, kind, { gate })`, `nodeEnd(nodeId, { status, exitCode, durationMs, truncated, output, error })` (`output` is accepted but never put in an event) and `gate(nodeId, gateKind, outcome)` report node progress; node ids match `^[a-z0-9_-]{1,64}$`.
- `agent()` also accepts `nodeId`, `tier` (resolved through `tierModels` when no `model` is given), `timeoutMs`, `idleTimeoutMs` (both enforced by the child supervisor), `retry: { maxAttempts, delayMs }` (the engine re-runs only a start failure or a child that stopped as `timeout` or `stalled`; each attempt is a separate paired agent call) and, with bash enabled, `doneWhen: { command, workdir, timeoutMs, maxContinuations }`; `evidence(nodeId)` returns the last exhausted done-when evidence for a node, else `null`.

Unknown options, malformed arguments, unsupported schemas, tripped caps, provider-start failures, and infrastructure result failures are fatal workflow errors. No timers, filesystem API, or Node globals are intentionally injected, though the trust caveat above still applies.

## Run sequence

`start()` validates meta, parses the body, resolves a registered normalized provider route, and resolves any per-run total-child cap before creating a worker or publishing `workflow/start`. A requested `maxTotalAgents` must be a positive safe integer no greater than the engine's configured deployment ceiling. Source mode installs TypeScript transforms through a data-URL bootstrap; built mode passes sibling `lib/worker.cjs` as a filesystem path because pkg's VFS hook expects CommonJS. Both work under ordinary Node. A ready/go handshake prevents a start-signal cancellation racing worker boot from executing the script's initial synchronous slice.

For each `agent()` call:

1. The worker sends `child-start` with a plain-data prompt and options.
2. The host calls the start request's provider override, or otherwise the configured provider, through async `SubagentRuntime.start`, passing the workflow's parent and one canonical per-run abort signal. Provider choice applies to every child in that run and is not visible to the script.
3. If start rejects, the host sends `child-start-error`; provider startup has already reached quiescence and no child lifecycle event is emitted.
4. If start fulfills while the workflow still admits work, the host records the run, observes `result`, then sends `child-started`. Even an already-settled result is forwarded afterward, preserving start-before-result order.
5. The worker emits paired `workflow/agent-start` and `workflow/agent-end` narration and requests child disposal after collection.

Provider starts are tracked separately from published children. If cancellation, worker death, or normal workflow settlement closes admission while a start is pending, the shared signal aborts it. A provider that nevertheless fulfills after closure is disposed by the host and never announced to the worker.

## Host hooks and seams for the supervisor

`bash()`, `approve()` and the node observers are protocol RPCs (`bash-start`/`bash-result`/`bash-error`, `approve-start`/`approve-result`, `node-start`, `node-end`, `gate`); the worker itself runs no command (the host's executor does). The host re-validates every `bash-start` (denylist, `WF_` mapping, size limits, workdir realpath containment under `WorkflowStartRequest.cwd`) before the executor runs, and tracks each command and each open approval as pending host work, so disposal waits for the process group to die. The abort signal shared with children also tree-kills every running command and settles every open approval `cancelled`.

The stranded sweep (`endStrandedNodes`) runs on every terminal path beside `endStrandedAgents`, so `workflow/node-end` and `workflow/gate` are paired before `workflow/end`.

`WorkflowStartRequest.gateManifest` (`{ nodeId, gateKind }[]`, the authority for which gates exist; one node may owe several, tracked per kind, and a worker's `nodeStart` cannot add or change them) pre-declares the compiled workflow's gates so a gate on a node that never started is reported `not-reached` on every terminal path.

Seams left for the supervisor, all on `WorkflowStartRequest` and implemented by `WorkerRun` in `host.ts`:

- `supervisor.register(child)` runs inside `startChild` before `subagents.start`; the session id is unknown, so key by `callId`.
- `supervisor.bind(child, childId)` runs once per published child and again for each continuation iteration; `childId` equals that child's `subagent/start` `info.id`, which is the correlation point for a stall watchdog.
- `supervisor.evaluate(child, outcome, tools)` runs after each child result when `doneWhen` is set. Return failure evidence to continue, `undefined` to accept. `tools.runBash` is validated, contained and abort-linked like a script's `bash()`. The engine owns the loop: it clamps the cap (default 3, ceiling 8), stamps `iteration` and `maxContinuations`, clamps the tail to 8192 characters, composes the next prompt (`composeContinuationPrompt`, evidence labelled as untrusted data) and starts a fresh child. Exhaustion returns `stopReason: 'done-when-exhausted'` with `continuation.evidence`.
- `supervisor.release(child, childId)` fires once per child on settle, dispose, or refusal.
- `onBashOutput` receives every command output chunk for the run store's spill.
- `approver` is the store-backed broker's plug-in; `WorkerRun.pendingApprovals()` and `decideApproval()` serve a UI that answers outside the approver.

A throwing `register`/`bind`/`release` is logged and ignored. A throwing or refusing `evaluate` (including a done-when check refused by the bash budget or concurrency limit) counts as a FAILED check with the tail `done_when check could not run: <reason>`, so the normal continuation and cap path applies and exhaustion fails the node with that evidence; it is never accepted as "no opinion". A `doneWhen` request with no evaluating supervisor (only possible when a caller installs one without `evaluate`) is refused loudly (`child-start-error`), never silently accepted. This package registers no listener on the agent turn-stop event; a test scans the sources to keep it that way.

`createWorkflowChildSupervisor(options)` is the default supervisor (`WorkflowStartRequest.supervisor` replaces it). It enforces `timeoutMs` as an absolute deadline (`handle.stop('timeout')`) and `idleTimeoutMs` as a stall watchdog (`handle.stop('stalled')`): a plain `setTimeout` rearmed on every append to the child's session log (the host forwards `session/event` for the bound child id) and paused while a tool call is in flight (`tool/call` opens it, `tool/result` closes it, matched by `callId`). It does not reuse the iterator-bound `idleWatchdog`. `evaluate` runs the `doneWhen` command through `tools.runBash` and reports a non-zero, timed-out or aborted check as failure evidence (stdout then stderr as the tail); the engine's loop owns the cap. `bind` without a prior `register` throws a clear error (the host logs it and the child runs unsupervised); `release` is idempotent and clears both timers and the subscription. With no `observe` feed only the deadline runs. A child whose script gave no `timeoutMs` gets a default absolute deadline of one hour (capped at 24 h), so nothing runs unbounded. Once a child's result is in hand, `evaluate` stops both timers before the done-when check runs. A done-when check counts against the same 8-concurrent / 1000-per-run `bash()` limits as a script's `bash()`. A remote run, whose appends never reach this process, is deadline-only (the stall watchdog is off).

## Value boundary

Values leaving the script pass through `materializeFromRealm`, which accepts plain, lossless JSON data and rejects exotic prototypes, functions, symbols, cycles, sparse arrays, non-finite numbers, and nested `undefined`. The walk runs in the worker, and defines object keys as data properties so `__proto__` cannot mutate a prototype.

Child results are projected and snapshotted before crossing from the host to the worker. This is a real process-like serialization boundary; it is deliberately different from trusted same-process workflow and subagent event payloads, which are borrowed immutable values.

## Cancellation and disposal

`WorkflowRun.cancel()` records the first reason, tells the worker to cancel, aborts the one signal shared by every pending and published child, and arms the `disposeGraceMs` timer. Worker hooks then throw `CANCELLED` at their next await. If the run remains unsettled at the deadline, the host resolves it as cancelled, pairs stranded child lifecycle events, and terminates the worker.

The subagent seam has one cancellation channel: the request signal. There is no separate child-cancel RPC. Published child teardown uses `run.dispose()`; pending provider starts remain provider-owned until their promise rejects or fulfills.

Normal settlement also aborts pending starts and begins disposing any published fire-and-forget children before the result becomes externally settled. The host's quiescence condition includes both pending starts and published child disposals, so cleanup does not forget an async startup transaction.

`dispose()` is idempotent. It cancels the run, starts host-driven disposal immediately, waits for result plus child quiescence up to the same grace, terminates the worker unconditionally, and performs a final survivor sweep. Per-child disposal is memoized so worker RPC, host cancellation, death cleanup, and public disposal all join one operation.

## Outcome and event guarantees

Terminal outcome is first-wins at host claim points. An accepted external cancellation overrides a later non-cancelled worker result; a result or worker death that claims first cannot be rewritten by reentrant cleanup callbacks.

Worker error, message failure, or premature exit closes message admission before cleanup, then resolves `error` unless cancellation already owns the run. Late queued messages cannot create children or narrate after that logical boundary.

The host keeps a ledger of forwarded child starts. A graceful worker supplies their ends; death or force termination synthesizes any missing end as cancelled. Every forwarded `workflow/agent-start` is therefore paired exactly once, although cleanup after an already-arrived workflow result may complete afterward.

## Config

| Key | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | Host-side subagent provider used by `agent()`. |
| `maxConcurrentAgents` | `0` | Concurrent `agent()` ceiling; `0` resolves from available CPU parallelism. |
| `maxTotalAgents` | `1000` | Total `agent()` calls in one run. |
| `maxItemsPerCall` | `4096` | Items accepted by one `parallel()` or `pipeline()` call. |
| `syncTimeoutMs` | `5000` | VM timeout for the script's initial synchronous slice. |
| `disposeGraceMs` | `5000` | Bound before force-settlement/termination and for public disposal. |

Bash limits are fixed constants rather than Config: 64 KB captured output per stream, 120 s default and 600 s ceiling timeout, 128 KB per environment variable and 256 KB in total.

An owning consumer may set `WorkflowStartRequest.subagentProvider` and `WorkflowStartRequest.maxTotalAgents` for one run. These are engine-level policy, not script hooks or model-facing options; the ordinary `workflow` tool leaves both unset. A per-run total-child cap may lower but never raise the configured `maxTotalAgents` ceiling.

## Model Experience

### Child-agent requests

#### What the model sees

Every script `agent()` call sends its prompt verbatim and optional model or structured-output schema to a subagent provider. Each child sees that provider's own context; phase and log narration stays on observer events.

#### Token effect

Potentially many independent child contexts are paid, bounded by `maxConcurrentAgents`, `maxTotalAgents`, and `maxItemsPerCall`; they never join the parent history directly.

#### KV Cache effect

Independent of the parent request cache and of sibling children. Each child can reuse only a byte-identical prefix under its own provider, model, prompt, and schema; its later history grows append-only.

### Parent tool result, indirectly

#### What the model sees

Through [`dsh-tool-workflow`](../tool-workflow/README.md), success exposes only the materialized final JSON value and child count in that consumer's wrapper. This engine supplies stable errors including `workflow script does not parse: <error>`, `invalid meta: <violations>`, `agent() requires a non-empty prompt string`, `agent() could not start a child: <error>`, `child agent run failed: <error>`, and its exact `parallel()`, `pipeline()`, `phase()`, option, schema, and JSON-boundary validation messages. Intermediate child outputs are available to the script but not the parent model.

#### Token effect

Zero direct parent tokens from this engine. Final result size is capped by the tool consumer and retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **`bashEnabled` is not a security boundary** — it only decides whether the hooks exist; a script that escapes `node:vm` reaches Node whether or not bash is on.
- **The default executor runs with host authority** — it inherits `SSH_AUTH_SOCK` and the host user's reach.
- **Continuation children count toward the agent cap** (`maxTotalAgents`).
- **A script `cancel()` sweeps as `interrupted`**, not `cancelled`.
- **Host volume caps** — 8 concurrent and 1000 total `bash()` calls, 16 pending and 1000 total approvals, 1000 nodes, 10000 node/gate events and 200000 worker messages per run; a flood ends the run with an error. `supervisor.bind` receives a handle whose `stop('timeout'|'stalled')` settles the child so engine `retry` can fire.
- **The worker/vm is not a security boundary** — model-written code can escape `node:vm` and reach the worker's process authority; a hostile-code deployment needs a separate-process or container engine.
- **The Fable model check is a cost guard, not a security boundary** — before a child agent starts, the host refuses the node when its final model (explicit, tier-mapped or inherited) or the catalog name that id resolves to names the Fable family; a provider that hides the family behind an unrelated name is not caught.
- **One worker thread is paid per run** — there is no pool, warm runtime, or cross-run script cache.
- **No ambient timers, filesystem, or network are injected, but escaped code can still reach Node** — the missing globals are portability API, not containment.
- **Bash children that start their own session survive** — the process group is tree-killed, but a descendant that calls `setsid` or double-forks out of the group is not tracked, and a host crash can orphan children (the run store's interrupted-run sweep must say "may be orphaned", not "killed").
- **`approve()` without an approver answers `unavailable`** — the engine never prompts by itself; the owner must inject the broker.
- **Continuation children appear only to the supervisor** — script-side `workflow/agent-*` events name the first child of an `agent()` call.
- **Termination can only report host-observed starts** — `agentsStarted` excludes worker-side calls still queued behind concurrency when a forced termination makes them unknowable.
- **Cross-realm errors fail `instanceof Error` inside scripts** — workflow authors must branch on stable fields such as `name` and `code`.

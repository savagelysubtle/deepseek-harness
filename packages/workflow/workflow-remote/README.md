# @deepseek-ai/dsh-workflow-remote

English | [中文](README.zh.md)

Permanently-mounted Typert Remote namespace `workflow` that the Workflows UI talks to (OP-240). `WorkflowRemoteService` registers the `workflowRemote` service and publishes its methods under the `workflow` namespace; the wire contract lives in `src/wire.ts` (exported as `./wire` and re-exported from the package root), and the Typert generator emits the `./typert` and `./remote` artifacts from this package.

It is its own package, mounted by its own Loader entry in [`packages/bundle/web-app/cordis.patch.yml`](../../bundle/web-app/cordis.patch.yml), for the same reason as [`@deepseek-ai/dsh-mcp-status`](../../mcp/mcp-status/README.md): a package's RPC contract is withdrawn when its last Loader entry unloads and the Gateway never falls back, so the namespace must not ride on a package that can unload. Reads are unprivileged (`list`, `read`, `validate`, `dryRun`, `runs`, `runDetail`, `pendingApprovals`); writes and raw node output are privileged (`save`, `run`, `resume`, `cancel`, `nodeOutput`, `approve`, `reject`, `attachUi`, `detachUi`) and are listed in `PRIVILEGED_METHODS` of [`@deepseek-ai/dsh-connection`](../../client/connection/README.md), so only a caller whose TCP peer address is loopback (and whose Host header is loopback) reaches them; `X-Forwarded-For` is never consulted. Every method resolves the caller's workspace from its session, validates every argument, and returns `{ ok: true, ... }` or a plain failure with no stack and no host path. `save` checks containment under the workspace `workflows/` directory, refuses symlinks, writes atomically, and compares an optimistic content token. `run` and `resume` need the trust challenge that `dryRun` issues for the caller (single use, five minutes); `run` re-reads the current file and refuses a plan whose content has since changed, while `resume` runs the pinned copy stored with the run, not the live file. `attachUi` and `detachUi` hold a renewable lease that tells the runner a human is present. `cancel` only stops a run that the calling session itself started. Pushed events carry ids and statuses only and no host path: `workflow/run-changed` (`WorkflowRunChange`), `workflow/approval-pending` (`WorkflowApprovalPending`: run, approval and node ids, never the question text, which `pendingApprovals` returns) and `workflow/approval-decided` (`WorkflowApprovalDecided`). Each also carries an opaque `workspaceKey`, the same value that `list`, `runs` and `attachUi` return, so a client ignores events of other workspaces. A save whose folder flush fails after the publish still succeeds and carries a `warning`.

## Call shapes

Browser code imports the contract from `@deepseek-ai/dsh-workflow-remote/client` (types, constants, `WORKFLOW_LOOPBACK_ONLY_MESSAGE`, `explainWorkflowRefusal`, `explainWorkflowRejection`, the lease timings); it re-exports `src/wire.ts` only, which has no value imports (one erased type-only import anchors the cordis event augmentation), so no Host module is reachable from it. The Remote face wraps every method result once more, so a call has three possible outcomes:

- **Success** is `RemoteResult<{ ok: true, ... }>`, for example `{ ok: true, value: { ok: true, leaseId: 'ab12...', ttlMs: 45000, workspaceKey: '0f3a...' } }`.
- **A Host-reported failure** is `{ ok: true, value: { ok: false, error: 'NOT_FOUND', message: '...' } }`; the machine-readable field is `error` (a `WorkflowErrorCode`), never `code`. `validate` reports a bad draft as `{ ok: false, diagnostics }` without `error`, so `error` is what separates a failed call from a verdict.
- **A carrier failure** (a 403 on a privileged method, a network fault) is `{ ok: false, error: { message: '... HTTP 403 ...' } }`, or a rejection, and is not a `WorkflowFailure`. Pass either to `explainWorkflowRejection('workflow/save', cause)`: it returns `WORKFLOW_LOOPBACK_ONLY_MESSAGE` for a 403 on a privileged endpoint and `undefined` otherwise.
- **`runDetail` nodes** are one row per attempt. The highest-attempt row of a node may also carry `attempts` (the real count, only when more than one) and `failure` (`WorkflowNodeFailure`: `NODE_STALLED` or `NODE_TIMEOUT`, the bounded message, and a fixed remedy). `failure` is read from the node record exactly as `tool-workflow-run` persisted it (message and remedy each bounded to 500 characters); there is no parsing of the error text and no remedy table, so a record written before the field existed, and a node that ran no agent, carry neither field.
- **`validate` takes no session argument:** its request is `{ text, name? }`, and every other method resolves its workspace from the calling session.

## Model Experience

None, as this Host-only Remote service registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Loopback is not authentication** — the privileged set is refused to LAN callers with a bare 403; `explainWorkflowRefusal` supplies the founder-facing explanation on the client side.
- **No caller authentication behind loopback (pre-existing gap)** — the privileged set, here and for `settings.*`, `credentials.*` and the rest, is guarded only by the loopback peer and Host checks. A model with a shell on the host can call these endpoints itself, so it can confirm its own trust challenge or approve its own approval; the bash-tool approval answer is equally unguarded today. Closing this needs a caller-auth token the model cannot reach; it is not invented here.
- **Events are not scoped host-side** — the Host event stream has no per-subscriber workspace filter, so every connected client receives run and approval ids of every workspace; `workspaceKey` lets the client filter, it does not hide them.
- **Cancel is per session** — a run can be cancelled only by the session that started it; another session in the same workspace sees it as not running.
- **Leases lapse** — a UI lease expires after 45 seconds without renewal, after which approvals fall back to the model path.
- **Web-app bundle** — the workflow engine is disabled there, so runs report unavailable.

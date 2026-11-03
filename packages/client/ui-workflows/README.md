# @deepseek-ai/dsh-client-ui-workflows

English | [中文](README.zh.md)

Browser **Workflows** surface for YAML workflows (OP-240). The browser plugin registers one localized button, id `workflows` at order 45, in the conversation session header's `conversation.session.header.actions` list (after the Org Board), and one `shell.overlay` entry with the same id. Pressing the button opens the overlay for that session; every call goes to the Host's `workflow` Remote namespace served by [`@deepseek-ai/dsh-workflow-remote`](../../workflow/workflow-remote/README.md), reached through [`api-remotes`](../../api/remotes/README.md) as that session, so the workspace is always the session's own. The plugin waits specifically on `remote.workflow`.

## What the overlay does

- **Workflows tab.** Lists the workspace's workflow files with a valid/invalid mark, node and diagnostic counts and the last run. Opening a file reads it with its save token and validates it (debounced, on demand, and after every load). *New workflow* seeds a template and saves it with `expectedToken: null`.
- **Editor.** The in-house `WorkflowEditor` (textarea, line gutter, clickable diagnostics). Save sends the token the file was loaded with. A lost race (`CONFLICT`) raises the editor's conflict state and shows the Host's message and remedy; **Reload** re-reads the file and discards the unsaved edit, which the banner says. A save that succeeded but could not flush the folder shows the Host's `warning` as a visible *Saved, with a warning* notice and is treated as saved. A file that could not be read shows its failure, not an empty editor.
- **Dry-run and trust.** Dry-run and Run both open the plan for the *saved* file (unsaved edits ask to be saved first): the execution order, a dependency graph drawn from the Host's layout, the gate manifest, every shell command verbatim (working directory and the names of environment variables it sets), agent nodes, prompt files and warnings. Declared inputs get a small form; changing one marks the plan stale until it is refreshed. A trusted plan runs directly. An untrusted plan shows the Host's exact `confirmText`, and *Trust and run* stays disabled until the acknowledgement box is ticked. The acknowledgement belongs to that exact plan (its `trustKey`, challenge and text): any new dry-run, edit, save, input change, spent challenge or closing the plan clears it, and the controller itself refuses to run without it. An untrusted plan the Host sent no `confirmText` for cannot be run (*refresh the plan*). The run carries `trustHash` (the plan's `trustKey`) and `trustChallenge`. The challenge is single-use: a refused untrusted start marks the plan spent and asks for a refresh. Starting a run opens it in the Runs tab.
- **Runs tab.** Pending approvals (with *Approve* and *Reject* plus an optional reason, offered only while the live-approvals lease is attached; otherwise the lease reason and remedy stand where the buttons would be; one call per approval at a time; the node's shell command is shown beside the message when the open dry-run plan is of the same workflow, otherwise the row says the command is not shown), the run list (paged by cursor), and a run's detail: nodes with status, attempt, exit code and duration, the gate report, approvals, inputs, a *file changed since this run* notice, node output read in 64 KiB slices, *Cancel run* for a running run and *Resume run* for an ended one (not while the run is still `cancelling`). A refused approve, reject, cancel or resume stays on screen with the Host's message and remedy until dismissed.
- **Live approvals lease.** Opening the overlay calls `attachUi`; the lease is renewed every 15 s (the Host's 45 s TTL) and released with `detachUi` when the overlay closes or unmounts. The header shows *Live approvals attached* or, when it is not, *lapsed* / *unavailable* with the reason and remedy. A failed renewal reads *lapsed* immediately and the next tick attaches a fresh lease; a renewal that never answers is declared lapsed when the TTL runs out. A 403 is final (*unavailable*, no retry spam).
- **Events.** `workflow/run-changed`, `workflow/approval-pending` and `workflow/approval-decided` reach every connected browser, so each handler compares the event's `workspaceKey` with the key `list`, `runs` and `attachUi` returned and ignores anything else, including an event with no key. Matching events refresh the run list, the workflow list, the pending approvals and the open run; bursts are coalesced to one refresh in flight plus one queued.
- **Loopback-only calls.** `save`, `run`, `resume`, `cancel`, `approve`, `reject`, `attachUi`, `detachUi` and `nodeOutput` are answered with a bare `403` to a browser that is not on the Host machine. Every call is folded into one never-throwing result in `src/client/api.ts`; a 403 on one of those endpoints is explained with `explainWorkflowRefusal` (the Host's *loopback-only* message) plus a remedy line, never shown as a status code.

## Pilot selectors

Everything below is a `data-*` attribute; none is a class name.

| Area | Selectors |
| --- | --- |
| Entry | `[data-workflows-button]` (header), `[data-workflows-overlay]` with `data-workflows-tab="workflows\|runs"`, `[data-workflows-tab-button="workflows\|runs"]`, `[data-pending-approvals-count]` |
| Lease | `[data-lease-indicator][data-lease-state="attaching\|attached\|lapsed\|refused\|detached"]`, `[data-lease-label]`, `[data-lease-reason]` |
| Failures | `[data-failure][data-failure-scope="list\|editor\|dryrun\|run\|action\|detail\|output\|runs\|approvals\|lease"][data-failure-code]`, children `[data-failure-message]`, `[data-failure-remedy]`, `[data-failure-dismiss]` |
| List | `[data-workflow-list]`, `[data-workflow-row][data-workflow-name][data-workflow-valid][data-selected]`, `[data-list-refresh]`, `[data-new-workflow-name]`, `[data-new-workflow]`, `[data-new-workflow-problem="invalid\|exists"]` |
| Editor | `[data-workflow-editor]`, `[data-editor-textarea]`, `[data-validate]`, `[data-save]`, `[data-dryrun]`, `[data-run]`, `[data-conflict]`, `[data-reload]`, `[data-diagnostic]`, `[data-save-ok]`, `[data-save-warning]` (`[data-save-warning-text]`), `[data-save-first]`, `[data-editor-new]` |
| Dry-run | `[data-dryrun-view][data-dryrun-status]`, `[data-dryrun-refresh]`, `[data-dryrun-close]`, `[data-input-field][data-input-name]`, `[data-dryrun-stale]`, `[data-plan-list]` / `[data-plan-node][data-node-id]`, `[data-plan-graph]` / `[data-graph-node][data-node-id][data-node-kind][data-node-gate]` / `[data-graph-edge][data-from][data-to]`, `[data-gate-manifest]` / `[data-gate-entry][data-gate-node][data-gate-kind]`, `[data-trust-command][data-node-id]` with `[data-command]`, `[data-trust-agent]`, `[data-plan-warning]` |
| Trust and run | `[data-trust-state="trusted\|untrusted"]`, `[data-confirm-text]`, `[data-trust-ack]`, `[data-no-confirm-text]`, `[data-run-start][data-trust-run="true\|false"]`, `[data-trust-spent]`, `[data-run-started][data-run-id]` |
| Runs | `[data-run-list]`, `[data-run-row][data-run-id][data-run-status]`, `[data-runs-refresh]`, `[data-runs-more]`, `[data-pending-approvals]`, `[data-approval-row][data-run-id][data-approval-id][data-approval-state]`, `[data-approve]`, `[data-reject]`, `[data-reject-reason]` (only while the lease is attached; otherwise `[data-approval-fenced][data-lease-state]` with `[data-approval-fence-reason]`), `[data-approval-command-label]`, `[data-approval-command]`, `[data-approval-command-unknown]`, `[data-approval-command-none]` |
| Run detail | `[data-run-detail][data-run-id][data-run-status]`, `[data-detail-close]`, `[data-run-cancel]`, `[data-run-resume]`, `[data-file-changed]`, `[data-run-error]`, from `ui-workflow-run`: `[data-workflow-nodes]` / `[data-workflow-node][data-node-id][data-node-kind][data-node-status][data-approval-state]` with `[data-node-status-text]`, `[data-node-meta]`, `[data-node-truncated]`, `[data-node-reason]`, `[data-approval-text][data-approval-badge]`, and `[data-gate-report][data-gate-report-open]`, `[data-gate-toggle]`, `[data-gate-table]` / `[data-gate-row][data-gate-node][data-gate-kind][data-gate-outcome]`, `[data-gate-reason]`; here: `[data-node-outputs]` / `[data-node-output-row][data-node-id]`, `[data-node-output-button]`, `[data-node-output]`, `[data-run-approvals]` |

## Composition

The package registers its locale dictionary (`workflows`, `en` and `zh`), the header button and the overlay as Cordis effects; unloading the plugin removes all three. The overlay's controller exists only while the overlay is open, so the lease, the timers and the event subscription all end with it. The shipped Web bundle lists the plugin once, after `ui-org-board`.

## Model Experience

None, as this package is a browser surface over Host-owned workflow state and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- *Resume run* sends no trust key or challenge. Resuming a run of content that is not trusted is refused by the Host, and the refusal and its remedy are shown; the trust path is a fresh dry-run and Run of the workflow, not Resume.
- The command shown beside an approval comes only from an open dry-run plan of the same workflow. The run detail does not carry node commands, and building a plan only to look would mint a new single-use challenge, so the row says when the command is not available.
- The run detail embeds the node list and the gate report from `ui-workflow-run` (mapped from `runDetail` by its `runDetailToNodeData`), so node status reads `done` rather than the wire's `success` and the gate report has no reason column text (the wire gate view carries none). The gate report starts collapsed unless a gate blocked.
- A conflicting save keeps the unsaved edit on screen but offers only *Reload*, which discards it.
- The graph is a static layered drawing (no zoom or pan); very wide workflows scroll.
- Events are delivered to every connected browser and filtered here; the Host cannot scope them per subscriber.
- Like the existing privileged methods, the privileged `workflow` calls rely on the loopback connection gate; there is no per-call caller token (see the `workflow-remote` limitations).

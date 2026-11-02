# @deepseek-ai/dsh-workflow-run-store

English | [中文](README.zh.md)

Durable on-disk store for YAML workflow runs (OP-240): an append-only record log, the pinned workflow source, spilled node output, and a folded index, kept outside the checkout under the dsh home. Pure Node I/O that depends on the [`@deepseek-ai/dsh-workflow`](../workflow/README.md) types only. Layout under `<dsh-home>/workflow-runs/<sha256(realpath(workspace))[0:16]>/`: `runs.jsonl` (one `v: 1` JSON record per line: run, node, gate, approval, end), `<runId>/source.yaml` (the pinned source), `<runId>/<nodeId>.out` (output over 64 KB), `index.json` (folded summary, rebuilt from the log when missing, stale or corrupt) and `writer.lock`. Directories are mode 0700 and files 0600.

The package root exports `openStore`, `workflowStoreDir`, `WorkflowRunStore` (`startRun`, `recordNode`, `recordGate`, `recordApproval`, `decideApproval`, `endRun`, `listRuns`, `getRun`, `readSource`, `readOutput`, `acquireWriter`, `releaseWriter`, `sweepInterrupted`, `prune`), `WorkflowStoreError`, `writeFileAtomic`, `LIMITS`, the record types, and `WORKFLOW_RUN_RECORD_VERSION`.

The single-writer lock is published with temp file plus `link()` and records pid, process start time and boot id; it is taken over only when that triple proves the holder dead. A second writer is refused with `WRITER_BUSY` naming the holder. Unknown record or index versions are refused, never guessed at.

## Model Experience

None, as this package persists run records to disk and contributes nothing to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No redaction point** — command output, inputs, approval text and the pinned `source.yaml` are stored verbatim (files 0600, directories 0700). The host must keep read methods (`getRun`, `readOutput`, `readSource`) off the LAN, loopback only.
- **Local filesystem with hard links only** — the lock relies on `link()` and the proc filesystem. A lock written by another host name is never taken over (the error names the file to delete if that host is gone). Without `/proc` the start time degrades to a plain `kill(pid, 0)` liveness check; the pid-namespace limitation applies: a holder in another pid namespace (container) on the same host looks dead, so do not share one dsh home across pid namespaces.
- **One handle per workspace per process** — open the store once and share it; a second handle in the same process is treated as another writer and refused with `WRITER_BUSY`. A handle runs one run at a time.
- **Small remaining lock window** — takeover of a stale lock is serialized by `writer.lock.takeover`, and a stale mutex is reclaimed by renaming it aside and verifying what was moved. One race remains: in the instant between a taker proving the lock dead and removing it, a holder that released and a new holder that linked a fresh lock can have that fresh lock removed; the displaced holder notices on its next write (`NOT_WRITER`) and fails loudly rather than corrupting records. Kinds and outcomes (`nodeKind`, `gateKind`, `outcome`) are short lowercase tokens; free text is refused.
- **Orphaned children** — sweeping a crashed run records that its commands may still be running; the store cannot stop them.
- **No migrations yet** — version 1 is the only schema; a newer index or record version is refused loudly.

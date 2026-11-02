# @deepseek-ai/dsh-workflow-remote

English | [中文](README.zh.md)

Permanently-mounted Typert Remote namespace `workflow` that the Workflows UI talks to (OP-240). `WorkflowRemoteService` registers the `workflowRemote` service and publishes its methods under the `workflow` namespace; the wire contract lives in `src/wire.ts` (exported as `./wire` and re-exported from the package root), and the Typert generator emits the `./typert` and `./remote` artifacts from this package.

It is its own package, mounted by its own Loader entry in [`packages/bundle/web-app/cordis.patch.yml`](../../bundle/web-app/cordis.patch.yml), for the same reason as [`@deepseek-ai/dsh-mcp-status`](../../mcp/mcp-status/README.md): a package's RPC contract is withdrawn when its last Loader entry unloads and the Gateway never falls back, so the namespace must not ride on a package that can unload. The only method today is `workflow/list`, which returns an empty roster; it exists so the generator has a method to emit.

## Model Experience

None, as this Host-only Remote service registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Scaffold only** — `list` returns an empty roster; discovery, read, validate, dry-run, save, run, approve, cancel, resume, the pushed events, and the privileged endpoint set are not implemented yet.

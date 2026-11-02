# @deepseek-ai/dsh-client-ui-workflows

English | [中文](README.zh.md)

Browser **Workflows** surface for YAML workflows (OP-240). The browser plugin registers one localized button, id `workflows` at order 45, in the conversation session header's `conversation.session.header.actions` list (after the Org Board), and one `shell.overlay` entry with the same id that shows the Workflows panel while the button has opened it. Both registrations share one open/closed store and wait specifically on the `workflow` Remote namespace served by [`@deepseek-ai/dsh-workflow-remote`](../../workflow/workflow-remote/README.md), reached through [`api-remotes`](../../api/remotes/README.md).

This revision is the package scaffold: the overlay shows a placeholder panel. The workflow list, the graph (`@xyflow/react`, the same range [`ui-org-board`](../ui-org-board/README.md) uses), the YAML editor, and the run view land in later slices of OP-240.

## Model Experience

None, as this package is a browser surface over Host-owned workflow state and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Scaffold only** — the overlay is a placeholder; it lists, edits, and runs nothing yet, and it does not call the `workflow` Remote namespace.

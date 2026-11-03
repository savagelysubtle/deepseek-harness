# @deepseek-ai/dsh-workflow-yaml

English | [中文](README.zh.md)

Pure YAML workflow definitions for the Workflows feature (OP-240): the parser, validator, graph compiler, and layout for `.workflows/<name>.yaml` files. The package performs no I/O and registers no Cordis service, so the Host tool, the Host Remote service, and the browser editor share one implementation. Its only runtime dependency is [`yaml`](https://eemeli.org/yaml/).

## Public API

- `analyze(text, options?)` parses (core schema only; anchors, aliases, and tags are rejected), validates, and describes a workflow file. It returns `{ ok, diagnostics, doc?, graph?, manifest?, locations?, hash }`, where `hash` is the SHA-256 of the exact UTF-8 bytes (absent when the text is over the cap). Text over 256 KiB is refused with a diagnostic. `options.checkModel(model, { nodeId }) => string | undefined` lets the host add the catalog-resolved model check: return a rejection reason to refuse the model.
- `Diagnostic` is the one located-error shape (1-based `line` and `column`, `code`, `severity`, `nodeId?`, `path`); errors inside `when` expressions and `$ref` templates are mapped into the YAML scalar.
- `compile(doc, { promptFiles? })` returns `{ meta, script, manifest, promptFiles, maxTotalAgents? }`: a plain-JS script body for the worker-thread workflow engine. User text appears in the script only as JSON string literals, and node outputs reach `bash` as `WF_*` environment variables, never in the command text. `COMPILED_SCRIPT_CONTRACT` lists the hooks and options the script uses.
- `describeGraph(doc)` and `layout(graph, { xGap, yGap, nodeW, nodeH })` give the display graph and a deterministic layered layout (barycenter ordering, no external layout library).
- `checkModelId`, `checkTierTable`, `checkRelativePath`, `checkEnvName` are the static denylist and containment checks; `describeTrustFacts(doc)` lists what a workflow will run for the trust prompt; `sha256Hex` is a synchronous, browser-safe hash.

All exports are pure: no I/O and no Node-only APIs, so the browser editor links this package directly.

## Model Experience

None, as this package parses and validates workflow files and contributes nothing to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A mutating prompt node must be verified** — `no-verify-step` is an error for a `prompt` node that may change the checkout (the default) when nothing downstream gates it. Escape hatches: set `mutates_checkout: false`, add `done_when`, or put a gating bash, approval, verifier or loop node after it.
- **Version 1 only** — `version: 1` is required; `evidence`, `on_error`, and `workflow`/`include` (including `kind: workflow`) are rejected, and `context: {resume}` and `fresh_context: false` are not yet supported.
- **Static checks are not a security boundary** — the Fable text check and path/env checks reject the obvious shapes; resolved-model and symlink checks are the host's runtime job (`analyze` exposes a `checkModel` hook for the former).
- **A string denylist can over-match** — separator-insensitive matching may reject an unrelated id that contains the letters `fable`.
- **Output passed between nodes is data, not instructions** — `$node.output` in a prompt is wrapped as labelled data, which reduces but cannot remove prompt-injection between nodes.

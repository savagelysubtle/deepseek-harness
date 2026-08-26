# Agent Note: Tool-shaped project memory (memory-by-tool-call)

Status: proposed

[English](2026-08-26-memory-tool-shaped.md) | 中文

## Problem

Steve's agents accumulate operational knowledge — session state, decisions, environment gotchas, canonical locations — that currently lives in per-agent chat histories or ad-hoc files. The reference deployment (opencode) proves the shape works: one directory per workspace under a shared home, plain topic markdown, emerging subdirs (`done/`, `todo/`, `spec/`), humans and agents co-editing the same bytes. What the harness lacked was the seam: no service owns durable per-project notes, so every seat reinvents storage and every note is unreachable from other seats.

Prompt-injection alternatives (a memory section recomputed each request) were ruled out by Steve directly: injected memory costs its full size on EVERY request whether or not it is relevant, pollutes the cacheable prefix whenever anything changes, and blurs what the model actually consulted.

## Proposal

One package (`@deepseek-ai/dsh-memory`), three faces:

- **Service Definition** `ctx.memory`: read/write/list/search over a storage root (default `<harness home>/memory/`), with the project scope resolved per operation from an explicit cwd. Content is ordinary markdown; frontmatter optional.
- **Local provider**: filesystem-backed, temp-file rename writes for co-editor safety, strict path jail before any I/O, complete-entry byte bound (256 KiB), bounded list/search results.
- **Model-facing tool** `memory` (`{action, path?, content?, query?}`): scope from the calling session's header cwd, zero prompt presence until called.

Scope slugs mirror the reference deployment's shape — `<workspace-basename>-<6 hash chars of sha256(resolved cwd)>` — so same-named checkouts never share notes while one checkout shares them across sessions, restarts, and seats.

## Alternatives

- **Injected memory sections / auto-recall embeddings.** Ruled out by directive: tool-shaped only. The deferred-work record keeps substring search as the ceiling; semantic recall can arrive later as another consumer of the same seam without touching the contract.
- **Session-log-backed memory** (notes as session events). Rejected: wrong lifetime. Memory outlives any session and must be shared across them; the log is per-session by design.
- **Separate SD package + separate tool package.** Folded into one slice: no independent provider-consumer evolution exists today, and the preset needs exactly two rows (local + tool) inside one isolate group either way.

## Consequences

- Agents gain durable cross-session project knowledge with token cost paid only on explicit reads; large bodies stay on disk, not in context.
- Humans join the loop for free: notes are real files under `$DSH_HOME/memory/`, editable and diffable like any repo documentation.
- Standard-preset adoption is a three-line group block; deployments that decline memory simply omit it, keeping request-cache catalogs stable.

## Required verification

- Keyless suites: provider round-trips, slug scoping/isolation, jail escape rejections (`../`, absolute, backslash, NUL, whitespace-only), byte bounds, search clipping and limits — plus the tool mounted through the real ToolRuntime exercising write→list→read→search against a session carrying a cwd, including the no-session rejection path.
- REAL-composition snapshot coverage through a runnable example stays OPEN for the landing PR (this slice holds within the assigned write-set); the tool's render paths are otherwise pinned by unit assertions here.

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

Project-scoped durable memory for the DeepSeek Harness: plain-markdown notes that persist across sessions, restarts, and seats, stored as real files humans and agents co-edit. Memory is TOOL-shaped — content reaches a model only when the seat explicitly reads or searches it through the `memory` tool; nothing is injected into a prompt in the background.

## Layout

The local provider stores notes under one storage root (default `<harness home>/memory/`, i.e. `$DSH_HOME` or `~/.dsh`), in one directory per project:

```
memory/
  deepseek-harness-1v55erz/     ← scope slug: <workspace-basename>-<6 hash chars of the absolute cwd>
    federation-org-model.md     ← topics at the top level
    todo/auth-notes.md          ← nested subdirs emerge organically (todo/, done/, spec/, …)
```

Two same-named checkouts get distinct slugs because the suffix hashes the resolved cwd. Entries are ordinary markdown files, frontmatter optional and preserved byte-for-byte.

## Plugins

| Export | Role |
|---|---|
| `.` | `MemoryService` Service Definition (`ctx.memory`) plus slug/jail helpers and types |
| `./local` | `LocalMemoryProvider` — filesystem-backed provider plugin (`name: memory-local`) |
| `./tool` | `memory` tool consumer plugin (`name: tool-memory`, injects `tools`) |
| `./invariant` | Package invariant companion |

Mount provider and tool together on an agent preset to give its agents memory; both consume no host-plane registries beyond `ctx.tools`.

## Service surface (`ctx.memory`)

- `read(cwd, path)` returns the entry verbatim; absent paths fail loud naming slug and path.
- `write(cwd, path, content)` replaces completely, creating directories implicitly; writes land through same-directory temp-file rename so co-editor readers never see a torn file.
- `list(cwd)` returns every entry recursively, sorted by path, with byte sizes.
- `search(cwd, query, limit?)` is a case-insensitive substring scan over lines, returning `{path, line, excerpt}` bounded by limit.

Every operation jails `path` first: relative, forward-slash only, no `..` segments, NUL-free, length-capped — violations reject before any I/O. One entry may hold up to 256 KiB of UTF-8.

## The `memory` tool

One action-discriminated call: `{action:"read"|"write"|"list"|"search", path?, content?, query?}`. The project scope comes from the calling session's `cwd`; calls without an agent session are rejected rather than falling back to the server's launch directory.

## OAuth-independent configuration

Config is two keys total: the provider accepts an optional `root` override for the storage tree, and the tool accepts an optional `searchLimit` clamp. Both default sensibly and validate fail-loud at load.

## Model Experience

### Memory entries

#### What the model sees

Nothing by default: registered memory adds no prompt text, no system-prompt section, and no catalog-side reminder. A session sees exactly what it reads — `read` results become the entry's verbatim markdown as the tool result; `list` renders one `- <path> (<N> B)` line per entry; `search` renders `[<path>:<line>] <excerpt>` rows; `write` renders a one-line confirmation. Failures render their diagnostics (`isError` results), which is how jail rejections teach the model the path grammar.

#### Token effect

Zero while unused — the cost is deferred until an explicit call, then linear in what was read or matched (an excerpt clip caps each search row). Writes put only the confirmation line into history; large bodies stay on disk instead of the context window.

#### KV Cache effect

Tool definition adds a constant prefix cost per request while mounted, stable like any other tool schema. Call results append after the reusable prefix and never invalidate earlier cache entries; repeated `read()` of the same unchanged entry reproduces identical bytes and stays prefix-stable.

## Known Limitations and Deferred Work

- **Last-writer-wins** — concurrent writers overwrite whole entries; there is no merge, lock, or history. Human co-editors rely on small topic files.
- **No delete/move action yet** — lifecycle pruning (e.g. done/) happens on disk by hand; the tool list reflects whatever exists.
- **Search is substring-only** — no regex, ranking, embeddings, or cross-project search.
- **Scope comes from the session header alone** — a deployment whose agents lack a session cwd gets working but unscoped errors telling it so; there is no implicit fallback by design.

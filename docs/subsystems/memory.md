# Durable project memory

English | [中文](memory.zh.md)

The memory seam stores durable plain-markdown notes per workspace, co-edited by humans and agents as ordinary files. Content reaches a model only when that seat explicitly reads or searches it through the `memory` tool — memory is a tool call, never background injection. [`MemoryService`](../../packages/memory/memory/src/index.ts) declares the operations, [`LocalMemoryProvider`](../../packages/memory/memory/src/local.ts) implements them over one filesystem root, and the package [README](../../packages/memory/memory/README.md) owns the storage layout and Model Experience detail.

## Project scoping

Every operation resolves its project scope from the caller's absolute `cwd`: notes belong to the checkout, never to a session, seat, or process. One workspace shares its scope across every session, restart, and seat, while two checkouts never share notes. [`projectSlug()`](../../packages/memory/memory/src/scope.ts) names each scope directory `<munged workspace basename>-<6 hash characters of the sha256 of the resolved cwd>`, so even same-named checkouts stay distinct directories.

## Stored values

All stored values use scope-relative POSIX paths (forward slashes, no leading `/`):

```ts type-equiv
/** One stored memory entry as `list()` reports it. */
interface MemoryEntry {
  /** Scope-relative POSIX path with forward slashes (`todo/auth.md`). */
  readonly path: string
  /** UTF-8 byte size of the stored file. */
  readonly bytes: number
}
```

```ts type-equiv
/** One search hit inside the scoped tree. */
interface MemoryMatch {
  /** Scope-relative path of the matching entry. */
  readonly path: string
  /** 1-based line number of the first match on that line. */
  readonly line: number
  /** The matched line, trimmed and clipped to the excerpt budget. */
  readonly excerpt: string
}
```

```ts type-equiv
/** Result of one committed write. */
interface MemoryWriteResult {
  /** Scope-relative path written (normalized form of the requested path). */
  readonly path: string
  /** Stored UTF-8 byte size. */
  readonly bytes: number
}
```

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)

## Limits and path jail

[`packages/memory/memory/src/scope.ts`](../../packages/memory/memory/src/scope.ts) holds the pure bounds helpers; every provider applies them before any filesystem call:

- `MAX_ENTRY_PATH_LENGTH` — longest accepted relative entry path, in characters (200).
- `MAX_ENTRY_BYTES` — largest storable entry, enforced on the complete UTF-8 value (256 KiB = 262,144 bytes).
- `MAX_LIST_ENTRIES` — whole-result cap on `list()` output (1,000 entries).
- `DEFAULT_SEARCH_LIMIT` — maximum matches one `search()` returns by default (50).
- `MAX_SEARCH_LIMIT` — hard ceiling on `search()` results regardless of the requested limit (200).

`jailedScopePath()` jails every model- or caller-supplied relative path before any I/O: absolute paths, `\` or NUL bytes, `..` traversal in any segment, empty paths, and over-long names reject loudly with the offending input, because silently rewriting a path would store content somewhere the caller did not ask about. Valid paths normalize (`a//b/.` collapses to `a/b`).

## Service operations

[`MemoryService`](../../packages/memory/memory/src/index.ts) is the abstract Service Definition published as `ctx.memory`; providers implement four operations over one storage root, each resolving the project scope from its `cwd` argument:

- `read(cwd, path)` returns one entry's full text verbatim, frontmatter included.
- `write(cwd, path, content)` creates or completely replaces one entry, creating missing directories; the result reports the normalized path and stored byte size.
- `list(cwd)` walks the scope recursively and returns every entry sorted by path, with byte sizes.
- `search(cwd, query, limit?)` runs a case-insensitive substring scan across the scoped entries' lines and returns matches ordered by path, then line number; empty queries reject, results never exceed `MAX_SEARCH_LIMIT`, and oversized or unreadable entries are skipped silently.

The local provider's added guarantees: writes land through same-directory temp-file rename, so co-editors always see the old or the new file, never a torn one; reads of a missing entry fail loud naming the project slug and path; an absent scope means zero entries, not an error; `list()` skips dotfiles and temp files.

## The `memory` tool

The [`tool.ts`](../../packages/memory/memory/src/tool.ts) consumer registers the action-discriminated `memory` tool `{action:"read"|"write"|"list"|"search", path?, content?, query?}` into the host tools registry's preset layer, and its registration returns the registry disposer. At call time it resolves `ctx.memory` strictly with `ctx.get('memory')` — an unmounted provider fails loud with the remedy instead of degrading. Read/write require a non-empty scope-relative `path`, write additionally requires the complete replacement `content`, and search requires a non-empty `query`. The project scope comes only from the calling agent's session-header `cwd`: without one, calls reject rather than falling back to the server's launch directory. An optional config clamp `searchLimit` (validated 1–200, default 50) caps matches per call, subject to the service's own ceiling.

## Composition

The provider publishes `ctx.memory`, so compositions mount it in an entry-local realm and let the tool share that realm to see the instance; nothing enters prompts without an explicit call. The standard preset wires this shape in its `memory` group in [`apps/cli/config/agent-presets/standard/agent.cordis.yml`](../../apps/cli/config/agent-presets/standard/agent.cordis.yml), and profile patch layers replicate the same group.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice-abstract-seam"></a>

### `ctx.memory` — `MemoryService` (abstract seam)

Abstract memory service. Providers implement the four operations over one storage root; every operation resolves the project scope from the caller's absolute `cwd`, so two checkouts never share notes and one checkout shares them across every session, restart, and seat.

```ts cordis-catalog
/**
 * Read one entry's full text.
 * @param cwd - absolute working directory naming the project scope.
 * @param path - scope-relative POSIX path; jailed before any I/O.
 * @returns the file content verbatim, frontmatter included.
 */
abstract read(cwd: string, path: string): Promise<string>

/**
 * Create or replace one entry atomically enough for human co-editors:
 * temp-file plus rename inside the target directory, so a reader never sees
 * a torn write.
 * @param cwd - absolute working directory naming the project scope.
 * @param path - scope-relative POSIX path; missing directories are created.
 * @param content - complete replacement text (UTF-8).
 * @returns the normalized path and stored byte size.
 */
abstract write(cwd: string, path: string, content: string): Promise<MemoryWriteResult>

/**
 * List every entry in the project scope, recursive, sorted by path.
 * @param cwd - absolute working directory naming the project scope.
 * @returns all entries with their byte sizes.
 */
abstract list(cwd: string): Promise<MemoryEntry[]>

/**
 * Case-insensitive substring search across the scoped entries' lines.
 * Empty files and oversized skips are silent; results are bounded by
 * {@linkcode MAX_SEARCH_LIMIT} regardless of the requested limit.
 * @param cwd - absolute working directory naming the project scope.
 * @param query - substring to find; empty queries reject.
 * @param limit - maximum matches to return (default {@link DEFAULT_SEARCH_LIMIT}).
 * @returns ordered by path, then line number.
 */
abstract search(cwd: string, query: string, limit?: number): Promise<MemoryMatch[]>
```

Source: [`packages/memory/memory/src/index.ts:37`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->

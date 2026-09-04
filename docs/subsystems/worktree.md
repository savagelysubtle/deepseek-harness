# Worktree

English | [中文](worktree.zh.md)

The worktree seam mints seat-scoped git worktrees so parallel agent rounds get isolated checkouts without colliding on paths, branches, or session names. Service Definition, provider contract, and local git provider all live in one package — [dsh-worktree](../../packages/worktree/worktree) (`ctx.worktrees`) — following the `dsh-llm` precedent for a concern that has not split yet; no model-facing Consumer ships yet, so a caller injects `ctx.worktrees` directly rather than going through a tool schema. The [worktree-capability-seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-31-worktree-capability-seam.md) owns the design rationale.

Source: [`packages/worktree/worktree/src/types.ts`](../../packages/worktree/worktree/src/types.ts)

## Slugs mint every name; the caller chooses none

`WorktreeSlug` is a seam-minted, branded identifier — `<base36 epoch ms>-<base36 counter>-<8 hex random>` — never chosen by the caller. Every derived name is a pure function of the caller's `seat` plus this slug: branch `<seat>/<slug>`, session `<seat>.<slug>`, path `<worktreesRoot>/<seat>-<slug>`, lock reason `<seat> <session>`. A monotonic per-process counter separates parallel mints within the same millisecond; the random tail separates mints across process restarts. `seat` follows the session-name grammar (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, restated from `@deepseek-ai/dsh-named-sessions` without a dependency edge, the `dsh-mailbox` address-grammar precedent) so a branch always stays filename-safe and git-legal.

## Spawn: request, result, and row

`spawn(request, providerName?)` resolves a provider, validates the seat and intent, checks the work environment, mints the slug, refuses the two states force would paper over, creates the worktree **locked**, runs the copy-list bootstrap, and publishes the row. A bootstrap failure rolls the half-built worktree back (unlock then remove) before the error surfaces; a rollback failure and the original error both reach the caller as an `AggregateError`.

```ts type-equiv
/**
 * Request to create one seat-scoped worktree. The caller supplies ownership
 * and intent; the seam mints the slug and derives every name from it.
 */
interface WorktreeSpawnRequest {
  /**
   * Seat that will work inside the worktree. Uses the session-name grammar
   * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, from `@deepseek-ai/dsh-named-sessions`):
   * filename-safe and valid inside a git branch name.
   */
  readonly seat: string
  /** Short caller intent, recorded on the row as the spawn's `lastReason`. */
  readonly intent: string
  /** Explicit ref to branch from; omitted resolves to `Config.mainRef`. */
  readonly mainRef?: string | undefined
}
```

```ts type-equiv
/** Published result of one successful spawn. */
interface WorktreeSpawnResult {
  /** Seam-minted slug behind every derived name. */
  readonly slug: WorktreeSlug
  /** Seat the worktree was spawned for. */
  readonly seat: string
  /** New branch the worktree checked out: `<seat>/<slug>`. */
  readonly branch: string
  /** Session name reserved for the seat's work in this worktree: `<seat>.<slug>`. */
  readonly session: string
  /** Absolute worktree path: `<worktreesRoot>/<seat>-<slug>`. */
  readonly path: string
  /** Ref the branch was cut from. */
  readonly branchRef: string
  /** Reason the creation lock carries: `<seat> <session>`. */
  readonly lockReason: string
  /** Repo-root-relative files the copy-list bootstrap placed into the worktree. */
  readonly copied: readonly string[]
}
```

`list()` and `row(slug)` read the live registry — one `WorktreeRow` per live branch, published at spawn and updated in place by lock/unlock, deleted by remove:

```ts type-equiv
/**
 * One registry row: seat → worktree path → branch → session name. Exactly one
 * row exists per live branch; removal deletes it.
 */
interface WorktreeRow {
  /** Seam-minted slug; the row's stable identity across lock state changes. */
  readonly slug: WorktreeSlug
  /** Seat the worktree belongs to. */
  readonly seat: string
  /** Branch the worktree checked out. */
  readonly branch: string
  /** Session name reserved for the seat's work in this worktree. */
  readonly session: string
  /** Absolute worktree path. */
  readonly path: string
  /** Ref the branch was cut from. */
  readonly branchRef: string
  /** Epoch milliseconds at which the seam published the row. */
  readonly createdAt: number
  /**
   * Reason the current git lock carries; `undefined` while unlocked. A row is
   * born locked (spawn creates the worktree under lock) and removal refuses
   * while this is set.
   */
  readonly lockReason?: string | undefined
  /** Reason attached to the most recent mutation (spawn intent, lock, or unlock). */
  readonly lastReason?: string | undefined
}
```

## Fences: force is unrepresentable

No provider method accepts a force flag. The two states `git worktree add -f` would paper over — an occupied target path, an existing branch — are refused loudly by the service, via the provider's `pathExists`/`branchExists` fences, before `add` ever runs; removal is likewise never forced, so a dirty worktree surfaces git's own refusal instead of being destroyed. `lock`/`unlock`/`remove` each require a non-empty caller-supplied reason — a fence change without a stated reason is exactly the silent fence this seam forbids — and every refusal names the existing fence's reason or the missing precondition in its message. `WorktreeError` carries one of these stable `WorktreeErrorCode`s:

| Code | Refuses when |
|---|---|
| `SEAT_INVALID` / `INTENT_INVALID` | The spawn request's `seat` fails the grammar, or `intent` is blank. |
| `ENV_MISSING` | The work environment lacks `DEEPSEEK_API_KEY` (whitespace-only counts as missing). |
| `PATH_EXISTS` / `BRANCH_EXISTS` | The target path or branch already exists — the states force would paper over. |
| `ALREADY_LOCKED` / `NOT_LOCKED` | `lock` on an already-locked row, or `unlock` on one that isn't locked. |
| `LOCKED` | `remove` on a row still carrying a lock reason. |
| `REASON_INVALID` | `lock`/`unlock`/`remove` called with a blank reason. |
| `NO_ROW` | The slug names no live row. |
| `NO_PROVIDER` / `DUPLICATE_PROVIDER` | No provider resolves unambiguously, or a name is registered twice. |
| `GIT_FAILED` | The local provider's git invocation exited non-zero; the message carries git's own stderr. |
| `COPY_LIST_UNSUPPORTED` / `COPY_SOURCE_MISSING` | `.worktree-include` uses unsupported syntax, or lists a file absent at the repo root. |
| `REGISTRY_CORRUPT` | The persisted `registry.json` fails its version or shape check at load. |

## Env gate and the copy-list bootstrap

`spawn` checks `DEEPSEEK_API_KEY` presence before any git or filesystem mutation, so a doomed spawn creates nothing. Once the worktree exists, the copy-list bootstrap copies the repo-root files a work session needs — v1 ships `.env` — into the same relative path under the fresh worktree. The list lives in `.worktree-include` at the repository root (gitignore syntax; blank lines and `#` comments skipped); v1 honors literal relative file paths only and refuses globs, negation, directory entries, absolute paths, and `..` segments with the offending line number, rather than silently copying less than the list promises. A listed-but-missing source file fails loud (`COPY_SOURCE_MISSING`). No list file present copies nothing — the documented default, not a skipped entry.

## The provider contract: `WorktreeProvider`

Provider mechanics are swappable behind one contract; `registerProvider` admits an implementation under its own name (duplicate names refuse loudly) and returns the disposer fiber teardown triggers.

```ts type-equiv
/**
 * One worktree backend. Force is unrepresentable: no method accepts a force
 * flag, and the service refuses — before calling the provider — the two
 * states force would paper over (an existing target path, an existing
 * branch). Removal is likewise never forced; a dirty worktree surfaces git's
 * refusal instead of being destroyed.
 */
interface WorktreeProvider {
  /** Registry-unique provider name. */
  readonly name: string

  /**
   * Create the worktree at `spec.path` on the new branch `spec.branch` cut
   * from `spec.mainRef`, created locked with `spec.lockReason` — the exact
   * `git worktree add --lock -b <branch> <path> <main-ref>` contract for the
   * local provider.
   * @param spec - fully resolved spawn input; the service has already refused existing paths and branches.
   */
  add(spec: WorktreeAddSpec): Promise<void>

  /**
   * Lock an existing worktree with a reason.
   * @param path - absolute worktree path.
   * @param reason - reason recorded with the git lock.
   */
  lock(path: string, reason: string): Promise<void>

  /**
   * Remove an existing lock. Git records no unlock reason; the service keeps
   * the caller's reason on the row.
   * @param path - absolute worktree path.
   */
  unlock(path: string): Promise<void>

  /**
   * Remove the worktree's admin metadata and directory. Refuses (via git)
   * when the worktree is locked or dirty — force-removal is unrepresentable.
   * @param path - absolute worktree path.
   */
  remove(path: string): Promise<void>

  /**
   * Whether the target path already exists in the provider's filesystem —
   * the fence that makes force-spawning (`git worktree add -f`)
   * unrepresentable before `add` runs.
   * @param path - absolute candidate worktree path.
   * @returns true when something already occupies the path.
   */
  pathExists(path: string): Promise<boolean>

  /**
   * Whether a local branch with this exact name already exists — the fence
   * that makes branch reuse impossible before `add` runs.
   * @param branch - full branch name.
   * @returns true when the branch exists.
   */
  branchExists(branch: string): Promise<boolean>

  /**
   * Enumerate the repository's worktrees as git sees them — the reconciliation
   * view tests and operators read rows against.
   * @returns one entry per worktree git reports, in git's order.
   */
  list(): Promise<readonly WorktreeListEntry[]>
}
```

`add` takes a fully resolved `WorktreeAddSpec` — the service has already refused existing paths and branches by the time a provider sees one:

```ts type-equiv
/** Fully resolved spawn input handed to a provider's {@link WorktreeProvider.add}. */
interface WorktreeAddSpec {
  /** Absolute target worktree path. */
  readonly path: string
  /** New branch to create and check out. */
  readonly branch: string
  /** Ref to branch from. */
  readonly mainRef: string
  /** Reason the creation lock carries. */
  readonly lockReason: string
}
```

`list()` returns one `WorktreeListEntry` per worktree the provider's backend reports, in its own order:

```ts type-equiv
/** One entry of the provider's worktree listing. */
interface WorktreeListEntry {
  /** Absolute worktree path. */
  readonly path: string
  /** Checked-out branch, without the `refs/heads/` prefix; absent for detached worktrees. */
  readonly branch?: string | undefined
  /** Whether the worktree is currently locked. */
  readonly locked: boolean
  /** Reason the lock carries, when locked and reported by git. */
  readonly lockReason?: string | undefined
}
```

## The local git provider

`LocalGitWorktreeProvider` (registered as `local-git`) implements every method as one git invocation addressing the resolved `repoRoot`: `add` runs `git worktree add --lock --reason <lockReason> -b <branch> <path> <mainRef>`; `lock`/`unlock`/`remove` map directly to their `git worktree` subcommands; `branchExists` uses `git rev-parse --verify --quiet refs/heads/<branch>` and treats exit 1 as "absent" while any other exit surfaces git's diagnostic; `list` parses `git worktree list --porcelain`. Every invocation strips `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR` from the child environment, because the harness itself commonly runs from inside a worktree of the very repository it is spawning into, and an inherited location variable would redirect the child git at the calling process's checkout instead of `repoRoot`. A non-zero git exit is wrapped in a `WorktreeError` (`GIT_FAILED`) carrying git's own stderr, never left to die silently. `LocalGitWorktrees` is the mountable service form: it registers one `LocalGitWorktreeProvider` against the mounted `WorktreeService`'s resolved `repoRoot` and unregisters it on fiber disposal, so consumers mount it beside the worktree service rather than constructing the provider class directly.

## Registry persistence

With `persist` enabled in `Config`, every row-publishing mutation mirrors the live registry to `<worktreesRoot>/registry.json` — an atomic write (temp file, then rename) so a crash mid-write never leaves a truncated file — and the next process's construction loads it back in. The file carries an explicit version tag; a version mismatch or any malformed row fails loud (`REGISTRY_CORRUPT`) rather than merging a half-understood registry. Git's own worktree state stays the authority over what exists on disk — the file only remembers the seam's bookkeeping, and nothing reconciles a row against a worktree removed outside the seam.

## Config

| Field | Type | Default | Semantics |
|---|---|---|---|
| `repoRoot` | string | — | Absolute path of the main checkout; must exist at construction, fails loud otherwise. |
| `worktreesRoot` | string? | `<basename(repoRoot)>.worktrees` sibling | Absolute directory under which worktrees are created (created on demand). |
| `mainRef` | string? | `master` | Ref new worktrees branch from when the request omits one. |
| `persist` | boolean? | `false` | Mirror registry rows to `<worktreesRoot>/registry.json` and load them at construction. |

## Events

Every registry mutation that commits — spawn, lock, unlock, remove — emits its matching `worktree/*` event (see the [events catalog](#cordis-surface)) carrying the committed (or, for removal, the deleted) row plus the mutation's reason. These are observe-only data snapshots: a listener receives the row and reason, never a mutable handle back into the registry, so it cannot itself lock, unlock, or remove anything.

## The service

`WorktreeService` owns the provider registry, slug minting, the fenced spawn/lock/unlock/remove operations, and the in-memory (optionally persisted) rows; `LocalGitWorktreeProvider`/`LocalGitWorktrees` own one provider's git mechanics. No consumer package registers a model-facing tool yet — a caller that wants worktrees today injects `ctx.worktrees` and, typically, mounts `LocalGitWorktrees` beside it.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

Registry over the process's worktree providers plus the fenced lifecycle operations. Registering the same provider name twice fails loud; the returned disposer unregisters exactly that contribution.

```ts cordis-catalog
/**
 * Register one worktree provider under its own name.
 * @param provider - the provider implementation to admit.
 * @returns the disposer that unregisters this provider; fiber disposal triggers it.
 * @throws WorktreeError with code `DUPLICATE_PROVIDER` when a live provider already holds the name.
 */
registerProvider(provider: WorktreeProvider): () => void

/**
 * Look up one registered provider by exact name.
 * @param name - the provider's registry name.
 * @returns the provider, or undefined when the name is not live.
 */
getProvider(name: string): WorktreeProvider | undefined

/**
 * Enumerate the live provider names in registration order.
 * @returns fresh provider names.
 */
listProviders(): string[]

/**
 * Spawn one seat-scoped worktree: verify the working environment, mint the
 * slug, refuse the states force would paper over, create the worktree
 * locked, run the copy-list bootstrap, and publish the row. No mutation
 * happens before every check passes; a bootstrap failure rolls the
 * worktree back before the error surfaces.
 * @param request - seat, intent, and optional main ref.
 * @param providerName - provider to use; omitted resolves the single registered provider and refuses ambiguity.
 * @returns the published spawn result.
 */
async spawn(request: WorktreeSpawnRequest, providerName?: string): Promise<WorktreeSpawnResult>

/**
 * Enumerate the live registry rows in spawn order — one row per live branch.
 * @returns fresh row snapshots.
 */
list(): readonly WorktreeRow[]

/**
 * Look up one registry row by slug.
 * @param slug - the seam-minted slug.
 * @returns the row, or undefined when no live branch carries it.
 */
row(slug: WorktreeSlug): WorktreeRow | undefined

/**
 * Lock an unlocked worktree with a reason.
 * @param slug - the worktree's slug.
 * @param reason - why the worktree is being locked; carried on the row, the git lock, and the event.
 * @param providerName - provider to use; same resolution as {@link spawn}.
 * @returns the committed row.
 */
async lock(slug: WorktreeSlug, reason: string, providerName?: string): Promise<WorktreeRow>

/**
 * Remove an existing lock, recording why.
 * @param slug - the worktree's slug.
 * @param reason - why the fence is coming down; carried on the row and the event.
 * @param providerName - provider to use; same resolution as {@link spawn}.
 * @returns the committed row.
 */
async unlock(slug: WorktreeSlug, reason: string, providerName?: string): Promise<WorktreeRow>

/**
 * Remove an unlocked worktree and delete its row. A locked worktree refuses
 * with its lock reason — the caller must unlock with a reason first. The
 * branch itself survives removal; reusing its name stays forbidden.
 * @param slug - the worktree's slug.
 * @param reason - why the worktree is being removed; carried on the event.
 * @param providerName - provider to use; same resolution as {@link spawn}.
 */
async remove(slug: WorktreeSlug, reason: string, providerName?: string): Promise<void>
```

Source: [`packages/worktree/worktree/src/index.ts:175`](../../packages/worktree/worktree/src/index.ts)

<a id="worktree-events"></a>

### `worktree/*` events

<a id="worktreelocked--emit"></a>

#### `worktree/locked` — emit

A worktree was locked with the carried reason.

```ts cordis-catalog
/**
 * A worktree was locked with the carried reason.
 * @mode emit
 * @param payload - the committed row and the lock reason.
 */
'worktree/locked'(payload: WorktreeEventPayload): void
```

Source: [`packages/worktree/worktree/src/index.ts:152`](../../packages/worktree/worktree/src/index.ts)

<a id="worktreeremoved--emit"></a>

#### `worktree/removed` — emit

A worktree was removed and its registry row deleted; the branch itself survives removal.

```ts cordis-catalog
/**
 * A worktree was removed and its registry row deleted; the branch itself
 * survives removal.
 * @mode emit
 * @param payload - the deleted row and the removal reason.
 */
'worktree/removed'(payload: WorktreeEventPayload): void
```

Source: [`packages/worktree/worktree/src/index.ts:166`](../../packages/worktree/worktree/src/index.ts)

<a id="worktreespawned--emit"></a>

#### `worktree/spawned` — emit

A worktree was created, locked at birth with reason `<seat> <session>`, its copy-list bootstrap finished, and its registry row published.

```ts cordis-catalog
/**
 * A worktree was created, locked at birth with reason `<seat> <session>`,
 * its copy-list bootstrap finished, and its registry row published.
 * @mode emit
 * @param payload - the committed row and the spawn's reason.
 */
'worktree/spawned'(payload: WorktreeEventPayload): void
```

Source: [`packages/worktree/worktree/src/index.ts:146`](../../packages/worktree/worktree/src/index.ts)

<a id="worktreeunlocked--emit"></a>

#### `worktree/unlocked` — emit

A worktree's lock was removed; the committed row's `lockReason` is undefined.

```ts cordis-catalog
/**
 * A worktree's lock was removed; the committed row's `lockReason` is
 * undefined.
 * @mode emit
 * @param payload - the committed row and the unlock reason.
 */
'worktree/unlocked'(payload: WorktreeEventPayload): void
```

Source: [`packages/worktree/worktree/src/index.ts:159`](../../packages/worktree/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->

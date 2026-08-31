# @deepseek-ai/dsh-worktree

The worktree capability seam: seat-scoped git worktrees for parallel agent rounds. This package owns all three roles of the seam as one concern — the **Service Definition** (`ctx.worktrees`, slug minting, fences, registry rows), the **provider contract** (`WorktreeProvider`), and the **local git provider** (`LocalGitWorktrees` / `LocalGitWorktreeProvider`). Consumers (the seat-spawning slices) inject the service and never touch git.

## Service API (`ctx.worktrees`)

| Member | Semantics |
|---|---|
| `registerProvider(provider)` | Admits one backend under its own name; duplicate names fail loud; returns the unregistering disposer (fiber disposal triggers it). |
| `getProvider(name)` / `listProviders()` | Exact-name lookup / registration-order names. |
| `spawn(request, providerName?)` | Verifies the work environment, mints the slug, refuses existing paths and branches, creates the worktree **locked** (`git worktree add --lock -b <branch> <path> <main-ref>`, reason `<seat> <session>`), runs the copy-list bootstrap, and publishes the row. A bootstrap failure rolls the worktree back before the error surfaces. |
| `list()` / `row(slug)` | Live registry rows — one row per live branch — in spawn order / by slug. |
| `lock(slug, reason)` / `unlock(slug, reason)` | Move the git lock with a mandatory reason; every state change lands on the row and an event. Re-locking a locked worktree refuses with the existing reason. |
| `remove(slug, reason)` | Removes an **unlocked** worktree and deletes its row. A locked worktree refuses with its lock reason — unlock first. The branch survives removal. |

## Contracts

- **The seam mints the slug; the caller never chooses one.** Every name derives from seat + slug: branch `<seat>/<slug>`, session `<seat>.<slug>`, path `<worktreesRoot>/<seat>-<slug>`. Uniqueness per parallel round comes from a monotonic counter; the random tail separates restarts.
- **Force is unrepresentable.** `git worktree add -f` is never built: the two states force would paper over — an occupied target path and an existing branch — are refused loudly before the provider runs, and no provider method accepts a force flag. Removal is likewise never forced; a dirty worktree surfaces git's refusal.
- **Never a silent fence.** Spawn is born locked with reason `<seat> <session>`; lock, unlock, and remove require a non-empty reason; every refusal message names the existing fence's reason or the missing precondition.
- **Env gate before work.** `spawn` checks `DEEPSEEK_API_KEY` (whitespace-only counts as missing) before any git or filesystem mutation and refuses with the variable named.
- **Copy-list bootstrap.** `.worktree-include` at the repository root (gitignore syntax; blanks and `#` comments skipped) lists repo-root-relative files copied into every fresh worktree; v1 honors literal file paths only and refuses globs, negation, and directory entries with the offending line number. A listed-but-missing file fails loud. No list file copies nothing — that is the documented default.
- **Registry persistence is a mirror.** With `persist`, rows live in `<worktreesRoot>/registry.json` (atomic tmp-rename write, version-gated load, corrupt files fail loud at mount). Git's own worktree state stays the authority over what exists on disk.

## Config

| Field | Type | Default | Semantics |
|---|---|---|---|
| `repoRoot` | string | — | Absolute path of the main checkout; must exist at mount, fails loud otherwise. |
| `worktreesRoot` | string? | `<basename(repoRoot)>.worktrees` sibling | Absolute directory under which worktrees are created (created on demand). |
| `mainRef` | string? | `master` | Ref new worktrees branch from when the request omits one. |
| `persist` | boolean? | `false` | Mirror registry rows to `<worktreesRoot>/registry.json` and load them at mount. |

## Extension points

Providers implement [`WorktreeProvider`](./src/provider.ts) — `add`/`lock`/`unlock`/`remove`/`pathExists`/`branchExists`/`list` — and register through `ctx.worktrees`. Mount the bundled local provider with the `LocalGitWorktrees` service beside the worktree service; it registers `local-git` against the service's resolved `repoRoot` and unregisters on fiber disposal.

## Model Experience

### Worktree lifecycle, when a consumer mounts the seam

#### What the model sees

Nothing directly: `ctx.worktrees` registers no prompt, tool, or schema of its own, and rows and events reach a model request only through a consumer surface that renders worktree state into the conversation.

#### Token effect

Zero direct tokens from this Service Definition; any history cost belongs to the consumer surface that renders worktree rows, names, or events into the conversation.

#### KV Cache effect

None from the seam itself: worktree names enter a request only where a consumer composes them, so reuse behavior follows that surface's prefix structure.

## Known Limitations and Deferred Work

- No consumer ships yet: the seat-spawning slice that mounts this seam into the runtime is a separate change; until then nothing in the shipped defaults exercises it.
- Copy-list v1 copies literal files only; globs, negation, and directory entries refuse loudly instead of half-honoring.
- `remove` leaves the branch behind; branch deletion is a separate explicit operation rather than silently destroying possibly-unmerged work.
- Registry rows are not reconciled against `git worktree list` automatically: a worktree removed outside the seam stays as a stale row until the reconciliation slice lands.
- README.zh.md pairing and the group's bilingual records are deferred to the docs slice.

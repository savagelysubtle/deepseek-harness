# Agent Note: Worktree seam — seam-minted slugs and unrepresentable force

Status: implemented

[English](2026-08-31-worktree-capability-seam.md) | [中文](2026-08-31-worktree-capability-seam.zh.md)

## Problem

Parallel agent rounds need isolated checkouts, but the obvious approach — let each caller run `git worktree add` with its own path and branch names — concentrates every failure mode the git command tolerates: forced reuse of a dirty path (`-f`), silent branch clobbering (`-B`), worktrees pruned out from under a running seat because nothing locked them, and fresh worktrees missing the credential files the main checkout carries outside version control. None of these failures announces itself at the point where the seat could still react.

## Decision

`@deepseek-ai/dsh-worktree` is a capability seam (Service Definition + provider contract + local git provider in one package, the `dsh-llm` precedent for a concern that has not split yet) whose central choice is **the seam mints the slug; the caller never names anything**. The caller supplies seat + intent; every derived name — branch `<seat>/<slug>`, session `<seat>.<slug>`, path `<worktreesRoot>/<seat>-<slug>`, lock reason `<seat> <session>` — is a pure function of those two strings plus a counter-and-random slug, so parallel rounds cannot collide by construction and no caller can steer the derivation.

The fences are enforced in the operation that could violate them, not by convention:

- Force is **unrepresentable** rather than forbidden: no provider method accepts a force flag, and the two states force would paper over (occupied path, existing branch) are refused loudly before the provider runs, via provider-owned `pathExists`/`branchExists` fences.
- Spawn creates the worktree **locked** (`git worktree add --lock --reason "<seat> <session>"`), so nothing external can prune or hijack it mid-round; removal refuses on a locked worktree with the existing reason carried in the message, and lock/unlock/remove all require a non-empty reason — a fence change without a stated reason is exactly the silent-fence shape this seam exists to prevent.
- The work-environment gate (`DEEPSEEK_API_KEY` presence) runs before any git or filesystem mutation, so a doomed spawn refunds nothing and creates nothing.
- The copy-list bootstrap (`.worktree-include`, gitignore syntax) copies credential-adjacent files such as `.env` into the fresh worktree; v1 honors literal paths and refuses globs, negation, and missing sources with line numbers, because a silently skipped copy is a fence that only falls over later, inside the seat's work.

Provider mechanics live behind `WorktreeProvider` (`add`/`lock`/`unlock`/`remove`/`pathExists`/`branchExists`/`list`), so the local git implementation — which strips `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR` from the child environment, since the harness itself commonly runs inside a worktree of the repository it is spawning into — is one swappable provider, and tests drive every fence through a fake without git.

## Testing

- Package tests cover the full spawn→list→lock→unlock→remove lifecycle, slug uniqueness under parallel spawning, every forbidden-operation refusal with its reason, the copy-list bootstrap against a real temp-dir fixture repo, the env gate, registry rows, and mirror persistence (including corrupt-file refusal).
- `tests/local-git.spec.ts` exercises the real git path end-to-end (creation lock reason visible in `git worktree list --porcelain`, `.env` copied, removal gone from git's own listing).

## Alternatives considered

- **Let the caller name paths and branches** — rejected: it re-creates every failure mode the fences exist for. Free-form names collide across parallel rounds, `-f` becomes the routine escape hatch for stale state, and no single component can see all live worktrees. Minting the slug in one place turns naming from a caller contract into a derived fact.
- **Allow forced operations behind an explicit flag** — rejected: force is how a loud failure becomes a silent one. The seam refuses the states force would paper over and leaves the underlying git escape hatch available to an operator who deliberately steps outside the seam.
- **Create worktrees unlocked and lock on demand** — rejected: the window between `add` and `lock` is exactly when another process may prune or claim the worktree; the race is closed by being born locked, with the unlock as the deliberate, reasoned act.
- **Split the seam into definition/provider/consumer packages now** — deferred: one package matches the `dsh-llm` precedent for a young concern; the provider contract is the split line when a second backend (a remote or pool provider) arrives.

## Consequences

- Registry rows are a mirror, not an authority: git's worktree state decides what exists on disk. A worktree removed outside the seam leaves a stale row until a reconciliation pass lands — deferred with the consumer slice.
- `remove` leaves the branch behind. Deleting branches here would silently destroy possibly-unmerged work; branch cleanup stays an explicit separate operation.
- The slug counter is process-local; uniqueness across processes rests on the random tail. Two processes minting in the same millisecond have astronomically small collision odds, and the branch-existence fence converts a collision into a loud refusal instead of corruption.
- The seat grammar restates the named-session pattern (the `dsh-mailbox` address-grammar precedent) to avoid a dependency edge for one regex; the comment cross-references the source of truth.

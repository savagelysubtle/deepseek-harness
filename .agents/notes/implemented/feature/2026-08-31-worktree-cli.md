# Agent Note: dsh-worktree CLI — stateless shell access to the worktree seam

Status: implemented

[English](2026-08-31-worktree-cli.zh.md) | 中文

## Problem

The worktree seam addresses worktrees only through a mounted service: a seat (or an operator standing outside the harness) had no bash-invocable way to spawn a worktree, read its rows, or move its lock fence. The consumer surface that exists (the host apiproxy's wire domain) is live-only — it answers while the harness runs, which is exactly when a seat is already inside the harness and does not need a shell path. Driving a worktree from a seat's shell, a cron wrapper, or an outage-time operator session had no surface at all.

## Decision

The `dsh-worktree` bin ships on `@deepseek-ai/dsh-worktree` itself, over the same precedent as `dsh-mailbox`: the CLI lives inside the owning package so it is version-locked to the seam contract it drives and cannot drift into calling operations that no longer exist. It exposes the seam's five fenced operations — `spawn`, `list`, `lock`, `unlock`, `remove` — one operation per invocation, with the result printed as JSON on stdout and every refusal printed as `<code>: <message>` on stderr with exit 1, the message being the service's own reason verbatim.

Statelessness is carried by the registry mirror rather than by any resident process: every invocation constructs the service with `persist: true`, so a spawn's minted slug lands in `<worktreesRoot>/registry.json` and the next invocation (`unlock`, `lock`, `remove`) addresses it from there. The CLI changes nothing about the seam's authority split — git's worktree state stays the authority over what exists on disk; the mirror only carries the bookkeeping rows between stateless processes.

Configuration comes from CLI flags, not from a running host: `--repo-root` defaults to the current directory and `--worktrees-root` keeps the package's `<basename>.worktrees` sibling default, both resolved by the same `resolveConfig` the plugin mount runs. The local git provider registers against the resolved repo root inside the invocation and unregisters before exit; a deployment needing a different provider uses the plugin surface, which resolves providers by name.

## Alternatives considered

- **A resident daemon holding the service** — rejected: the seam's registry is cheap to reconstruct from the mirror, and a resident process would need its own lifecycle, discovery, and failure story that the harness already owns where a harness exists at all.
- **A thin bash script around `git worktree`** — rejected: it would reimplement slug minting, the lock fences, the env gate, and the copy-list bootstrap outside the seam, exactly the second copy of the policy the seam exists to own.
- **Wiring the CLI into the host apiproxy consumer** — rejected: the apiproxy surface is the in-harness path; a CLI dependent on a running host would be unusable precisely in the no-harness situations the command exists for.

## Consequences

`package.json` gains the `bin` entry and a package-local `tsdown.config.ts` building `lib/cli.js` beside the root and invariant bundles. The CLI's registry mirror writes mean an operator running `spawn` against a repository creates `<worktreesRoot>/registry.json` where the plugin-only surface previously created nothing without `persist` — a visible but intended side effect, since statelessness requires the mirror. The CLI mounts only the bundled local git provider; multi-provider deployments keep the plugin surface.

## Testing

`packages/worktree/worktree/tests/cli.spec.ts` pins the parser (subcommands, optional `--main-ref`/path flags, `--help` selection, loud unknown/missing/ malformed refusals), the output contract (JSON on stdout with exit 0, usage with exactly one trailing newline, `<code>: <message>` refusals on stderr with exit 1), the cross-invocation lifecycle over real git (spawn → re-lock refusal → unlock → lock → locked-remove refusal → unlock → remove, rows carried by the registry mirror between separate invocations), the env gate and config refusals, and the bin entry: the symlink-resolving execution guard and a subprocess run of the real source entry through tsx.

# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each
# side as of the last confirmed-consistent state. Both languages carry equal authority;
# after editing either side, bring the other along and re-record with:
#   pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-31-worktree-cli.md
2026-08-31-worktree-cli.md: PENDING 2026-08-31-worktree-cli.zh.md: PENDING

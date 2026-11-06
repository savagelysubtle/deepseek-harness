# @deepseek-ai/dsh-agent-claude-code-seat-checks

English | [中文](README.zh.md)

The **seat checks** of [Claude Code coder seats](../agent-claude-code-driver/README.md). It is a cordis plugin that runs two boot proofs and then registers the `canary` and `rules-hooks` readiness entries and a per-query **clone hook check** into the registries the [policy package](../agent-claude-code-tools/README.md) serves. Together with the `sandbox` entry of the [bash package](../agent-claude-code-bash/README.md) that is everything a coder needs to be served, so this package is what lifts the coder refusal. It has no third-party dependency.

## What it does

- **Mount order, in one try block.** `name: agent-claude-code-seat-checks`, `inject: [claudeCodePolicyRegistries, claudeCodeGuardProbe]`, so mount order against the policy provider is free. The body runs (1) the guard probe, (2) the checker self-test, and only then, synchronously with no `await`, registers (3) the clone check (id `clone-hooks-check`, roles `['coder']`), (4) the `rules-hooks` readiness contributor, and (5) the `canary` contributor, the last only on an explicit `{ ok: true }` probe result. A failure before the registrations registers nothing, so nothing is half-registered.
- **A failure is loud and final for this process.** Any caught error logs at error level `agent-claude-code-seat-checks: canary FAILED <code>` (and a second line with the reason), records the short code as a readiness note the not-ready error shows, and registers nothing. The coder stays refused until the host restarts, because the registries cannot unregister and there is no retry loop. A second mount throws before registering anything (`already mounted`).
- **Coupled to enforcement.** `extend()` in the policy package throws for a coder unless a clone check with id `clone-hooks-check` is registered for coder, whatever readiness says, so a bogus `rules-hooks` registrant alone does not lift anything.
- **Unloading.** Disposing the plugin sets a flag; the registered check then refuses every query with code `disposed`.

## The guard boot canary

The probe belongs to the policy package (`claudeCodeGuardProbe`, built from the same resolved options as the real policy). It generates a real coder policy for the reserved synthetic seat `dsh-canary-probe`, runs the exact hook command through `/bin/sh` and requires: an unknown tool is denied (exit 2, `seat-guard: denied:`, "is not granted"); an `Edit` of `<cwd>/.git/config` is denied with the protected-location reason; a granted `Read` is **allowed** (the negative control); and the node binary, guard copy and policy file still hold their attested hashes afterwards. This package calls it with the per-run timeout `canaryTimeoutMs`, maps a rejection to code `error`, and registers `canary` only on `ok: true`. Failure codes: `attest`, `timeout`, `exit`, `reason`, `control`, `changed`, `spawn`, `error`.

**What a passing canary does not prove.** It proves the generated command denies when run through `/bin/sh`. It does **not** prove the Claude CLI invokes the hook or honours exit 2 (CLI semantics and version drift). That is proven only by the policy package's `scripts/live-probe.mjs` at the S8 drill, before any coder seat takes real work; nobody should read "canary passed" as more.

**Honesty about the threat model.**

- A non-seat process running as the same uid can swap the node binary or the guard and rewrite the 0700 policy files. Attestation does not defend against that.
- The per-query re-attest (size, mtime, ctime, inode) closes the window to one turn.
- The negative control (a granted `Read` must exit 0) defeats an always-deny fake guard that only prints the denial text.
- Readiness is keyed on the `provides` string, so any in-process plugin could register `canary`; a same-process plugin is already fully trusted. The coupling above means a bogus `rules-hooks` alone does not lift enforcement.

## The clone hook check (`rules-hooks`)

Purpose, stated plainly: **provisioning hygiene and drift detection, defence in depth behind the guard and the sandbox. It is not a security boundary.** A coder clone must carry no host-executable git hook state at all: the whole `.git` is read-only inside the sandbox and host git runs with hooks disabled, so nothing is fenced here and the check asserts absence. It neither installs nor enforces the `reference-transaction` fence; that belongs to `~/.agents` only. No network is used anywhere.

- **Cadence.** Every query computes a fingerprint (`lstat` of `.git`, `.git/config`, the must-be-absent entries, `.git/hooks` and each hook entry: mode, inode, link count, size, mtime, ctime; about a dozen calls, no spawn). The git parse runs only at a seat's first query, on a working-directory change, or when the fingerprint changed. A refusal is never remembered. A missing entry has a stable token; an unreadable entry gets a token that never repeats, so it is a changed fingerprint, never a pass.
- **State checks.** `.git` is a real directory. Must be **absent**: `.git/commondir`, `.git/gitdir`, `.git/dsh-hooks`, `.git/config.worktree`, `.git/worktrees`, `.git/objects/info/alternates`, `.git/objects/info/http-alternates`. `.git/hooks` is a real directory (or absent) holding only regular files named `*.sample`. `.git/config` is `lstat`-regular, one link, not a symlink, at most 64 KiB, checked **before** git is spawned (a hostile config could bury `core.hooksPath` past a truncated read).
- **The config is read by git.** `git config --file <cwd>/.git/config --list -z --no-includes`, absolute git path, cwd `/`, environment `PATH=/usr/bin:/bin`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME=/nonexistent`, `LC_ALL=C` and nothing inherited, a 5 s timeout and a 256 KiB output cap. Records are split on the first newline only; keys are matched lowercase and anchored.
- **Allowlist.** `core.repositoryformatversion`, `core.filemode`, `core.bare` (must be false), `core.logallrefupdates`, `core.ignorecase`, `core.precomposeunicode`, `core.symlinks`, `remote.<n>.url`, `remote.<n>.fetch`, `branch.<n>.remote`, `branch.<n>.merge`, `user.name`, `user.email`, `init.defaultbranch`. Everything else is refused with its key named. A remote url must be an absolute local path, `https://`, `ssh://` or scp-style, and any value containing `::` is refused (a remote helper runs a program). `branch.<n>.remote` must be a plain name.
- **Fail closed.** Granted only when the spawn returned no error, no signal, status 0, empty stderr, and stdout that ends in a NUL and parses completely. Everything else throws `CloneCheckError`, which the policy package turns into a recorded refusal and a typed turn error naming the key or path and the remedy.

Refusal codes: `git-missing`, `timeout`, `enobufs`, `eacces`, `enoent`, `parse`, `config-too-large`, `config-not-regular`, `config-key`, `config-value`, `git-not-directory`, `forbidden-entry`, `hook-entry`, `fs-error`, `git-error`, `git-signal`, `git-exit`, `git-stderr`, `disposed`. Every refusal text carries the scrub commands (remove the named path or key outside any seat, or provision a fresh clone with `pnpm install --offline --ignore-scripts --config.package-import-method=copy`).

**Checker self-test.** Before registering, the plugin builds throwaway clones in a temporary directory and requires the check to pass a clean one and to refuse each hostile one for the expected code: `core.hooksPath`, a filter driver, `include.path`, a `remote.o.uploadpack`, `core.bare = true`, an `ext::` url, an executable `pre-commit`, a `reference-transaction`, a `config.worktree`, and a symlinked config. The `rules-hooks` contributor therefore means "the checker works"; the clone verdict itself is enforced on every query.

## Host-side git on a clone

The package exports `assertCloneHookState(cwd)` (same checks, uncached, throws `CloneCheckError`). Call it **before every host-side git command** on a coder clone, and run those commands as `git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat ...` with `GIT_CONFIG_NOSYSTEM=1`. Never `git add -A` in a clone: a seat can write a nested `sub/.git/config`, and `git status` ran its `core.fsmonitor` once the host added `sub`. A clone provisioned without `--ignore-scripts` fails the check, because the root postinstall (`install-lefthook`) writes `core.hooksPath`, `.git/config.worktree` and `.git/dsh-hooks` into it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` registers nothing and warns; coder seats stay not-ready. |
| `gitPath` | first of `/usr/bin/git`, `/usr/local/bin/git` | Absolute, normalised path of git. No git found fails the canary with code `git-missing`. |
| `canaryTimeoutMs` | `20000` | Timeout of each hook run of the guard probe, 1 to 300000. |

An invalid `gitPath` or timeout throws `SeatChecksConfigError` at mount. There is no snapshot file and no snapshot path.

## Tests

Specs hold 100% per-file coverage and cover each error path of the canary and of the clone check with its own test: git missing, `EACCES`, timeout, `ENOBUFS`, signal, non-zero status, stderr output, unparsable output, an oversized, symlinked, hardlinked and missing config, every must-be-absent entry, every hook shape, and every hostile key. They run real git on throwaway configs (no network) and one end-to-end mount against the real policy provider and the real built guard.

## Known Limitations and Deferred Work

- **Per-query enforcement, not create-time.** The clone path is only known at query time, so a coder turn on a bad clone fails as a turn error with a typed reason and a remedy, not as a create-time refusal.
- **Clone-local state only.** The host user's global and system git config is covered by the operator rules above, not by this check.
- **The check is TypeScript.** A Rust port behind the same seam is possible later together with the guard port; nothing here depends on it.
- **A failed canary needs a restart.** There is no retry loop, and a same-process plugin could still register `canary` by string.
- **Follow-up, not closed here.** The per-seat proof in `extend()` still blocks the first query for up to 15 s; the boot canary cannot replace it because the proof key includes each seat's policy hash.

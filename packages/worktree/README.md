# worktree/ — seat-scoped git worktree family

English | [中文](README.zh.md)

Isolated git worktrees for parallel agent rounds: the seam mints slugs, derives branch/session/path names, fences every state change behind loud reasons, and bootstraps the fresh worktree with the repository's copy list.

| Package | Role | ctx key |
|---|---|---|
| [`worktree/`](worktree/README.md) | Service Definition + provider contract + local git provider: slug minting, registry rows, lock fences, copy-list bootstrap, env gate | `ctx.worktrees` |

Planned roles: the seat-spawning consumer (mounts the seam into the runtime) and a registry-reconciliation pass over `git worktree list`.

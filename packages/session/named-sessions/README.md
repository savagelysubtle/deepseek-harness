# @deepseek-ai/dsh-named-sessions

English | [中文](README.zh.md)

Named-session identity derivation and cross-process per-name locking, shared by every consumer that addresses a durable session by a stable human-chosen name — today the headless runner, tomorrow the mailbox bridge and any other named-run surface.

There is no map store: the durable session id is **derived** from the project anchor plus the name (`named-` + 32 hex of SHA-256 over the anchor and the name), so every process running in the same project recomputes the same identity. The anchor (see `projectAnchor`) is the git common directory when the working directory belongs to a repository — every worktree of one repository derives the same ids — and the resolved working directory itself otherwise, so two repositories never derive one name into one session. The same token names the lock file under the canonical directory `headless/locks/`, making "one live holder per named session" enforceable across processes through plain filesystem semantics.

## Service API

No `ctx` service: this is a pure utility library plus an invariant companion.

| Export | Semantics |
|---|---|
| `assertValidSessionName(name)` | Enforces the filename-safe grammar `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; throws with usage-grade wording. |
| `projectAnchor(cwd)` | The shared project identity that every consumer hashes: the real path of the git common directory when `cwd` belongs to a repository, the real path of `cwd` itself otherwise. Never throws; one `git rev-parse` probe (2 s bound) per uncached resolved directory. |
| `deriveNamedSessionId(name, cwd?)` | Deterministic branded `SessionId` for a validated name in the project at `cwd` (default: the process working directory). One-way: neither the name nor the anchor is recoverable from the id. |
| `acquireNamedSessionLock(name, options?, cwd?)` | Exclusive create-or-take-over of `<token>.lock`. Rejects loud while a live process holds it; takes over artifacts whose holder is provably gone (dead pid, unreadable content). With `options.maxAgeMs`, a live holder older than the bound also loses the artifact; absent (default), pid liveness is the only takeover path. `cwd` must match the derivation cwd so the lock guards the id that is actually written. |
| `NamedSessionLock.release()` | Removes the artifact only while it still records this holder — a taken-over file belongs to its successor. |
| `namedLockPath(name, cwd?)` / `lockPathForToken(token)` | The one place the id-to-lock algebra lives; the invariant companion checks through these. |

Callers own the name→address map (channel routing, dashboards); this package owns identity and exclusion only.

## Model Experience

None, as the package derives session ids and lock artifacts with no tool, prompt, or context registration of its own.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- A narrow takeover race window exists between the liveness read and the recreate; a same-process retry is the caller's remedy.
- `maxAgeMs` takeover trusts the recorded `createdAt`; a live holder whose payload lacks a readable timestamp still rejects even with the bound set.
- No enumeration of live names: the artifact set under `headless/locks/` is inspectable but not a public API.
- Identity is project-scoped: one name derives different session ids in different repositories, so name-based routing across repositories is the caller's map.

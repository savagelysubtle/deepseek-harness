# @deepseek-ai/dsh-named-sessions

English | [中文](README.zh.md)

Named-session identity derivation and cross-process per-name locking, shared by every consumer that addresses a durable session by a stable human-chosen name — today the headless runner, tomorrow the mailbox bridge and any other named-run surface.

There is no map store: the durable session id is **derived** from the name (`named-` + 32 hex of SHA-256), so every process recomputes the same identity from the name alone. The same token names the lock file under the canonical directory `headless/locks/`, making "one live holder per name" enforceable across processes through plain filesystem semantics.

## Service API

No `ctx` service: this is a pure utility library plus an invariant companion.

| Export | Semantics |
|---|---|
| `assertValidSessionName(name)` | Enforces the filename-safe grammar `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; throws with usage-grade wording. |
| `deriveNamedSessionId(name)` | Deterministic branded `SessionId` for a validated name. One-way: the name is never recoverable from the id. |
| `acquireNamedSessionLock(name, options?)` | Exclusive create-or-take-over of `<token>.lock`. Rejects loud while a live process holds it; takes over artifacts whose holder is provably gone (dead pid, unreadable content). With `options.maxAgeMs`, a live holder older than the bound also loses the artifact; absent (default), pid liveness is the only takeover path. |
| `NamedSessionLock.release()` | Removes the artifact only while it still records this holder — a taken-over file belongs to its successor. |
| `namedLockPath(name)` / `lockPathForToken(token)` | The one place the id-to-lock algebra lives; the invariant companion checks through these. |

Callers own the name→address map (channel routing, dashboards); this package owns identity and exclusion only.

## Model Experience

None — nothing here reaches a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- A narrow takeover race window exists between the liveness read and the recreate; a same-process retry is the caller's remedy.
- `maxAgeMs` takeover trusts the recorded `createdAt`; a live holder whose payload lacks a readable timestamp still rejects even with the bound set.
- No enumeration of live names: the artifact set under `headless/locks/` is inspectable but not a public API.

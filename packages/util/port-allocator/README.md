# dsh-port-allocator

English | [中文](README.zh.md)

Per-session port and environment allocation for parallel sessions. Worktrees isolate files, not ports: N parallel sessions each running a dev server need N non-colliding ports and env that cannot cross-talk. This package is the zero-dependency library behind that allocation — a `PortAllocator` that hands out ports it has actually verified bindable, and an `EnvIsolator` that builds each session's environment as a fresh object.

It is a **library, not a service or plugin**: no `ctx`, registers nothing, emits no events. A session-lifecycle consumer wires allocation to session start and release to session end; this package owns neither sessions nor processes.

## API

```ts
import {
  EnvIsolator,
  PortAllocationError,
  PortAllocator,
  MAX_TCP_PORT,
  MIN_TCP_PORT,
  resolveEnvIsolatorConfig,
  resolvePortAllocatorConfig,
} from '@deepseek-ai/dsh-port-allocator'
```

| Export | Role |
|---|---|
| `PortAllocator` | Allocate the next free port per session from a validated range; `release(port)` returns it to the pool at session end. Concurrent `allocate()` calls are serialized so no two sessions receive the same port. |
| `resolvePortAllocatorConfig(input)` | The config boundary: validates `min`/`max` (integers, legal TCP range, `min < max`), `maxAttempts` (integer ≥ 1), `probeHost`, and seeded `inUse` ports. Defaults resolve here — explicitly — never at a call site. |
| `PortAllocationError` | Rejected by `allocate()` when no port is available; carries every failed probe (`port`, `code`, `message`) in probe order. |
| `probeFailure(port, error)` | Normalizes one listen error into a probe failure record; the code falls back to `UNKNOWN` when the error carries none. |
| `EnvIsolator` | Build one session's env from its base env and allocated port: the port var, an optional session-id var, and session-suffixed values for configured base variables. |
| `resolveEnvIsolatorConfig(input)` | The env config boundary: POSIX-name validation, unique suffix names, and a non-empty separator when suffixing is configured. |
| `MIN_TCP_PORT` / `MAX_TCP_PORT` | The legal TCP range for explicit binds (`1`–`65535`); fixed by the protocol, not configurable. |

## How allocation works

The allocator scans its range lowest-first, skipping ports it has already handed out and ports seeded as `inUse`. A port free in that set can still be held by a foreign process, so each candidate is probed for **actual bindability**: a real `net.Server` listens on the configured probe host and closes immediately. The probe uses Node's own server defaults, so its outcome predicts the consumer's later bind on the same host. Probing stops at `maxAttempts`; exhaustion rejects with a `PortAllocationError` listing every failed probe and how the range was otherwise consumed.

The `probeHost` default is `127.0.0.1`: harness consumers bind loopback, and a loopback probe detects exactly the holders those consumers will conflict with. Choose `0.0.0.0` only for a consumer that binds all interfaces — it over-detects (it skips ports a loopback bind could still use), which is the safe direction.

```ts
const allocator = new PortAllocator({ min: 3100, max: 3199, maxAttempts: 5 })
const port = await allocator.allocate()      // verified bindable, reserved
// ... hand `port` to the session's dev server ...
allocator.release(port)                      // session ended
```

## How env isolation works

`sessionEnv()` copies the caller's base env into a fresh object, stamps the allocated port into `portVar`, and — when a session id is supplied — stamps it into `sessionVar` and appends it after `suffixSeparator` to the base value of each configured `suffixVars` entry (session-scoped tmp dirs, cache paths). A suffix variable absent from the base env stays absent: isolation never invents values. The module holds no reference to `process.env` and never mutates the caller's `baseEnv`.

```ts
const isolator = new EnvIsolator({
  portVar: 'PORT',
  sessionVar: 'DSH_SESSION_ID',
  suffixVars: ['TMPDIR'],
  suffixSeparator: '-',
})
const env = isolator.sessionEnv({ baseEnv, port, sessionId: session.id })
// { ...baseEnv, PORT: '3100', DSH_SESSION_ID: 'session-7', TMPDIR: '/tmp/dsh-session-7' }
```

## Known Limitations and Deferred Work

- **Probe-then-close leaves a hand-off window** — between the probe's close and the consumer's real bind, a foreign process can grab the port. Siblings inside this process are protected by the allocator's reservation; the residual race is cross-process, and the consumer closes it by binding immediately after `allocate()` resolves.
- **The probe predicts a Node `net.Server` bind under default options** — a consumer binding through another stack, or with non-default socket flags, can still hit a conflict the probe could not see.
- **A loopback probe misses non-loopback holders by design** — a port held only on another interface reads as free; configure `probeHost: '0.0.0.0'` when the consumer binds all interfaces.
- **No cross-process coordination** — allocation state is one process's memory. Ports held by other processes or earlier runs are caught by the probe or excluded through the seeded `inUse` set, never by shared bookkeeping.
- **Released ports are re-probed, not quarantined** — a released port can be handed straight back out; a lingering foreign grab from the previous session is caught by the next allocation's probe.

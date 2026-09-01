# Agent Note: Port/env allocation integration — library plus boundary resolve, one instance per process

Status: implemented

[English](2026-08-31-port-env-allocator-integration.md) | [中文](2026-08-31-port-env-allocator-integration.zh.md)

## Problem

Parallel sessions need disjoint TCP ports and session-scoped environment state, and the obvious per-consumer approach reimplements the same failure modes every time: a hard-coded range that collides with another deployment's choices, an in-memory reservation trusted without asking the kernel, a port handed out and bound so late that a foreign process claims it first, and session env assembled by mutating `process.env` or a shared base object. `@deepseek-ai/dsh-port-allocator` ships the capability as a pure library; without a documented integration pattern, every consumer would re-decide where validation lives, who owns the instance, and when the bind must happen.

## Decision

The package is a library, not a service: no `ctx`, no registration, no events. Every consumer composes it through the same four moves, which together are the integration contract:

- **Config via schemastery at the plugin layer.** Deployment-varying choices — the allocation range, probe bound, probe interface, and the env variable names — are validated Config fields on the consuming plugin, changeable from cordis.yml. The library never reads configuration sources; it receives the raw values as arguments.
- **Resolve functions at the boundary.** `resolvePortAllocatorConfig` and `resolveEnvIsolatorConfig` are the modules' config boundaries: schemastery validates structure, the resolve functions own value semantics (TCP-range membership, `min < max`, integer probe bound, POSIX env names, unique suffix vars, a non-empty separator whenever suffix vars exist) and fail loud at construction — misconfiguration is refused before any allocation or env derivation, never silently skipped at call time. Defaults live inside the owning resolve step (the loopback `probeHost` precedent), not at call sites.
- **One instance per process.** The allocator's reservation table is in-memory and process-local, and concurrent `allocate()` calls are serialized within the instance — two instances in one process would not share reservations and could hand the same port to two sessions. The owning plugin constructs exactly one `PortAllocator` (and one `EnvIsolator`) at its scope, never per request, and releases allocated ports through `release` on the same instance.
- **Bind immediately after allocate.** `allocate` probes bindability with a real listen and closes it, so the handed-out port is known bindable at that instant, but only the in-memory reservation guards it afterwards. The consumer binds its listener as the next step after `allocate` returns; a delayed bind leaves a window where a foreign process can claim the port and the reservation describes a port nobody holds. Exhaustion surfaces as `PortAllocationError` carrying every probe failure, so a full range reports why each candidate was rejected.

`EnvIsolator` completes the pairing: given the caller's base env and the allocated port, `buildSessionEnv` returns a fresh session env — the port var, the optional session-id var, and session-suffixed values for configured base variables — and the module holds no reference to `process.env` at all, so the parent's environment is never read from nor written to.

## Testing

- The package suite covers the config boundaries field by field, the allocate/probe/release cycle including serialization of concurrent allocations, exhaustion with the full probe-failure list, and session env derivation (port var, session var, suffix vars, and the separator consistency rule).
- The invariant companion registers the package and asserts no additional runtime relationship: the library holds no `ctx`, so there is no owned event stream or registry to check.

## Alternatives considered

- **Make the allocator a cordis service** — deferred: no second consumer exists yet, and a service would force every deployment to mount registration machinery for a capability one plugin may use. A library plus this documented pattern keeps the capability-seam split (the `dsh-llm`/worktree precedent) available for the day a second backend or consumer arrives.
- **Allocate without probing** — rejected: a port absent from the in-memory set may be held by a foreign process, and only the kernel knows; the probe converts a would-be runtime `EADDRINUSE` at session start into a refused allocation with a per-port reason.
- **Let consumers own validation** — rejected: scattered range and name checks reappear in every consumer with different strictness, and a default invented at a call site cannot be changed centrally. The resolve functions are the single place value semantics and defaults live.

## Consequences

- Composition wiring is each consumer's job every time: Config fields, instance ownership, and lifecycle disposal are not provided by the library. This pattern note is the checklist; a consumer that skips the one-instance or bind-immediately rules reintroduces the races the library exists to close.
- Cross-process allocation stays probabilistic: the probe narrows but does not eliminate races with processes outside this allocator. Deployments sharing a range across processes must partition the range or seed `inUse` with the known holds; the kernel remains the only authority.
- The library's zero-dependency stance (beyond the brand-free stdlib) means consumers gain no schemastery dependency through it — the plugin layer already carries Config, and the resolve functions accept plain values.

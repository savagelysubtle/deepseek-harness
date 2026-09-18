# Agent Note: Worktree consumer integration — one adaptation seam, ref=slug, folded refusals

Status: implemented

English | [中文](2026-08-31-worktree-consumer-integration.zh.md)

## Problem

The host gateway (`dsh-host-apiproxy`) shipped its worktree surface against a consumer-declared seam contract while the real capability package was still being built in parallel: the consumer's declarations were the contract of record, and an integration commit was expected to replace them with the real package without rewriting the wire surface. The integration had to reconcile two vocabularies — the wire's `WorktreeHandle`/`WorktreeRow`/spawn-input and the service's `WorktreeSpawnRequest`/`WorktreeSpawnResult`/`WorktreeRow` — without letting either drift, without leaking the service's full refusal vocabulary onto the wire, and without breaking the optional-composition rule (a deployment without the seam still serves every other domain).

## Decision

`src/worktree-seam.ts` is the adaptation layer, and it is the only place the two vocabularies meet:

- **The consumer's declared contract stays; the declaration is gone.** The gateway handlers still consume the consumer-facing `WorktreeSeam` (spawn/list/lock/remove) and its typed `WorktreeSeamError`, but the module no longer declares a Context key or local types. `worktreeSeamOf(ctx)` reads the service the real package registers itself (`ctx.get('worktrees')`, from `@deepseek-ai/dsh-worktree`'s own declaration merge) and wraps it with `adaptWorktreeService`. The service is read with `ctx.get`, never declared injection, so an absent service answers `worktree-unavailable` exactly as before.
- **ref=slug.** The consumer never constructs a reference: the slug the service mints into `WorktreeHandle.slug` is the address `worktree.lock`/`worktree.remove` carry. The wire brand (`WorktreeRef`) re-brands onto the service's slug id verbatim through one documented cast — the two brands name the same string by convention, and the convention lives in the adaptation module.
- **Vocabulary mapping at one boundary.** Spawn: the input's `sessionName` is the service's `intent`; the handle's `sessionName` is the service-minted `session` (`<seat>.<slug>`), not the caller's input — the seam owns naming, the caller supplies ownership and intent. Rows: `session` → `sessionName` and `lockReason` → `locked`/`lockReason`. Because the service spawns every worktree locked (`<seat> <session>` creation reason, see [the seam note](2026-08-31-worktree-capability-seam.md)), a fresh mint refuses wire `worktree.lock` until the seat-side lifecycle unlocks it; the wire surface deliberately has no unlock verb yet.
- **Refusals fold into a three-code consumer vocabulary.** The service's `WorktreeError` codes map `LOCKED`/`ALREADY_LOCKED` → `worktree-locked`, `NO_ROW` → `worktree-unknown`, and every other code — plus any non-`WorktreeError` throw — → `worktree-forbidden`; the service's message always reaches the caller verbatim, because the message is the reason the caller sees. The mapping is deliberately open on the forbidden side: the consumer distinguishes only what the wire distinguishes, so an upstream code added later folds without a consumer change instead of coupling the consumer to the full upstream list.

| Service refusal | Wire `seamCode` |
| --- | --- |
| `LOCKED`, `ALREADY_LOCKED` | `worktree-locked` |
| `NO_ROW` | `worktree-unknown` |
| every other code, and any non-`WorktreeError` throw | `worktree-forbidden` |

## Testing

- `tests/api-proxy-worktree.spec.ts` drives every verb through a `WorktreeService` double over the real interface shape — rows born locked, `NO_ROW`/`ALREADY_LOCKED`/`LOCKED` refusals with the service's message texts — so the spawn-input→intent mapping, the minted-session handle, the row projection, and every folded refusal are exercised at the RPC surface, not against a hand-rolled seam.
- The client side gained contract currency for the new domain: the two `FakeApiClient` test doubles implement `IApiClient['worktree']`, and the connection fixture's in-memory contract impl serves the four verbs with a born-locked registry.

## Alternatives considered

- **Rewrite the handlers against `WorktreeService` directly** — rejected: five call sites would each redo the input/result mapping and the refusal folding, and the wire tests would mock the service instead of the consumer contract. One adaptation seam keeps the handlers stable and makes the mapping itself the tested unit.
- **Map every `WorktreeError` code onto a wire code 1:1** — rejected: it couples the consumer to the full upstream vocabulary and forces a consumer edit whenever the service adds a code. The three-code vocabulary is what the wire's callers distinguish; everything else is "not permitted as asked" with the reason carried verbatim.
- **Re-register the service under the consumer's old `worktree` key** — rejected: two Context keys for one service invites reads of a key nothing mounts; the package's own registration (`worktrees`) is authoritative and the consumer reads it.

## Consequences

- The wire error's `seamCode` details field is now always present on `worktree-refused`: the adaptation types every throw, where previously only typed seam errors echoed a code.
- A spawned handle's `sessionName` semantics changed with the real service: it is the seam-minted `<seat>.<slug>` session, not the caller's spawn input. Callers that echoed the input name must read the handle.
- The wire surface cannot transition a born-locked worktree to lockable or removable — unlock lives seat-side through the service itself. The verb joins the wire when a wire caller needs it (README Known Limitations).
- Client packages that fake `IApiClient` must carry the `worktree` domain; contract currency for a new `RpcMethodMap` domain reaches the client test doubles in the same change.

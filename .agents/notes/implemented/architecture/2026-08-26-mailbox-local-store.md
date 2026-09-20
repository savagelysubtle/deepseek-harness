# Agent Note: Mailbox local store — SQLite leasing semantics

Status: implemented

English | [中文](2026-08-26-mailbox-local-store.zh.md)

## Problem

The mailbox seam (see the capability-seam note) defines publish/claim/settle but ships no store, so every address in `ctx.mailbox` is unroutable until a provider lands. Queue exclusivity is the design's load-bearing decision: two drainers (one per process, or two after a restart) must never deliver the same message concurrently, while a crashed claimer's message must come back automatically. The opencode fork prior art kept claim state in process memory, so a crash left rows permanently invisible.

## Decision

`@deepseek-ai/dsh-mailbox-local` implements the provider contract over `node:sqlite`'s `DatabaseSync` with all exclusivity living in SQL:

- A claim is ONE `BEGIN IMMEDIATE` transaction: candidate select (pending or `claimed_at <= now - staleClaimMs`, ordered FIFO by `created_at`) followed by a guarded UPDATE whose `changes === 1` result admits the winner. The check is belt-and-suspenders over the transaction — it keeps the winner relation true even if a future edit loosens the transaction mode.
- Lease refs embed a fresh random claim token (`<message id>:<claim token>`). Settlement matches token AND `state = 'claimed'`, so stale-reclaimed leases, double settles, and refs from other stores all reject instead of miswriting. Refs are strings rather than memory handles: they stay valid across process restarts and die exactly when their row's token rotates.
- `settle(pending)` returns the row to a fresh `pending` state (lease columns cleared), which is how a bridge defers when session residency says "live holder elsewhere" without waiting out any staleness window.
- Schema ownership rides a `mailbox_meta.schema_version` stamp checked inside the open transaction: empty files initialize at v1; non-mailbox files and any foreign version reject the mount loud. Monotonic, no migration path — the pre-release stance covers reformatting freely.
- The plugin resolves config once (`path?` → `<dsh home>/mailbox/mailbox.db`), opens synchronously so an incompatible database fails the mount itself, and registers provider `local` through `ctx.effect`; disposal unregisters first, then closes the handle (storage-sqlite ordering).

## Alternatives considered

Rejected: pid artifacts in queue rows (the named-sessions lock already owns residency liveness; duplicating it here would wedge leases that stale-timestamp reclaim dissolves); `PRAGMA user_version` for the schema stamp (a bare integer cannot distinguish "mailbox database" from "some other tool's file" the way a named meta table can); configurable journal mode (no deployment needs a rollback-journal fallback yet; WAL stays fixed until one does).

## Verification

The package suite covers version-stamp acceptance/rejection, payload round-trip with optional-field omission, address scoping, the limit bound (including SQLite's negative-LIMIT-reads-unbounded trap), stale reclaim via an injected clock at the exact boundary, pending-deferral, terminal failure, settlement rejection paths, default-path resolution, and registry mount plus disposal proof on a real `Context`. Composition coverage boots this provider through the Loader with the bridge slice, per the testing policy.

## Consequences

Every named agent address becomes durably routable within one machine, and the bridge slice can be written against a working store instead of mocks. The store keeps zero in-memory delivery state, so kill -9 loses nothing already published. Cross-process contention surfaces as loud `SQLITE_BUSY` until the bridge adds pacing — accepted because silent retries would hide lost-wakeup bugs the drain loop must own anyway.

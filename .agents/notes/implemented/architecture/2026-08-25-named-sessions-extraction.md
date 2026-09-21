# Agent Note: named-sessions extraction from headless

Status: implemented

**Date:** 2026-08-25 · **Packages:** `@deepseek-ai/dsh-named-sessions` (new), `@deepseek-ai/dsh-headless` · **Kind:** architecture

**Supersedes the in-package placement described in** [2026-08-25-headless-named-sessions.md](2026-08-25-headless-named-sessions.md): the derivation and lock contracts are unchanged; only their home moved (that note's "inside packages/bundle/headless" placement now lives here as a shared package).

## Problem

The named-session primitives — grammar validation, id derivation, the per-name lock with stale-pid takeover, and the id-to-lock path algebra — lived only inside the headless bundle's own `src/named-session.ts`, private to that package. That was sufficient while headless was the primitive's only consumer, but the mailbox bridge (then in design) needed to cold-resume dormant named sessions and exclude itself from live headless runners through that same lock artifact, which meant a second consumer now needed to compute the identical derived id and reach the identical lock path. Implementing the derivation a second time in a second package risked the two token computations drifting apart silently, since nothing ever compares the name again after the first write — exactly the class of divergence a one-way hash hides.

## Decision

The named-session primitives — grammar validation, id derivation (`named-` + 32-hex SHA-256 token), the per-name lock with stale-pid takeover, and the id-to-lock path algebra — moved verbatim out of the headless bundle's own `src/named-session.ts` into the new utility package `@deepseek-ai/dsh-named-sessions`. The id/lock relation invariant moved with them; headless now carries a justified-empty invariant companion. Headless depends on the new package and its behavior is unchanged: same derived ids, same lock artifact at `headless/locks/<token>.lock`, same failure messages.

## Why extract now

The mailbox bridge (in design) cold-resumes dormant named sessions and must exclude itself from live runners through the **same** lock artifact. Duplicating the derivation in two consumers would let the two token computations drift — the exact class of silent divergence the one-way hash hides, since nothing ever compares the name again after first write. One owner makes the artifact location and grammar load-bearing in exactly one place.

## The `maxAgeMs` takeover bound

`acquireNamedSessionLock(name, { maxAgeMs })` adds one takeover path: a holder that is provably alive but recorded its `createdAt` longer ago than the bound loses the artifact. Default (absent) keeps shipped semantics exactly — pid liveness is the only takeover path. A live holder whose payload lacks a readable timestamp still rejects even with the bound set: age cannot be proved, so the conservative reading wins. This gives the bridge's deferred-delivery loop a bounded-wait escape without weakening the runner's mutual exclusion.

## Required verification

- Moved suite (`packages/session/named-sessions/tests/named-session.spec.ts`) covers derivation, grammar, acquire/release, stale-pid and torn-artifact takeover, real OS liveness probing, and the three new `maxAgeMs` cases (aged takeover, young rejection, undated rejection).
- Headless unit + real-composition suites pass unchanged against the package import.
- The relocated invariant still fails loud on announced named ids without held locks.

## Alternatives considered

- **Keeping the primitives in headless and importing from the bundle**: inverts the dependency direction — bundles compose packages, utilities must not depend on bundles.
- **Folding the primitives into `dsh-home-paths` or another util**: mixes exclusion semantics into an unrelated home; the lock algebra deserves its own invariant companion.

## Consequences

Headless carries a new dependency on `@deepseek-ai/dsh-named-sessions` and now holds a justified-empty invariant companion rather than owning the id/lock relation invariant directly. Any future consumer — the mailbox bridge included — gets identical derivation and lock behavior by depending on the package rather than reimplementing it, which is the point of the move, but it also means the derivation algorithm and the lock artifact path (`headless/locks/<token>.lock`) are now a shared contract: changing either now affects every consumer at once rather than one package in isolation. The new `maxAgeMs` takeover bound shipped in the same change and is available to every consumer, not only the one that motivated it, so headless's own lock behavior stays unchanged only because it does not pass the option.

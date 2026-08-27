# Agent Note: named-sessions extraction from headless

**Date:** 2026-08-25 · **Packages:** `@deepseek-ai/dsh-named-sessions` (new), `@deepseek-ai/dsh-headless` · **Kind:** architecture

**Supersedes the in-package placement described in** [2026-08-25-headless-named-sessions.md](2026-08-25-headless-named-sessions.md): the derivation and lock contracts are unchanged; only their home moved (that note's "inside packages/bundle/headless" placement now lives here as a shared package).

## Decision

The named-session primitives — grammar validation, id derivation (`named-` + 32-hex SHA-256 token), the per-name lock with stale-pid takeover, and the id-to-lock path algebra — moved verbatim out of `packages/bundle/headless/src/named-session.ts` into the new utility package `@deepseek-ai/dsh-named-sessions`. The id/lock relation invariant moved with them; headless now carries a justified-empty invariant companion. Headless depends on the new package and its behavior is unchanged: same derived ids, same lock artifact at `headless/locks/<token>.lock`, same failure messages.

## Why extract now

The mailbox bridge (in design) cold-resumes dormant named sessions and must exclude itself from live runners through the **same** lock artifact. Duplicating the derivation in two consumers would let the two token computations drift — the exact class of silent divergence the one-way hash hides, since nothing ever compares the name again after first write. One owner makes the artifact location and grammar load-bearing in exactly one place.

## The `maxAgeMs` takeover bound

`acquireNamedSessionLock(name, { maxAgeMs })` adds one takeover path: a holder that is provably alive but recorded its `createdAt` longer ago than the bound loses the artifact. Default (absent) keeps shipped semantics exactly — pid liveness is the only takeover path. A live holder whose payload lacks a readable timestamp still rejects even with the bound set: age cannot be proved, so the conservative reading wins. This gives the bridge's deferred-delivery loop a bounded-wait escape without weakening the runner's mutual exclusion.

## Alternatives declined

- **Keeping the primitives in headless and importing from the bundle**: inverts the dependency direction — bundles compose packages, utilities must not depend on bundles.
- **Folding the primitives into `dsh-home-paths` or another util**: mixes exclusion semantics into an unrelated home; the lock algebra deserves its own invariant companion.

## Required verification

- Moved suite (`packages/session/named-sessions/tests/named-session.spec.ts`) covers derivation, grammar, acquire/release, stale-pid and torn-artifact takeover, real OS liveness probing, and the three new `maxAgeMs` cases (aged takeover, young rejection, undated rejection).
- Headless unit + real-composition suites pass unchanged against the package import.
- The relocated invariant still fails loud on announced named ids without held locks.

# Agent Note: Headless named sessions — derivation over a map store

Status: implemented

## Problem

`dsh --profile headless` ran one fresh session per invocation. Automation that splits a long task across invocations had no way to land each run in the same durable session without minting and tracking session ids itself.

## Decision

- `sessionId = SessionId('named-' + sha256(name).hex[0..32))`. The 32-hex suffix doubles as the filename component of the lock artifact, so one hash serves identity and locking.
- Create-vs-resume checks persisted-log existence via `sessionPersistence.list()` membership (the same primitive the API remote resolver uses) and then calls `agents.resume({resumeSessionId})` or `agents.create({sessionId})`. A present-but-unloadable log rejects loudly from `resume`; nothing silently recreates over a broken log.
- Mutual exclusion uses one lock artifact per name at `headless/locks/<hash>.lock`, created `O_EXCL` holding `{pid, createdAt}`. Staleness is holder-pid liveness (`ESRCH` ⇒ dead ⇒ take over); a live holder fails loud with exit 1. Release verifies the artifact still records the releasing holder before unlinking, so a taken-over loser never deletes its successor's lock. Takeover retries are bounded (5 attempts) so two racing acquirers cannot livelock.
- All resolution lives in an explicit `resolveRunSpec()` step in the runner; `run()` consumes a closed union (`one-shot | named`) instead of re-defaulting config fields inline.
- In json mode the runner subscribes to the `session/event` firehose scoped to `seq >= firstSeq` recorded before the followup, streaming one NDJSON line per `assistant/message`. The line shape `{"type":"text","sessionID":...,"part":{"type":"text","text":...}}` mirrors the existing SDK text-part vocabulary instead of inventing a headless-only envelope; the plain text summary is suppressed in this mode.

## Verification

Unit suites cover derivation determinism and pattern validation, lock acquire/release/takeover/live-holder rejection (liveness probe injected), create-vs-resume branching, NDJSON shape and firstSeq scoping, summary suppression, and lock release on failure paths. A real-composition Loader test boots the shipping loop over the JSONL backend twice against a scripted model: run one creates and streams well-formed NDJSON; run two resumes and its model request contains the prior conversation.

## Alternatives considered

- **A name→id map store under the harness home, consulted on every run**: rejected. It loses to derivation on every axis this bundle cares about. A map is one more file created, torn by SIGKILL between rename and content write, and corrupted when two invocations race their first run for the same name — exactly the concurrency named sessions exist to serve. Derivation (`named-<sha256(name)[0..32)>`) makes every process compute the same answer with zero shared mutable state instead; there is nothing to create, lock for its own integrity, or clean up. The cost is deliberate: names cannot be enumerated (the caller owns the name map), which is documented as a known limitation rather than hidden.
- **Recording the human name on the `SessionHeader` and resuming by header lookup**: rejected. It would couple the session format to a display concern. Adding a field to the header ripples through `SESSION_FORMAT_VERSION`, both persistence backends' validation, and every projection consumer — version-bump pressure from an optional convenience. It also still needs a lookup index over headers to resolve name → id, reintroducing the map problem at worse layering. If a future surface genuinely needs first-class names, that decision belongs to the session format's own change, not to a bundle patch.

## Consequences

Named sessions work across processes with no coordinator beyond the filesystem. The caller owns name enumeration, and the pid-liveness staleness rule accepts a narrow takeover race (pid reuse or simultaneous takeover) documented in the README's known limitations.

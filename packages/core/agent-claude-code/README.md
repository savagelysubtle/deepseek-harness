# @deepseek-ai/dsh-agent-claude-code

English | [中文](README.zh.md)

The **Claude Code seat driver** package: a seat keeps its name, mailbox, registry row, and log, and only the thinking moves to the unmodified `claude` program run through the official Agent SDK under the operator's own login. Like [`agent-loop`](../agent-loop/README.md), the driver is its own package and registers against the keyed agent-factory seam in [`dsh-agent`](../agent/README.md); nothing in core depends on it.

This slice ships the **durable record layer only**: the event vocabulary, the redacting recorder, and the invariant companion. The SDK runtime, steering, tools, and fleet limits land in later slices, and `apply` is intentionally inert until the factory registers.

## Durable events

Six log-only events (no surface; they never enter model context), each stamped `version: 1`. The browser-safe `@deepseek-ai/dsh-agent-claude-code/types` subpath owns the payload types and the `SessionEventMap` declaration; the generated [persistence catalog](../../../docs/persistence-catalog.md) lists them.

| Event | Written when | Notable fields |
|---|---|---|
| `claude-code/session-bound` | Before the first prompt of a seat, so a crash cannot lose the binding | dsh `sessionId`, `sdkSessionId`, `model`, `driver: 'claude-code'`, `at` |
| `claude-code/turn-completed` | The SDK `result` message of one turn | `turnIndex`, `outcome` (`success` or the SDK error subtype), `isError`, `numTurns`, `durationMs`, `durationApiMs`, `estimatedCostUsd`, `usage`, per-model `modelUsage`, optional `stopReason` |
| `claude-code/steer` | A push, interrupt-then-push, or resume steered a seat | `kind`, short redacted `reason` (at most 200 characters), `at` |
| `claude-code/compact` | A Claude-side `compact_boundary` | `preTokens`, `trigger` (`auto` or `manual`), `at` |
| `claude-code/rate-limited` | A rate limit was observed | `source` (`sdk` or `http`), optional `retryAfterMs`, `breakerTripped`, `at` |
| `claude-code/fleet-refused` | The fleet limiter refused a turn | `reason` (`concurrency`, `turns-per-hour`, `breaker`, `founder-reserve`), `limit`, `observed`, `at` |

`estimatedCostUsd` is the SDK's notional cost; on a subscription it is a usage signal, not a bill.

## Recorder

`recordClaudeCodeEvent(session, type, data, warn?)` is the only writer. It never throws and returns whether the event was appended:

- The payload is **rebuilt from named fields** (an allowlist), so unknown fields, prompt text, tool-result bodies, response bodies, and headers cannot ride along. Only `retryAfterMs` survives from a rate-limit response.
- Free text (steering reasons, outcomes, stop reasons) is control-stripped, **token-redacted** (`sk-ant-…`, other `sk-…`, GitHub tokens, Slack `xox*-`, AWS `AKIA…`, JWTs, bearer, and `token`/`secret`/`password`/`api_key` assignments including quoted JSON values, plus any 40-plus-character token-like run), **path-redacted** (a leading `/` or `~` and at least two segments; dates, `a/b/c`, and URL tails are left alone), and capped (500 characters; 200 for the steering reason). Identifier fields (`sessionId`, `sdkSessionId`, `model`) skip the long-run and path rules, because cwd-salted session ids are legitimately longer than 40 characters.
- SDK numbers that are missing, negative, or non-finite are recorded as `0`.
- The result is snapshotted to lossless JSON before the append; a circular, hostile, or otherwise unrecordable input drops the event instead of failing the turn. The optional `warn` sink receives a one-line drop reason (the recorder has no logger of its own).

## Invariant

`@deepseek-ai/dsh-agent-claude-code/invariant` registers the package companion. On cold load and every live append it requires: `version: 1`; the required fields and enums of each event; a `session-bound` before any `turn-completed`, `steer`, or `compact`; and strictly increasing `turnIndex`. Repeated `session-bound` events (re-binding) are allowed. `rate-limited` and `fleet-refused` may precede binding because a refusal can happen before a session starts. It is not yet mounted in a bundle; composition lands with the driver.

## Known Limitations and Deferred Work

- **No runtime yet** — the SDK-backed `Agent`, streaming steering, cancellation, tool policy, and fleet limits are later slices; this package only records what they will report.
- **`turnIndex` is strictly increasing per Session** — a driver that restarts numbering within one Session would be rejected by the invariant.
- **Redaction is shape-based** — a credential that matches none of the known shapes (for example a bare short secret with no key name, a PEM block split across lines, or a base64 blob under 40 characters) is out of scope and not recognized, which is why bodies and prompts are never recorded at all.
- **S4 requirement: seed `turnIndex` on resume** — on cold resume or crash fallback the driver must seed `turnIndex` from the Session's last `claude-code/turn-completed` plus 1; restarting numbering at 1 within an existing Session is rejected by the invariant.

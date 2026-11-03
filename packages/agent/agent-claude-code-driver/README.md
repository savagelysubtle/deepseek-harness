# @deepseek-ai/dsh-agent-claude-code-driver

English | [中文](README.zh.md)

The **Claude Code seat driver**: a seat whose registry row says `driver: claude-code` keeps its name, mailbox, row, and dsh log, and only the thinking moves to the unmodified `claude` program, run through the official Agent SDK under the operator's own login. dsh never sends a model request itself and never touches the login token.

The package registers a factory under the `claude-code` key of the keyed agent-factory seam in [`dsh-agent`](../../core/agent/README.md) (`ctx.agents.setFactory(factory, 'claude-code')`). Callers that pass no `driver` still reach the default loop ([`agent-loop`](../../core/agent-loop/README.md)) unchanged. The durable record vocabulary lives in [`agent-claude-code`](../../core/agent-claude-code/README.md); this package reuses its recorder.

## Seat row

```yaml
seats:
  mail-triage:
    driver: claude-code
    claude_code:
      model: haiku            # alias or full id; a fable id is rejected unless the row sets fable_ok: true
      effort: low             # optional: low | medium | high | xhigh | max
      role: mail-only         # coder | lead | mail-only
      max_turns: 20           # SDK maxTurns for one query
      claude_path: /home/me/.local/share/claude/versions/2.1.317/claude   # absolute, required
      max_calls_per_window: 30   # optional; enforced by a later slice
    fable_ok: false
```

- `claude_path` must be absolute and is used as given: there is never a PATH lookup (`which claude` may be a wrapper script).
- The validator folds the model id with Unicode NFKC, drops invisible format characters, and lowercases it before looking for `fable`, so full-width or zero-width spellings do not slip through.
- The plugin `Config` is `{ stateDir, seats, disposeGraceMs?, defaultPauseMs? }`. Until the registry slice lands, the seat for a session is looked up by `meta.agentPreset`, else by the session id.

## Turn model and steering

Every turn is one streaming-input `query()`. Its `prompt` is an open `AsyncIterable<SDKUserMessage>` (`PromptStream`) that stays open while the query runs.

- **First query** passes a fresh UUID as `sessionId`; **later queries** pass `resume` with `persistSession: true`. The driver appends `claude-code/session-bound` to the dsh log **before the first prompt is sent**, so a crash between bind and prompt keeps the binding. A bound session whose Claude transcript is missing or unreadable after a completed turn is refused: `claude-code/resume-failed` is appended and the turn fails with a "needs a re-seed" remedy. The driver never starts a fresh Claude session silently, and the mail stays queued.
- **`agent.steer(msg)`** claims the message and pushes it into the open stream. Claude consumes it at its **next model-call boundary**, so the latency is the remaining time of the tool call in flight (the S0 spike measured a push at 8 s landing at 24.5 s during a 20 s `sleep`). `agent.followup(msg)` queues a separate later turn.
- The stream is closed once every pushed message has been answered by a `result` and the inbox is empty. A result that names none of the pushed message uuids is taken as answering all of them.
- **Fallback:** `interruptAndResume(msg)` calls `query.interrupt()`, then delivers the message in a resumed query. The result iterator throws after an interrupt, so interrupt and close are wrapped.
- **Phase machine:** exactly one live query per seat in this process. A second `create`/`resume`, or a second agent's turn, for a seat with a live query is rejected with a coded error (`CLAUDE_CODE_SEAT_BUSY`).

## Tools, options, and cancel

- Every query sets `settingSources: []`, `strictMcpConfig: true`, `permissionMode: 'dontAsk'`, `maxTurns`, `model`, the pinned `pathToClaudeCodeExecutable`, and the scrubbed `env`. `lead` and `mail-only` seats get `tools: []`; `coder` seats get `Read, Grep, Glob, Edit, Write`. Native `Bash` and `AskUserQuestion` are always in `disallowedTools`.
- `QueryOptionsExtension` is the typed extension point for inline `settings` (hooks and deny rules, a later slice). It is applied before the fences, so it cannot loosen them.
- **Cancel** aborts the controller, calls `query.close()` (try/catch), then makes the child's process group exit: the subprocess owner's SIGTERM-then-SIGKILL ladder first, a direct group `SIGKILL` if it cannot prove the tree gone. The turn ends `aborted`, and the inbox is cleared unless `keepInbox`.
- **Process ownership:** the child is spawned through the shared subprocess owner in its own process group. The pid and process start time of each seat's child are recorded in `<stateDir>/claude-code-seat-pids.json`; at plugin start `ProcessLedger.reapStale()` kills a recorded child whose start time still matches and ignores recycled pids.

## Environment

The child environment is the credential-scrubbed parent environment minus `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `CLAUDE_CODE_OAUTH_TOKEN`. The plugin refuses to start, and every turn refuses to run, when any of those is set in the host environment.

## Subscription pause

The SDK has no dedicated "rate limit" result subtype. The driver treats these as the window being refused: a `rate_limit_event` whose `rate_limit_info.status` is `rejected` (reason `usage-exhausted` for the `overage` type or `credits_required`, else `rate-limit`), an assistant message with `error: 'rate_limit'` or `'billing_error'`, and a result with `api_error_status: 429`. The seat appends `claude-code/paused {reason, until?}`, stops the query, fails the turn with code `CLAUDE_CODE_PAUSED`, and refuses further turns (mail stays queued) until the reset time, or `defaultPauseMs` (15 minutes) when none was reported. This is a per-seat signal only; fleet-wide pausing is a later slice.

## Durable records written

`claude-code/session-bound`, `claude-code/resume-failed`, `claude-code/steer`, `claude-code/paused`, and one `claude-code/turn-completed` per turn (mapped from named `result` fields only). The turn index is the dsh turn number, so it keeps increasing across restarts as the record invariant requires.

## Known Limitations and Deferred Work

- **No event mapper yet** — assistant text, tool calls, compaction boundaries, and unmapped messages are not yet written to the dsh log (plan section 9); only the records listed above are.
- **No lease or inbox integration** — the driver runs on the agent inbox; failing a mailbox lease on pause or resume failure, crash-recovery idempotency keys, and the bridge flip refusal belong to later slices.
- **Seat lookup is provisional** — seats are found by `meta.agentPreset` or the session id until the registry slice supplies the real resolver.
- **Rules, git fence, and sandboxed shell are not wired** — only the options extension point exists; coder seats have no shell.
- **Transcript check uses the SDK** — `getSessionInfo` returning nothing is read as a missing transcript, so a transcript with no extractable summary would also be refused.
- **Per-seat window cap and fleet limits** — `max_calls_per_window` is validated but not enforced.

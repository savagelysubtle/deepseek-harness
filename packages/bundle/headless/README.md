# `@deepseek-ai/dsh-headless`

English | [中文](README.zh.md)

The dsh one-shot bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`dsh-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker as a core execution capability, and inserts this package's `headless-runner` plugin (config `{task}`, resolved from the injected `headlessStartup` provider). It mounts no Host, HTTP server, Web runtime, or browser plugin.

After the Loader settles, the runner reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), creates or resumes one persisted Agent through `ctx.agents`, submits the task as an ordinary user message, and waits for quiescence. It flushes the Session before folding the owned durable event interval, reports the assistant output in the requested format, and requests exit through the launcher-provided `ctx.appExit` host hook ([`dsh-cmdline`](../../boot/cmdline/README.md)) (final `turn/end` completed → 0, otherwise 1). A terminal `error` reason also writes its code and message to stderr; successful runs keep stderr empty. The process opens no listening port.

The task text and output flags are this app's command line: the ordinary `headless-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), parses `dsh --profile headless [flags] "task"`, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and resolves lazy config from it (`resolveRunSpec()` in [`src/index.ts`](src/index.ts)). A missing or whitespace-only task is rejected before the runner activates.

## Flags

| Flag | Effect |
| --- | --- |
| `--session-name <name>` | Target a durable named session instead of a fresh one-shot session. The task positional stays mandatory. |
| `--format <text\|json>` | Output format; defaults to `text`. An unknown value is a usage failure (exit 1). |

## Named sessions

With `--session-name <name>`, the session id derives deterministically from the name: `named-<first 32 hex digits of sha256(name)>` ([`src/named-session.ts`](src/named-session.ts)). There is no name-to-id map store to create or corrupt — every process computing the derivation for the same name lands on the same durable id. If no log is persisted under that id, the runner calls `agents.create`; if one exists, it calls `agents.resume`. A present-but-unloadable log surfaces the persistence backend's error loudly instead of silently recreating. Names must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` because they feed a filename component on disk; invalid names are usage failures (exit 1).

Concurrent invocations of one name exclude each other through a per-name lock artifact at `<home>/headless/locks/<hash>.lock` (`DSH_HOME`, default `~/.dsh`). The artifact is created with `O_EXCL` holding `{pid, createdAt}`. A holder whose pid is dead (`ESRCH`) is stale and its artifact is taken over; a live holder makes the invocation fail loud with `session "<name>" is active in another process` (exit 1). The lock is released when the run settles, including failure paths.

### Output formats

- `text` (default) prints the last non-empty assistant message of the run's interval.
- `json` streams one NDJSON line per `assistant/message` event of the run's interval, shaped exactly:

```json
{"type":"text","sessionID":"<id>","part":{"type":"text","text":"<joined text blocks>"}}
```

  Events before the run's first seq are never streamed, and the plain text summary is suppressed.

## Model Experience

None, as the runner submits the task as an ordinary user message; prompts and tools belong to the base and headless bundle rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **One submitted task only** — the runner has no interactive follow-up surface; it waits through any work the Agent completes before returning to idle and reports the last non-empty assistant message in that interval.
- **`ctx.appExit` is launcher-owned** — booting the headless profile outside the `dsh` launcher fails loud at activation until the host provides the exit request.
- **No name enumeration** — derivation over a map store means the harness cannot list existing session names; the caller owns the name map.
- **Narrow lock-takeover race** — staleness is decided by holder-pid liveness, so pid reuse or a takeover race between two acquiring processes can hand the lock to the wrong process in a narrow window.

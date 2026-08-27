# @deepseek-ai/dsh-seat-runner

English | [中文](README.zh.md)

The wake-on-arrival executor: a small long-lived daemon that polls the mailbox store for claimable work and starts seat runs through the standard headless entrypoint, beside the web host and under the same per-name lock any human run takes (the one-writer rule in [docs/architecture.md](../../../docs/architecture.md) § "Session log"). The daemon contains no seat logic — discovery, registry resolution, and one shell-out are its whole job, so a second project with different seats and edges needs only a new registry file, never new code.

## Model

- **Discovery** — every poll interval the daemon reads `claimableAddresses` from the configured mailbox store (default `<dsh home>/mailbox/mailbox.db`): addresses holding at least one `pending` message, or one whose claim went stale. This mirrors the drain path's own selection, so what the daemon sees is exactly what a run would admit.
- **Resolution** — each address `<namespace>:<name>` resolves through the org registry (`@deepseek-ai/dsh-mailbox`'s `loadOrgRegistry`): the name must be a roster seat and the seat's namespace must match the address. An unroutable address warns once per daemon run and is skipped; it stays pending for whoever fixes the roster.
- **Wake** — one child process per seat, never more: `dsh --profile headless --session-name <name> --mailbox-namespace <namespace> "<wake task>"`, executed in the seat's registry-resolved workspace. Backlog admission inside the run is the headless runner's existing behavior; a mail already claimed by another run simply is not discovered here.
- **Failure handling** — a nonzero wake exit (the proven contended-lock case: a human or another run holds the seat's lock) leaves the mail pending and puts the seat into exponential backoff: `backoffBaseMs * 2^min(attempts-1, maxBackoffExponent)`, reset by any clean exit. The exponent cap keeps a stuck seat retrying slowly instead of never.
- **Lifecycle** — the interval loop contains its own faults (a failed tick logs and continues); `SIGINT`/`SIGTERM` stop the loop and close the store while in-flight wake children finish independently as ordinary headless processes.

## Config

`dsh-seat-runner [--registry <path>] [--store <path>] [--poll-interval-ms <n>] [--stale-claim-ms <n>] [--entrypoint <cmd>] [--backoff-base-ms <n>]`

| Flag | Default | Meaning |
|---|---|---|
| `--registry` | `<dsh home>/org/registry.yml` | Org registry file (roster, edges, call-up). |
| `--store` | `<dsh home>/mailbox/mailbox.db` | Mailbox SQLite database to poll. |
| `--poll-interval-ms` | `5000` | Discovery tick interval. |
| `--stale-claim-ms` | `120000` | Staleness bound for discovery; mirrors the headless backlog drain. |
| `--entrypoint` | `dsh` | Command a wake run shells out to, resolved through PATH. |
| `--backoff-base-ms` | `2000` | Base of the exponential wake backoff (exponent capped at 6). |

Every value validates at boot; an invalid flag fails loud instead of starting a misconfigured daemon. The wake task text is not a flag: it is pinned model-visible text owned by this package (below), changeable only in source, because its framing is a contract shared with the in-turn delivery path rather than a per-deployment tuning knob.

## Extension points

- The mailbox store is any `MailboxProvider` implementation exposing `claimableAddresses`; the seam owns provider substitution.
- The org registry is data (`interagent` topology lives in the file, not in code); adding seats, edges, or a second company is file editing.

## Model Experience

### Request context and condition

#### What the model sees

When mail arrives for a seat and no run holds its lock, the daemon starts a headless run whose task text is the fixed literal below, delivered as the run's ordinary task after the backlog drain.

##### Verbatim wake task text

```markdown
You have new mail. Use the mailbox tool to drain your inbox, handle each message, then stop.
```

#### Token effect

Once per wake run, approximately 25 tokens, replacing nothing — a fresh or resumed run reads it as its task turn.

#### KV Cache effect

Append-only within the woken run's first turn; the literal is byte-stable, so resumed runs keep their cached prefix up to the appended task text.

## Known Limitations and Deferred Work

- **Single-store discovery** — the daemon polls one mailbox database; a deployment that serves seats from more than one store needs one daemon per store, with no cross-store coordination.
- **Workspace existence is a wake-time failure** — registry `cwd` paths are not checked at boot; a missing workspace fails the wake run (loud in the log) rather than the daemon start, so a broken seat cannot block the other seats' mail.
- **No per-seat environment isolation** — wake children inherit the daemon's environment; OS-level isolation between departments stays deferred per the messaging redesign plan.

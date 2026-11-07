# @deepseek-ai/dsh-agent-claude-code-registry

English | [中文](README.zh.md)

The **registry glue** for the [Claude Code seat driver](../agent-claude-code-driver/README.md). It joins two packages that do not know each other: the mailbox bridge, which owns the single view of the org registry and passes each delivery a frozen seat binding, and the driver, which owns the Agent SDK, the host-private seat entries, and the mail admission seam. It has no config, holds no state, and needs only the agent registry (`inject = ['agents']`).

It provides two things on the context:

- **`ctx.claudeCodeSeatSource`.** Called by the driver when a seat is not in its static config. It takes the binding the bridge put in `agentOptions.seatBinding` (`{seat, rowHash, row}`), recomputes the hash of the row, compares it with the hash of the bridge's current row (`ctx.mailboxSeatRows.current(seat)`, which returns only the row hash, the driver and the two admission lists, never the cwd, session id or tools), and returns `{seat, row}` only when they agree. It refuses a request with no binding (so the api-proxy and every other caller can never open a Claude Code seat), a missing `mailboxSeatRows` service, a binding whose row does not match its own hash (forged), a stale binding (the registry row changed since the bridge bound it), a seat the bridge holds no valid row for, and a row that does not select `driver: claude-code`.
- **`ctx.claudeCodeMailHooks = { admit }`.** The driver runs `admit` on every send and steer. It applies the row's `admit_from` (the seats whose mail the seat accepts; empty means nobody) and `admit_sender_classes` through the same pure function the bridge uses (`admitsMail` in `dsh-mailbox`). It fails closed: no row service, an unknown seat, mail that names no sender, or a hop class the registry has no name for all deny. The object has **no `lease` property**: the mailbox lease sink belongs to a later slice, and until then the driver keeps its own lease handling.

## What a registry row can and cannot do

The registry row is an untrusted request: it names the driver and who may mail the seat, nothing else. The model, effort, caps, `claude_path`, its sha256, `fable_ok`, the working directory pin and the widest sender list are the **host entry** under `hostSeats` in the driver's profile row, which the founder owns and no seat can write. The glue never reads host config. Someone who can edit the registry can deny service to a seat, shrink its sender list, or flip its driver (the bridge refuses a flip over a log with the other driver's history). They cannot choose the binary, enable a fable model, change the model, the caps or the working directory, or widen `admit_from` beyond the founder's `admit_from_ceiling`.

```yaml
# profile cordis.patch.yml: two rows, two owners
- insert:
    - id: agent-claude-code-driver            # host config, founder-owned
      name: '@deepseek-ai/dsh-agent-claude-code-driver'
      config:
        stateDir: claude-code
        claudePathPrefixes: [/home/me/.local/share/claude/versions]
        hostSeats:
          mail-triage:
            model: haiku
            role: mail-only
            claude_path: /home/me/.local/share/claude/versions/2.1.317/claude
            cwd: /home/me/work/mail-triage
            admit_from_ceiling: [ops-lead]
    - id: agent-claude-code-registry          # this package: no config
      name: '@deepseek-ai/dsh-agent-claude-code-registry'
```

The full example, with every optional field commented, is [`tests/fixtures/profile.cordis.patch.yml`](tests/fixtures/profile.cordis.patch.yml); a spec parses it and checks it against the driver's own `Config` schema. The registry row for the same seat names `driver: claude-code`, the `admit_from` list and the classes. The two mount in any order (the driver and the glue read each other lazily), and the mailbox bridge must also be mounted for a seat to open.

## Who can mail a Claude Code seat

In plain terms: a Claude Code seat accepts mail only from the seats its row lists in `admit_from`, and only in the classes its row lists in `admit_sender_classes`. Both lists default to nobody.

- `dsh-mailbox send --from steve` is class `unverified`: steve is not a roster seat, and the transport prefixes `guest:`. A Claude Code seat refuses it unless the row lists `unverified` and names the sender, which hire allows only on test seats.
- Class `seat` means "any roster seat", not "trusted". The bridge admits guest mail to every address it serves, so every default-loop served seat counts as externally exposed. The code checks only that the row's list fits inside the founder's `admit_from_ceiling`; the ceiling is the founder's attestation that those seats are not reachable from outside.
- The bridge's own admission is the verdict the sender sees. This package's `admit` is defense in depth behind it, for a caller that reaches the driver without the bridge.

## Tests

`tests/source.spec.ts` (the verifying source), `tests/admit.spec.ts` (the allow and deny matrix), `tests/composition.spec.ts` (the glue, the real driver and a fake bridge in all six mount orders), and `tests/fixture.spec.ts` (the example profile). The bridge is replaced by a fake that provides only the row service; the SDK and the `claude` binary are never started.

## Known Limitations and Deferred Work

- **The mailbox lease is not wired** — `claudeCodeMailHooks` carries no `lease`, so a refused or paused seat's mail is queued while the bridge has already settled it as delivered; the sender sees delivery. The mailbox lease sink (slice S8) closes it.
- **The host-entry check is a delayed warning** — the registry loads after mount and the row service cannot tell "not loaded yet" from "absent", so a host entry with no registry row is reported once, shortly after mount, not at the instant of mounting.
- **Only `mail-only` seats** — any other role in a host entry is refused until the permission slice (S5) lands.

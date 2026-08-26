English | [中文](2026-08-26-guest-mailbox-access.zh.md)

# Agent Note: Guest mailbox access — outage-time store interface + drain-time governance

Status: implemented

## Problem

Outside council is summoned precisely because the harness is broken; during
the 2026-08-26 `dsh web` outage there was no channel to any seat — Steve
hand-carried every message. A bridge plugin cannot fix this: it dies with the
plugin tree that is failing (the bootstrap paradox). The multiprocess SQLite
store, however, was already sanctioned by design as a concurrent-writer
surface; what was missing was guest ergonomics and governance.

## Decision

Two paths over one address space, chosen by host health. Path A (host up):
the landed `mailbox.publish` RPC — its existence is this spec's Path A;
governance now says guests may use it. Path B (host down): the new
`dsh-mailbox` bin shipped on `@deepseek-ai/dsh-mailbox-local` itself, so the
writer is version-locked to `SCHEMA_VERSION` and cannot drift into tripping
its own compatibility gate.

- Guests publish always and drain their own inbox at arrival (claim + settle
  `done`; `--peek` defers to `pending`). No push surface: guests are not
  persistent processes.
- First-writer safety: file creation (`0700` dir / `0600` file) moved into one
  shared `openLocalMailbox` used by BOTH the plugin mount and the CLI, so an
  out-of-harness first write never falls back to the ambient umask. No second,
  copy-pasted creation path exists to diverge.
- Drain-time admission (`admitFromNamespaces`, default empty = fail-closed):
  an external writer bypasses write-side checks by construction, so acceptance
  of foreign-origin mail is decided in `deliverLease` before routing.
  Unparseable senders fail closed. Chairs-only is then composition, not code:
  only chair bridges opt into `['guest']`.
- Payload isolation prerequisite (council-found DoS): one malformed-payload
  row previously poisoned the WHOLE claim batch for every address. The claim
  loop now isolates such rows (claim-owned, settled `failed/malformed-payload`
  after commit) and delivers their siblings.

Rejected per council table: a claudecode-bridge plugin (bootstrap paradox);
interop with Claude Code's own messaging (wrong transport, live-only);
`peek()`/`list()` on MailboxProvider (claim+settle-pending already expresses
non-consuming read — PR-B contract stays frozen); push notifications (guests
are not pageable); write-time enforcement (impossible by construction); a
separate guest-mailbox package (~200 lines of ceremony).

Corrections recorded where the diffs touched them: plan config is `path`
(→ `mailbox.db`) not `databasePath`(→ `.sqlite`); seat convention is colon form
`<namespace>:<name>` (`gotham:alfred`), not slash; directory-vs-package-name
divergence noted on the plan's package table.

## Verification

CLI suite: round-trip with payload file, `--peek` non-consumption, loud
schema-version rejection, grammar rejection pre-write, both-payload-sources
conflict, POSIX first-writer modes, real-bin piped stdin through the execution
guard. Store suite: malformed-payload row isolated while batch siblings
deliver (council test 4). Bridge suites: down-host bootstrap (CLI write with
no host, inline mount drain delivers the dormant seat), admission gate
fail-closed default, admitted-guest delivery, unparseable-sender fail-closed.
Composition suite (real Loader): guest mail settles `failed/sender-not-admitted`
under the default composition and delivers end-to-end once the roster opts in.

## Consequences

Council becomes reachable for the exact window it exists for: harness down.
Seats answer guests by publishing back to `guest:<agent>` addresses no bridge
serves — intentionally parked rows drained out-of-band; PR-F's send tool must
route parked destinations via plain `ctx.mailbox.publish()` (never
`publishAndWake`, whose roster gate would reject them). Audit retention of
guest mail remains open policy; today receipts settle `done` and age out.

# Agent Note: Seats can hold a mailbox conversation without forging identity

Status: implemented

English | [中文](2026-08-29-mailbox-seat-conversation-slice.zh.md)

## Problem

Sender attribution on delivered mail was fixed separately (see the mail relay envelope note), but three gaps remained before seats could actually converse.

**A seat had no way to send at all.** No in-process mailbox tool existed. `tool-cordis` is read-only inspection and is not in the shipped bundles, so a seat's only send path was shelling out to `dsh-mailbox send --from <anything> --to <anyone>`. `--from` is free text, so a seat could forge any sender including the founder. The envelope defanged that at the receiving end; the ability to write the forgery still existed.

**The store could not date or correlate a message.** `MailboxMessage` carried no send time — the sqlite table had `created_at` but never selected it into the record — so the relay dated mail by `lease.claimedAt`, the *delivery* moment, misdating anything that sat queued. And nothing could look a message up by `traceId`, so the bridge could not establish that an incoming message answered one the recipient had sent. That is the second half of the witnessed alfred/robin failure: a reply read as a fresh instruction.

**Three admission rules were declared but not enforced.** `orgRegistryAllows()` was exported, fully tested, and had zero non-test callers, so the org's `edges` and `callUp` were decorative. There were no loop guards beyond `maxClaimPerCycle`. Worst, `~/.dsh/org/registry.yml` stated in a comment that "the loader must refuse any edge that crosses the test:true boundary, so these can never reach a live seat" — the `test` field was parsed, type-validated, and enforced nowhere. Throwaway test seats could reach live production seats. A promise with no code behind it is worse than no promise, because it is relied upon.

## Decision

**Sender identity comes from the transport.** A new `@deepseek-ai/dsh-tool-mailbox` package registers two tools. `mailbox_send` takes `to`, `subject`, `body`, and optional `blocking` — and **no `from`**: the runtime fills it from the trusted session name the launcher supplied, so a seat physically cannot claim to be another seat or the founder. `mailbox_check_inbox` takes **no arguments at all**, so a seat can only ever drain its own address. An anonymous run (no session name) fails both tools loud at call time rather than falling back to an untrusted identity. The `dsh-mailbox` CLI remains the outside-operator bootstrap path but stamps its sender `guest:<original>` unconditionally, un-suppressible and not pre-satisfiable by already-prefixed input; a stamped sender never matches a roster seat, so the receiving end renders it `unverified`.

**The store now dates and correlates.** `MailboxMessage.sentAt` is required and provider-minted at publish from the existing `created_at` column, never re-stamped by claim, reclaim, or settle — a message that sat queued keeps its admission time. A new `MailboxPublishInput = Omit<MailboxMessage, 'id' | 'sentAt'>` keeps both provider-minted fields out of caller reach, the same discipline already applied to `id`. `MailboxProvider.lookupByTraceId(traceId)` returns `MailboxTraceEntry[]` (`{ id, from, to, sentAt }`, earliest first) as a pure read that claims, settles, and mutates nothing — enough for a caller to establish that a correlation id has travelled before and in which direction.

**Admission is ordered, and the boundary outranks the graph.** Drain-time admission now runs: registry health, then the `test: true` boundary, then org topology, then sender admission, then loop guards. A seat marked `test: true` may exchange mail only with seats also marked, in either direction, and that rule **outranks the admission list, the edge list, and `callUp`** — which would otherwise carry a call-up seat straight across it. Topology refusals name the route `findOrgRegistryRoute` offers, so a sender is told the path it should have used. Loop guards are a size cap, a per-address depth cap, identical-repeat suppression, and a per-`traceId` hop counter: guards only, never a spend cap, and guard memory records real admissions so a lease deferred back to pending is re-judged rather than suppressed by its own earlier check.

## Alternatives considered

**Let the send tool accept `from` and validate it.** Rejected. Validation against what? The only authority is the registry, and a seat that may legitimately mail any peer could then name any peer as sender. Removing the field is the only version with no bypass.

**Treat a missing org registry as "refuse everything".** Rejected for a *missing* file, kept for a *broken* one. A missing registry is a deployment with no org graph — the CLI bootstrap world — where the registry-dependent rules have nothing to judge and no-op. A present file that will not load refuses loud: no check could prove an exchange boundary-safe, and silently permitting is precisely the failure the boundary exists to prevent. Fixing the file self-heals the bridge on the next cycle.

**Add spend caps alongside the loop guards.** Explicitly out of scope by founder ruling. The guards stop an oversized message and a self-resending loop; they hold no opinion about the org's total work.

## Consequences

Reply threading is still not rendered. The seam it needs now exists (`sentAt` plus `lookupByTraceId`), but `delivery.ts` was deliberately left untouched this round so the four parallel work streams held disjoint file ownership. Rendering "replying to your message of …" is the remaining piece before a back-and-forth reads as a conversation rather than a series of unrelated instructions.

`MailboxMessage.sentAt` being required is a breaking change for any code constructing the record directly; the in-repo call sites are updated, and `MailboxPublishInput` is the type publishers should use.

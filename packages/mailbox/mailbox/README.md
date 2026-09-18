# @deepseek-ai/dsh-mailbox

English | [中文](README.zh.md)

The mailbox capability seam: durable, cross-process agent messaging with publish/claim/settle semantics. This package owns the **Service Definition** role — the provider contract, the address grammar, the `ctx.mailbox` registry, and the `mailbox` message-source kind. Concrete stores live in their own packages (`mailbox-local`, `mailbox-rest`); consumers such as the mailbox bridge depend on this definition, never on a provider.

## Service API (`ctx.mailbox`)

| Member | Semantics |
|---|---|
| `registerProvider(provider)` | Admits one store under its own name; duplicate names fail loud; returns the unregistering disposer (fiber disposal triggers it). |
| `getProvider(name)` | Exact-name lookup; `undefined` when not live. |
| `list()` | Live providers in registration order. |
| `publish(message, signal?)` | Convenience through the configured `defaultProvider`; validates the destination grammar in the admitting operation. |
| `claim(filter, signal?)` | Default-provider claim after validating every filter address. |
| `settle(leaseRef, outcome, signal?)` | Default-provider settlement of one lease. |
| `lookupByTraceId(traceId, signal?)` | Default-provider pure read of every stored message carrying a traceId (`{ id, from, to, sentAt }` per entry) — the direction evidence a consumer needs to recognize a reply; claims and settles nothing. |
| `declareRoster(mountId, addresses)` | SWD-118 roster-drift alarm, condition (A): declares one mount's served roster and warns — never throws — if it disagrees with a roster already declared under a different mount id, naming both mount ids and the specific seats each side is missing. See [Roster-drift alarm](#roster-drift-alarm). |

## Contracts

- **Address grammar** — the seat's bare name, reusing the named-session name pattern (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`); one name names one seat, so the bridge derives target session ids with no second encoding. `parseMailboxAddress`/`formatMailboxAddress` round-trip by construction.
- **At-least-once delivery** — a crashed claimer's lease is reclaimed after `staleClaimMs`; consumers tolerate duplicate claims.
- **Sent time is provider-minted** — every delivered message carries `sentAt` (epoch ms), stamped when the provider admitted it and never re-stamped by a claim, reclaim, or settlement, so queued mail keeps its original date; `lease.claimedAt` remains the delivery-claim moment.
- **`done` = inbox admission** — settlement records that the message reached its target's queue, never an answer; replies travel as newly published messages. The `result` column of an outcome is the delivery envelope only, never business payload.
- **Default resolution fails loud** — conveniences without a registered configured default throw at call time naming the gap; named-provider calls are unaffected.

## Config

| Field | Type | Default | Semantics |
|---|---|---|---|
| `defaultProvider` | string? | absent | Provider name for the no-argument conveniences. Blank names fail schema validation at mount; unknown names fail loud at first resolved call. |

## Roster-drift alarm

Seat identity is maintained BY HAND in three places: the org registry (`~/.dsh/org/registry.yml`) and the served `addresses` of both `mailbox-bridge` and `tool-mailbox`. Nothing checked that they agree until this ticket; when they diverged in the past, mail to the missing seat was silently swallowed — no error, no bounce. Exactly two conditions alarm, at mount time, by founder ruling — both warn loudly and never throw, refuse a mount, or block mail:

- **(A) the two served rosters disagree with each other** — `MailboxRegistry.declareRoster` above, called once by each mount.
- **(B) a roster serves a name the org registry does not know** — judged by each mount alone (it already holds both its own roster and the registry it was configured with); see the `roster` module's [`unknownServedSeats`](./src/roster.ts) and [`loadRegistrySeatNames`](./src/roster.ts).

**Deliberately NOT alarmed on:** a seat the registry lists that no roster serves. That gap is normal and, on the production deployment, deliberate — `test: true` seats and any intentionally unserved seat are never meant to receive mail. Alarming there would be noise from day one.

A registry that is simply ABSENT is the legitimate no-registry world (the down-host CLI bootstrap case): nothing is knowable as a seat, so condition (B) no-ops rather than alarming. A registry that EXISTS but will not load is different, and the alarm itself must never become a silent failure: that case warns explicitly that condition (B) could not be checked, instead of quietly passing as "nothing is wrong."

## Extension points

Providers implement [`MailboxProvider`](./src/provider.ts) and register through `ctx.mailbox`. Address resolution policies (chair-to-chair aliasing) layer on top of the grammar extension point documented in [`provider.ts`](./src/provider.ts) — none ships yet.

## Model Experience

Indirectly, through its consumers: the bridge and the headless runner render admitted messages as user turns attributed to the merged `mailbox` message source; the seam registers no prompt or schema of its own.

#### KV Cache effect

Independent: delivered messages enter history through their consumers, so any prefix effect belongs to the delivering surface, not this seam.

## Known Limitations and Deferred Work

- **No subscription/watch surface** — claimers poll; a change-notification event may join the seam when a second bridge shape needs push semantics.
- **No cross-provider addressing** — addresses carry no provider qualifier; the default-provider indirection assumes one logical store per deployment namespace.

# Agent Note: Mail refusals log a durable notice into the sender's session

Status: implemented

English | [中文](2026-08-29-mail-refusal-durable-sender-notice.zh.md)

## Problem

A mailbox admission refusal was, for the sender, a silent fence. The bridge settled the recipient's row `failed`, warned the host log, and emitted `mailbox/refused`; the host's api-proxy turned that event into a `host/agent-error` wire frame addressed to the sender's session. But that frame is effectively invisible, and this was proven in a live browser test: a refused send from `tt-ping` to `t2-loner` settled the row with the exact reason, and the sender's session displayed nothing for the next 2.5 minutes. Two client-side facts explain it. The manager's `host/agent-error` handler is `this.sessions.get(frame.sessionId)?.handleAgentError(...)` — the `?.` drops the frame when the sender's session object is not resident in the client — and `handleAgentError` writes `lastAgentError`, a single-slot transient field: no conversation node, no reload survival, no sidebar mark. The rail is right for a synchronous failure (the persistence fence, which fires while the user is in the session) and wrong for an asynchronous one, which fires when nobody is watching.

## Decision

The bridge logs the refusal into the SENDER's session as a durable context node, alongside (not instead of) the existing wire frame, which stays as the live toast. `injectRefusalNotice` runs inside the same `refuse` call that settles the row and emits the event, and appends a `user/message` whose merged source is a new `MailboxRefusalSource` — `kind: 'mailbox'`, `form: 'notice'`, carrying `refusedTo` (the attempted recipient), `messageId` (tying the notice back to the send), `reason` (verbatim), and a bounded `summary`. `MailboxMessageSource` became a union of that and the existing relay source, discriminated on `form`.

**No `from`, deliberately.** `mailboxRelay()` on the client keys on `kind === 'mailbox'` plus a readable `from`; stamping `from` would render the refusal as an incoming mail card. It is the harness reporting on the sender's own action, not correspondence from the refused recipient, so the notice carries no sender field and never reads as mail.

**No loop, structurally.** The notice never enters the mail store — it is appended to the session log directly — so no admission rule, including the one that fired, can ever judge it. Nothing claims it, nothing refuses it, nothing re-drains it. The alternative already in the codebase proves why the distinction matters: a post-admission failure publishes a `bounce` through the store, which is safe exactly because the bounce is not admission-judged in the failing direction — but a refusal's cause IS an admission rule, so a stored bounce would be refused by the very rule it reports. Injection failure is also contained: every path inside `injectRefusalNotice` warns instead of raising, because a raise out of `refuse` would hand the lease to the drain's generic failure handler, which publishes a bounce — reintroducing the circular route.

**No interrupt.** The notice never touches the agent inbox: no `steer`, no `followup`, no waking `send`. The sender is usually mid-turn — it just called the send tool — and a waking delivery from a refusal would let a seat interrupt itself. For a resident sender the append lands in the log and the running driver reads it from history on the request it already runs; for a dormant sender the bridge takes the same per-session lock delivery uses, resumes the agent, appends, flushes durable, and disposes without ever driving a turn, and never creates a session — a sender that has never run, like a `guest:` sender, is notified through nothing (the CLI channel reports its own outcome).

**Presentation.** The client reads the notice with `mailboxRefusal()` (recipient AND reason required — a confident card over a mystery is worse than the generic row) and renders a dedicated refusal card: the mail card's geometry, but a warning icon and the error accent where the mail card carries a mail icon and the business blue. It starts collapsed (a refusal interrupts nothing, unlike blocking mail), keeps the recipient and reason visible while closed, and exposes `data-context-mail-refusal` as the stable browser-test hook. A source missing its recipient or reason falls through to the generic `notice` presentation rather than blanking.

## Alternatives considered

**Bounce the refusal back through the store.** Rejected outright — the circularity is the original design constraint: the bounce would be subject to the rule that refused the original, refused in turn, and the sender would have seen silence. This is a deliberate narrowing of [the founder-model-and-bounces note](../architecture/2026-08-26-mailbox-founder-model-and-bounces.md): its "bounce on every terminal failure" holds for failures AFTER admission (routing, wake, provisioning), while an ADMISSION refusal — whose cause is itself an admission rule — reports on the context bus and logs this durable notice instead of storing a bounce.

**Wake the sender with the notice (`followup`).** Rejected: a refusal must never start a turn. The sender may be mid-turn; a waking delivery from a refusal is the self-interrupt loop shape the founder model already rejects for peer mail.

**Reuse `agent.inject()` (the non-waking inbox lane).** Rejected as the durable outlet: injected context is transient — claimed only at a later step boundary, discarded by cancellation or disposal — so a refusal could be lost exactly when the sender goes quiet. It is the right lane for model-facing narration, the wrong one for a durable record.

**Fix only the client frame (`host/agent-error`).** Rejected as insufficient: making the error surface when the session object happens to be resident still leaves it transient, unlisted, and unreloadable. The frame is kept for its live-toast value; the durable node is the outlet.

## Consequences

Every refused send now leaves three durable traces: the recipient's failed row, the context event, and the notice in the sender's log — plus the live frame. The sender's model sees the refusal (log appends join derived history), so it does not re-send unchanged expecting success. A refusal whose sender's registry entry cannot resolve (broken registry) degrades to the row and event only — the notice is best-effort by design and its failure never masks the refusal.

## Verification

- `packages/mailbox/bridge/tests/bridge.spec.ts` — live-sender notice (exact source, no `from`, no wake, exactly one refusal event, no store rows), dormant-sender resume/append/flush/dispose without provisioning, guest and unparseable senders skipped, a guard refusal (`duplicate-suppressed`) also noticed.
- `packages/mailbox/bridge/tests/composition.spec.ts` — real Loader tree: warmup persists the sender, a no-edge seat-to-seat send is refused, and the sender's JSONL log on disk contains the `notice` source with the store id and no `from`.
- `packages/client/runtime/tests/context-provenance.client.spec.ts` — `mailboxRefusal()` reads, degrades, and never matches the relay form.
- `packages/client/ui-conversation/tests/mail-refusal-row.client.spec.tsx` — the refusal card renders (and the mail card still renders for relay sources; a field-less notice degrades to the generic row).

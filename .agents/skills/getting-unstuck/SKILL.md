---
name: getting-unstuck
description: Use when a problem is not yielding — you have theorised twice about the same thing, a fix did not work, or you are about to try a third variation of an idea. Covers reading the artifact before reasoning about it, searching instead of recalling, using the scratchpad to think on paper, and fanning a problem out to coworkers rather than going vertical alone
---

# Getting unstuck

## The tell

**You have explained the same failure to yourself twice and it still is not fixed.**

That is the signal. Not frustration, not elapsed time — *repetition*. The second
time you find yourself refining a theory rather than testing one, stop and use
this.

Going vertical alone is the expensive failure: one agent takes one hypothesis
deep, then the next, then the next — serially, paying full price for each. Four of
those in a row is a wasted hour that four perspectives would have collapsed into
one round.

## 1. Look at the artifact before reasoning about it

**Read the actual thing.** The corrupt file, the real log line, the response body,
the on-disk bytes. Not what should be in it — what is.

> **Worked example, 2026-08-28.** A session log was reported as
> `corrupt Zstandard session log: complete frame contains a torn JSONL record`.
> I spent three rounds reasoning about zstd frame boundaries and flush semantics.
> Then I ran `zstd -dc file | tail` — the file ended with a clean newline, every
> line was valid JSON, and the last three records read `seq 169`, `seq 170`,
> `seq 80`. It was a **sequence regression from a stale writer**, not a framing
> fault at all. One command, and it was answered outright.

The lesson generalises: **an error message names a symptom, not a cause.** That
message pointed at the compression layer, and the fault was two writers with
independent counters. If you reason from the message you inherit its mistake.

## 2. Search — you do not remember everything

Reach for the web early, not as a last resort. Things change, and the fact that
you *know* something does not mean you remember it correctly.

Search is most valuable for **ruling a whole branch out cheaply**. In the example
above, research established that a zstd frame can be byte-perfect while its payload
ends mid-record — which is what let me stop treating the compression layer as the
suspect and go look at the file.

A senior engineer with thirty years still reads the docs. Not knowing is normal;
guessing when you could check is not.

## 3. Think on paper — use the scratchpad

Write the problem out in `org/<seat>/scratchpad/` **while you are working, not
after**. Writing forces the gaps into the open: you often see the flaw in your own
reasoning as you write the sentence claiming it.

Worth writing down as you go:

- what you observed, quoted exactly — not paraphrased
- what you have ruled **out**, and the evidence that ruled it out
- the hypothesis you are testing right now, stated so it could be wrong
- anything surprising, even if it seems unrelated

The ruled-out list is the valuable part. It is what stops you, or the next agent,
re-walking a dead branch.

⚠ The scratchpad is **working notes, not memory**. Durable conclusions go to the
memory tool or the vault. A gotcha worth keeping goes to both — the vault so
nobody re-learns it, memory so you have it to hand.

## 4. Fan it out — ask your coworkers

**This is the one that beats going vertical.** When you are stuck, send a
`blocking` message to your department:

⚠ **Assign the directions. Do not ask for "a different perspective."**

Your coworkers run the **same model you do**. Told to "take a different angle" they
will reach for the same first suspect you did, and you will get four copies of your
own reasoning back — or a round of conversation deciding who does what, which is
the latency you were trying to avoid.

**Split the search space yourself, in the message.** Vague is fine; unassigned is
not.

Bad:

> *"I'm stuck on the corrupt log. Can you each take a different angle?"*

Good:

> *"Stuck on a session log reported corrupt. Ruled out: the lock change (all
> writers agree now) and concurrency (the other process had exited before the
> write). Please take one each —*
> - *batman: read the actual bytes. Decompress it and look at the tail.*
> - *robin: the write path. Can anything end a frame mid-record?*
> - *lucious: the readers. Is the error message even accurate for what's on disk?*
> - *me: I'll research the compression format's guarantees.*
>
> *Report what you found even if it's 'not this' — that's still a branch closed."*

Then each seat runs its assigned hypothesis in parallel, and you reconcile.

Why it works better than thinking harder alone:

- **Breadth beats depth when you do not know where the fault is.** Four cheap
  parallel probes beat one expensive serial descent.
- **Assigned directions produce genuinely different guesses.** Standing context
  helps — a seat that has been working the UI reaches differently from one working
  the store — but do not rely on it. The assignment is what guarantees coverage;
  context only sharpens it.
- **The answer is often between the answers.** Sometimes one seat is right;
  sometimes it takes a combination, and none of them would have got there alone.

Say what you have already ruled out, or you will get your own dead branches back.

⚠ **Not available until inter-seat mail is working.** Until then the fan-out is
Steve, so make it cheap for him: bring the observation, what you ruled out, and a
specific question — not a narrated struggle.

## 4b. No coworkers? Escalate — do not go outside on your own

If you have nobody to fan out to, **that is an escalation, not a licence to reach
outside the org.**

- **You are a seat with a lead:** message your lead. Stuck long enough to have
  ruled things out is exactly what the escalation path is for, and your lead can
  fan the problem across the department in one message.
- **You hold the `outside-thinking` skill:** use it — read that skill first, the
  rules there are not optional.
- **Neither:** say so plainly and hand the problem up with what you ruled out.

⚠ **Reaching a model outside this harness is deliberately restricted to the
orchestrator and the guest session.** Not gatekeeping for its own sake — if a CEO
or a department seat could do it too, every question would round-trip: the
orchestrator asks, the seat goes and researches, the seat reports back. The point
of concentrating it at the top is that the thinking gets hashed out **once**, at
the tier that can act on it, and a conclusion goes down rather than a task coming
back up.

So if you are stuck and outside help is what you need: **say that to your lead.**
Getting it is their call, not yours.

## 5. Know when to stop

Two failed attempts at the same problem means the framing is wrong, not that the
third attempt will land. Re-state the problem, or escalate.

And if what broke is a **test session**: do not repair it. Record what broke it,
fix the code, delete the session, spawn a new one. See `dsh-session-testing`.

---
name: dsh-user-testing
description: The standing flow for verifying a dsh feature the way an operator actually experiences it — launching a throwaway host, driving the web UI with playwright-cli, and the cold-read check that is the only proof a session log is intact. Use before declaring any user-visible change done.
---

# Testing dsh like a user

**A feature is not done because its tests pass.** Steve's standing rule: *"before
declaring it passed, you must go in as a user with playwright, double check things,
click it around like a user, make sure it all works."*

Unit tests prove the code does what you told it to. This proves the operator gets
what they wanted. Those have diverged repeatedly in this project — most expensively
when a health probe reported `"ok": true` for a session log that was already torn.

Run this flow the same way every time. Skipping a step is how the last one got missed.

---

## 0. Blast radius — before anything starts

**Launch the server and every session from `Coding/dshTest`. Never from a real
department.** Steve, 2026-08-28: *"Just launch a server and sessions from test never
from real departments."*

This is not caution for its own sake. Everything shares one `~/.dsh`: one mailbox,
one lock directory, one session tree. A test that spawns from `deepseek-harness`
puts a stray session in the harness's own panel and can reach live seats.

**Never message Steve from a test.** To exercise a round trip, use a **ring**:
`seat 1 → seat 2 → seat 3`, never `2 → 1`. His reasoning: a ring shows the telephone
game — you can see what each hop actually received — and a fault cannot corrupt the
sender it came from. A two-seat ping-pong hides both.

## 1. Find the host by process, never by config

```bash
ss -tlnp | grep LISTEN
```

The unit file has claimed 3030 while the host was actually on 3080. **A correct
config is not evidence of what is running.** Read the live socket.

To stop one: `pkill -f "dsh web"` does **not** match — the real cmdline is
`node …/bin.js web`. Kill by pid from `ss`, or you will start a second host that
mutates shared state and then dies on the port conflict, having already done damage.

**Never mutate `~/.dsh/sessions` or `~/.dsh/storages/*` while a host is live.** It
reconciles against what it finds and garbage-collects what it does not. That cost
twelve workspace registrations once.

## 2. Establish the baseline BEFORE the change

Open the UI and record what "correct" looks like now — which sessions are grouped,
what the seat is called, what the panel shows.

```bash
playwright-cli open http://127.0.0.1:<port>
playwright-cli find "tt-"     # search the a11y snapshot; returns refs
playwright-cli screenshot
```

Without a baseline you cannot tell a fix from a coincidence. Half the "it works now"
claims in this project were a UI that had always looked like that.

## 3. Drive it as a person, not as an API

Click the thing. Type in the box. Reload the page. Use the actual controls:

```bash
playwright-cli click <ref>
playwright-cli fill <ref> "some text" --submit
playwright-cli goto http://127.0.0.1:<port>    # reload — state must survive
```

An operator does not call your endpoint; they click a button and read a panel. If
the change affects what they see, **the rendered page is the artifact under test.**

## 4. The cold-read check — the one that actually catches corruption

**This is the step that gets skipped, and it is the only one that proves the log.**

A running host answers session reads **from memory**. A torn or mis-sequenced log
looks perfectly healthy until something reads it fresh from disk. A probe against a
live host is worthless for this:

```bash
# WORTHLESS for log integrity — served from the host's cache
curl .../session.history   →  {"ok": true}
```

So force a cold read:

1. Stop the host (by pid, per §1).
2. Start it again.
3. Open the session in the UI.

If it opens with its history intact, the log is genuinely sound. If it was torn, this
is where it surfaces — and where it would have surfaced for Steve tomorrow instead.

Reading the artifact directly also beats reasoning about it. Decompressing one log
answered in a single command what three rounds of theorising about zstd framing had
not:

```bash
zstd -d -c ~/.dsh/sessions/<workspace>/<session>/session.jsonl.zstd \
  | python3 -c "import json,sys; [print(json.loads(l)['seq'], json.loads(l)['type']) for l in sys.stdin if l.strip()]" \
  | head -40
```

Seq numbers must be contiguous from 0. A repeat or a jump backwards is the tear.

## 5. State the evidence, or it did not pass

Never write "verified" alone. Say which surface you looked at and what it showed:

> *"Spawned `tt-ping` from dshTest, host on 3080. Panel showed it under the dshTest
> group, not Ungrouped. Renamed it, reloaded the page — still there, history intact.
> Restarted the host and reopened it cold: 214 events, seq contiguous."*

Steve cannot see what you did. *"The tool said it worked"* has been wrong here often
enough that it counts for nothing on its own.

## 6. Clean up

Test sessions are **throwaway**. A broken one gets deleted, not repaired — the fix
belongs in the codebase, not in that log. A corrupt log on a **live** seat is the
opposite: that is an incident. Archive it, tell Steve, delete nothing without asking.

---

## Related

- `dsh-session-testing` — the sandbox itself, the seat roster, spawning
- `playwright-cli` — the command surface used above
- `getting-unstuck` — when the thing under test will not cooperate

## Field notes

> Append what you learn, dated. Do not rewrite the body mid-task; these get folded
> in at the weekly skill review.

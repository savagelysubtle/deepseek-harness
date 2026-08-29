---
name: dsh-session-testing
description: Use when testing seat spawning, mail delivery, workspace grouping, session titling, or anything else that creates or drives a dsh session — covers the dshTest sandbox, why you spawn from deepseek-harness rather than in it, and the standing rule that a broken session is thrown away rather than repaired
---

# Testing sessions in dsh

You are working **in `deepseek-harness`**. You spawn from here, and you **message
into** the test seats. You do not spawn from the sandbox and work there.

That distinction is the whole point: the sandbox holds throwaway *targets*, not a
workplace. A real coding session that lives in `dshTest` has confused the two.

## The sandbox

`/mnt/Dev/Coding/dshTest` — five scratch markdown files and three test seats:

| Seat | Role |
|---|---|
| `tt-lead` | stands in for a department lead |
| `tt-ping` | sends |
| `tt-pong` | replies |

They are registered in `~/.dsh/org/registry.yml` with `test: true`, and the
registry refuses any edge crossing that boundary — a test seat cannot mail
`alfred`, `robin`, `yoda` or any `web-*` seat, and none of them can mail a test
seat. **That boundary is a backstop, not your first line of defence.** Address
test mail to `tt-*` names deliberately.

Everything shares one `~/.dsh`: one mailbox, one lock directory, one session
store. That is deliberate — tests exercise the real multi-process behaviour rather
than a simulation of it, which is exactly why the seat names have to carry the
isolation.

## A broken session is evidence, not a patient

**Standing rule from the founder. This is the most important line here.**

When a session log corrupts — a torn frame, a wedged lock, history that will not
load — **do not try to repair it.**

> *"It never appends right, it never gets back into fix, and then you spend five,
> six rounds trying to fix something, and then I have to stop you and just say
> forget it. So let's stop now and say forget it instead of six rounds later."*

This has been attempted repeatedly over several days and has never once worked.

**Do this instead:**

1. **Record what broke it.** The cause is the valuable part — it is a code bug and
   it will reach a real seat if you do not find it.
2. **Fix the code**, not the log.
3. **Delete the session** and spawn a fresh one.
4. **Re-test** against the new session.

The only legitimate reason to open a corrupt log is to understand the failure well
enough to fix its cause. The moment you have that, stop.

Sessions in `dshTest` are disposable without exception — all of them can be thrown
away at any time, and the area gets audited and wiped periodically.

⚠ **Scoped to the sandbox.** A corrupt log on a **live** seat is an incident:
archive it, tell Steve, and delete nothing without asking.

## Spawning a test seat

```bash
dsh-hire tt-ping --dry-run          # resolve identity, cwd, lock, memory — spawn nothing
dsh-hire tt-ping --brief "…"        # create or resume
```

`dsh-hire` reads the seat's project directory and recorded session id from the org
registry, refuses a seat the registry does not know, refuses while the seat's lock
is held by a live process, and pins the panel title. `--dry-run` first is cheap and
tells you exactly what is about to happen.

⚠ **Known issue:** `dsh-hire` pins the title over the host API immediately after
the headless process exits, and "exited" is not "log flushed". This is the
suspected cause of two corrupted logs on 2026-08-28. Until it is fixed, prefer
`--no-title` when you do not need the panel name.

## Verifying like a user

Code-level tests do not prove the operator's experience. For anything that changes
what a person sees:

```bash
playwright-cli open http://127.0.0.1:3080
playwright-cli find "tt-"        # search the a11y snapshot, returns refs
playwright-cli click <ref>
playwright-cli screenshot
```

Check the rendered page, not a log line or a tool's own report — all three have
been individually wrong.

## Before you touch `~/.dsh` state

**Check whether a host is running, by process rather than by config:**

```bash
ss -tlnp | grep LISTEN          # the host is on 3080, NOT the 3030 the unit claims
```

Mutating `~/.dsh/sessions` or `~/.dsh/storages/*` while a host is live has already
cost a workspace registry once: the host reconciled against the emptied directory
and garbage-collected every registration. `pkill -f "dsh web"` does **not** match —
the real cmdline is `node …/bin.js web`. Kill by pid from `ss`.

## The rollback

`dsh-stable` is a frozen known-good build at `/mnt/Dev/Coding/dsh-stable`, invoked
as `dsh-stable`. It is never rebuilt from source. If a dev build breaks the thing
you drive, that is the way back.

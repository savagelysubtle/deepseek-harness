# Agent Note: Machine-owner wake budget with a loud wind-down turn

Status: implemented

English | [中文](2026-08-26-machine-owner-wake-budget.zh.md)

## Problem

`tool-jobs` bounds its self-exciting wake chain with `maxConsecutiveWakes` (default 3), reset only when an owner claims a user-authored message. For a delegated subagent child that bound is mis-shapen twice over: the child's approval policy is pinned to `'never'` at delegation (`dsh-subagent` `captureDelegatedPolicyOverrides`), so it can never ask a human to unstick it, and its inbox fills almost exclusively with plugin notices — which deliberately never refill the budget. Past exhaustion, completions degrade to injection, and injection does not open a turn: a parked child strands silently beside its own finished work (see `interagentstuff/plans/background-lifetime-findings-2026-08-26.md` §2.1).

## Decision

Two-class semantics keyed off the durable header (`SessionHeader.origin === 'subagent'`):

- Interactive owners: unchanged — `maxConsecutiveWakes` (3), silent degrade to injection.
- Machine-owned owners: new validated `Config.machineOwnerWakeBudget` (default 16, same whole-number discipline; `Infinity` stays rejected because the guard must bound, not vanish), and at exhaustion exactly one **wind-down turn**: a wakeup-lane delivery instructing the child to persist state via the memory tool and remain quiet, after which deliveries inject without opening turns. A user-authored claim resets budget and wind-down together, so every input epoch costs at most K+1 woken turns — the liveness guard is replaced with a loud cap, not removed.

The wind-down names the memory tool because the child's scratchpad lives only in its conversation; persisting is what makes a later poke by anyone effective.

## Alternatives considered

- Unlimited wakes for machine owners — rejected: the self-exciting chain still needs a bound; only its shape differs from a human's.
- Pure per-owner policy knob with no class distinction — rejected as the primary mechanism: every deployment would have to know to configure it, silently re-introducing the stall for anyone who does not; origin classification is durable in the header and needs zero configuration. The knob still exists (`machineOwnerWakeBudget`) for deployments that want a different ceiling.
- Refill on any claimed message including plugin notices — rejected: it deletes exactly the bound that stops a wake/start/complete loop.

## Consequences

- Interactive sessions see zero behavior change; existing snapshot fixtures hold.
- Delegated children stay live across long background-job chains while remaining bounded per epoch.
- Config surface grows by one key documented in both README config tables.

## Required verification

Keyless unit lanes in `tool-jobs.spec.ts`: machine budget wake sequence, wind-down content, epoch reset, and interactive-owner regression pins (silent degrade, no memory-tool text).

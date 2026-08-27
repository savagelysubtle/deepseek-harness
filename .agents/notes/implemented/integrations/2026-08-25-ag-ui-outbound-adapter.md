# Agent Note: AG-UI outbound adapter placement and allowlist

**Date:** 2026-08-25 · **Package:** `@deepseek-ai/dsh-ag-ui` · **Kind:** architecture/integration

## Decision

The external-dashboard surface ships as its own optional plugin, `@deepseek-ai/dsh-ag-ui`, owning a dedicated `node:http` listener at `POST /ag-ui/:threadId`, translating durable session events into [AG-UI](https://docs.ag-ui.com) SSE frames through an explicit allowlist. Translation is a pure module (`src/translate.ts`); transport is a thin shell (`src/server.ts`); Cordis coupling lives only in `src/index.ts`.

## Why a separate listener instead of the web-GUI server

`ctx.webServer`'s contract is browsers-only, loopback-bound, and unauthenticated; the dashboard surface exposes session content to non-browser consumers and therefore needs bearer auth on every route. Mounting there would either weaken the GUI server's stated guarantees or fork its routing per consumer. Precedent: ACP owns stdio, `sdk/server` owns its HTTP socket. Cost accepted: deployments run one more port, placed behind their TLS-terminating gateway.

## Why an allowlist with drop-on-unmapped

The wire leaves the process trust boundary. Session event maps are merge-extensible — any plugin can add vocabulary — so a default-forward rule would leak new payloads (prompt headers, hook internals, future credential-bearing events) to external consumers by accident. Drop-and-count makes the leak direction impossible by construction and surfaces vocabulary gaps in one debug line; mapping a new event is an explicit code change in this package. The protocol's tolerate-unknown-types clause obliges our *client* behavior, not our server to forward.

## Mid-run attach semantics

A stream attaching while a turn is open receives `MESSAGES_SNAPSHOT` from committed log state plus one synthesized `RUN_STARTED`, so clients always observe well-formed RUN brackets even though the run began before they connected. Accepted imprecision: chunk deltas of the already-open step are not replayed; the step's `assistant/message` closes whatever brackets exist.

## Alternatives declined

- **Extending `SessionEventMap` with AG-UI-shaped events**: violates model-visible ⟺ logged in spirit — the projection is presentation, not session fact.
- **Serving frames from the existing host gateway**: couples the adapter to host release cadence and auth model before the dashboard consumer shape stabilizes.

## Required verification

- Unit suites cover translation purity (bracketing, drops, mid-run synthesis), SSE framing/keepalive/overflow isolation, and constant-time token comparison (`tests/`).
- The package invariant watches live frame streams process-wide: emitted types stay inside the AG-UI union and RUN_* frames respect open-run state, failing loud at emission.

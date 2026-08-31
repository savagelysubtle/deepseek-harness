# Agent Note: The web carrier mints rpcIds without requiring a secure context

Status: implemented

English | [中文](2026-08-31-web-lan-insecure-context-rpcid.zh.md)

## Problem

On any non-loopback browser (a LAN IP such as `http://10.0.0.3:3080`, e.g. the couch-mode iPhone), the DSH web GUI rendered its shell but workspaces and sessions never populated; the same build at `http://127.0.0.1:3080` worked completely. The researcher seat's packet-level diagnosis (2026-08-31, `companyOrchestrator/researcher/research/dsh-mobile-access/`) established: every WebSocket upgrade succeeded and the server pushed real subscription data; the client itself closed both sockets (code 1001, "WebSocket is closed before the connection is established"); `host.describe` never produced a single fetch; and `ConnectionController.loop`'s silent `catch {}` reduced the visible symptom to an eternal "connection lost, retry #N" backoff loop. The failure was origin-string-dependent, not transport-dependent — which ruled out the fence, TLS, persisted state, and the server-side gateway (the api-proxy events stream contains no origin branch at all; the server merely mirrored the client's own close).

The origin string that matters is the secure-context boundary. `crypto.randomUUID()` exists only in secure contexts (HTTPS or localhost); a plain-HTTP LAN origin is neither. `AbstractApiClient.mintRpcId()` — the base carrier for every unary call, including the readiness `host.describe` — called it directly, so on a LAN origin the very first RPC threw `TypeError: crypto.randomUUID is not a function` before any fetch, the rejection was swallowed by the reconnect loop's catch-all, and the connection generation aborted before readiness, closing both downlink sockets mid-handshake.

## Decision

`mintRpcId()` mints RFC 4122 version 4 UUIDs from `crypto.getRandomValues()`, which browsers expose on insecure origins, via a new internal `randomUuid()` helper in the apiproxy fetch carrier. The helper mirrors the one `@deepseek-ai/dsh-client-connection` already uses for its generic RPC channel (`rpc.ts` was safe; the apiProxy base carrier was not) — it is a deliberate duplicate rather than an import because the dependency edge points from client-connection to apiproxy, not back. The wire format is unchanged: rpcIds are still UUID v4 strings, the server echoes them verbatim, and no schema or persistence surface moves. The new test in `fetch-carrier.spec.ts` stubs the insecure-context crypto shape (`getRandomValues` present, `randomUUID` absent) and asserts a v4-format mint through the real `mintRpcId`.

## Alternatives considered

**Override `mintRpcId` in `WebApiClient` (client-connection only).** Rejected: it would fix the one consumer and leave the base carrier broken for every other `AbstractApiClient` consumer on insecure origins. The defect lives in the base class, so the fix does too.

**Require HTTPS (e.g. Tailscale) instead.** Rejected as the fix: the researcher's evidence proved the failure is origin-dependent, not transport-dependent, so HTTPS alone would not have restored sessions; HTTPS remains the separate roadmap unlock for PWA install and in-browser mic. The designed couch-mode deployment is plain HTTP on a LAN IP by explicit decision.

**Counter- or timestamp-based rpcIds.** Rejected: minting is per-call in shared browser contexts (multiple tabs), and a CSPRNG UUID costs the same as any unique-enough scheme while keeping the id opaque and collision-free.

## Consequences

The LAN/mobile deployment is actually usable: sessions populate and history renders from a non-loopback origin, with the only remaining non-2xx responses being the by-design loopback pin on privileged methods (`settings.describe`, `credentials.describe` → 403). Two same-class call sites were found during the fix sweep and deliberately left alone as logged follow-ups: `packages/client/ui-conversation/src/client/service.ts` mints draft attachment ids with `crypto.randomUUID()` (user-reachable on a LAN origin the moment a draft attachment is added — same TypeError shape) and `packages/llm/llm/src/message.ts`'s `createMessage` mints `MessageId` the same way (currently unreachable from browser bundles — no client caller; safe where it actually runs, on Node). Reintroduction condition: any new browser-side `crypto.randomUUID()` use re-breaks insecure origins; the quick audit is fingerprinting the served client bundles for `getRandomValues(new Uint8Array(16))`. The diagnostic debt that hid the real error remains untouched: the silent `catch {}` arms in `ConnectionController.loop` and `pumpStream` are logged as a simplification/observability candidate, not changed here.

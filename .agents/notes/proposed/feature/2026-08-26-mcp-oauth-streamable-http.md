# Agent Note: OAuth for Streamable HTTP MCP servers

Status: proposed

English | [中文](2026-08-26-mcp-oauth-streamable-http.zh.md)

## Problem

`dsh-mcp-client` bridges Streamable HTTP MCP servers with static request headers only ([plugin note](../../implemented/feature/2026-07-07-mcp-client-plugin.md) — this proposal extends it; nothing in it is superseded). The two remotes Steve's agents need — supabase and stripe MCP — are OAuth-only: they issue no static credentials, and the reference deployment (opencode) holds nothing but PKCE flow state for them (`mcp-auth.json`). A header-only client cannot use these servers at all.

Copying opencode's storage would be wrong twice over. Its `mcp-auth.json` is an ad-hoc plaintext JSON state file outside any precedence story, and its tokens live next to unrelated flow state with no per-operation read. The harness already owns a credential seam whose doctrine is "configuration carries references; consumers resolve per operation"; OAuth state belongs there or nowhere.

## Proposal

Add an explicit `auth: { mode: 'oauth', scope?, clientId?, redirectPort? }` block to the Streamable HTTP config and implement the SDK's `OAuthClientProvider` over `ctx.credentials`:

- **Explicit, not auto-started.** A 401 never begins a consent flow on its own. Consent is human approval of one identity grant; it is declared in composition where a reviewer sees it. An unauthenticated 401 keeps failing the connection with its diagnostic.
- **One credential reference per server.** Everything persists as `DSH_MCP_OAUTH_<SERVERNAME>` (uppercased, non-identifier characters become underscores): tokens, dynamic client registration, pending PKCE verifier, discovery cache, versioned `{version:1,...}` envelope in `$DSH_HOME/.credentials.yaml` at mode `0600`. Corrupt envelopes fail loud instead of masquerading as "not authorized" — silently looping consent for no effect is worse than a named error.
- **Per-operation resolution is the refresh-and-handoff story.** Every provider read goes through the store at call time, so (a) tokens written by one process reach every other process immediately, and (b) the SDK-driven refresh rotation commits through the same path. A running host picks up CLI-written tokens on its next connection attempt without restart.
- **Consent runs where a browser can.** `dsh-mcp-client-auth` (package bin) prints the authorization URL, captures the loopback redirect on `127.0.0.1:<auth.redirectPort>` (default 14506), exchanges the code, writes the store. Hosts never listen; when consent is missing they log the URL once with run-the-CLI guidance and keep retrying under the normal reconnect budget. Host and CLI advertise the SAME fixed redirect URL so dynamic registration matches whichever process consents first.
- **Refresh stays SDK-owned.** The SDK refreshes whenever it holds a `refresh_token` and re-saves rotated tokens through `saveTokens`; this package owns only persistence.

## Alternatives

- **Auto-detect 401 → start consent.** Rejected: turns any auth misconfiguration into a surprise interactive flow from an unsupervised host.
- **Plaintext JSON state file (opencode parity).** Rejected: bypasses credential precedence, shadowing rules, and the 0600 write discipline the local provider already enforces.
- **Auth as a separate service plugin** (per the earlier design brief). Deferred: no second consumer exists today, and the provider needs no configuration beyond what the server row already carries. The structural `OAuthCredentialStore` surface keeps that door open.

## Consequences

- supabase/stripe-style remotes become usable headlessly after one CLI run on any machine.
- New peer dependencies: `@deepseek-ai/dsh-credentials` (seam) and `@deepseek-ai/dsh-credentials-local` (CLI-side store construction).
- Known limitations recorded in the README: single-port coordination per server, CLI trusts the SDK's `state` handling (single-user local threat model), no `apikey` mode by design.

## Required verification

- Keyless suite against an in-process consent-gated fixture (`tests/oauth.spec.ts`): full CLI consent round trip, host pickup + refresh rotation over the real SDK transport, missing-consent containment with guidance log, fail-loud without the credential service, corrupt-envelope rejection, scoped invalidation.
- REAL-composition coverage rides the existing plugin-loading tests; snapshot surfaces are unchanged because no model-visible text changes.

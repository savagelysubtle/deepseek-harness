# Agent Note: A per-boot caller token gates the privileged `/api` methods

Status: implemented

English | [中文](2026-11-06-op-270-per-boot-caller-token.zh.md)

## Problem

The `/api` loopback fence ([browser-trust boundary](2026-07-28-api-browser-trust-boundary.md)) decides who may reach the route: a loopback socket peer and a loopback `Host`. Any other local page or process on the same machine passes both checks, so it could call privileged methods that answer approvals, stop sessions, write the org registry, create work areas, or list host directories. A founder stamp on a user message (`peerIsLoopback`) had the same weakness: loopback alone proved only that the caller ran on this machine. The sentinel design review for OP-270 (vault note `Plans/2026-11-06-OP-270-sentinel-design-review.md`) required a secret that only the operator's own browser tab holds.

## Decision

The host mints a random caller token at every boot and requires it, in the `x-dsh-token` request header, on the privileged `/api` methods.

- **Token.** `createCallerAuth()` (`packages/client/connection/src/caller-token.ts`) draws 32 random bytes as base64url once per host boot. The token lives only in that closure: never in an environment variable, a file, or `DSH_WEB_URL`. A restart invalidates every earlier token. `verify()` compares sha256 digests with `timingSafeEqual`.
- **Launch codes.** `HostConnectionService.mintLaunchCode()` returns a single-use random code, valid for `LAUNCH_CODE_TTL_MS` (10 minutes). Pending codes are held only as sha256 digests, at most `MAX_PENDING_LAUNCH_CODES` (16) at a time; a mint past the cap evicts the oldest. An exchange consumes the code whether or not it had expired.
- **Handing the code to the operator.** The `web-runtime` plugin of `@deepseek-ai/dsh-web-app` builds `http://127.0.0.1:<port>/#dsh-boot=<code>`. A URL fragment is never sent to a server. With an interactive stdout the link is printed on one line. Otherwise it is written to `$XDG_RUNTIME_DIR/dsh-web-access-<port>.url`, mode 0600, and only the path is printed; when the variable is unset nothing is written (a shared temp directory is not safe for the secret) and a line says so. The code never enters `DSH_WEB_URL`, the web-surface prompt section, or any environment variable, because those reach the agent.
- **Exchange.** On load, the page (`src/client/caller-auth.ts`) removes the fragment with `history.replaceState` before any network step, then posts `{code}` to `POST /api/auth.exchange` (`application/json`). The host answers `{ok: true, token}` with `cache-control: no-store`; the endpoint accepts only a loopback socket peer with a loopback `Host` (403 otherwise). A wrong, replayed, or expired code gets 401 with a plain message.
- **Token storage and transport.** The page keeps the token in memory and in `sessionStorage` (scoped to the page origin, so a reload keeps it); it never uses `localStorage` or the URL. Every API request carries it in `x-dsh-token`. WebSocket downlinks (`events.mux`, `events.host`) are unprivileged and carry no token; every privileged call is a unary POST.
- **Gate.** The gate wraps the shared `/api` fetch handler, so it also covers endpoints claimed by Typert interceptors such as `workflow/*`. A method in `PRIVILEGED_METHODS` still requires a loopback socket peer and loopback `Host` (403 otherwise) and now also a valid token (401 with `CALLER_TOKEN_REQUIRED_MESSAGE` otherwise). `host.listDirectory` and `session.export` form a second set, `TOKEN_REQUIRED_METHODS`: they keep the ordinary `trustedHosts` fence and add the token. The privileged set grew by `org.write`, `org.writeServed`, `worktree.create`, `worktree.remove`, `worktree.lock`, `host.createDirectory`, `session.sendAll`, `session.stopAll`, and `session.stopTree`. `session.create`, `session.prompt`, `subagent.prompt`, `session.history`, `session.rename`, `mailbox.publish`, and `mcp/status` stay open, because non-browser callers need them or they grant nothing beyond `session.create`.
- **Consumers in the API Proxy.** The carrier threads the verified result into the proxy as `RpcRequest.callerAuthenticated` and `RespondCaller`. `session.prompt` and `session.sendAll` mint the founder stamp only when the peer is loopback and the token is valid. `respond` refuses approval answers and the plan-review answer with `caller-not-authenticated` when the token is missing and with `caller-not-loopback` for a non-loopback peer; the pending entry stays pending. `allowNonLoopbackApprovalAnswers` (default `false`) is the single switch that would let a token-bearing LAN caller answer.
- **Refusals are visible.** Any 401 or a refused exchange turns the token state to `rejected`, and `mountAuthBanner` (`src/client/auth-banner.ts`) shows a fixed red strip (`role="alert"`) with the reason and "Reopen dsh from the launcher link". There is no silent retry. Fixture mode (`?fixture`) has no host and no token. The host logs each refusal as a warning that names the method and never a token or code; warnings are limited to one per 10 seconds, with a count of suppressed ones.

The banner is plain DOM because `AppFrame` is pure and has no Cordis access, so the existing `ConnectionBanner` atom and the layout seats are not reachable from the token holder.

## Alternatives considered

**Token in a cookie.** A browser attaches a cookie to every port on the host, so a seat's own dev server on another loopback port would receive the token and could replay it. A request header is attached only by this page's code.

**Token in the URL query.** Rejected: query strings reach the server, access logs, and the `Referer` header. The fragment stays in the browser.

**Token or code in `DSH_WEB_URL` or another environment variable.** Rejected: the managed bash environment and the prompt sections reach the agent, which could then act as the operator.

**`localStorage`.** Rejected: it persists across browser restarts and outlives the boot that minted the token. `sessionStorage` is bounded by the tab and still survives a reload.

**Render the notice with the `ConnectionBanner` atom and `ui-layout`.** Not chosen: `AppFrame` is pure and has no Cordis access. A React banner is a possible later change.

## Consequences

- A same-user process or page that holds no token can no longer answer an approval, stop sessions, or call the other privileged methods, and cannot receive a founder stamp.
- Existing automation that parses the `dsh web: http://...` line keeps working for unprivileged methods. To use a privileged method it must read the access link from the terminal line or the 0600 file, post the code to `/api/auth.exchange`, and send `x-dsh-token`. Playwright flows, the `dsh-stable` restart helper, and the `dsh-session-testing` skill live outside this repository and are not changed here.
- The token is lost on every host restart, and an open tab then shows the red strip until the operator opens a new launcher link.
- A LAN phone cannot answer approvals under the default setting, even with a token; whether to enable `allowNonLoopbackApprovalAnswers` is an open founder question.
- The gate refuses by method name, not by endpoint inventory. A new privileged method must be added to `PRIVILEGED_METHODS` or `TOKEN_REQUIRED_METHODS` to be covered.
- Failed exchanges are not throttled. A code is 256 bits and single use, so guessing is infeasible; only the warning log is rate limited.
- Verified by `caller-gate.host.spec.ts`, `caller-token.host.spec.ts`, `route-classification.host.spec.ts`, `caller-auth.client.spec.ts` (connection), `api-proxy-caller-auth.spec.ts` and `api-proxy-founder-stamp.spec.ts` (apiproxy), and `web-app.spec.ts`.

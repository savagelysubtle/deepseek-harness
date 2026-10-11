/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
// `./handle-store.ts` imports `SERVER_NAME_PATTERN`/`Config` back from THIS
// file — the same circular pair `status-registry.ts` used to form with
// `./connection.ts` (see that file's former module doc, preserved in spirit
// here): this file is the entry point that begins — and, transitively,
// finishes — loading `./connection.ts` (imported just above) before
// `./handle-store.ts` gets a turn, so by the time `apply()` below actually
// calls into it, every top-level binding it needs is settled.
import { registerMcpHandle } from './handle-store.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export type { McpResult } from './tools.ts'
export type { ConnectionHandle, ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'
// `RECONNECT_DEFAULTS.maxAttempts` is the attempt budget a patch-disabled
// mount's synthesized status row reports (no live handle to read a real
// budget from) — `@deepseek-ai/dsh-mcp-status`'s `list()` needs the same
// default this package's own Config schema uses, not a second guess at it.
export { RECONNECT_DEFAULTS } from './connection.ts'
export { CredentialsOAuthProvider, buildClientMetadata, oauthCredentialRef } from './oauth.ts'
export type { OAuthCredentialStore } from './oauth.ts'
// The shared loopback OAuth-callback listener stays owned by this package —
// `auth-cli.ts`'s standalone `dsh-mcp-client-auth` CLI uses it directly, and
// `@deepseek-ai/dsh-mcp-status`'s `authorize-start` imports this same public
// export rather than a second implementation (SWD-164 round 5, defect 2).
export { ConsentTimeoutError, startAuthorizationCallbackListener } from './oauth-callback.ts'
export type { AuthorizationCallbackListener, CaptureAuthorizationCodeOptions } from './oauth-callback.ts'
export {
  backupPatchBytes,
  defaultPatchPath,
  hashMcpPatchBytes,
  listMcpHandles,
  locateMcpMount,
  JS_EXPR_SCALAR_TAG,
  PATCH_CUSTOM_TAGS,
  parsePatchDocument,
  parsePatchFile,
  readMcpPatchEntries,
  redactAbsolutePaths,
  registerMcpHandle,
  subscribeMcpHandles,
} from './handle-store.ts'
export type {
  McpHandleEntry,
  McpMountLocation,
  McpMountLookup,
  McpPatchEntry,
  ParsedPatchFile,
  RegisterMcpHandleOptions,
} from './handle-store.ts'
export type { McpServerState, McpServerStatus } from './status.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/**
 * Bound on waiting for a late-registering `credentials` service before an
 * OAuth-configured instance fails loud. `inject = ['tools']` gives this
 * plugin no ordering guarantee relative to `@deepseek-ai/dsh-credentials-local`
 * (a hard `inject` on `credentials` would break every non-OAuth instance in
 * deployments that never mount it, e.g. the stdio-only mcp-memory examples),
 * so a same-boot-wave race is expected and worth a short wait rather than an
 * immediate false-negative.
 */
const CREDENTIALS_WAIT_TIMEOUT_MS = 10_000

/** Poll granularity while waiting on {@link CREDENTIALS_WAIT_TIMEOUT_MS}. */
const CREDENTIALS_POLL_INTERVAL_MS = 50

/**
 * Valid `serverName`, kept below the public tool-name budget. Exported so
 * `@deepseek-ai/dsh-mcp-status`'s `set-enabled` validates the exact same
 * grammar before it ever touches `cordis.patch.yml` — one pattern, not two
 * that could drift.
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Live `serverName` reservations per app, keyed off `ctx.root` (multiple apps
 * in one process — tests — must not see each other's names). A duplicate
 * namespace is a configuration error surfaced at plugin load, never silent
 * shadowing.
 */
const activeServerNames = new WeakMap<Context, Set<string>>()

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/**
 * OAuth configuration for one server. Authorization is explicit config, never
 * an auto-started flow on an unexpected 401: consent is human approval of one
 * identity grant, so it is declared here where a reviewer can see it.
 */
export interface OAuthAuthConfig {
  /** Selects the OAuth 2.0 authorization-code flow with PKCE. */
  mode: 'oauth'
  /** Scope string requested when the server does not advertise one; omission lets discovery decide. */
  scope?: string
  /** Pre-registered client id; omission performs RFC 7591 dynamic client registration on first consent. */
  clientId?: string
  /**
   * Loopback port for the consent redirect. Must match the `--redirect-port`
   * passed to the `dsh-mcp-client-auth` consent CLI. Default {@link DEFAULT_OAUTH_REDIRECT_PORT}.
   */
  redirectPort?: number
}

/** Default loopback port for the OAuth consent redirect capture. */
export const DEFAULT_OAUTH_REDIRECT_PORT = 14_506

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across live mcp-client instances.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /**
   * OAuth 2.0 authorization for this server. Omission sends requests as-is;
   * a server that answers 401 then fails the connection with its diagnostic.
   */
  auth?: OAuthAuthConfig
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

const Auth: z<OAuthAuthConfig> = z.object({
  mode: z.const('oauth').required(),
  scope: z.string(),
  clientId: z.string(),
  redirectPort: z.number().step(1).min(1).max(65_535).default(DEFAULT_OAUTH_REDIRECT_PORT),
})

const StdioBranch = z.object({
  transport: z.const('stdio'),
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: Reconnect,
}) as unknown as z<StdioConfig>

const StreamableHttpBranch = z.object({
  transport: z.const('streamable-http'),
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  url: z.string().required(),
  headers: z.dict(String).default({}),
  // Prevent Schemastery from materializing an omitted `auth` as `{}` (every
  // z.object() carries an implicit `default: {}`), which would then fail
  // `auth.mode missing required value` on a header-only, static-token
  // mount — the README's own example (SWD-167). `auth: { mode: 'oauth' }`
  // still resolves exactly as before: this default only applies when the
  // key is absent.
  auth: Auth.default(undefined as unknown as OAuthAuthConfig),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: Reconnect,
}) as unknown as z<StreamableHttpConfig>

/** True for a plain, non-array object — the shape {@link CONFIG_TYPE}'s resolver can read `transport` off of. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Matches the ` but got <value>` tail Schemastery's 'object', 'dict',
 * 'string', 'const', 'array', and 'tuple' resolvers (vendor/schemastery/src
 * /index.ts ~609-753) append to a type-mismatch message, interpolating the
 * raw received value — to the end of the string (`[\s\S]*`, not `.*`), so a
 * multi-line value is stripped along with the rest. A message with no such
 * tail (e.g. "missing required value", or the serverName pattern message,
 * which never embeds the value at all) does not match and is left alone.
 */
const BUT_GOT_TAIL_RE = / but got [\s\S]*$/

/**
 * Rewrite ANY error thrown resolving one Config branch so the raw value a
 * Schemastery resolver interpolated into a type-mismatch message can never
 * reach a caller or a log line — for every field, not a field-name
 * allowlist (SWD-167 round 4, sentinel finding: a field allowlist — round
 * 3's `headers`/`env` — chases a generic Schemastery behavior; `url`,
 * `args`, and even `auth` itself can carry a live credential too, e.g. an
 * operator pasting a token straight into `auth` instead of `headers`).
 * Mutates `.message` on the SAME error object rather than constructing a
 * replacement, so `.options.path` (what cordis's `resolveConfig` reports as
 * the issue's `path` — the `$.url`/`$.args[1]`-style prefix that names which
 * field is wrong), the `ValidationError` class, and its `~standard`
 * -recognized prototype all survive completely unchanged; this also makes
 * the rewrite correct no matter what `options.path` looks like, including
 * missing or non-array, since nothing here ever reads it. The expectation
 * text ("expected string", "missing required value", the serverName
 * pattern, …) is untouched — only the interpolated value, when present, is
 * dropped.
 * @param error - the value caught resolving one Config branch. Always a
 *   real `Error` with a string `.message` in practice: every throw inside
 *   the 'object'/'dict'/'string'/'const'/'array'/'tuple' resolvers — the
 *   only ones either branch ever reaches, both only ever handed a data
 *   value this file has already confirmed is a plain record — is a
 *   Schemastery `ValidationError`, and this Config defines no custom
 *   validator that could throw anything else.
 * @returns never: this always throws (the same error, message rewritten in place when there was a value to drop).
 */
function redactReceivedValue(error: unknown): never {
  const thrown = error as Error
  if (BUT_GOT_TAIL_RE.test(thrown.message)) {
    thrown.message = thrown.message.replace(BUT_GOT_TAIL_RE, ' (received value withheld)')
  }
  throw thrown
}

/**
 * Schemastery type name for this package's own discriminated Config union,
 * registered once below via `z.extend` (a new entry in Schemastery's
 * resolver registry — it does not touch the shared `'union'`/`'object'`
 * resolvers any other schema in the process uses).
 *
 * SWD-167 round 2 (sentinel finding): the built-in `z.union()` resolver
 * (vendor/schemastery/src/index.ts ~765-775) tries every branch and, if ALL
 * fail, throws `` expected <union> but got ${JSON.stringify(data)} `` —
 * dumping the ENTIRE candidate config, including a live bearer token in
 * `headers.Authorization`, into a message that reaches the persistent host
 * log through cordis's fiber reload path (vendor/cordis/src/fiber.ts).
 * `transport` already discriminates the two branches unambiguously — every
 * caller in this repo sets it (examples/, every test) — so this resolver
 * dispatches directly to the ONE branch it names instead of trying both and
 * falling through to that dump. A failure inside the matched branch reports
 * its own specific, path-scoped field error (e.g. "url missing required
 * value"), never the whole object.
 */
const CONFIG_TYPE = 'dsh-mcp-client-config'

z.extend(CONFIG_TYPE, (data, _schema, options, strict) => {
  const transport = isPlainRecord(data) ? data.transport : undefined
  if (transport === 'stdio') {
    try {
      return z.resolve(data, StdioBranch, options, strict)
    } catch (error) {
      redactReceivedValue(error)
    }
  }
  if (transport === 'streamable-http') {
    try {
      const resolved = z.resolve(data, StreamableHttpBranch, options, strict) as [Record<string, unknown>, unknown?]
      // A bare `auth:` key in YAML parses to `auth: null`, which must behave
      // exactly like an omitted `auth` (SWD-167 round 2, reviewer finding):
      // `resolveAuthProvider` (connection.ts) only guards `=== undefined`, so
      // a literal `null` would otherwise reach `config.auth.scope` and throw
      // a TypeError at connect time instead of failing loud at validation.
      // `resolved[0]` is always a plain object here — the 'object' resolver
      // (vendor/schemastery/src/index.ts ~752) either returns one or throws
      // (caught above) — so no extra shape guard is needed.
      if (resolved[0].auth === null) delete resolved[0].auth
      return resolved
    } catch (error) {
      redactReceivedValue(error)
    }
  }
  // SWD-167 round 3 (sentinel finding C): never echo the raw `transport`
  // value — a secret-shaped string here (an operator's paste-over-the-wrong-
  // field mistake) would otherwise land in the host log unredacted.
  throw new z.ValidationError(
    transport === undefined
      ? 'transport is required and must be "stdio" or "streamable-http"'
      : `transport must be "stdio" or "streamable-http", not an unrecognized value of type ${typeof transport}`,
    options,
  )
})

export const Config = z({ type: CONFIG_TYPE }) as unknown as z<Config>

// ---- Plugin apply ----

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Fail loud at load: OAuth requires the credential-reference service to hold
  // tokens. Without it the plugin could never authorize, so reject THIS
  // instance with the mounting fix named. The widened probe is deliberate:
  // an auth block on a stdio row exists only at runtime (the schema strips
  // it, and union narrowing would call the check impossible).
  const authBlock = (config as { auth?: OAuthAuthConfig }).auth
  if (authBlock !== undefined) {
    if (config.transport !== 'streamable-http') {
      throw new Error(
        `mcp-client(${config.serverName}): auth.oauth applies only to transport: streamable-http servers`,
      )
    }
    if (ctx.get('credentials') === undefined) {
      // Not present *yet* is not the same as never mounted: `credentials` and
      // this plugin both activate during the same boot wave, and nothing
      // orders one ahead of the other. `ctx.get` only returns a service once
      // its owning fiber reaches ACTIVE — for credentials-local that is after
      // its own async init (reading `.credentials.yaml`, arming the file
      // watcher) settles, which routinely outlasts this plugin's synchronous
      // activation. Poll the same strict check resolveAuthProvider uses below
      // rather than `ctx.inject`, whose dependency-satisfaction signal fires
      // on registration, not on that ACTIVE transition — failing loud only if
      // credentials genuinely never shows up within the bound.
      const deadline = Date.now() + CREDENTIALS_WAIT_TIMEOUT_MS
      while (ctx.get('credentials') === undefined) {
        if (Date.now() >= deadline) {
          throw new Error(
            `mcp-client(${config.serverName}): auth.oauth requires the credential-reference service — mount @deepseek-ai/dsh-credentials-local`,
          )
        }
        await new Promise(resolve => setTimeout(resolve, CREDENTIALS_POLL_INTERVAL_MS))
      }
    }
  }

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  ctx.effect(() => {
    let names = activeServerNames.get(ctx.root)
    if (!names) {
      names = new Set()
      activeServerNames.set(ctx.root, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    return () => void names.delete(config.serverName)
  }, 'mcp-client.serverName')

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  const connection = startConnection(ctx, config, reconnect)

  ctx.effect(() => {
    return () => connection.dispose()
  }, 'mcp-client.connection')

  // Registration into the root-scoped handle store is unconditional — this
  // instance must behave identically whether or not
  // `@deepseek-ai/dsh-mcp-status` is mounted anywhere on this context tree
  // (a headless or embedded host may have no Remote status surface at all).
  // See `./handle-store.ts`'s module doc for why that service no longer
  // lives in this package (SWD-164 round 5, defect 2).
  ctx.effect(() => registerMcpHandle(ctx, config, connection), 'mcp-client.statusRegistration')

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor enters its reconnect loop.
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}

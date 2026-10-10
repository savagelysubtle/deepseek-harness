/**
 * One-time OAuth consent CLI for Streamable HTTP MCP servers
 * (`dsh-mcp-client-auth`). Headless hosts cannot click consent screens: this
 * command runs the browser leg on any machine that can open a URL, captures
 * the redirect on a local loopback listener, exchanges the code, and writes
 * the resulting token state into the credential store under
 * `DSH_MCP_OAUTH_<SERVERNAME>`. A running mcp-client instance for the same
 * server picks the tokens up on its next connection attempt through its
 * per-operation credential resolution — no restart.
 *
 * Built as its own bundle and declared in `package.json` `bin`; imports the
 * local credential provider directly because it runs outside any Host.
 *
 * @module @deepseek-ai/dsh-mcp-client/auth-cli
 */

import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider, resolveSpec } from '@deepseek-ai/dsh-credentials-local'
import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthCredentialStore } from './oauth.ts'
import { CredentialsOAuthProvider } from './oauth.ts'
import { DEFAULT_OAUTH_REDIRECT_PORT } from './index.ts'
import { captureAuthorizationCode } from './oauth-callback.ts'

/** Parsed command line. */
interface CliArgs {
  /** MCP endpoint URL (`--url`). */
  url: string
  /** Server namespace matching the plugin config (`--server-name`). */
  serverName: string
  /** Optional scope override (`--scope`). */
  scope?: string
  /** Optional pre-registered client id (`--client-id`). */
  clientId?: string
  /** Loopback port (`--redirect-port`). */
  redirectPort: number
  /** Credentials document override (`--credentials-path`). */
  credentialsPath?: string
  /** Consent wait budget in milliseconds (`--timeout-ms`). */
  timeoutMs: number
  /** Drop stored state before logging in (`--reset`). */
  reset: boolean
}

// Node's `setTimeout` takes a 32-bit signed delay internally: anything above
// this clamps to 1ms (with a TimeoutOverflowWarning) and fires almost
// immediately instead of after the requested wait, which is the opposite of
// what a caller asking for a long consent-wait budget wants.
const NODE_TIMER_MAX_MS = 2_147_483_647

/**
 * Parse `--flag value` arguments; repeated or unknown flags fail loud.
 * Exported so tests can assert accepted values directly, without driving the
 * network and credential-fiber work the rest of {@link runAuthCli} does.
 * @param argv - raw argv entries after the script path.
 * @returns the parsed flags.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>()
  const flagsWithValues = new Set(['--url', '--server-name', '--scope', '--client-id', '--redirect-port', '--credentials-path', '--timeout-ms'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    /* v8 ignore next -- argv from process.argv is never sparse; only a fabricated array could produce this */
    if (arg === undefined) break
    if (arg === '--reset') continue
    const value = argv[i + 1]
    if (!flagsWithValues.has(arg) || value === undefined) {
      throw new Error(`unknown or incomplete argument: ${arg}`)
    }
    if (values.has(arg)) throw new Error(`repeated argument: ${arg}`)
    values.set(arg, value)
    i += 1
  }
  const url = values.get('--url')
  const serverName = values.get('--server-name')
  if (url === undefined || serverName === undefined) {
    throw new Error([
      'usage: dsh-mcp-client-auth --url <mcp-endpoint> --server-name <name>',
      '  [--scope s] [--client-id id] [--redirect-port p] [--credentials-path f] [--timeout-ms ms] [--reset]',
    ].join('\n'))
  }
  // Port and timeout flags carry different bounds: a redirect port is a real
  // TCP port (1..65535), but a consent-wait timeout's only documented value
  // is the 300_000ms default — so the port's 65_535 ceiling must not apply
  // here. It is still bounded above, just by a different ceiling: Node's
  // setTimeout delay (NODE_TIMER_MAX_MS), past which a long wait fires almost
  // instantly instead of waiting, defeating the point of a longer timeout.
  const portFlag = (name: string, fallback: number): number => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be an integer between 1 and 65535`)
    return parsed
  }
  const timeoutFlag = (name: string, fallback: number): number => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > NODE_TIMER_MAX_MS) {
      throw new Error(`${name} must be an integer between 1 and ${NODE_TIMER_MAX_MS} (Node's timer ceiling)`)
    }
    return parsed
  }
  const scope = values.get('--scope')
  const clientId = values.get('--client-id')
  const credentialsPath = values.get('--credentials-path')
  return {
    url,
    serverName,
    ...(scope === undefined ? {} : { scope }),
    ...(clientId === undefined ? {} : { clientId }),
    redirectPort: portFlag('--redirect-port', DEFAULT_OAUTH_REDIRECT_PORT),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
    timeoutMs: timeoutFlag('--timeout-ms', 300_000),
    reset: argv.includes('--reset'),
  }
}

/**
 * Run the consent flow: print the authorization URL, capture the loopback
 * redirect, exchange the code, and persist the tokens. Exported so tests (and
 * exotic embedders) can drive it in-process; executing this module as a bin
 * calls it with `process.argv`.
 * @param argv - flag entries in argv form (no script path).
 */
export async function runAuthCli(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv)
  const ctx = new Context()
  // watch: false — a one-shot command has nothing to hot-reload.
  const credentialsConfig = {
    ...(args.credentialsPath === undefined ? {} : { path: args.credentialsPath }),
    watch: false,
  }
  // Cordis only runs a Service's [Service.init] — where credentials-local's
  // loadInitial() reads the existing .credentials.yaml into memory — when the
  // class is mounted through ctx.plugin(...); a bare
  // `new LocalCredentialProvider(ctx, {...})` never reaches it, so resolve()
  // would always see an empty store regardless of what is on disk, and the
  // "Already authorized" short circuit below could never fire.
  const fiber = ctx.plugin(LocalCredentialProvider, credentialsConfig)
  await fiber
  try {
    const store: OAuthCredentialStore = ctx.credentials
    const provider = CredentialsOAuthProvider.create({
      serverName: args.serverName,
      serverUrl: new URL(args.url),
      ...(args.scope === undefined ? {} : { scope: args.scope }),
      ...(args.clientId === undefined ? {} : { staticClientId: args.clientId }),
      store,
      redirectUri: `http://127.0.0.1:${args.redirectPort}/callback`,
      onAuthorizationUrl(authorizationUrl) {
        console.log(`Open this URL in any browser and approve access:\n\n  ${String(authorizationUrl)}\n\nWaiting for the consent redirect on 127.0.0.1:${args.redirectPort} ...`)
      },
    })
    if (args.reset) await provider.invalidate('all')

    let result = await sdkAuth(provider, { serverUrl: args.url, ...(args.scope === undefined ? {} : { scope: args.scope }) })
    if (result === 'AUTHORIZED') {
      console.log(`Already authorized: valid tokens are stored under ${provider.ref}. Pass --reset to start over.`)
      return
    }
    const code = await captureAuthorizationCode(args.redirectPort, args.timeoutMs)
    result = await sdkAuth(provider, {
      serverUrl: args.url,
      ...(args.scope === undefined ? {} : { scope: args.scope }),
      authorizationCode: code,
    })
    /* v8 ignore next -- SDK 1.29.0 authInternal always returns AUTHORIZED or throws given an authorizationCode (auth.js ~262-271) */
    if (result !== 'AUTHORIZED') throw new Error('token exchange did not complete — rerun the command')
    const info = await ctx.credentials.describe(provider.ref)
    console.log([
      `Authorized. MCP OAuth tokens stored as credential reference ${provider.ref}`,
      `in ${resolveSpec(credentialsConfig).filename} (source layer: ${info.source}).`,
    ].join(' '))
  } finally {
    await fiber.dispose()
  }
}

// Bin execution guard: run only when this file is the entry module, so an
// in-process import (tests, embedders) never starts a listener.
const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) {
  runAuthCli(process.argv.slice(2)).catch((error: unknown) => {
    /* v8 ignore next -- every throw site reachable from runAuthCli (parseArgs, the credential fiber's init, URL parsing,
       the SDK auth flow, captureAuthorizationCode) throws Error instances */
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  })
}

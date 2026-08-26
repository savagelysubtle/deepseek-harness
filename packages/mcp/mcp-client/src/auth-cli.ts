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

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider, resolveSpec } from '@deepseek-ai/dsh-credentials-local'
import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthCredentialStore } from './oauth.ts'
import { CredentialsOAuthProvider } from './oauth.ts'
import { DEFAULT_OAUTH_REDIRECT_PORT } from './index.ts'

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

/**
 * Parse `--flag value` arguments; repeated or unknown flags fail loud.
 * @param argv - raw argv entries after the script path.
 * @returns the parsed flags.
 */
function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>()
  const flagsWithValues = new Set(['--url', '--server-name', '--scope', '--client-id', '--redirect-port', '--credentials-path', '--timeout-ms'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
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
  const numberFlag = (name: string, fallback: number): number => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be an integer between 1 and 65535`)
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
    redirectPort: numberFlag('--redirect-port', DEFAULT_OAUTH_REDIRECT_PORT),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
    timeoutMs: numberFlag('--timeout-ms', 300_000),
    reset: argv.includes('--reset'),
  }
}

/**
 * Wait for the authorization-server redirect on a loopback listener.
 * @param port - the port advertised as the redirect URI's port.
 * @param timeoutMs - how long to wait for the browser round trip.
 * @returns the authorization code from the callback.
 */
function captureAuthorizationCode(port: number, timeoutMs: number): Promise<string> {
  const captured: PromiseWithResolvers<string> = Promise.withResolvers()
  const server = createServer((request, response) => {
    const incoming = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (incoming.pathname !== '/callback') {
      response.writeHead(404).end()
      return
    }
    const error = incoming.searchParams.get('error')
    const code = incoming.searchParams.get('code')
    response.writeHead(200, { 'content-type': 'text/plain' })
    if (code !== null) {
      response.end('Authorization complete. You may close this window.\n')
    } else {
      response.end(`Authorization failed: ${error ?? 'missing code'}${incoming.searchParams.get('error_description') ? ` (${incoming.searchParams.get('error_description')})` : ''}\n`)
    }
    response.end()
    if (code !== null) {
      captured.resolve(code)
    } else {
      captured.reject(new Error(`authorization server redirected with error: ${error ?? 'missing code'}`))
    }
  })
  const timer = setTimeout(() => {
    captured.reject(new Error(`no consent callback within ${timeoutMs}ms — rerun the command to get a fresh login URL`))
  }, timeoutMs)
  timer.unref()
  server.on('error', (error) => {
    captured.reject(new Error([
      `cannot listen on 127.0.0.1:${port} for the consent redirect (${String(error)})`,
      '— free the port or pass --redirect-port on BOTH this command and the plugin config',
    ].join(' ')))
  })
  void captured.promise.finally(() => {
    clearTimeout(timer)
    server.close()
  })
  server.listen(port, '127.0.0.1')
  return captured.promise
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
  const localProvider = new LocalCredentialProvider(ctx, {
    ...(args.credentialsPath === undefined ? {} : { path: args.credentialsPath }),
    watch: false,
  })
  const store: OAuthCredentialStore = localProvider
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
  if (result !== 'AUTHORIZED') throw new Error('token exchange did not complete — rerun the command')
  const info = await localProvider.describe(provider.ref)
  console.log([
    `Authorized. MCP OAuth tokens stored as credential reference ${provider.ref}`,
    `in ${resolveSpec(localProvider.config).filename} (source layer: ${info.source}).`,
  ].join(' '))
}

// Bin execution guard: run only when this file is the entry module, so an
// in-process import (tests, embedders) never starts a listener.
const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) {
  runAuthCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  })
}

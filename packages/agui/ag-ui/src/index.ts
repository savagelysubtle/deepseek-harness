/**
 * AG-UI outbound adapter plugin: subscribes to session events and serves them
 * as AG-UI protocol events over SSE so external dashboards can render agent
 * runs ([protocol](https://docs.ag-ui.com)). Read-only projection — the mount
 * registers no tools, no prompts, and nothing model-visible.
 *
 * The endpoint runs on this plugin's own node:http listener, never on the web-GUI server:
 * that server is browsers-only, loopback, and unauthenticated by contract,
 * while this surface exposes session content to external consumers and
 * carries its own bearer auth instead. Mounting is optional and stays out of
 * shipped defaults; deployments expose it behind a gateway that terminates TLS.
 *
 * @module @deepseek-ai/dsh-ag-ui
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
// Empty type imports carry the agent-event Context merge for the failure
// broadcast and the approval-event merge for the display-only projection.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgUiConfig } from './types.ts'
import { AgUiServer } from './server.ts'
import type { ResolvedAgUiOptions } from './server.ts'
export type { AgUiEvent, BracketState } from './types.ts'
export {
  APPROVAL_CUSTOM_EVENT,
  createBracketState,
  isOpenTurn,
  projectMessages,
  synthesizeRunStart,
  translateAgentError,
  translateSessionEvent,
} from './translate.ts'
export { AgUiServer, bearerTokenMatches, listAgUiServers, onAgUiServer } from './server.ts'
export type { ResolvedAgUiOptions } from './server.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ag-ui'

/** The session store resolves thread ids to live sessions; without it no stream can attach. */
export const inject = ['sessions']

/** Plugin config: listener address, required bearer token, and buffering knobs. */
export type Config = AgUiConfig

/**
 * Schema for {@link Config}. The bearer token is required and length-floored:
 * a missing or short token fails schema validation at plugin load, before any
 * socket exists (misconfiguration fails loud).
 */
export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().min(0).max(65_535).required(),
  bearerToken: Schema.string().min(8).required(),
  keepAliveMs: Schema.number().min(1).default(15_000),
  maxBufferedEvents: Schema.number().min(1).default(256),
})

/**
 * Explicit resolve step from wire config to listener options. Loader mounts
 * are already schema-validated; this assertion keeps programmatic mounts
 * equally loud about a missing or undersized bearer token.
 * @param config - validated plugin config.
 * @returns the fully resolved listener options.
 */
function resolveOptions(config: Config): ResolvedAgUiOptions {
  if (typeof config.bearerToken !== 'string' || config.bearerToken.length < 8) {
    throw new Error('ag-ui: bearerToken must be a string of at least 8 characters')
  }
  return {
    host: config.host ?? '127.0.0.1',
    port: config.port,
    bearerToken: config.bearerToken,
    keepAliveMs: config.keepAliveMs ?? 15_000,
    maxBufferedEvents: config.maxBufferedEvents ?? 256,
  }
}

/**
 * Mount the adapter: start its own HTTP listener and subscribe to session
 * and agent-failure events. Disposal closes every socket and awaits listener
 * quiescence, so an HMR reload leaves neither sockets nor listeners behind.
 * @param ctx - Cordis context carrying the session store and logger.
 * @param config - deployment config; see {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Misconfiguration fails loud before any resource is created.
  const options = resolveOptions(config)
  // ACP-pattern capture: broadcast callbacks run outside this plugin's
  // injection scope, so read injected services during apply rather than lazily.
  const sessions = ctx.sessions
  const server = new AgUiServer(options, (threadId) => {
    const session = sessions.get(threadId)
    return session?.events
  }, ctx.logger('ag-ui'))

  ctx.on('session/event', (session, event: SessionEvent) => {
    server.broadcastSessionEvent(session.header.id, event)
  })

  ctx.on('agent/error', ({ agent, error }) => {
    server.broadcastAgentError(agent.session.id, errorChain(error))
  })

  // One lifecycle controller owns listener teardown end to end: stop accepting,
  // destroy every socket, await quiescence.
  ctx.effect(() => async () => {
    await server.dispose()
  }, 'ag-ui.listen')
}

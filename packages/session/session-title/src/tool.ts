/**
 * Model-facing `session_title` tool: lets a seat name its own conversation.
 *
 * This exists because the host cannot do it on a seat's behalf. Titling
 * appends a `session/title` event, which is a log write, and while a seat is
 * running it holds its own one-writer lock — so `session.rename` over the host
 * API answers `agent-busy` naming the seat's own pid. A running session
 * therefore has exactly one legitimate writer for its own title: itself.
 *
 * The tool routes to {@link SessionTitleService.rename}, which pins the title
 * with the `user` source so automatic generation stops competing with it.
 * @module @deepseek-ai/dsh-session-title/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: declaration-merges ctx.sessionTitle onto Context via the seam package.
import type {} from './index.ts'

export const name = 'tool-session-title'
export const inject = ['tools']

/** Config for the session-title tool consumer. */
export interface Config {}

/** Schemastery configuration for the tool consumer. */
export const Config: z<Config> = z.object({})

const TOOL_DESCRIPTION = [
  'Set the title of your own conversation — the name it shows under in the session list.',
  '',
  'Use it when your session has a name that does not describe it: a seat whose title is still',
  'the first line of its kickoff prompt, or a session whose subject has moved on. Prefer a short',
  'noun phrase; for a named seat, its own name is usually right.',
  '',
  'The title you set is pinned: automatic title generation stops replacing it.',
].join('\n')

/** The one result shape the tool returns. */
interface SessionTitleToolOutput {
  title: string
}

/**
 * Mount the session-title tool onto the tools registry for this layer.
 * @param ctx - context carrying the host tools registry and the title service.
 * @returns the registration disposer (registry teardown unregisters the tool).
 */
export const apply = (ctx: Context): (() => void) => {
  // Arrow, not a function declaration: Cordis treats a prototype-bearing
  // ordinary function as a constructor, and this registration is synchronous.
  return ctx.tools.register(defineTool({
    name: 'session_title',
    description: TOOL_DESCRIPTION,
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'The title to set. Must contain visible characters; long values are truncated by the service.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string', required: true } },
      },
      render(_args, value) {
        return [{ type: 'text', text: `Session title set to: ${value.title}` }]
      },
    },
    execute(args, exec): Promise<SessionTitleToolOutput> {
      const service = ctx.get('sessionTitle')
      if (service === undefined) {
        throw new Error('session_title requires the session-title service — mount @deepseek-ai/dsh-session-title')
      }
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('session_title requires an agent session: only a live session can title itself')
      }
      const { title } = args as { title?: unknown }
      if (typeof title !== 'string') {
        throw new TypeError('session_title requires a string "title"')
      }
      // rename() normalizes, rejects an empty result, and pins with source
      // `user` — the same acceptance path the UI's rename takes.
      // Synchronous work behind an async signature: rename() commits in-process,
      // so there is nothing to await and `async` would only add a tick.
      return Promise.resolve({ title: service.rename(session, title).title })
    },
  }))
}

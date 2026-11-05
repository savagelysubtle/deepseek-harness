/**
 * `mailbox_directory`: lists the seats this seat may mail, which are exactly the host stanza's
 * `send_to` entries. The names are operator-configured roster names, not external content, so the
 * call does not taint the session. Any FUTURE tool that returns mail bodies or other external
 * content must call the context's `markTainted` before returning; S6 owns those tools.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/mcp/directory
 */

import { MAILBOX_DIRECTORY_TOOL } from '../contributors.ts'
import { DIRECTORY_SCHEMA } from './schema.ts'
import { defineSeatTool, textResult } from './types.ts'
import type { SeatTool, SeatToolContext } from './types.ts'

/**
 * Build the `mailbox_directory` tool over a seat's closure.
 * @param context - the seat closure.
 * @returns the tool.
 */
export function createDirectoryTool(context: SeatToolContext): SeatTool {
  return defineSeatTool(context, {
    name: MAILBOX_DIRECTORY_TOOL,
    description: 'List the seats you may send mail to.',
    inputSchema: DIRECTORY_SCHEMA,
    handler: () => {
      if (context.sendTo.length === 0) {
        return Promise.resolve(textResult(context, 'No seats: this seat has no send_to entries in its host stanza (key send_to).'))
      }
      return Promise.resolve(textResult(context, `Seats you may mail:\n${context.sendTo.map(name => `- ${name}`).join('\n')}`))
    },
  })
}

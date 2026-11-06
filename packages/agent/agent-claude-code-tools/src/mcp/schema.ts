/**
 * Input schemas of the dsh MCP tools. Every schema is a strict object: an unknown key (`from`,
 * `seat`, `tainted`, `chain`, anything else) is rejected, never stripped, so the model cannot even
 * try to name an identity. {@link assertConvertible} is the fail-closed schema conversion check the
 * server runs at construction.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/mcp/schema
 */

import { MAILBOX_SEGMENT_PATTERN_SOURCE } from '@deepseek-ai/dsh-mailbox'
import { z } from 'zod'

/**
 * Largest mail body, in UTF-8 bytes. The mailbox package declares no body limit of its own (checked:
 * no size constant in `dsh-mailbox`, `mailbox-local` or `tool-mailbox`), so this package sets it.
 */
export const MAX_BODY_BYTES = 64 * 1024

/** Longest accepted trace id. */
export const MAX_TRACE_ID_LENGTH = 128

/** The mailbox address grammar, which is also the grammar of a `send_to` entry. */
const ADDRESS = new RegExp(MAILBOX_SEGMENT_PATTERN_SOURCE)

/** Trace ids are ASCII tokens; the mailbox mints UUIDs. */
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** The only inputs `mailbox_send` takes. There is no `from`, `seat`, `tainted` or `chain`. */
export const SEND_SCHEMA = z.strictObject({
  to: z.string().regex(ADDRESS, 'to must be a seat name (letters, digits, dot, dash, underscore; at most 64 characters)').describe('The seat to mail. It must be one of the seats mailbox_directory lists.'),
  body: z.string().min(1).max(MAX_BODY_BYTES).refine(
    text => Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES,
    `body must be at most ${MAX_BODY_BYTES} bytes`,
  ).describe('The message text.'),
  replyToTraceId: z.string().max(MAX_TRACE_ID_LENGTH).regex(TRACE_ID).optional().describe('The trace id of a message you received, when this is a reply to it.'),
  blocking: z.boolean().optional().describe('Set only when you are blocked waiting for the answer; the host may refuse it.'),
})

/** `mailbox_directory` takes no input at all. */
export const DIRECTORY_SCHEMA = z.strictObject({})

/** The parsed input of `mailbox_send`. */
export type SendInput = z.infer<typeof SEND_SCHEMA>

/**
 * Convert a tool input schema to JSON Schema and require the result to be a closed object. Any
 * schema that cannot convert, or converts to something open, throws: this runs at server
 * construction, so a bad tool can never reach a call.
 * @param tool - the tool name, for the error message.
 * @param schema - the zod schema.
 * @returns the JSON Schema the model will see.
 * @throws when zod cannot represent the schema, or the result is not a closed object.
 */
export function assertConvertible(tool: string, schema: z.ZodType): Record<string, unknown> {
  let converted: Record<string, unknown>
  try {
    converted = z.toJSONSchema(schema, { unrepresentable: 'throw', io: 'input' })
  } catch (error: unknown) {
    throw new Error(`agent-claude-code-tools: the input schema of tool ${tool} cannot be converted (${String(error)}); refusing to build the server`, { cause: error })
  }
  if (converted['type'] !== 'object' || converted['additionalProperties'] !== false) {
    throw new Error(`agent-claude-code-tools: the input schema of tool ${tool} must be a closed object (additionalProperties false); refusing to build the server`)
  }
  return converted
}

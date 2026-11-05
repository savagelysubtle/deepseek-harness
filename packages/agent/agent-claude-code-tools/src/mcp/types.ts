/**
 * Shared shapes of the dsh MCP tools: what a tool factory is handed (the per-seat closure), what a
 * tool is, and the result helpers. The closure is built once per server instance and never from
 * model input.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/mcp/types
 */

import type { MailboxPublishInput } from '@deepseek-ai/dsh-mailbox'
import type { z } from 'zod'

/** The result a tool hands back to the model: text only. */
export interface SeatToolResult {
  /** The MCP result type is open; the index signature keeps this assignable to it. */
  [key: string]: unknown
  /** One text block. */
  readonly content: { type: 'text'; text: string }[]
  /** True when the call was refused or failed. */
  readonly isError?: boolean
}

/** Everything a tool may use. Every field is fixed at server construction. */
export interface SeatToolContext {
  /** The seat's own mailbox agent id (its bare name). The only source of a message's `from`. */
  readonly seat: string
  /** The seats this seat may mail, from the host stanza's `send_to`. */
  readonly sendTo: readonly string[]
  /** Whether the host stanza lets this seat send blocking mail. */
  readonly allowBlocking: boolean
  /** Whether the Claude session has read untrusted content (sticky per session). */
  isTainted(): boolean
  /**
   * Mark the session tainted. A FUTURE tool that returns mail bodies or any external content must call
   * this before returning (S6 owns those tools); S5's two tools return only operator-configured names.
   */
  markTainted(reason: string): void
  /** Trace ids of mail already delivered to this seat. */
  deliveredTraceIds(): ReadonlySet<string>
  /** Publish one message through the mailbox service; throws when the service is unavailable. */
  publish(input: MailboxPublishInput, signal?: AbortSignal): Promise<unknown>
  /** Mint a fresh trace id. */
  newTraceId(): string
  /** Scrub text on its way to the model. */
  scrub(text: string): string
}

/** One tool the server exposes. */
export interface SeatTool {
  /** Bare name (without the `mcp__dsh__` prefix). */
  readonly name: string
  /** Description the model sees. */
  readonly description: string
  /** Strict input schema. */
  readonly inputSchema: z.ZodType
  /** Run the tool on raw model input; it validates the input itself and never throws for bad input. */
  handler(input: unknown): Promise<SeatToolResult>
}

/** Builds one tool over a seat's closure. */
export type SeatToolFactory = (context: SeatToolContext) => SeatTool

/**
 * A scrubbed text result.
 * @param context - the seat closure (for the scrubber).
 * @param text - the text.
 * @param isError - mark the result as an error.
 * @returns the result.
 */
export function textResult(context: SeatToolContext, text: string, isError = false): SeatToolResult {
  return { content: [{ type: 'text', text: context.scrub(text) }], ...isError ? { isError: true } : {} }
}

/**
 * Define a tool whose handler receives input already validated against its strict schema.
 * @param context - the seat closure.
 * @param definition - name, description, schema and the typed handler.
 * @returns the tool; bad input yields an error result naming the offending keys, not a throw.
 */
export function defineSeatTool<S extends z.ZodType>(
  context: SeatToolContext,
  definition: {
    readonly name: string
    readonly description: string
    readonly inputSchema: S
    readonly handler: (input: z.output<S>) => Promise<SeatToolResult>
  },
): SeatTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    handler: async (raw) => {
      const parsed = definition.inputSchema.safeParse(raw)
      if (!parsed.success) {
        const why = parsed.error.issues.map(issue => `${issue.path.join('.') || '(input)'}: ${issue.message}`).join('; ')
        return textResult(context, `${definition.name}: invalid input (${why})`, true)
      }
      return definition.handler(parsed.data)
    },
  }
}

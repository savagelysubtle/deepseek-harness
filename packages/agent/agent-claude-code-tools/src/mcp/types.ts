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

/** A root a tool's output is scrubbed of: the operator's home, or the seat's working directory. */
export type ScrubRoot = 'home' | 'cwd'

/** Roots scrubbed when a tool names none: the mailbox tools' behaviour. */
export const DEFAULT_SCRUB_ROOTS: readonly ScrubRoot[] = ['home', 'cwd']

/** Per-call options of {@link SeatToolContext.scrub}. */
export interface SeatScrubOptions {
  /** Which roots to scrub; default {@link DEFAULT_SCRUB_ROOTS}. The bash tool passes `['home']`. */
  readonly scrubRoots?: readonly ScrubRoot[]
  /** Length cap in code points; default the scrubber's own cap. */
  readonly maxLength?: number
}

/** Everything a tool may use. Every field is fixed at server construction. */
export interface SeatToolContext {
  /** The seat's own mailbox agent id (its bare name). The only source of a message's `from`. */
  readonly seat: string
  /** The seats this seat may mail, from the host stanza's `send_to`. */
  readonly sendTo: readonly string[]
  /** Whether the host stanza lets this seat send blocking mail. */
  readonly allowBlocking: boolean
  /** The seat's working directory (canonical, pinned per seat); fixed at server construction, never from model input. */
  readonly cwd: string
  /** Whether the Claude session has read untrusted content (sticky per session). */
  isTainted(): boolean
  /**
   * Mark the session tainted. Tools do not call this themselves: every tool declares {@link SeatTool.taint}
   * and the server marks the session before the handler of an `'always'` tool runs.
   */
  markTainted(reason: string): void
  /** Trace ids of mail already delivered to this seat. */
  deliveredTraceIds(): ReadonlySet<string>
  /** Publish one message through the mailbox service; throws when the service is unavailable. */
  publish(input: MailboxPublishInput, signal?: AbortSignal): Promise<unknown>
  /** Mint a fresh trace id. */
  newTraceId(): string
  /** Log a host-side warning; its text is never shown to the model. */
  warn(message: string): void
  /** Scrub text on its way to the model; `options` picks the roots (default home and cwd) and the length cap. */
  scrub(text: string, options?: SeatScrubOptions): string
}

/**
 * Whether a tool's results taint the session. Required on every tool: `'always'` for any tool that can
 * return content the operator did not configure (command output, mail bodies, files); `'never'` only with
 * a non-empty {@link NeverTaint.taintReason}. The server enforces it before the handler runs.
 */
export type TaintDeclaration = AlwaysTaint | NeverTaint

/** The session is tainted before the handler runs, so a throw or a timeout after reading content still taints. */
export interface AlwaysTaint {
  /** Taints the session on every call. */
  readonly taint: 'always'
  /** Not used for `'always'` tools. */
  readonly taintReason?: undefined
}

/** The tool never returns anything but host-configured values. */
export interface NeverTaint {
  /** Never taints. */
  readonly taint: 'never'
  /** Why no call can return external content; required, non-empty, and listed by the snapshot test. */
  readonly taintReason: string
}

/** The shape every tool shares. */
export interface SeatToolBase {
  /** Bare name (without the `mcp__dsh__` prefix). */
  readonly name: string
  /** Description the model sees. */
  readonly description: string
  /** Strict input schema. */
  readonly inputSchema: z.ZodType
  /**
   * Run the tool on raw model input; it validates the input itself and never throws for bad input. Only
   * `createSeatMcpServer` calls it, after enforcing {@link TaintDeclaration}.
   * @param input - the model's raw arguments.
   * @param signal - aborts the call (the MCP layer's cancellation); absent when the caller has none.
   */
  handler(input: unknown, signal?: AbortSignal): Promise<SeatToolResult>
}

/** One tool the server exposes. */
export type SeatTool = SeatToolBase & TaintDeclaration

/**
 * Check a tool's taint declaration at registration.
 * @param tool - the tool as a plain value (it may come from untyped JavaScript).
 * @throws when `taint` is missing or not `'always'`/`'never'`, or a `'never'` tool has no non-empty `taintReason`.
 */
export function assertTaintDeclaration(tool: { readonly name: string; readonly taint?: unknown; readonly taintReason?: unknown }): void {
  if (tool.taint !== 'always' && tool.taint !== 'never') {
    throw new Error(`agent-claude-code-tools: tool ${tool.name} must declare taint: 'always' or 'never'`)
  }
  if (tool.taint === 'never' && (typeof tool.taintReason !== 'string' || tool.taintReason.trim() === '')) {
    throw new Error(`agent-claude-code-tools: tool ${tool.name} declares taint: 'never' and must give a non-empty taintReason`)
  }
}

/** Builds one tool over a seat's closure. */
export type SeatToolFactory = (context: SeatToolContext) => SeatTool

/**
 * A scrubbed text result.
 * @param context - the seat closure (for the scrubber).
 * @param text - the text.
 * @param isError - mark the result as an error.
 * @param options - scrub roots and length cap (default: the mailbox tools' behaviour).
 * @returns the result.
 */
export function textResult(context: SeatToolContext, text: string, isError = false, options?: SeatScrubOptions): SeatToolResult {
  return { content: [{ type: 'text', text: context.scrub(text, options) }], ...isError ? { isError: true } : {} }
}

/**
 * Define a tool whose handler receives input already validated against its strict schema.
 * @param context - the seat closure.
 * @param definition - name, description, schema, the typed handler and the taint declaration.
 * @returns the tool; bad input yields an error result naming the offending keys, not a throw.
 * @throws when the taint declaration is missing or incomplete (see {@link assertTaintDeclaration}).
 */
export function defineSeatTool<S extends z.ZodType>(
  context: SeatToolContext,
  definition: {
    readonly name: string
    readonly description: string
    readonly inputSchema: S
    readonly handler: (input: z.output<S>, signal?: AbortSignal) => Promise<SeatToolResult>
  } & TaintDeclaration,
): SeatTool {
  assertTaintDeclaration(definition)
  const base: SeatToolBase = {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    handler: async (raw, signal) => {
      const parsed = definition.inputSchema.safeParse(raw)
      if (!parsed.success) {
        const why = parsed.error.issues.map(issue => `${issue.path.join('.') || '(input)'}: ${issue.message}`).join('; ')
        return textResult(context, `${definition.name}: invalid input (${why})`, true)
      }
      return definition.handler(parsed.data, signal)
    },
  }
  if (definition.taint === 'always') return { ...base, taint: 'always' }
  return { ...base, taint: 'never', taintReason: definition.taintReason }
}

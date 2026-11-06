/**
 * The per-seat in-process MCP server. One instance is built per seat per query; two servers never
 * share state because every tool is built over its own closure. This module is also the only place a tool
 * handler is invoked, which is what makes the taint declaration structural. Schema conversion is checked here,
 * at construction, so an unusable tool can never fail at call time.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/mcp/server
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { AnyZodRawShape, McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { MCP_SERVER_NAME } from '../contributors.ts'
import { assertConvertible } from './schema.ts'
import type { SeatToolTemplate } from './template.ts'
import { assertTaintDeclaration } from './types.ts'
import type { SeatToolContext } from './types.ts'

/** Inputs of {@link createSeatMcpServer}. */
export interface SeatServerInput {
  /** The seat's bare name. */
  readonly seat: string
  /** Bare tool names to expose, exactly the host stanza's `tools`. */
  readonly tools: readonly string[]
  /** Where the tools come from. */
  readonly template: SeatToolTemplate
  /** The seat closure every tool is built over. */
  readonly context: SeatToolContext
}

/** The `'never'` tools each server serves, with their reasons; filled by {@link createSeatMcpServer}. */
const NEVER_TOOLS = new WeakMap<object, ReadonlyMap<string, string>>()

/**
 * The tools a server built by {@link createSeatMcpServer} serves that declare the never taint, as `name -> taintReason`.
 * Read-only, for tests and diagnostics (a snapshot over the full registries lists every exemption that is live).
 * @param server - a server returned by {@link createSeatMcpServer}.
 * @returns the map, or an empty one for any other object.
 */
export function neverTaintTools(server: object): ReadonlyMap<string, string> {
  return NEVER_TOOLS.get(server) ?? new Map<string, string>()
}

/**
 * Build the seat's `dsh` server.
 * @param input - seat, tool names, template and closure.
 * @returns the SDK in-process server config.
 * @throws {SeatMutedByPolicyError} on an empty tool list or a name the template cannot provide.
 * @throws when a tool's input schema cannot be converted to a closed JSON Schema object, or its taint declaration is missing or incomplete.
 */
export function createSeatMcpServer(input: SeatServerInput): McpSdkServerConfigWithInstance {
  const built = input.template.build(input.seat, input.tools, input.context)
  const never = new Map<string, string>()
  const tools = built.map((tool): SdkMcpToolDefinition => {
    assertConvertible(tool.name, tool.inputSchema)
    assertTaintDeclaration(tool)
    // Read once: a tool object that changes its declaration or name after registration must not change what the wrapper enforces.
    const { taint, name, taintReason } = tool
    if (taint === 'never') never.set(name, taintReason)
    return {
      name,
      description: tool.description,
      // The SDK types want a raw shape, but its MCP layer accepts a whole zod object, which is what makes
      // the schema strict (a raw shape would be wrapped in a stripping object and `from` would vanish silently).
      inputSchema: tool.inputSchema as unknown as AnyZodRawShape,
      // The single choke point: taint is applied here, before the handler, so a throw or a timeout after the
      // handler read content still leaves the session tainted. No other code path may call a handler.
      handler: async (raw, extra) => {
        if (taint === 'always') input.context.markTainted(`tool:${name}`)
        return tool.handler(raw, (extra as { signal?: AbortSignal } | undefined)?.signal)
      },
    }
  })
  const server = createSdkMcpServer({ name: MCP_SERVER_NAME, tools })
  NEVER_TOOLS.set(server, never)
  return server
}

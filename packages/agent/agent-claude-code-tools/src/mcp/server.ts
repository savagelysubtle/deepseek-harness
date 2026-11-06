/**
 * The per-seat in-process MCP server. One instance is built per seat per query; two servers never
 * share state because every tool is built over its own closure. Schema conversion is checked here,
 * at construction, so an unusable tool can never fail at call time.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/mcp/server
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { AnyZodRawShape, McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { MCP_SERVER_NAME } from '../contributors.ts'
import { assertConvertible } from './schema.ts'
import type { SeatToolTemplate } from './template.ts'
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

/**
 * Build the seat's `dsh` server.
 * @param input - seat, tool names, template and closure.
 * @returns the SDK in-process server config.
 * @throws {SeatMutedByPolicyError} on an empty tool list or a name the template cannot provide.
 * @throws when a tool's input schema cannot be converted to a closed JSON Schema object.
 */
export function createSeatMcpServer(input: SeatServerInput): McpSdkServerConfigWithInstance {
  const built = input.template.build(input.seat, input.tools, input.context)
  const tools = built.map((tool): SdkMcpToolDefinition => {
    assertConvertible(tool.name, tool.inputSchema)
    return {
      name: tool.name,
      description: tool.description,
      // The SDK types want a raw shape, but its MCP layer accepts a whole zod object, which is what makes
      // the schema strict (a raw shape would be wrapped in a stripping object and `from` would vanish silently).
      inputSchema: tool.inputSchema as unknown as AnyZodRawShape,
      handler: async raw => tool.handler(raw),
    }
  })
  return createSdkMcpServer({ name: MCP_SERVER_NAME, tools })
}

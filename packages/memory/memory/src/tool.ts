/**
 * Model-facing `memory` tool: read, write, list, and search the project's
 * durable markdown notes. Content enters a conversation only through this
 * tool's results — memory is an explicit tool call, never background
 * injection. The project scope comes from the calling session's cwd.
 * @module @deepseek-ai/dsh-memory/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
// Type-only: declaration-merges ctx.memory onto Context via the seam package.
import type {} from './index.ts'

export const name = 'tool-memory'
export const inject = ['tools']

/** Config for the memory tool consumer. */
export interface Config {
  /**
   * Cap on `search` matches returned per call; the provider clamps this to
   * its own hard ceiling. Default 50 keeps worst-case output bounded.
   */
  searchLimit?: number
}

/** Schemastery configuration for the tool consumer. */
export const Config: z<Config> = z.object({
  searchLimit: z.number().step(1).min(1).max(200),
})

/** The single result shape every action returns; absent keys stay absent. */
interface MemoryToolOutput {
  action: 'read' | 'write' | 'list' | 'search'
  path?: string
  bytes?: number
  content?: string
  entries?: JsonValue[]
  matches?: JsonValue[]
}

const TOOL_DESCRIPTION = [
  'Read, write, list, and search DURABLE project memory: plain-markdown notes scoped to',
  'the current workspace that persist across sessions, restarts, and seats — yours and',
  "your teammates' co-edit them on disk.",
  'Use write() to record decisions, environment gotchas, session state worth carrying',
  'forward, or canonical locations; use read()/list()/search() instead of asking the user',
  'to repeat context the memory already holds. Paths are scope-relative with forward',
  'slashes (`todo/auth.md`, `spec/decisions.md`); parent traversal is rejected.',
  'Content costs prompt tokens only when you read or search it, so prefer list() first,',
  'then read() the specific entries you need.',
].join('\n')

/** Narrow one JSON render value back to the canonical output. */
function asOutput(value: JsonValue): MemoryToolOutput {
  return value as unknown as MemoryToolOutput
}

/**
 * Mount the memory tool onto the tools registry for this composition layer.
 * @param ctx - context carrying the host tools registry and the memory service.
 * @param config - consumer options (search cap).
 * @returns the registration disposer (registry teardown unregisters the tool).
 */
export const apply = (ctx: Context, config: Config): (() => void) => {
  // Arrow, not a function declaration: Cordis treats a prototype-bearing
  // ordinary function as a constructor, and this registration is synchronous.
  const searchLimit = config.searchLimit ?? 50
  return ctx.tools.register(defineTool({
    name: 'memory',
    description: TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['read', 'write', 'list', 'search'],
        description: 'What to do: read one entry, write/replace one entry, list every entry, or substring-search all entries.',
      },
      path: {
        type: 'string',
        description: 'Entry path, scope-relative with forward slashes (required for read/write). No leading `/`, no `..` segments.',
      },
      content: {
        type: 'string',
        description: 'Complete replacement text in UTF-8, up to 256 KiB (required for write). Plain markdown; frontmatter optional.',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive substring to find across entry lines (required for search).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          content: { type: 'string' },
          entries: { type: 'array', items: { type: 'json' } },
          matches: { type: 'array', items: { type: 'json' } },
        },
      },
      render(_args, value) {
        const out = asOutput(value)
        if (out.action === 'read') {
          return [{ type: 'text', text: out.content ?? '' }]
        }
        if (out.action === 'write') {
          return [{ type: 'text', text: `Saved ${String(out.path)} (${String(out.bytes)} bytes).` }]
        }
        if (out.action === 'list') {
          const entries = (out.entries ?? []) as Array<{ path: string; bytes: number }>
          if (entries.length === 0) {
            return [{ type: 'text', text: '(no memory entries yet — create one with action:"write")' }]
          }
          return [{ type: 'text', text: entries.map(entry => `- ${entry.path} (${String(entry.bytes)} B)`).join('\n') }]
        }
        const matches = (out.matches ?? []) as Array<{ path: string; line: number; excerpt: string }>
        if (matches.length === 0) {
          return [{ type: 'text', text: '(no matches)' }]
        }
        return [{ type: 'text', text: matches.map(match => `[${match.path}:${String(match.line)}] ${match.excerpt}`).join('\n') }]
      },
    },
    async execute(args, exec): Promise<MemoryToolOutput> {
      const memory = ctx.get('memory')
      if (memory === undefined) {
        throw new Error('memory tool requires the memory service — mount @deepseek-ai/dsh-memory/local')
      }
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) {
        throw new Error('memory requires an agent session with a working directory (cwd-scoped storage)')
      }
      const input = args as { action?: unknown; path?: unknown; content?: unknown; query?: unknown }
      const { action } = input
      if (action === 'read') {
        return { action, content: await memory.read(cwd, requirePath(input.path)) }
      }
      if (action === 'write') {
        const result = await memory.write(cwd, requirePath(input.path), requireContent(input.content))
        return { action, path: result.path, bytes: result.bytes }
      }
      if (action === 'list') {
        // Entries are JSON-safe records by construction; JsonValue asks for
        // the index signature they already satisfy at runtime.
        return { action, entries: await memory.list(cwd) as unknown as JsonValue[] }
      }
      if (action === 'search') {
        if (typeof input.query !== 'string' || input.query.trim() === '') {
          throw new Error('memory: action "search" requires a non-empty query')
        }
        return { action, matches: await memory.search(cwd, input.query, searchLimit) as unknown as JsonValue[] }
      }
      throw new Error(`memory: unknown action ${JSON.stringify(action)} — expected read | write | list | search`)
    },
  }))
}

/**
 * Require a present path argument for read/write actions.
 * @param value - raw path argument from the model.
 * @returns the validated path string.
 */
function requirePath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('memory: this action requires a non-empty "path" (scope-relative, forward slashes)')
  }
  return value
}

/**
 * Require a present content argument for write actions.
 * @param value - raw content argument from the model.
 * @returns the validated content string.
 */
function requireContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('memory: action "write" requires string "content" — send the COMPLETE replacement text')
  }
  return value
}

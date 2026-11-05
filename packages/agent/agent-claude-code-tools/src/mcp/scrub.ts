/**
 * Scrubber for everything a dsh MCP tool says back to the model: control characters (except
 * newline and tab) are removed, any path under a protected root (the operator's home, the seat's
 * working directory) is replaced, and the length is capped.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/mcp/scrub
 */

/** Longest tool result text, in UTF-16 code units. */
export const MAX_RESULT_LENGTH = 4000

/** What replaces a path under a protected root. */
export const REDACTED_PATH = '[path]'

/** Marker appended when the text was cut. */
const TRUNCATED = '... [truncated]'

/** Every control character except newline (U+000A) and tab (U+0009). */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/** Options of {@link scrubText}. */
export interface ScrubOptions {
  /** Absolute directories whose paths must never appear (the operator home, the seat cwd). */
  readonly roots: readonly string[]
  /** Length cap; default {@link MAX_RESULT_LENGTH}. */
  readonly maxLength?: number
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scrub one string for the model.
 * @param text - raw text.
 * @param options - protected roots and the length cap.
 * @returns text with no control characters (but newline and tab), no path under a root, at most the cap.
 */
export function scrubText(text: string, options: ScrubOptions): string {
  const max = options.maxLength ?? MAX_RESULT_LENGTH
  let out = text.replace(CONTROL, '')
  // Longest roots first so a nested root is replaced whole; a root is matched together with the rest of its path.
  const roots = [...new Set(options.roots.filter(root => root.length > 1))].sort((a, b) => b.length - a.length)
  for (const root of roots) {
    out = out.replace(new RegExp(`${escapeRegExp(root.replace(/\/+$/, ''))}(?![\\w-]|\\.[\\w-])(?:/[^\\s'"\`<>)\\]}]*)?`, 'g'), REDACTED_PATH)
  }
  return out.length > max ? `${out.slice(0, Math.max(0, max - TRUNCATED.length))}${TRUNCATED}` : out
}

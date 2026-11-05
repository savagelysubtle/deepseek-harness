/**
 * Strict grammars shared by the host side (command and policy-file writers) and the seat-guard
 * hook. Guard-reachable: node builtins only, erasable TypeScript only.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/grammar
 */

/** A seat name: lower-case, starts with a letter, at most 32 characters, no separators. */
export const SEAT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** A lower-case hex SHA-256 digest. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/

/** A bare dsh tool name (the part after `mcp__dsh__`). */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/**
 * Whether a value is a valid seat name.
 * @param value - candidate.
 * @returns true when it matches {@link SEAT_NAME_PATTERN}.
 */
export function isSeatName(value: unknown): value is string {
  return typeof value === 'string' && SEAT_NAME_PATTERN.test(value)
}

/**
 * Whether a value is a valid lower-case hex SHA-256 digest.
 * @param value - candidate.
 * @returns true when it matches {@link SHA256_PATTERN}.
 */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

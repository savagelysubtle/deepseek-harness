/**
 * Shared boundary validators for the port-allocator package. Config values and
 * request values may arrive from parsed consumer Config, so every one is
 * validated here with a message naming the field and the owning module.
 * @module @deepseek-ai/dsh-port-allocator/validate
 */

/** Lowest port number TCP accepts for an explicit bind. */
export const MIN_TCP_PORT = 1

/** Highest port number TCP accepts. */
export const MAX_TCP_PORT = 65_535

/**
 * Validate one port number for a named field.
 * @param value - candidate port number.
 * @param source - owning module name used in the thrown message (`port allocator`, `env isolator`).
 * @param field - field name used in the thrown message.
 * @returns nothing; throws when `value` is not an integer inside the legal TCP range.
 */
export function assertTcpPort(value: number, source: string, field: string): void {
  if (!Number.isInteger(value) || value < MIN_TCP_PORT || value > MAX_TCP_PORT) {
    throw new Error(
      `${source}: ${field} must be an integer between ${MIN_TCP_PORT} and ${MAX_TCP_PORT}, received ${value}`,
    )
  }
}

/**
 * Validate one environment-variable name for a named field. POSIX names only;
 * the consumer owns any cross-platform name-case concern.
 * @param value - candidate variable name.
 * @param source - owning module name used in the thrown message (`env isolator`).
 * @param field - field name used in the thrown message.
 * @returns nothing; throws when `value` is not a valid POSIX environment-variable name.
 */
export function assertEnvName(value: string, source: string, field: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(
      `${source}: ${field} must be a POSIX environment-variable name (letters, digits, underscore; not starting with a digit), received ${JSON.stringify(value)}`,
    )
  }
}

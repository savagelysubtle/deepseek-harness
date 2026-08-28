/**
 * The mailbox address grammar: one bare segment per seat.
 *
 * Addresses are the seat's own name — identical to the named-session name
 * grammar (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, from
 * `@deepseek-ai/dsh-named-sessions`): filename-safe, bounded, and already the
 * routing vocabulary consumers know. One name names one seat across the whole
 * deployment ("message alfred" — there is exactly one), so a derived session
 * id can be computed from an address with no second encoding.
 *
 * @module @deepseek-ai/dsh-mailbox/address
 */

import type { MailboxAddress } from './types.ts'

/** Source form of one mailbox address; identical to the session-name grammar. */
export const MAILBOX_SEGMENT_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

const ADDRESS_PATTERN = new RegExp(MAILBOX_SEGMENT_PATTERN_SOURCE)

/**
 * Validate one raw address against the address grammar and brand it.
 * @param raw - candidate address text.
 * @returns the branded address, safe to hand to providers.
 * @throws when the address violates the grammar.
 */
export function parseMailboxAddress(raw: string): MailboxAddress {
  if (!ADDRESS_PATTERN.test(raw)) {
    throw new Error(`invalid mailbox address ${JSON.stringify(raw)}: must match ${MAILBOX_SEGMENT_PATTERN_SOURCE}`)
  }
  return raw as MailboxAddress
}

/**
 * Validate and brand one address. Round-trips through
 * {@link parseMailboxAddress} by construction.
 * @param name - the seat's address, typically also its session name.
 * @returns the branded formatted address.
 * @throws when the name violates the grammar.
 */
export function formatMailboxAddress(name: string): MailboxAddress {
  return parseMailboxAddress(name)
}

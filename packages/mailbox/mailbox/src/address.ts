/**
 * The `<namespace>:<name>` address grammar shared by every mailbox endpoint.
 *
 * Both segments reuse the named-session name grammar (`^[A-Za-z0-9]
 * [A-Za-z0-9._-]{0,63}$`, from `@deepseek-ai/dsh-named-sessions`): it is
 * filename-safe, bounded, and already the routing vocabulary consumers know.
 * One grammar decision covers both halves, so `ceo-web:operations` parses and
 * a derived session id can later be computed for the name half without any
 * new encoding.
 *
 * @module @deepseek-ai/dsh-mailbox/address
 */

import type { MailboxAddress } from './types.ts'

/** Source form of one mailbox address segment; identical to the session-name grammar. */
export const MAILBOX_SEGMENT_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

const SEGMENT_PATTERN = new RegExp(MAILBOX_SEGMENT_PATTERN_SOURCE)

/** Separator between the namespace and the name segment. */
export const MAILBOX_ADDRESS_SEPARATOR = ':'

/** Hard bound on a full formatted address; 64 + 1 + 64 plus headroom. */
const MAX_ADDRESS_LENGTH = 160

/**
 * Validate one raw address against the segment grammar and brand it.
 * @param raw - candidate address text.
 * @returns the branded address, safe to hand to providers.
 * @throws when either segment violates the grammar or the separator is missing.
 */
export function parseMailboxAddress(raw: string): MailboxAddress {
  const separatorAt = raw.indexOf(MAILBOX_ADDRESS_SEPARATOR)
  if (separatorAt <= 0) {
    throw new Error(`invalid mailbox address ${JSON.stringify(raw)}: expected "<namespace>:<name>"`)
  }
  assertMailboxSegment('namespace', raw.slice(0, separatorAt), raw)
  // A second separator can only land in the name half, whose grammar forbids ':' —
  // so validating the tail rejects multi-colon forms without a special case.
  assertMailboxSegment('name', raw.slice(separatorAt + 1), raw)
  return raw as MailboxAddress
}

/**
 * Compose an address from validated parts. Round-trips through
 * {@link parseMailboxAddress} by construction.
 * @param namespace - routing scope of the endpoint (for example a company or deployment).
 * @param name - endpoint within the namespace (typically the target agent's session name).
 * @returns the branded formatted address.
 * @throws when either part violates the segment grammar.
 */
export function formatMailboxAddress(namespace: string, name: string): MailboxAddress {
  assertMailboxSegment('namespace', namespace, `${namespace}<sep>…`)
  assertMailboxSegment('name', name, `…<sep>${name}`)
  return `${namespace}${MAILBOX_ADDRESS_SEPARATOR}${name}` as MailboxAddress
}

/**
 * Enforce the shared segment grammar against one labeled half of an address.
 * @param label - which half failed, for the error message.
 * @param value - the segment text under judgment.
 * @param whole - the full address context, for the error message.
 * @throws when the segment is empty, oversized, or carries illegal characters.
 */
function assertMailboxSegment(label: 'namespace' | 'name', value: string, whole: string): void {
  if (!SEGMENT_PATTERN.test(value) || whole.length > MAX_ADDRESS_LENGTH) {
    throw new Error(
      `invalid mailbox ${label} in ${JSON.stringify(whole)}: segments must match ${MAILBOX_SEGMENT_PATTERN_SOURCE}`,
    )
  }
}

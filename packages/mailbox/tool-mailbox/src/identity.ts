/**
 * The trusted sender identity of the mailbox tools. The identity is resolved
 * once at plugin mount from the deployment-supplied session name — the name
 * the operator's launcher passed to the seat's process — and both tools close
 * over the resolved value. The model-facing schema carries no sender field at
 * all, so a seat cannot claim to be anyone else: the caller-side forgery
 * surface the seam's free-form `from` otherwise leaves open does not exist
 * here.
 *
 * @module @deepseek-ai/dsh-tool-mailbox/identity
 */

import { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import type { MailboxAddress } from '@deepseek-ai/dsh-mailbox'

/**
 * Resolve the calling session's mailbox address from its trusted session
 * name. The mailbox address grammar is the named-session name grammar, so a
 * valid name parses directly; {@link formatMailboxAddress} enforces that
 * equivalence loudly instead of trusting it.
 * @param sessionName - the trusted session name supplied by the deployment,
 *   or undefined for an anonymous run that has none.
 * @returns the branded own address.
 * @throws when the run has no session name: an anonymous run has no trusted
 *   identity, so there is no sender to fill and no address to drain. The
 *   tools fail with this error at call time — mounting without a name is
 *   legitimate (the tool catalog stays stable across runs), using the tools
 *   without one is not.
 */
export function resolveMailboxIdentity(sessionName: string | undefined): MailboxAddress {
  if (sessionName === undefined || sessionName.trim() === '') {
    throw new Error(
      'mailbox tools require a named session: no trusted sender identity exists for an anonymous run'
      + ' (start with dsh --profile headless --session-name <name> to get one)',
    )
  }
  return formatMailboxAddress(sessionName)
}

/**
 * The trusted sender identity of the mailbox tools. The model-facing schema
 * carries no sender field at all, so a seat cannot claim to be anyone else:
 * the caller-side forgery surface the seam's free-form `from` otherwise
 * leaves open does not exist here. What remains is where the runtime gets the
 * identity it fills in, and that depends on how many seats share the process.
 *
 * **One process, one seat** — `dsh --profile headless --session-name <name>`.
 * The launcher validated the name before the process had an agent, so the
 * name IS the identity and {@link Config.sessionName} carries it.
 *
 * **One process, many seats** — the host serving the UI. A mount-time name
 * would be a single identity handed to every session in the process, which
 * is worse than no identity: seat A's send would be stamped seat B. The
 * identity has to come from the CALLING agent instead, and the only thing the
 * tool has of it is its durable session id. That is enough, because the id is
 * derived from the name by {@link deriveNamedSessionId} — so re-deriving the
 * id of every served address and matching is a pre-image search over a known
 * finite set. A caller cannot pass the check by naming an address; it passes
 * only by actually running as the session that address derives to.
 *
 * @module @deepseek-ai/dsh-tool-mailbox/identity
 */

import { formatMailboxAddress } from '@deepseek-ai/dsh-mailbox'
import type { MailboxAddress } from '@deepseek-ai/dsh-mailbox'
import { deriveNamedSessionId } from '@deepseek-ai/dsh-named-sessions'

/**
 * What the tool knows about who is calling. Both fields are supplied by the
 * runtime and neither is reachable from the model's arguments.
 */
export interface IdentitySources {
  /**
   * The launcher-validated session name of a single-seat process, or
   * undefined when the deployment has no such name (the multi-seat host).
   */
  readonly sessionName?: string
  /**
   * The addresses this deployment serves — the same roster the bridge is
   * mounted with. Empty or absent in a single-seat process, where the name
   * above is the whole answer.
   */
  readonly addresses?: readonly string[]
  /**
   * The calling agent's durable session id, when the call runs on behalf of
   * an agent. Absent for a direct registry call outside any agent loop.
   */
  readonly agentSessionId?: string
}

/**
 * Resolve the calling session's mailbox address.
 *
 * The agent-derived match is tried FIRST and, when a roster exists, it is
 * also final: in a many-seat process the mount-time name cannot be right for
 * more than one caller, so falling back to it after a failed match would
 * hand every non-seat session one seat's identity. A process with no roster
 * has only the launcher's name, and there the name is authoritative.
 * @param sources - the runtime-supplied identity inputs.
 * @returns the branded own address.
 * @throws when no trusted identity exists: an anonymous run has none to fill
 *   and none to drain, and a session the deployment does not serve is not a
 *   seat. The tools fail with this error at call time — mounting without an
 *   identity is legitimate (the tool catalog stays stable across runs), using
 *   the tools without one is not.
 */
export function resolveMailboxIdentity(sources: IdentitySources): MailboxAddress {
  const { sessionName, addresses, agentSessionId } = sources
  if (addresses !== undefined && addresses.length > 0) {
    if (agentSessionId === undefined) {
      throw new Error(
        'mailbox tools require a calling agent in a multi-seat deployment: the sender identity is the calling'
        + ' session\'s own, and a call with no agent has none',
      )
    }
    const match = addresses.find(address => String(deriveNamedSessionId(address)) === agentSessionId)
    if (match === undefined) {
      throw new Error(
        `mailbox tools: session "${agentSessionId}" is not one of the addresses this deployment serves`
        + ` (${addresses.join(', ')}), so it has no seat identity to send or drain as`,
      )
    }
    return formatMailboxAddress(match)
  }
  if (sessionName === undefined || sessionName.trim() === '') {
    throw new Error(
      'mailbox tools require a named session: no trusted sender identity exists for an anonymous run'
      + ' (start with dsh --profile headless --session-name <name> to get one)',
    )
  }
  return formatMailboxAddress(sessionName)
}

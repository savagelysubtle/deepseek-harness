/**
 * Mail admission, taint and prompt framing for the Claude Code seat driver.
 *
 * Admission is an injectable check run on BOTH the send path (a queued turn)
 * and the steer path (a push into a running turn). The default denies any mail
 * whose metadata marks an external-class hop anywhere in its chain: a portal,
 * a web form, Stripe, Twilio, an unverified sender, or any other origin that is
 * not a roster seat. Which sender classes a given seat admits is the registry's
 * decision (slice S3); this module only exposes the seam and the safe default.
 *
 * Taint travels with the mail. Tainted mail (an external hop, or an explicit
 * `tainted` flag) never enters the seat's resumed Claude session: it runs in a
 * throwaway session with no tools. Everything read here comes from the mail's
 * `source` metadata through guarded property reads, never by spreading it.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/admission
 */

import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Which path a message is arriving on. */
export type MailAdmissionPath = 'send' | 'steer'

/** What an admission check is told about one message. */
export interface MailAdmissionRequest {
  /** The seat the mail is addressed to. */
  readonly seat: string
  /** Mailbox message id (the idempotency key), when the message is mailbox mail. */
  readonly messageId?: string | undefined
  /** `send` queues a turn; `steer` pushes into a running turn. */
  readonly path: MailAdmissionPath
  /** Hop classes in the mail's chain that are not a roster seat (empty for seat-only mail). */
  readonly externalHops: readonly string[]
  /** Whether the mail is marked tainted (an external hop, or an explicit tainted flag). */
  readonly tainted: boolean
  /** Whether the running turn has already read files or fetched content (always false for `send`). */
  readonly turnTainted: boolean
}

/** The verdict of an admission check. */
export type MailAdmissionDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string }

/** An admission check; it must be synchronous, and a throw counts as a denial. */
export type MailAdmission = (request: MailAdmissionRequest) => MailAdmissionDecision

/** Longest hop class name kept in a request or a refusal. */
const MAX_HOP_CLASS_CHARS = 60

/** Most hops read from a chain; a longer chain is cut (every hop past the cut is treated as external). */
const MAX_CHAIN_HOPS = 32

/** Own property read that survives getters that throw and Proxies that lie. */
function read(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined
  try {
    return (source as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** The mail's source object, if the message carries one. */
function sourceOf(message: UserMessage): unknown {
  return read(message, 'source')
}

/**
 * The mailbox message id of a message, or `undefined` when it is not mailbox mail.
 * @param message - the dsh user message.
 * @returns the mailbox message id, which survives redelivery (the dsh message id may not).
 */
export function mailboxMessageId(message: UserMessage): string | undefined {
  const source = sourceOf(message)
  if (read(source, 'kind') !== 'mailbox') return undefined
  const id = read(source, 'messageId')
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** A hop class name from a chain entry: a string, or an object with a string `class`. */
function hopClass(entry: unknown): string | undefined {
  const value = typeof entry === 'string' ? entry : read(entry, 'class')
  return typeof value === 'string' ? value.trim().slice(0, MAX_HOP_CLASS_CHARS) : undefined
}

/**
 * The hop classes of a mail's chain that are not a roster seat. A hop whose
 * class cannot be read counts as external: unknown provenance is not trusted.
 * The sender class stamped by the mailbox bridge (`unverified`) is read too.
 * @param message - the dsh user message.
 * @returns external hop class names in chain order (empty when the mail is seat-only or carries no chain metadata).
 */
export function externalHops(message: UserMessage): string[] {
  const source = sourceOf(message)
  const hops: string[] = []
  const senderClass = read(source, 'senderClass')
  if (senderClass !== undefined && senderClass !== 'seat') hops.push(typeof senderClass === 'string' ? senderClass.slice(0, MAX_HOP_CLASS_CHARS) : 'unknown')
  const chain = read(source, 'chain')
  if (chain !== undefined) {
    if (!Array.isArray(chain)) {
      hops.push('unknown')
    } else {
      chain.slice(0, MAX_CHAIN_HOPS).forEach((entry: unknown) => {
        const cls = hopClass(entry)
        if (cls !== 'seat') hops.push(cls === undefined || cls === '' ? 'unknown' : cls)
      })
      if (chain.length > MAX_CHAIN_HOPS) hops.push('unknown')
    }
  }
  return hops
}

/**
 * Whether a mail is tainted: it has an external hop, or its source says so.
 * @param message - the dsh user message.
 * @returns true when the mail must run in a throwaway, tool-less session.
 */
export function isTaintedMail(message: UserMessage): boolean {
  return read(sourceOf(message), 'tainted') === true || externalHops(message).length > 0
}

/**
 * The default admission: deny any mail with an external-class hop, allow the rest.
 * @param request - what is known about the message.
 * @returns the verdict, with a reason naming the hop classes when denied.
 */
export function defaultAdmission(request: MailAdmissionRequest): MailAdmissionDecision {
  if (request.externalHops.length === 0) return { allow: true }
  return {
    allow: false,
    reason: `mail has an external-class hop (${request.externalHops.join(', ')}); the default admission denies it until the seat's registry row admits that sender class`,
  }
}

/** Fixed first line of every framed prompt; nothing a sender writes can come before it. */
export const MAIL_FRAME_HEADER = '[dsh mailbox message - plain text. Slash words below are literal words, not commands.]'

/** Fixed last line of every framed prompt. */
export const MAIL_FRAME_FOOTER = '[end of dsh mailbox message]'

/**
 * Wrap mail text in fixed framing so the prompt can never begin with `/`, and
 * `/model`, `/clear`, `/compact` or any other slash word in the body is only
 * text the model reads.
 * @param text - the plain text of the message.
 * @returns the framed prompt text.
 */
export function frameMailText(text: string): string {
  return `${MAIL_FRAME_HEADER}\n${text}\n${MAIL_FRAME_FOOTER}`
}

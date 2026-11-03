/**
 * Idempotent mail handling: what the driver knows about each mailbox message
 * from its own durable records, and the seam through which a turn settles or
 * fails the mailbox lease.
 *
 * Ordering for one mailbox message (the README repeats this):
 *
 * 1. The mail is admitted (send or steer path); a refusal writes
 *    `claude-code/refused` and fails the lease. Nothing else happens.
 * 2. When a turn claims it, the message id is checked against the log. A
 *    message already settled is settled again and skipped; a message claimed
 *    earlier without an outcome (a crash, or a copy still running) is never
 *    run a second time.
 * 3. `claude-code/mail-claimed` is appended and the session is FLUSHED, and
 *    only then is the prompt sent. A failed flush fails the lease and sends
 *    nothing.
 * 4. When the turn ends, `claude-code/mail-outcome` is appended (settled,
 *    failed or paused) and the lease is settled or failed with the reason.
 *
 * A crash between steps 3 and 4 leaves a claimed record with no outcome, so a
 * redelivery fails loudly instead of running the same mail twice. A failure
 * before step 3 leaves no record at all, so a retry runs normally.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/mail-lease
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** What the driver needs from the mailbox bridge's lease: settle it, or fail it with a reason. */
export interface MailLeaseSink {
  /**
   * The mail was answered; mark the lease done. Must be safe to call twice for one message.
   * @param messageId - the mailbox message id.
   */
  settle(messageId: string): void | Promise<void>
  /**
   * The mail was not (or could not be) answered; mark the lease failed with a visible reason.
   * @param messageId - the mailbox message id.
   * @param reason - short redacted reason the sender can read.
   */
  fail(messageId: string, reason: string): void | Promise<void>
}

/** What the driver's own log says about one mailbox message. */
export type MailState = 'claimed' | 'settled' | 'failed' | 'paused'

/** Per-session view of mailbox message states, rebuilt from the log and kept current by the agent. */
export class MailLog {
  private readonly states = new Map<string, MailState>()

  /**
   * @param session - the session whose `claude-code/mail-*` records are read.
   */
  constructor(session: Session) {
    for (const event of session.events) {
      const data = event.data as { messageId?: unknown; outcome?: unknown }
      if (typeof data.messageId !== 'string') continue
      if (event.type === 'claude-code/mail-claimed') this.states.set(data.messageId, 'claimed')
      else if (event.type === 'claude-code/mail-outcome') this.states.set(data.messageId, data.outcome as MailState)
    }
  }

  /**
   * The recorded state of a message.
   * @param messageId - the mailbox message id.
   * @returns the state, or undefined when the log has never seen the message.
   */
  get(messageId: string): MailState | undefined {
    return this.states.get(messageId)
  }

  /**
   * Remember a state written to the log.
   * @param messageId - the mailbox message id.
   * @param state - the new state.
   */
  set(messageId: string, state: MailState): void {
    this.states.set(messageId, state)
  }
}

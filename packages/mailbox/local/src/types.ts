/**
 * Local-store data contracts of the SQLite mailbox provider: the row mapping
 * and clock vocabulary owned by this package. Seam-level message, lease, and
 * outcome types live in `@deepseek-ai/dsh-mailbox`; nothing here re-declares
 * them.
 *
 * @module @deepseek-ai/dsh-mailbox-local/types
 */

/**
 * One `messages` table row. Optional seam fields and lease bookkeeping are
 * nullable columns; reconstruction maps `NULL` back to an omitted field.
 */
export interface MessageRow {
  id: string
  to_address: string
  from_address: string
  type: string | null
  subject: string | null
  /** JSON-encoded payload; `null` when the message carries none. */
  payload: string | null
  trace_id: string | null
  /** `1` iff the sender marked itself blocked waiting for an answer; `null` = false. */
  blocking: number | null
  state: 'pending' | 'claimed' | 'done' | 'failed'
  created_at: number
  claimed_at: number | null
  claim_token: string | null
  settle_state: 'done' | 'failed' | null
  /** JSON-encoded delivery envelope (`{ deliveredAt, messageId }` or `{ reason }`); `null` unless settled terminal. */
  result: string | null
}

/**
 * Epoch-millisecond source used for creation and claim timestamps and for
 * staleness cutoffs. The default is `Date.now`; tests inject a fake clock.
 */
export type MailboxClock = () => number

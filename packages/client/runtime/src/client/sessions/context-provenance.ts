// Context source projection: the role and the human-facing producer name
// of one logged non-user `user/message`, read from its durable `source` alone.
// The client keeps no table of known plugin ids — a renamed or newly mounted
// producer must never need a client release to stay identifiable, and a resumed
// or foreign log must project the same way as a live one.

/**
 * Which model-facing role a logged non-user message plays.
 *
 * `recall` marks material lifted out of another session's log; `inject` marks
 * every other producer-supplied context. Mid-turn steering is the third role
 * the transcript distinguishes, but it has its own event and node kind
 * (`steering/message` / `SteeringMessageNode`) and never reaches here.
 */
export type ContextRole = 'inject' | 'recall'

/** Role and producer name presented for one logged non-user message. */
export interface ContextProvenanceView {
  /** The role this context plays in the model-facing conversation. */
  role: ContextRole
  /**
   * Producer name for the row header, taken from the durable source: the
   * instruction paths, the referenced session titles, the plugin id, or the
   * bare source kind for a producer this UI version does not know. Null only
   * when the source carries no readable kind at all.
   */
  label: string | null
}

/** One durable source narrowed to the readable-record shape; null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** A record field read as a non-empty string, or null. */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Distinct non-empty `field` values of an array-valued source member, in first-seen order. */
function collect(source: Record<string, unknown>, member: string, field: string): string[] {
  const list = source[member]
  if (!Array.isArray(list)) return []
  const seen: string[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    const value = record === null ? null : readString(record, field)
    if (value !== null && !seen.includes(value)) seen.push(value)
  }
  return seen
}

/** A collected name list rendered as one label; null when the list is empty. */
function joined(names: string[]): string | null {
  return names.length > 0 ? names.join(', ') : null
}

/**
 * Project one durable message source onto its transcript role and producer name.
 *
 * The source arrives over the wire as opaque JSON (`MessageSource` is
 * merge-extensible, so no client-side union can be exhaustive), and a durable
 * log may predate or postdate this UI; every unreadable shape therefore
 * degrades to `inject` with whatever name the record still carries.
 * @param source - the logged `user/message` source, exactly as recorded.
 * @returns the role and producer name to present for this context.
 */
export function contextProvenance(source: unknown): ContextProvenanceView {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  if (record === null || kind === null) return { role: 'inject', label: null }
  switch (kind) {
    // Cross-session snapshots are the one durable source that carries another
    // session's material; its references name the sessions they were read from.
    case 'session-reference':
      return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind }
    // Workspace instructions name the files they were reconciled from, which
    // identifies the producer far better than the plugin id would.
    case 'agent-instructions':
      return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind }
    case 'plugin':
      return { role: 'inject', label: readString(record, 'plugin') ?? kind }
    // A user-explicit skill invocation names the skill it injected.
    case 'skill-invocation':
      return { role: 'inject', label: readString(record, 'name') ?? kind }
    // Delivered mail names its sender address. The dedicated mail card
    // (`ContextInjectionRow`, gated on {@link mailboxRelay}) replaces this
    // label entirely once the source is readable; it survives here only as
    // the collapsed-row fallback for a mailbox source that names no sender.
    case 'mailbox':
      return { role: 'inject', label: readString(record, 'from') ?? kind }
    // Documented default arm of the merge-extensible source map: an unknown
    // producer still identifies itself by its own durable kind.
    default:
      return { role: 'inject', label: kind }
  }
}

/**
 * Context forms this UI version renders with a dedicated presentation. The
 * durable vocabulary (`ContextForm` in `dsh-llm`) may already be wider — an
 * unrecognized or absent value degrades to the opaque presentation rather than
 * dropping the row, so a log written by a newer or foreign producer still
 * renders.
 */
const KNOWN_FORMS = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'] as const

/** One durable context form this UI version knows how to present. */
export type KnownContextForm = typeof KNOWN_FORMS[number]

/**
 * Read the producer-declared form off one durable message source.
 * @param source - the logged `user/message` source, exactly as recorded.
 * @returns the form when this UI version presents it, otherwise null (opaque).
 */
export function contextForm(source: unknown): KnownContextForm | null {
  const record = asRecord(source)
  const form = record === null ? null : readString(record, 'form')
  return form !== null && (KNOWN_FORMS as readonly string[]).includes(form)
    ? form as KnownContextForm
    : null
}

/**
 * Sender class a delivered mailbox relay's source may state: `seat` when the
 * sender address matched a roster seat at delivery, `unverified` otherwise.
 * Mirrors `SenderClass` in `@deepseek-ai/dsh-mailbox-bridge`, duplicated here
 * rather than imported so this UI package stays independent of the bridge.
 */
export type MailboxSenderClass = 'seat' | 'unverified'

/**
  * Everything this UI version can read off a delivered mailbox relay's durable
 * source. The bridge stamps `senderClass` on every delivery, and `subject` and
 * `blocking` whenever the message carried them (`relaySource` in
 * `@deepseek-ai/dsh-mailbox-bridge`, onto `MailboxMessageSource` in
 * `@deepseek-ai/dsh-mailbox`), so all three normally read. They still read null
 * for a message logged before that stamping landed, and for one that simply
 * carried no subject or was not blocking — the mail card degrades by omitting
 * whatever reads null. Nothing here is scraped from the model-facing envelope
 * text; the source is the only input, and it is merge-extensible by design.
 */
export interface MailboxRelayView {
  /** Sender address, exactly as the source records it. */
  from: string
  /** Sender class stated at delivery, when the source records it. */
  senderClass: MailboxSenderClass | null
  /** Subject line, when the source records one. */
  subject: string | null
  /** Whether the sender is blocked waiting on a reply, when the source records it. */
  blocking: boolean | null
}

/**
 * Read one delivered mailbox relay off its durable source.
 *
 * Narrower than {@link contextForm}: `form: 'relay'` alone does not say
 * whether a context is delivered mail or a subagent relay (both declare it),
 * so the mail presentation and {@link contextForm}'s `relay` dispatch both
 * call this first and fall back to the subagent presentation when it reads
 * null.
 * @param source - the logged `user/message` source, exactly as recorded.
 * @returns the readable mail fields, or null when this is not a readable
 *   mailbox relay (a different `kind`, or one that names no sender).
 */
export function mailboxRelay(source: unknown): MailboxRelayView | null {
  const record = asRecord(source)
  if (record === null || readString(record, 'kind') !== 'mailbox') return null
  const from = readString(record, 'from')
  if (from === null) return null
  const senderClass = record['senderClass']
  const blocking = record['blocking']
  return {
    from,
    senderClass: senderClass === 'seat' || senderClass === 'unverified' ? senderClass : null,
    subject: readString(record, 'subject'),
    blocking: typeof blocking === 'boolean' ? blocking : null,
  }
}

/**
 * What this UI version can read off a mailbox refusal notice's durable source.
 * The bridge stamps a refusal notice as `kind: 'mailbox'`, `form: 'notice'` —
 * the harness reporting a refused send into the SENDER's session — with the
 * attempted recipient, the terminal reason, and the refused message's id. It
 * carries NO `from` by design, which is exactly why {@link mailboxRelay} never
 * matches it: a refusal must never present as mail from a peer.
 */
export interface MailboxRefusalView {
  /** Recipient address the refused mail was addressed to. */
  refusedTo: string
  /** The terminal refusal reason recorded on the recipient's failed row. */
  reason: string
  /** One-line account for the collapsed row, when the source records one. */
  summary: string | null
}

/**
 * Read one mailbox refusal notice off its durable source.
 *
 * Narrower than {@link contextForm}: a readable refusal names its attempted
 * recipient AND its reason, both required because a notice missing either is
 * not a readable refusal — presenting one without the reason would show a
 * confident card over a mystery. Such a source reads null here and falls
 * through to the generic notice presentation, which renders whatever the
 * record still carries.
 * @param source - the logged `user/message` source, exactly as recorded.
 * @returns the readable refusal fields, or null when this is not a readable
 *   mailbox refusal (a different `kind`, the `relay` form, or missing
 *   recipient or reason).
 */
export function mailboxRefusal(source: unknown): MailboxRefusalView | null {
  const record = asRecord(source)
  if (record === null || readString(record, 'kind') !== 'mailbox') return null
  if (readString(record, 'form') !== 'notice') return null
  const refusedTo = readString(record, 'refusedTo')
  const reason = readString(record, 'reason')
  if (refusedTo === null || reason === null) return null
  return { refusedTo, reason, summary: readString(record, 'summary') }
}

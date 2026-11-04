/**
 * Seat driver selection, mail admission and the single-view binding — the
 * pure half of the Claude Code seat driver's registry slice (OP #292, S3).
 *
 * The registry row is untrusted routing data: it says WHICH driver runs a
 * seat and WHO may send it mail, nothing more. Model, effort, caps, binary
 * path and every other cost or trust setting live in host-private config.
 * Everything here is a pure function over a row or a session log, so the
 * bridge, the driver glue and the host door share one definition of each
 * decision instead of three drifting copies.
 *
 * @module @deepseek-ai/dsh-mailbox/seat-driver
 */

import { createHash } from 'node:crypto'
import type { OrgRegistrySeat } from './org-registry.ts'

/** The driver names a registry row may select; any other value quarantines the seat. */
export const SEAT_DRIVER_KEYS = ['default', 'claude-code'] as const

/** A driver a seat row may select. */
export type SeatDriverKey = typeof SEAT_DRIVER_KEYS[number]

/** The driver a row without a `driver` field runs under: the in-process agent loop. */
export const DEFAULT_SEAT_DRIVER: SeatDriverKey = 'default'

/** Sender classes a seat row may admit; mirrors the bridge's sender-class vocabulary. */
export const SEAT_SENDER_CLASSES = ['seat', 'unverified'] as const

/** One admissible sender class. */
export type SeatSenderClass = typeof SEAT_SENDER_CLASSES[number]

/**
 * Resolve the driver a row selects.
 * @param seat - the seat row (or just its `driver`).
 * @returns the row's driver, or {@link DEFAULT_SEAT_DRIVER} when it names none.
 */
export function seatDriverKey(seat: Pick<OrgRegistrySeat, 'driver'>): SeatDriverKey {
  return seat.driver ?? DEFAULT_SEAT_DRIVER
}

/** The only fields of a session event the classifier reads. */
export interface SeatDriverEvent {
  /** The event type, e.g. `claude-code/session-bound`. */
  readonly type: string
}

/**
 * What a stored session log says about the driver that wrote it: a
 * {@link SeatDriverKey}, `mixed` (both drivers left history in one log, never
 * resumable), or `undefined` (no model turn was ever answered, so the log
 * makes no claim and cannot be contaminated).
 */
export type RecordedSeatDriver = SeatDriverKey | 'mixed' | undefined

/**
 * Classify a stored session log by the driver that wrote it. Only the two
 * allowlisted drivers are ever believed: a `<x>/session-bound` for any other
 * `x` is ignored, never trusted.
 *
 * - `claude-code/session-bound` present: `claude-code`, unless a
 *   `request/header` is also present, which makes it `mixed`.
 * - No session-bound, and a `request/header` or `assistant/message`
 *   present: `default`.
 * - Otherwise (no model turn ever answered, including a log holding only
 *   `user/message` entries): `undefined`. A seat that crashed after queueing
 *   mail but before binding must not read as a flip.
 * @param events - the stored log's events, in order or not.
 * @returns the recorded driver, `mixed`, or `undefined`.
 */
export function recordedSeatDriver(events: Iterable<SeatDriverEvent>): RecordedSeatDriver {
  let bound = false
  let header = false
  let assistant = false
  for (const event of events) {
    if (event.type === 'claude-code/session-bound') bound = true
    else if (event.type === 'request/header') header = true
    else if (event.type === 'assistant/message') assistant = true
  }
  if (bound) return header ? 'mixed' : 'claude-code'
  if (header || assistant) return 'default'
  return undefined
}

/** A mail request as the admission rule sees it. */
export interface SeatMailRequest {
  /** The sending address's seat or guest name. */
  readonly from: string
  /** Every sender class the sender falls under. */
  readonly classes: readonly SeatSenderClass[]
}

/** Verdict of {@link admitsMail}. */
export type SeatAdmission = { readonly allow: true } | { readonly allow: false; readonly reason: string }

/**
 * Decide whether a seat row admits one piece of mail. Default-deny on both
 * axes: the sender must be named in `admit_from` (empty or absent admits
 * nobody) AND every class the sender falls under must be listed in
 * `admit_sender_classes`. The reason names the part that failed.
 * @param row - the seat row carrying the admission lists.
 * @param request - the sender and its classes.
 * @returns allow, or a refusal with a reason.
 */
export function admitsMail(
  row: Pick<OrgRegistrySeat, 'admit_from' | 'admit_sender_classes'>,
  request: SeatMailRequest,
): SeatAdmission {
  const from = row.admit_from ?? []
  if (!from.includes(request.from)) {
    return {
      allow: false,
      reason: from.length === 0
        ? `admit_from is empty (the seat admits nobody); sender "${request.from}" is not admitted`
        : `sender "${request.from}" is not in admit_from`,
    }
  }
  // Fail closed: a sender with no class at all is not "every class listed".
  if (request.classes.length === 0) return { allow: false, reason: 'no sender class supplied' }
  const classes = row.admit_sender_classes ?? []
  for (const senderClass of request.classes) {
    if (!classes.includes(senderClass)) {
      return { allow: false, reason: `sender class "${senderClass}" is not in admit_sender_classes` }
    }
  }
  return { allow: true }
}

/** The security-field projection of a row: everything whose change must dispose a resident seat. */
export interface SeatRoutingProjection {
  readonly driver: SeatDriverKey
  readonly sessionId: string | null
  readonly cwd: string
  readonly admit_from: readonly string[]
  readonly admit_sender_classes: readonly SeatSenderClass[]
  readonly test: boolean | null
  readonly tools: { readonly allow: readonly string[] | null; readonly deny: readonly string[] | null } | null
}

/**
 * Project a row onto its security fields, normalised so that semantically
 * equal rows project equal: lists sorted, absent values explicit.
 * @param row - the seat row.
 * @returns the projection.
 */
export function seatRoutingProjection(row: OrgRegistrySeat): SeatRoutingProjection {
  const sorted = (list: readonly string[] | undefined): readonly string[] | null => list === undefined ? null : [...list].sort()
  return {
    driver: seatDriverKey(row),
    sessionId: row.sessionId ?? null,
    cwd: row.cwd,
    admit_from: [...row.admit_from ?? []].sort(),
    admit_sender_classes: [...row.admit_sender_classes ?? []].sort(),
    test: row.test ?? null,
    tools: row.tools === undefined ? null : { allow: sorted(row.tools.allow), deny: sorted(row.tools.deny) },
  }
}

/**
 * Hash a row's security-field projection: sha256 hex of its canonical JSON
 * (fixed key order, sorted lists). Stable across source key order; changes
 * when any of `driver`, `sessionId`, `cwd`, `admit_from`,
 * `admit_sender_classes`, `test` or `tools` changes.
 * @param row - the seat row.
 * @returns the sha256 hex digest.
 */
export function seatRowHash(row: OrgRegistrySeat): string {
  const p = seatRoutingProjection(row)
  const canonical = JSON.stringify([
    p.driver, p.sessionId, p.cwd, p.admit_from, p.admit_sender_classes, p.test,
    p.tools === null ? null : [p.tools.allow, p.tools.deny],
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * A seat's row frozen at one delivery: the bridge resolves the row once, hashes
 * it, and hands the binding to the driver so row and hash cannot diverge.
 * Non-durable: it rides `agentOptions` and is never persisted.
 */
export interface SeatBinding {
  /** The seat name. */
  readonly seat: string
  /** {@link seatRowHash} of {@link SeatBinding.row}. */
  readonly rowHash: string
  /** The frozen row. */
  readonly row: OrgRegistrySeat
}

/**
 * The `AgentOptions` addition carrying a {@link SeatBinding}. `AgentOptions`
 * is a merge-extensible interface in `@deepseek-ai/dsh-agent`; this package
 * does not depend on that package, so a consumer that does (the bridge, the
 * driver glue) merges it with
 * `declare module '@deepseek-ai/dsh-agent' { interface AgentOptions extends SeatBindingOptions {} }`.
 */
export interface SeatBindingOptions {
  /** The frozen seat row for this delivery; absent for any caller that is not the mailbox bridge. */
  seatBinding?: SeatBinding
}

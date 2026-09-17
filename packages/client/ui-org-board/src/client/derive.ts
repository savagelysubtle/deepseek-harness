/**
 * Pure data shaping between the raw `org.get` value and what the board
 * renders: badges, the two drift lists, and the roster-name labels a drift
 * row's gaps or matches are described with. No React, no DOM — kept testable
 * without mounting React Flow.
 */

import type {
  OrgDriftResult, OrgDriftRow, OrgRegistryView, OrgSeat,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Namespace-bound translate, exactly the `t` this package's components receive. */
export type OrgBoardTranslate = TranslateNS<'orgBoard'>

/** One badge shown on a seat node (and, for 'unserved', echoed in the detail panel). */
export interface SeatBadge {
  kind: 'lead' | 'test' | 'unserved' | 'callUp'
  label: string
}

/** The two drift lists split by {@link OrgDriftRow.registered} — every row is in exactly one. */
export interface DriftLists {
  /** Registered seats missing from at least one served roster. */
  unserved: readonly OrgDriftRow[]
  /** Served addresses that name no registered seat. */
  unregistered: readonly OrgDriftRow[]
}

/**
 * Split a successful drift report into its two lists, or report why there is
 * none to split. Never returns an empty-but-successful shape for a failed
 * report — the caller must branch on `drift.ok` itself before calling this.
 * @param drift - the `org.get` drift result.
 * @returns the two lists, or `undefined` when `drift.ok` is false.
 */
export function driftLists(drift: OrgDriftResult): DriftLists | undefined {
  if (!drift.ok) return undefined
  const unserved: OrgDriftRow[] = []
  const unregistered: OrgDriftRow[] = []
  for (const row of drift.rows) (row.registered ? unserved : unregistered).push(row)
  return { unserved, unregistered }
}

/**
 * Roster names a registered-but-gapped drift row is missing from.
 * @param row - one row from {@link DriftLists.unserved}.
 * @param t - namespace-bound translate.
 * @returns translated roster labels, in mailbox-bridge-then-tool-mailbox order.
 */
export function missingRosterLabels(row: OrgDriftRow, t: OrgBoardTranslate): string[] {
  const labels: string[] = []
  if (!row.servedByMailboxBridge) labels.push(t('roster.mailboxBridge'))
  if (!row.servedByToolMailbox) labels.push(t('roster.toolMailbox'))
  return labels
}

/**
 * Roster names that DO serve a served-but-unregistered drift row.
 * @param row - one row from {@link DriftLists.unregistered}.
 * @param t - namespace-bound translate.
 * @returns translated roster labels, in mailbox-bridge-then-tool-mailbox order.
 */
export function servedRosterLabels(row: OrgDriftRow, t: OrgBoardTranslate): string[] {
  const labels: string[] = []
  if (row.servedByMailboxBridge) labels.push(t('roster.mailboxBridge'))
  if (row.servedByToolMailbox) labels.push(t('roster.toolMailbox'))
  return labels
}

/**
 * Every badge one seat earns: lead/test come straight off the registry row,
 * `unserved` from the drift lookup (present only when `drift.ok`, per the
 * hard requirement that a suppressed drift result must not silently read as
 * "fully served"), and `callUp` from registry-level membership.
 * @param name - seat name.
 * @param seat - the registry's seat record.
 * @param callUp - the registry's call-up seat list.
 * @param driftRow - this seat's row from {@link DriftLists.unserved}, when drift succeeded and it has one.
 * @param t - namespace-bound translate.
 * @returns badges in a fixed, stable order.
 */
export function seatBadges(
  name: string,
  seat: OrgSeat,
  callUp: readonly string[],
  driftRow: OrgDriftRow | undefined,
  t: OrgBoardTranslate,
): SeatBadge[] {
  const badges: SeatBadge[] = []
  if (seat.lead === true) badges.push({ kind: 'lead', label: t('badge.lead') })
  if (seat.test === true) badges.push({ kind: 'test', label: t('badge.test') })
  if (driftRow !== undefined) badges.push({ kind: 'unserved', label: t('badge.unserved') })
  if (callUp.includes(name)) badges.push({ kind: 'callUp', label: t('badge.callUp') })
  return badges
}

/**
 * Index a registry-ok drift report's unserved rows by seat name for O(1)
 * per-node lookup while building the graph.
 * @param unserved - {@link DriftLists.unserved}, or `undefined` when drift is unavailable.
 * @returns name → row map; empty when `unserved` is `undefined`.
 */
export function unservedByName(unserved: readonly OrgDriftRow[] | undefined): Map<string, OrgDriftRow> {
  return new Map((unserved ?? []).map(row => [row.seat, row]))
}

/** Seat names in a registry, in the registry's own key order. */
export function seatNamesOf(registry: OrgRegistryView): string[] {
  return Object.keys(registry.seats)
}

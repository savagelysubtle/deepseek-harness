/**
 * The bridge's single view of the org registry's seat rows (OP #292, S3).
 *
 * The bridge is the only reader of the registry for driver selection and
 * admission. Per delivery it resolves a seat's row ONCE into a frozen
 * {@link SeatRowView} (row plus the hash of its security-field projection),
 * and everything downstream - the admission verdict, the binding the driver
 * receives, the residency's recorded hash - comes from that one value, so
 * the row an admission judged and the row a driver opens cannot diverge.
 *
 * Everything in this module is pure over a parsed {@link OrgRegistry} except
 * the {@link MailboxSeatRows} factory, which only wraps a caller-supplied
 * peek at the bridge's own mtime-keyed registry cache.
 *
 * @module @deepseek-ai/dsh-mailbox-bridge/seat-rows
 */

import {
  DEFAULT_SEAT_DRIVER,
  seatDriverKey,
  seatRoutingProjection,
  seatRowHash,
} from '@deepseek-ai/dsh-mailbox'
import type { OrgRegistry, OrgRegistrySeat, SeatBinding, SeatDriverKey, SeatSenderClass } from '@deepseek-ai/dsh-mailbox'

/** One seat's row frozen at a single registry read, with the hash of its security fields. */
export interface SeatRowView {
  /** The seat name (its mailbox address). */
  readonly seat: string
  /** The driver the row selects ({@link DEFAULT_SEAT_DRIVER} when it names none). */
  readonly driver: SeatDriverKey
  /** A deep-frozen copy of the row; mutating the registry cannot alter it. */
  readonly row: OrgRegistrySeat
  /** {@link seatRowHash} of {@link SeatRowView.row}. */
  readonly rowHash: string
}

/**
 * What {@link MailboxSeatRows.current} hands another package: the seat's
 * security hash, its driver and its admission lists, and nothing else. The
 * full row (cwd, session id, tools) stays inside the bridge; a caller that
 * needs it gets it through the binding the bridge itself hands the driver.
 * The lists are the row's own deep-frozen arrays (an absent list reads as
 * empty, which {@link admitsMail} treats the same way).
 */
export interface SeatCurrentView {
  /** {@link seatRowHash} of the seat's current row. */
  readonly rowHash: string
  /** The driver the row selects. */
  readonly driver: SeatDriverKey
  /** The row's `admit_from` list (empty when the row has none). */
  readonly admit_from: readonly string[]
  /** The row's `admit_sender_classes` list (empty when the row has none). */
  readonly admit_sender_classes: readonly SeatSenderClass[]
}

/**
 * The context service other packages (the Claude Code driver glue) use to
 * ask the bridge which row a seat currently has, so there is exactly one
 * view of the registry in the process. Provided under `mailboxSeatRows`.
 */
export interface MailboxSeatRows {
  /** The org registry file this service reads through; two bridges must agree on it. */
  readonly registryPath: string
  /**
   * The seat's security hash, driver and admission lists as of the bridge's last registry read.
   * Synchronous and read from the bridge's own cache: it never touches the
   * disk. A seat that is unknown, quarantined (`invalid`), or absent because
   * no registry has loaded yet resolves to `undefined`, so a caller can never
   * open a seat on a row the bridge itself would refuse.
   * @param seat - the seat name.
   * @returns the narrowed view (no row, cwd, session id or tools), or `undefined`.
   */
  current(seat: string): SeatCurrentView | undefined
}

/** Names of the security fields whose change must dispose a resident seat, in projection order. */
const PROJECTED_FIELDS = [
  'driver', 'sessionId', 'cwd', 'admit_from', 'admit_sender_classes', 'test', 'tools',
] as const

/** One seat whose routing-relevant row changed between two registry reads. */
export interface SeatRowChange {
  /** The seat name. */
  readonly seat: string
  /** The security fields that differ (plus `invalid`, `added` or `removed` when those apply). */
  readonly changed: readonly string[]
  /** Whether the seat is quarantined after the change. */
  readonly nowInvalid: boolean
  /** Whether the seat was quarantined before the change. */
  readonly wasInvalid: boolean
}

/** Views cached per parsed registry object; a reload produces a new object and so a fresh map. */
const viewCache = new WeakMap<OrgRegistry, Map<string, SeatRowView | null>>()

/**
 * Deep-freeze a plain JSON-shaped value in place.
 * @param value - the value to freeze.
 * @returns the same value, frozen.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * One roster seat looked up defensively (own properties only), or undefined
 * when the name is not a seat.
 * @param registry - the parsed registry.
 * @param name - the address under lookup.
 * @returns the seat entry, or undefined.
 */
export function rosterSeat(registry: OrgRegistry, name: string): OrgRegistrySeat | undefined {
  return Object.hasOwn(registry.seats, name) ? registry.seats[name] : undefined
}

/**
 * Resolve a seat's frozen view from a parsed registry. Cached per registry
 * object, so hashing happens once per reload, not once per message.
 * @param registry - the parsed registry; `undefined` (no registry file) has no seats.
 * @param seat - the seat name.
 * @returns the view, or `undefined` for an unknown or quarantined seat.
 */
export function seatViewOf(registry: OrgRegistry | undefined, seat: string): SeatRowView | undefined {
  if (registry === undefined) return undefined
  let perSeat = viewCache.get(registry)
  if (perSeat === undefined) {
    perSeat = new Map()
    viewCache.set(registry, perSeat)
  }
  const hit = perSeat.get(seat)
  if (hit !== undefined) return hit ?? undefined
  const entry = rosterSeat(registry, seat)
  let view: SeatRowView | undefined
  if (entry !== undefined && entry.invalid === undefined) {
    const row = deepFreeze(structuredClone(entry))
    view = Object.freeze({ seat, driver: seatDriverKey(row), row, rowHash: seatRowHash(row) })
  }
  perSeat.set(seat, view ?? null)
  return view
}

/**
 * The reason a seat's row was quarantined, or `undefined` when the seat is
 * unknown or valid.
 * @param registry - the parsed registry.
 * @param seat - the seat name.
 * @returns the quarantine reason.
 */
export function seatInvalidReason(registry: OrgRegistry | undefined, seat: string): string | undefined {
  if (registry === undefined) return undefined
  return rosterSeat(registry, seat)?.invalid
}

/**
 * The binding a driver receives in `agentOptions.seatBinding`: the same frozen
 * row and hash the admission judged.
 * @param view - the seat's view for this delivery.
 * @returns the frozen binding.
 */
export function seatBindingOf(view: SeatRowView): SeatBinding {
  return Object.freeze({ seat: view.seat, rowHash: view.rowHash, row: view.row })
}

/**
 * Build the `mailboxSeatRows` service over a peek at the bridge's registry cache.
 * @param registryPath - the registry file the bridge reads.
 * @param peek - returns the bridge's last successfully parsed registry for that path.
 * @returns the service.
 */
export function createMailboxSeatRows(registryPath: string, peek: () => OrgRegistry | undefined): MailboxSeatRows {
  return Object.freeze({
    registryPath,
    current(seat: string) {
      const view = seatViewOf(peek(), seat)
      if (view === undefined) return undefined
      return Object.freeze({
        rowHash: view.rowHash,
        driver: view.driver,
        admit_from: view.row.admit_from ?? [],
        admit_sender_classes: view.row.admit_sender_classes ?? [],
      })
    },
  })
}

/**
 * The text of the refusal a stored session log's driver earns against the
 * driver a seat's row selects. The text deliberately prints no command: the
 * remedy is the founder's call, never an instruction an agent could run.
 * @param seat - the seat name.
 * @param rowDriver - the driver the row selects.
 * @param logDriver - what the stored log holds.
 * @returns the refusal reason.
 */
export function seatDriverFlipReason(seat: string, rowDriver: SeatDriverKey, logDriver: string): string {
  return `seat-driver-flip: seat "${seat}" row says driver "${rowDriver}" but its session log holds "${logDriver}" history; ask the founder to reseed this seat or revert the row`
}

/**
 * Judge a stored log's recorded driver against the row's driver. An
 * unanswered log (`undefined`) makes no claim and passes; `mixed` never
 * matches any driver.
 * @param seat - the seat name.
 * @param rowDriver - the driver the row selects.
 * @param recorded - the classifier's verdict on the log.
 * @returns the refusal reason, or `undefined` when the log matches or makes no claim.
 */
export function seatDriverFlipRefusal(
  seat: string,
  rowDriver: SeatDriverKey,
  recorded: SeatDriverKey | 'mixed' | undefined,
): string | undefined {
  if (recorded === undefined || recorded === rowDriver) return undefined
  return seatDriverFlipReason(seat, rowDriver, recorded)
}

/**
 * Diff two registry reads and report every seat whose routing fields changed
 * where the change could matter to a non-default seat: the seat was or is a
 * non-default driver, or it became quarantined (its resident must go either
 * way). Default seats that stay default and valid report nothing, so the
 * default loop's behaviour is untouched.
 * @param previous - the earlier read.
 * @param next - the later read.
 * @returns the changed seats, in roster order of the later read then removed seats.
 */
export function diffSeatRows(previous: OrgRegistry, next: OrgRegistry): readonly SeatRowChange[] {
  const changes: SeatRowChange[] = []
  const names = new Set([...Object.keys(next.seats), ...Object.keys(previous.seats)])
  for (const seat of names) {
    const before = rosterSeat(previous, seat)
    const after = rosterSeat(next, seat)
    const changed: string[] = []
    if (before === undefined) changed.push('added')
    else if (after === undefined) changed.push('removed')
    else {
      const left = seatRoutingProjection(before)
      const right = seatRoutingProjection(after)
      for (const field of PROJECTED_FIELDS) {
        if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) changed.push(field)
      }
      if (before.invalid !== after.invalid) changed.push('invalid')
    }
    if (changed.length === 0) continue
    const wasInvalid = before?.invalid !== undefined
    const nowInvalid = after?.invalid !== undefined
    const nonDefault = (before !== undefined && seatDriverKey(before) !== DEFAULT_SEAT_DRIVER)
      || (after !== undefined && seatDriverKey(after) !== DEFAULT_SEAT_DRIVER)
    if (!nonDefault && !(nowInvalid && !wasInvalid)) continue
    changes.push({ seat, changed, nowInvalid, wasInvalid })
  }
  return changes
}

/**
 * Per-bridge memory of the last registry read it observed, so each reload can
 * be diffed against the one before it.
 */
export class SeatRowTracker {
  private last: OrgRegistry | undefined

  /**
   * Record a registry read and return what changed since the previous one.
   * The first read only sets the baseline; reading the same parsed object
   * again reports nothing.
   * @param registry - the registry as of this drain cycle.
   * @returns the changed seats, empty for the first read or an unchanged registry.
   */
  observe(registry: OrgRegistry): readonly SeatRowChange[] {
    const previous = this.last
    this.last = registry
    if (previous === undefined || previous === registry) return []
    return diffSeatRows(previous, registry)
  }
}

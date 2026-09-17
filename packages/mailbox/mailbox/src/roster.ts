/**
 * SWD-118 roster-drift alarm: seat identity is maintained BY HAND in three
 * places — the org registry, the mailbox bridge's `addresses`, and the tool
 * mailbox's `addresses` — and nothing ever checked that they agree. When
 * they diverged in the past, mail to the missing seat was silently
 * swallowed: no error, no bounce. This module holds the pure comparison and
 * message-formatting logic behind the fix; the mount-time wiring lives in
 * `index.ts` (`MailboxRegistry.declareRoster`, condition A) and in each
 * mount's own `apply` (condition B, which only that mount can judge since it
 * alone holds both its own roster and the registry it was configured with).
 *
 * Exactly two conditions alarm, by founder ruling — both measure ZERO on the
 * production deployment today, so the first time either fires it means
 * something real:
 *
 * **(A) the two served rosters disagree with each other.** The bridge
 * roster and the tool-mailbox roster should always be identical; nothing
 * enforced that until this ticket. A one-sided address means mail to that
 * seat half-works in a way that is miserable to diagnose (the tool believes
 * it can send there, or the bridge believes nobody is home, in a way the
 * other side does not share).
 *
 * **(B) a roster serves a name the org registry does not know.** Never
 * correct — the registry is the roster's own source of truth for who may
 * exist as a seat at all.
 *
 * **Deliberately NOT alarmed on: registry-vs-roster difference** (a seat the
 * registry lists but no mount serves). The registry holds 24 seats today;
 * each roster serves 19; the 5-seat gap is four `test: true` seats plus one
 * intentionally unserved archive seat (`web-engineering-archive`) — correct
 * as shipped. An alarm that fired on that gap would be noise from day one
 * and would get ignored, which is worse than no alarm at all.
 *
 * @module @deepseek-ai/dsh-mailbox/roster
 */

import { loadOrgRegistry } from './org-registry.ts'

/** One cross-mount roster disagreement: what each side has that the other lacks. */
export interface RosterDrift {
  /** Addresses the first roster serves that the second does not. */
  readonly onlyFirst: readonly string[]
  /** Addresses the second roster serves that the first does not. */
  readonly onlySecond: readonly string[]
}

/**
 * Compare two mounts' served address sets. Pure; callers decide what to do
 * with a non-empty result.
 * @param first - the first mount's served addresses.
 * @param second - the second mount's served addresses.
 * @returns the drift; both lists are empty when the rosters agree exactly.
 */
export function diffRosters(first: Iterable<string>, second: Iterable<string>): RosterDrift {
  const firstSet = new Set(first)
  const secondSet = new Set(second)
  return {
    onlyFirst: [...firstSet].filter(address => !secondSet.has(address)).sort(),
    onlySecond: [...secondSet].filter(address => !firstSet.has(address)).sort(),
  }
}

/**
 * Format condition (A)'s warning: two mounts serving different rosters.
 * Names both mount ids and the specific seats each side has that the other
 * lacks — never a bare "rosters differ", which gives the operator nothing
 * to act on.
 * @param firstMountId - the first mount's identity (its plugin name).
 * @param secondMountId - the second mount's identity (its plugin name).
 * @param drift - the computed disagreement; pass only a non-empty drift.
 * @returns the warning text.
 */
export function rosterDriftWarning(firstMountId: string, secondMountId: string, drift: RosterDrift): string {
  return `mailbox roster drift: "${firstMountId}" and "${secondMountId}" serve different addresses — `
    + `only "${firstMountId}" serves: [${drift.onlyFirst.join(', ')}]; `
    + `only "${secondMountId}" serves: [${drift.onlySecond.join(', ')}]. `
    + 'Mail to a seat missing from one roster silently half-works; reconcile the two mounts\' `addresses` config.'
}

/**
 * Condition (B): served names the org registry does not know. Pure over an
 * already-loaded registry's seat names; the mount-time caller decides what a
 * missing or unreadable registry means (see {@link loadRegistrySeatNames}).
 * @param addresses - one mount's served addresses.
 * @param knownSeats - the org registry's seat names.
 * @returns the served names absent from the registry, sorted; empty when every served name is known.
 */
export function unknownServedSeats(addresses: Iterable<string>, knownSeats: ReadonlySet<string>): readonly string[] {
  return [...new Set(addresses)].filter(address => !knownSeats.has(address)).sort()
}

/**
 * Format condition (B)'s warning: a mount serves a name the registry does
 * not know.
 * @param mountId - the mount's identity (its plugin name).
 * @param unknown - the served names absent from the registry; pass only a non-empty list.
 * @returns the warning text.
 */
export function unknownServedSeatsWarning(mountId: string, unknown: readonly string[]): string {
  return `mailbox roster drift: "${mountId}" serves ${unknown.length === 1 ? 'a name' : 'names'} the org registry `
    + `does not know: [${unknown.join(', ')}]. The registry is the source of truth for seat identity; `
    + 'add the seat there or remove it from this mount\'s `addresses` config.'
}

/** How a mount-time attempt to load the org registry for condition (B) resolved. */
export type RegistryLoadOutcome =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable'; readonly error: Error }
  | { readonly kind: 'loaded'; readonly seatNames: ReadonlySet<string> }

/**
 * Load the org registry for condition (B)'s check, classifying failure the
 * same way the bridge's own drain-time judgment does (see
 * `mailbox-bridge`'s `judgmentRegistry`): a MISSING file is the legitimate
 * no-registry world — nothing is knowable as a seat, so `'missing'` tells
 * the caller to no-op rather than alarm. A file that EXISTS but will not
 * load is `'unavailable'`, and the caller must warn that condition (B)
 * could NOT be checked rather than silently treat the absence of a mismatch
 * as "nothing is wrong" — the alarm itself must never become a silent
 * failure.
 * @param path - the registry file path.
 * @returns the classified outcome.
 */
export async function loadRegistrySeatNames(path: string): Promise<RegistryLoadOutcome> {
  try {
    const registry = await loadOrgRegistry(path)
    return { kind: 'loaded', seatNames: new Set(Object.keys(registry.seats)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unavailable', error: error instanceof Error ? error : new Error(String(error)) }
  }
}

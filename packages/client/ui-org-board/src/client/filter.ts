/**
 * Pure matcher behind the toolbar's seat filter. A seat matches when the
 * (trimmed, case-insensitive) query is empty, is a substring of its name, or
 * is exactly one of the flag words (`lead`, `test`, `unserved`) the seat
 * carries.
 */

/** The seat flags the filter can name. */
export interface SeatFlags {
  lead: boolean
  test: boolean
  unserved: boolean
}

/**
 * Decide whether one seat matches the filter text.
 * @param name - the seat's name.
 * @param flags - which of lead / test / unserved the seat carries.
 * @param query - the raw text typed into the filter box.
 * @returns true when nothing should be dimmed for this seat.
 */
export function seatMatchesFilter(name: string, flags: SeatFlags, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if (name.toLowerCase().includes(needle)) return true
  return (needle === 'lead' && flags.lead) || (needle === 'test' && flags.test) || (needle === 'unserved' && flags.unserved)
}

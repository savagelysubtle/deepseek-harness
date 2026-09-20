/**
 * Pure served-roster address editor (SWD-134 slice 5 step 2): the board
 * offers a single served / not-served choice per seat, never two, because
 * the profile mounts TWO served lists (`mailbox-bridge` decides whether a
 * message is ever COLLECTED, `tool-mailbox` decides whether it is ever
 * ACCEPTED) and a seat present on one but not the other silently loses mail
 * with no error on either side — see `org-served-roster.ts`'s module header
 * for the full account. `org-board-store.ts`'s `setSeatServed` sends the ONE
 * list this function builds to BOTH mounts identically, so divergence
 * between the two lists is never expressible through this toggle.
 *
 * No RPC, no React, no I/O — mirrors `edit.ts`'s shape for the same reason:
 * a caller can safely diff or display the "before" list after the call.
 */

/**
 * Add `name` to `current` if absent, or remove it if present.
 *
 * No grammar validation here — the toggle only ever acts on a name already
 * present in the loaded registry (a served address the board offers is
 * always a known seat name), and the server validates every proposed
 * address regardless (see `writeOrgServedRoster`'s own grammar check).
 * @param current - the served-address list to build the next list from; never mutated.
 * @param name - the address to add or remove.
 * @param served - the desired membership: `true` adds it, `false` removes it.
 * @returns the next served-address list. Returns `current` itself (never
 *   copied) when `name`'s membership already matches `served` — nothing to
 *   change, and the input is never mutated either way.
 */
export function nextServedAddresses(
  current: readonly string[], name: string, served: boolean,
): readonly string[] {
  const has = current.includes(name)
  if (served) {
    return has ? current : [...current, name]
  }
  return has ? current.filter(address => address !== name) : current
}

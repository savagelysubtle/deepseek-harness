/**
 * Pure org-registry document editors (SWD-134 slice 4 step 3): every function
 * here takes an {@link OrgRegistryDocument} — the UNRESOLVED shape `org.get`
 * returns as `document`, never the resolved `registry` view — and returns
 * either the next document or a described refusal. No RPC, no React, no I/O:
 * `org-board-store.ts` is the only caller that turns a success into an actual
 * `org.write`, and a later slice's UI previews a refusal (or, for
 * {@link removeSeat}, its cascade) before ever reaching the store.
 *
 * Every editor treats its input as immutable — a new document (and any new
 * nested seat/array) is built, the input's own objects and arrays are never
 * written to — so a caller can safely diff or display the "before" document
 * after the call.
 */

import type {
  OrgEdge, OrgRegistryDocument, OrgRegistryDocumentSeat, OrgSeatTools,
} from '@deepseek-ai/dsh-api-remotes/client'

/**
 * The mailbox address grammar, DUPLICATED here rather than imported from
 * `@deepseek-ai/dsh-mailbox`. Read straight from the source of truth —
 * `MAILBOX_SEGMENT_PATTERN_SOURCE` in packages/mailbox/mailbox/src/address.ts
 * — and reused verbatim rather than re-typed: seat names ARE mailbox
 * addresses, so a name the mailbox layer would reject must never reach the
 * registry file.
 *
 * Not imported directly because this package (`ui-org-board`) is
 * browser-only and carries no dependency on `@deepseek-ai/dsh-mailbox` (see
 * its package.json) — that package's barrel entry pulls in `node:crypto`/
 * `node:fs` through `org-registry.ts`, and adding the dependency is a
 * package.json change outside this task's scope. This mirrors the exact same
 * boundary the codebase already crosses by duplication rather than import:
 * `OrgSeatTools` in packages/host/apiproxy/src/api/org.ts ("declared locally
 * rather than imported... api/ must stay browser-importable with zero
 * host-package dependencies") and `MailboxSenderClass` in
 * packages/client/runtime/src/client/sessions/context-provenance.ts
 * ("Mirrors `SenderClass` in `@deepseek-ai/dsh-mailbox-bridge`, duplicated
 * here"). Drift is not left to memory: `edit.client.spec.ts` reads the
 * mailbox source and fails if these two ever stop matching.
 */
export const SEAT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** One editor's outcome: the next document (plus any editor-specific extras), or a named refusal. */
export type EditOutcome =
  | { readonly ok: true; readonly document: OrgRegistryDocument }
  | { readonly ok: false; readonly reason: string }

/** {@link removeSeat}'s outcome additionally reports what its cascade dropped. */
export type RemoveSeatOutcome =
  | {
    readonly ok: true
    readonly document: OrgRegistryDocument
    /** Edges dropped because they named the removed seat, in the document's original order. */
    readonly cascadedEdges: readonly OrgEdge[]
    /** `callUp` entries dropped because they named the removed seat. */
    readonly cascadedCallUp: readonly string[]
  }
  | { readonly ok: false; readonly reason: string }

/**
 * Add one new seat.
 * @param doc - the current document (unresolved `cwd`s).
 * @param name - the new seat's name; validated against the mailbox address grammar.
 * @param cwd - the new seat's workspace, exactly as it should be written (absolute, or relative to `doc.baseDir`).
 * @returns the document with the seat added, or a refusal.
 */
export function addSeat(doc: OrgRegistryDocument, name: string, cwd: string): EditOutcome {
  if (!SEAT_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `seat name ${JSON.stringify(name)} must match ${SEAT_NAME_PATTERN.source} (seat names are mailbox addresses)` }
  }
  if (name in doc.seats) return { ok: false, reason: `seat ${JSON.stringify(name)} already exists` }
  const seat: OrgRegistryDocumentSeat = { cwd }
  return { ok: true, document: { ...doc, seats: { ...doc.seats, [name]: seat } } }
}

/**
 * Remove one seat, cascading its removal over every edge and `callUp` entry
 * that names it — leaving either in place would name a seat the document no
 * longer has, which the server's parser refuses outright (an unknown edge
 * endpoint fails the whole write, not just that edge).
 * @param doc - the current document.
 * @param name - the seat to remove.
 * @returns the document with the seat and its cascade removed (naming what
 *   was cascaded, so a caller can warn before committing), or a refusal.
 */
export function removeSeat(doc: OrgRegistryDocument, name: string): RemoveSeatOutcome {
  if (!(name in doc.seats)) return { ok: false, reason: `unknown seat ${JSON.stringify(name)}` }

  const cascadedEdges = doc.edges.filter(([from, to]) => from === name || to === name)
  const remainingEdges = doc.edges.filter(([from, to]) => from !== name && to !== name)
  const cascadedCallUp = doc.callUp.filter(seat => seat === name)
  const remainingCallUp = doc.callUp.filter(seat => seat !== name)
  const { [name]: _removed, ...remainingSeats } = doc.seats

  return {
    ok: true,
    document: { ...doc, seats: remainingSeats, edges: remainingEdges, callUp: remainingCallUp },
    cascadedEdges,
    cascadedCallUp,
  }
}

/**
 * Whether an edge (in either stored direction — edges are undirected) already
 * connects the given pair.
 * @param edges - the document's edge list.
 * @param a - one endpoint.
 * @param b - the other endpoint.
 * @returns whether `[a, b]` or `[b, a]` is already present.
 */
function hasEdge(edges: readonly OrgEdge[], a: string, b: string): boolean {
  return edges.some(([from, to]) => (from === a && to === b) || (from === b && to === a))
}

/**
 * Add one undirected edge.
 * @param doc - the current document.
 * @param from - one endpoint.
 * @param to - the other endpoint.
 * @returns the document with the edge added, or a refusal for an unknown
 *   endpoint, a self-edge, or a duplicate in either stored direction (the
 *   server's parser never checks for duplicates itself).
 */
export function addEdge(doc: OrgRegistryDocument, from: string, to: string): EditOutcome {
  if (!(from in doc.seats)) return { ok: false, reason: `unknown seat ${JSON.stringify(from)}` }
  if (!(to in doc.seats)) return { ok: false, reason: `unknown seat ${JSON.stringify(to)}` }
  if (from === to) return { ok: false, reason: `an edge must connect two distinct seats, not ${JSON.stringify(from)} to itself` }
  if (hasEdge(doc.edges, from, to)) return { ok: false, reason: `an edge already connects ${JSON.stringify(from)} and ${JSON.stringify(to)}` }
  const edge: OrgEdge = [from, to]
  return { ok: true, document: { ...doc, edges: [...doc.edges, edge] } }
}

/**
 * Remove one undirected edge, in whichever direction it is stored.
 * @param doc - the current document.
 * @param from - one endpoint.
 * @param to - the other endpoint.
 * @returns the document with the edge removed, or a refusal when no edge connects the pair.
 */
export function removeEdge(doc: OrgRegistryDocument, from: string, to: string): EditOutcome {
  if (!hasEdge(doc.edges, from, to)) return { ok: false, reason: `no edge connects ${JSON.stringify(from)} and ${JSON.stringify(to)}` }
  const edges = doc.edges.filter(([a, b]) => !((a === from && b === to) || (a === to && b === from)))
  return { ok: true, document: { ...doc, edges } }
}

/**
 * Build the next `tools` field from proposed `allow`/`deny` lists, applying
 * the server parser's own rule: a PRESENT `tools` key must carry at least one
 * of `allow`/`deny`, and any list it does carry must be non-empty
 * (packages/mailbox/mailbox/src/org-registry.ts `parseSeatTools`). Clearing
 * both must OMIT the key entirely — `tools: {}` or `tools: { allow: [] }`
 * both fail that same parser and invalidate the whole document.
 * @param allow - proposed allow-list, or `undefined`/empty to clear it.
 * @param deny - proposed deny-list, or `undefined`/empty to clear it.
 * @returns the next `tools` value, or `undefined` when the key should be omitted.
 */
function nextSeatTools(
  allow: readonly string[] | undefined, deny: readonly string[] | undefined,
): OrgSeatTools | undefined {
  const hasAllow = allow !== undefined && allow.length > 0
  const hasDeny = deny !== undefined && deny.length > 0
  if (!hasAllow && !hasDeny) return undefined
  return {
    ...hasAllow ? { allow } : {},
    ...hasDeny ? { deny } : {},
  }
}

/**
 * Replace one seat's tool restriction.
 * @param doc - the current document.
 * @param name - the seat to change.
 * @param allow - the seat's next allow-list, or `undefined`/empty to clear it.
 * @param deny - the seat's next deny-list, or `undefined`/empty to clear it.
 * @returns the document with the seat's `tools` replaced (or omitted
 *   entirely when both lists are cleared), or a refusal for an unknown seat.
 */
export function setSeatTools(
  doc: OrgRegistryDocument, name: string,
  allow: readonly string[] | undefined, deny: readonly string[] | undefined,
): EditOutcome {
  const seat = doc.seats[name]
  if (seat === undefined) return { ok: false, reason: `unknown seat ${JSON.stringify(name)}` }
  const tools = nextSeatTools(allow, deny)
  // Build the next seat from every OTHER field of the current seat, then add
  // `tools` back only when present — never `{ ...seat, tools }`, which would
  // write a `tools: undefined` key that survives to the written document.
  const { tools: _currentTools, ...seatWithoutTools } = seat
  const nextSeat: OrgRegistryDocumentSeat = { ...seatWithoutTools, ...tools === undefined ? {} : { tools } }
  return { ok: true, document: { ...doc, seats: { ...doc.seats, [name]: nextSeat } } }
}

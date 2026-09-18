/**
 * org domain contract: a projection of the organisation's seat roster and
 * mail topology, plus its one host-side write primitive. `org.get` reads
 * three independent sources — the hand-edited registry, and the two
 * served-address rosters a profile's patch layer mounts (`mailbox-bridge`,
 * `tool-mailbox`) — and reports the drift between them. `org.write` replaces
 * the whole registry document, guarded by a content token so a write can
 * never silently clobber a change the founder made by hand between the read
 * and the write (see {@link OrgApi.write}). Neither method touches the
 * served-roster mounts — existing in the registry and being served are
 * different facts, and mutating the served side is a later slice's scope.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * One seat's tool restriction on the wire. Deliberately re-declared here
 * rather than imported from `@deepseek-ai/dsh-mailbox`: api/ must stay
 * browser-importable with zero host-package dependencies, and the shape
 * matches structurally, so both sides agree without a runtime import (same
 * precedent as `WorktreeRef` in worktree.ts).
 */
export interface OrgSeatTools {
  /** Tool names to keep; all others are hidden. */
  readonly allow?: readonly string[]
  /** Tool names to hide; everything else stays. */
  readonly deny?: readonly string[]
}

/** One registry seat exactly as `org.get` reports it (structural mirror of `OrgRegistrySeat`). */
export interface OrgSeat {
  /** Workspace the seat's runs execute in, already resolved to an absolute path. */
  readonly cwd: string
  /** Marks a department head; documentation metadata, not enforcement data. */
  readonly lead?: boolean
  /** The seat's durable session id, when the registry records one. */
  readonly sessionId?: string
  /** Marks a throwaway seat; an edge may never cross the test boundary. */
  readonly test?: boolean
  /** Restricts which tools the seat's agent may use; absent means unrestricted. */
  readonly tools?: OrgSeatTools
}

/** One undirected mail-permission edge between two seat names. */
export type OrgEdge = readonly [from: string, to: string]

/** The parsed registry as `org.get` reports it. */
export interface OrgRegistryView {
  /** Absolute base every relative seat `cwd` resolved against. */
  readonly baseDir: string
  /** Roster keyed by seat name; seat names are mailbox addresses. */
  readonly seats: Readonly<Record<string, OrgSeat>>
  /** Undirected seat-to-seat edges that permit direct mail. */
  readonly edges: readonly OrgEdge[]
  /** Seats that may message ANY seat regardless of edges. */
  readonly callUp: readonly string[]
}

/**
 * The registry read, or a named reason it could not be produced. `ok: false`
 * is the ONLY representation of "unreadable" — an empty `seats` map is never
 * used to mean "the registry could not be loaded", mirroring the precedent
 * `StopDescendantsResult` sets: a partial or missing outcome must never
 * type-check as the same shape as success.
 *
 * `token` is the file's content hash at the moment of this read — sha256 of
 * its raw bytes, not a stored revision counter (see {@link OrgApi.write}).
 * Send it back as `write`'s `expectedToken` so a write built on this read is
 * refused if the file changed underneath it, rather than silently clobbering
 * whatever changed it.
 */
export type OrgRegistryResult =
  | { readonly ok: true; readonly registry: OrgRegistryView; readonly token: string }
  | { readonly ok: false; readonly reason: string }

/**
 * One registry seat exactly as a caller submits it to `org.write` —
 * structurally identical to {@link OrgSeat}, but `cwd` is NOT resolved: it is
 * absolute or relative-to-`baseDir` exactly as a hand-edited file would carry
 * it, because `org.write` round-trips through the real YAML parser and a
 * pre-resolved absolute path would silently rewrite every relative seat the
 * founder wrote by hand.
 */
export interface OrgRegistryDocumentSeat {
  /** Workspace the seat's runs execute in: absolute, or relative to the document's `baseDir`. */
  readonly cwd: string
  /** Marks a department head; documentation metadata, not enforcement data. */
  readonly lead?: boolean
  /** The seat's durable session id, when the document records one. */
  readonly sessionId?: string
  /** Marks a throwaway seat; an edge may never cross the test boundary. */
  readonly test?: boolean
  /** Restricts which tools the seat's agent may use; absent means unrestricted. */
  readonly tools?: OrgSeatTools
}

/**
 * The complete registry document `org.write` accepts and persists — the same
 * `baseDir`/`seats`/`edges`/`callUp` shape the YAML file itself has, unlike
 * {@link OrgRegistryView}'s already-resolved read projection. A whole-document
 * replace rather than fine-grained mutations: the caller already holds the
 * entire registry from `org.get`, and one atomic replace is far easier to
 * reason about than a mutation language. The host runs this through the
 * SAME parser/validator `org.get` reads with before writing a single byte —
 * a document that fails validation is refused, never partially applied.
 */
export interface OrgRegistryDocument {
  /** Absolute base every relative seat `cwd` resolves against. */
  readonly baseDir: string
  /** Roster keyed by seat name; seat names are mailbox addresses. */
  readonly seats: Readonly<Record<string, OrgRegistryDocumentSeat>>
  /** Undirected seat-to-seat edges that permit direct mail. */
  readonly edges: readonly OrgEdge[]
  /** Seats that may message ANY seat regardless of edges. */
  readonly callUp: readonly string[]
}

/**
 * One served-address roster read from a profile's `cordis.patch.yml` mount
 * (`mailbox-bridge` or `tool-mailbox`), or a named reason it could not be
 * produced — the profile patch file was unreadable or not valid YAML, or the
 * mount is absent from the composed profile. Never an empty list standing in
 * for "could not read this".
 */
export type OrgRosterResult =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * One row of the computed drift between the registry and the two served
 * rosters, for every name that is NOT registered-and-served-by-both — a seat
 * every source agrees on produces no row, so this is a diff, not a join.
 * The three facts stay independent rather than collapsed into one verdict:
 * serving and existing are different facts, and which of the three (if any)
 * is "wrong" is a judgment this API deliberately does not make.
 */
export interface OrgDriftRow {
  /** The seat or served address name under comparison. */
  readonly seat: string
  /** Whether this name is a seat in the parsed registry. */
  readonly registered: boolean
  /** Whether the mailbox-bridge mount's served addresses list includes this name. */
  readonly servedByMailboxBridge: boolean
  /** Whether the tool-mailbox mount's served addresses list includes this name. */
  readonly servedByToolMailbox: boolean
}

/**
 * The drift report, or a named reason it could not be computed — always the
 * case when `registry`, `mailboxBridge`, or `toolMailbox` itself failed,
 * since a diff is meaningless with a missing side. The reason names which
 * side(s) were missing rather than silently reporting an empty (falsely
 * clean) drift report.
 */
export type OrgDriftResult =
  | { readonly ok: true; readonly rows: readonly OrgDriftRow[] }
  | { readonly ok: false; readonly reason: string }

/** Org-domain unary methods (the map keys org.* of RpcMethodMap). */
export interface OrgApi {
  /**
   * Reads the org registry and the two served-roster lists (the
   * `mailbox-bridge` and `tool-mailbox` mounts) from the active profile's
   * patch layer, and reports the drift between them. Writes nothing and
   * mutates no state — every field is a fresh read.
   *
   * Each of the three sources fails INDEPENDENTLY of the others: an
   * unreadable registry does not prevent the rosters from being reported,
   * and an unreadable profile does not prevent the registry from being
   * reported. `drift` additionally requires all three to have succeeded,
   * since a diff needs every side; its own failure names which side(s) were
   * missing.
   */
  get(request: RpcRequest<{}>): Promise<RpcResponse<{
    /**
     * Name of the profile the two served rosters were read from. The active
     * profile is not discoverable at runtime anywhere in this host today, so
     * this deployment always reports the same hardcoded default — naming it
     * here is what turns that assumption from a fact only visible in source
     * into one the caller (and the org board UI) can actually see and act on
     * if a deployment ever boots a different profile.
     */
    profile: string
    registry: OrgRegistryResult
    mailboxBridge: OrgRosterResult
    toolMailbox: OrgRosterResult
    drift: OrgDriftResult
  }>>

  /**
   * Replace the whole registry document. Refuses when `expectedToken`
   * (from a prior `org.get`'s `registry.token`) no longer matches the file's
   * current content — the file changed since it was read, most often
   * because the founder hand-edited it, and this call must never overwrite
   * that change silently — as an `org-registry-conflict` error naming both
   * tokens. Refuses an invalid document (unknown edge endpoint, malformed
   * seat, etc.) as an `org-registry-rejected` error carrying the parser's
   * own message; nothing is written in that case either. Out of scope: the
   * served-seat rosters a profile's patch layer mounts — this method only
   * ever touches the registry file itself, never `cordis.patch.yml`.
   */
  write(request: RpcRequest<{
    document: OrgRegistryDocument
    expectedToken: string
  }>): Promise<RpcResponse<{
    registry: OrgRegistryView
    token: string
  }>>
}

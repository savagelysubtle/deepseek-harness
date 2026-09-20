/**
 * Org Board controller: one `org.get` read published into a snapshot store,
 * plus (SWD-134 slice 4 step 3) the registry write path — five
 * document-editing verbs that build the next `OrgRegistryDocument` through
 * the pure functions in `edit.ts` and submit it through `org.write` — and
 * (SWD-134 slice 5 step 2) the served-roster write path: one verb,
 * `setSeatServed`, that builds the next served-address list through
 * `served-edit.ts`'s `nextServedAddresses` and submits it through
 * `org.writeServed`. This step owns no UI: it only has to leave the store in
 * a state a later component can render correctly.
 */

import type {
  IApiClient, OrgRegistryDocument, ResponseValue,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  addEdge, addSeat, removeEdge, removeSeat, setSeatTools,
} from './edit.ts'
import type { EditOutcome, RemoveSeatOutcome } from './edit.ts'
import { nextServedAddresses } from './served-edit.ts'

/** The full `org.get` payload once the RPC itself succeeds. */
export type OrgBoardValue = ResponseValue<'org.get'>

/**
 * One `org.write` attempt's outcome, kept until superseded by the next
 * attempt or cleared by a successful one. The three server-reported kinds
 * mirror `org-registry-conflict`/`org-registry-rejected`/
 * `org-registry-write-failed` — see `OrgApi.write`'s doc comment in
 * packages/host/apiproxy/src/api/org.ts on why those three are never folded
 * into one generic failure. `'invalid'` is a FOURTH kind this store adds:
 * a local `edit.ts` refusal (or an edit attempted with no document loaded)
 * that never reached the server at all — distinct from `'rejected'`, which
 * specifically means the server's own parser refused a document this store
 * DID send.
 */
export type OrgBoardWriteNotice =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'write-failed'; readonly message: string }

/** Write-side snapshot, independent of the read `status`/`error`/`value` above (see the field notes below). */
export interface OrgBoardWriteState {
  /** Whether an `org.write` call is currently in flight. Never true from a local `edit.ts` refusal — nothing was sent. */
  pending: boolean
  /** The most recent write attempt's outcome; `null` before any attempt, and cleared on a new attempt or a success. */
  notice: OrgBoardWriteNotice | null
}

/**
 * One `org.writeServed` attempt's outcome. Its OWN union, deliberately NOT
 * folding into {@link OrgBoardWriteNotice} above: a served-roster write and a
 * registry write are two different files with two different token guards
 * (see org-served-roster.ts), and `'split'` has no registry-write
 * counterpart at all — it is the disclosure that the two served rosters
 * already disagreed BEFORE this write ever ran, carrying both sides so the
 * interface can show the operator exactly what it is being asked to
 * reconcile. `'invalid'`/`'conflict'`/`'rejected'`/`'write-failed'` keep the
 * exact same meanings {@link OrgBoardWriteNotice} already gives them, one
 * layer up: a local refusal before anything was sent, the served-roster file
 * changed since it was read, the proposed address failed validation, or an
 * unrelated I/O failure.
 */
export type OrgBoardServedWriteNotice =
  | OrgBoardWriteNotice
  | {
    readonly kind: 'split'
    /** Addresses only `mailbox-bridge` currently serves. */
    readonly onlyMailboxBridge: readonly string[]
    /** Addresses only `tool-mailbox` currently serves. */
    readonly onlyToolMailbox: readonly string[]
  }

/** Served-roster write-side snapshot, the {@link OrgBoardWriteState} counterpart for `setSeatServed`. */
export interface OrgBoardServedWriteState {
  /** Whether an `org.writeServed` call is currently in flight. Never true from a local refusal — nothing was sent. */
  pending: boolean
  /** The most recent served write attempt's outcome; `null` before any attempt, and cleared on a new attempt or a success. */
  notice: OrgBoardServedWriteNotice | null
}

/** Org Board snapshot: either no successful read yet, or the full `org.get` value, plus the write-side state. */
export interface OrgBoardState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /**
   * Set only when `status === 'error'`: the RPC itself failed (transport or
   * business error), so none of `profile`/`registry`/`mailboxBridge`/
   * `toolMailbox`/`drift` below were ever populated. This is distinct from
   * any of those individual fields carrying their OWN `{ ok: false }` — that
   * case still reaches `status: 'ready'`, because the outer call succeeded
   * and returned a value (just one whose inner unions say "unreadable").
   */
  error: string | null
  value: OrgBoardValue | null
  /**
   * Write-side state, deliberately NOT folded into `status`/`error`/`value`
   * above: those three describe the last `org.get` READ, and per NO
   * OPTIMISTIC UI (see `write`'s doc comment on `OrgBoardController`), a
   * write must never touch `value` before the server confirms it. Keeping
   * write state in its own field means a pending write or a stale notice can
   * never be mistaken for read state, and a read (including a
   * reconnect-triggered one) never has to reason about write bookkeeping.
   */
  write: OrgBoardWriteState
  /**
   * Served-roster write-side state, kept separate from {@link write} above
   * for the same reason `write` is kept separate from the read fields: a
   * registry write and a served-roster write are two independent files, two
   * independent tokens, and two independent in-flight/notice lifecycles —
   * folding them into one field would make a pending registry write and a
   * pending served write indistinguishable to a renderer.
   */
  servedWrite: OrgBoardServedWriteState
}

const IDLE_WRITE_STATE: OrgBoardWriteState = { pending: false, notice: null }

const IDLE_SERVED_WRITE_STATE: OrgBoardServedWriteState = { pending: false, notice: null }

const IDLE_STATE: OrgBoardState = {
  status: 'idle', error: null, value: null, write: { ...IDLE_WRITE_STATE }, servedWrite: { ...IDLE_SERVED_WRITE_STATE },
}

/** Controller joining one `org.get` read, the `org.write` write path, and their published snapshot. */
export class OrgBoardController {
  /** Row snapshot consumed through a bound selector hook. */
  readonly store: SnapshotStore<OrgBoardState> = createSnapshotStore({
    ...IDLE_STATE, write: { ...IDLE_WRITE_STATE }, servedWrite: { ...IDLE_SERVED_WRITE_STATE },
  })

  /**
   * SHARED by `load()` and `write()` — the same "latest call wins" guard
   * `load()` already used in slice 2, now extended to writes. A write reads
   * its own generation right before calling `org.write`; if a `load()` (an
   * explicit reload, or a `connection/reset` refresh) starts and finishes
   * first, it bumps this counter, so the write's eventual response is
   * recognized as stale and discarded — the fresh read is never clobbered by
   * a write that was already answering a question the UI no longer has.
   */
  private generation = 0

  /**
   * The unresolved document and content token from the most recently
   * ACCEPTED `org.get`/`org.write` response — never captured once and held
   * across a refresh. Every verb reads these fresh at call time, so a write
   * issued after a background reload always carries that reload's token, per
   * the "never a stale capture" requirement. `null` before any successful
   * read, or after one whose `registry` came back `{ ok: false }` (nothing
   * to edit).
   */
  private document: OrgRegistryDocument | null = null
  private token: string | null = null

  /**
   * The `mailbox-bridge` mount's served-address list from the most recently
   * ACCEPTED `org.get`/`org.writeServed` response, and the served-roster
   * file's own content token — the {@link document}/{@link token} pair's
   * counterpart for the served-roster write path, read fresh at call time by
   * {@link setSeatServed} for the same "never a stale capture" reason.
   *
   * `servedAddresses` is populated ONLY when `value.drift.ok` is true, and
   * even then it is ALWAYS `mailboxBridge.addresses` — never a fallback to
   * `toolMailbox.addresses` when `mailboxBridge` itself failed to load.
   * `drift.ok` already requires the registry AND both rosters to have loaded
   * successfully, so gating on it covers every unreadable case in one
   * condition. Falling back to whichever roster happened to load would mean
   * silently picking a winner between two lists that may already disagree —
   * exactly the guess this whole feature exists to stop the operator from
   * making blind. `null` before any successful read, or whenever `drift.ok`
   * is false (including a partial failure: registry and ONE roster loaded,
   * the other did not).
   */
  private servedAddresses: readonly string[] | null = null

  /**
   * The served-roster file's content token, independent of
   * {@link servedAddresses}'s own gating: populated whenever
   * `value.servedRosterToken.ok` is true, which only requires the profile
   * patch file itself to have been read and parsed — not that either mount
   * inside it matched the recognised shape. A write built from this token
   * alone (with `servedAddresses` null) is refused locally by
   * {@link setSeatServed} before ever reaching the server, since there is no
   * base list to toggle against.
   */
  private servedRosterToken: string | null = null

  /** @param api - the org domain's wire face. */
  constructor(private readonly api: Pick<IApiClient, 'org'>) {}

  /**
   * (Re-)issue `org.get`. Latest call wins over anything still in flight,
   * including an in-flight `write()` — see {@link generation}.
   *
   * Resets `write.pending` and `servedWrite.pending` unconditionally: a write
   * superseded by this load will discard its own late response (generation
   * mismatch) and so would never otherwise clear `pending` itself, which
   * would leave the UI showing "still saving" forever. `write.notice` and
   * `servedWrite.notice` are both left untouched on purpose — a background
   * reconnect refresh must not silently erase a rejected/write-failed/split
   * notice the user hasn't acted on yet (see `write()`'s and
   * `setSeatServed()`'s own per-outcome handling for the cases that DO
   * intend to replace one: `org-registry-conflict` and
   * `org-served-roster-conflict` each explicitly reload AND set their own
   * notice first).
   * @returns nothing; {@link store} carries success or failure.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
      state.write.pending = false
      state.servedWrite.pending = false
    })
    try {
      const response = await this.api.org.get({})
      if (generation !== this.generation) return
      if (!response.result.ok) {
        // Narrow outside the updater: the immer draft callback is its own
        // closure, so TS re-widens `response.result` inside it and would
        // otherwise force a redundant `.ok ? null : ...` ternary whose
        // true-branch can never execute (we're already inside `!ok`).
        const { message } = response.result.error
        this.document = null
        this.token = null
        this.servedAddresses = null
        this.servedRosterToken = null
        this.store.update((state) => {
          state.status = 'error'
          state.error = message
          state.value = null
        })
        return
      }
      const value = response.result.value
      if (value.registry.ok) {
        this.document = value.registry.document
        this.token = value.registry.token
      } else {
        this.document = null
        this.token = null
      }
      // See this.servedAddresses's own doc comment on why this gates on
      // `drift.ok` alone and never falls back to `toolMailbox.addresses`.
      // `drift.ok` guarantees `mailboxBridge.ok` at runtime (drift can only
      // succeed when every source it diffs succeeded), but the two are
      // structurally independent union fields, so `mailboxBridge.ok` is
      // checked explicitly here too rather than asserted past the type
      // checker.
      this.servedAddresses = value.drift.ok && value.mailboxBridge.ok ? value.mailboxBridge.addresses : null
      this.servedRosterToken = value.servedRosterToken.ok ? value.servedRosterToken.token : null
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.value = value
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.document = null
      this.token = null
      this.servedAddresses = null
      this.servedRosterToken = null
      this.store.update((state) => {
        state.status = 'error'
        state.error = error instanceof Error ? error.message : String(error)
        state.value = null
      })
    }
  }

  /**
   * Add one seat. Builds the next document through `edit.ts`'s `addSeat`
   * against the currently held document, then writes it.
   * @param name - the new seat's name.
   * @param cwd - the new seat's workspace (absolute, or relative to the document's `baseDir`).
   * @returns nothing; {@link store}'s `write` field carries the outcome.
   */
  async addSeat(name: string, cwd: string): Promise<void> {
    await this.applyEdit(document => addSeat(document, name, cwd))
  }

  /**
   * Remove one seat, cascading over any edge or `callUp` entry naming it.
   * `edit.ts`'s `removeSeat` is exported separately for a caller that wants
   * to PREVIEW the cascade (e.g. a confirmation dialog) before ever calling
   * this verb; this method itself only needs its success/failure, so it
   * discards the cascade lists `removeSeat` reports.
   * @param name - the seat to remove.
   * @returns nothing; {@link store}'s `write` field carries the outcome.
   */
  async removeSeat(name: string): Promise<void> {
    await this.applyEdit(document => removeSeat(document, name))
  }

  /**
   * Add one undirected edge.
   * @param from - one endpoint.
   * @param to - the other endpoint.
   * @returns nothing; {@link store}'s `write` field carries the outcome.
   */
  async addEdge(from: string, to: string): Promise<void> {
    await this.applyEdit(document => addEdge(document, from, to))
  }

  /**
   * Remove one undirected edge, in whichever direction it is stored.
   * @param from - one endpoint.
   * @param to - the other endpoint.
   * @returns nothing; {@link store}'s `write` field carries the outcome.
   */
  async removeEdge(from: string, to: string): Promise<void> {
    await this.applyEdit(document => removeEdge(document, from, to))
  }

  /**
   * Replace one seat's tool restriction.
   * @param name - the seat to change.
   * @param allow - the seat's next allow-list, or `undefined`/empty to clear it.
   * @param deny - the seat's next deny-list, or `undefined`/empty to clear it.
   * @returns nothing; {@link store}'s `write` field carries the outcome.
   */
  async setSeatTools(name: string, allow: readonly string[] | undefined, deny: readonly string[] | undefined): Promise<void> {
    await this.applyEdit(document => setSeatTools(document, name, allow, deny))
  }

  /**
   * Set one seat's served / not-served state — the ONE fact the board offers
   * per seat, replacing BOTH the `mailbox-bridge` and `tool-mailbox` served
   * lists together through `org.writeServed`. Builds the next list through
   * `served-edit.ts`'s `nextServedAddresses` against the currently held
   * {@link servedAddresses} (the `mailbox-bridge` list — see its own doc
   * comment on why never `toolMailbox`), refused locally, without ever
   * calling the server, when either that or {@link servedRosterToken} isn't
   * currently loaded.
   *
   * `acknowledgeSplit` is taken from the caller and forwarded verbatim —
   * this method never re-derives, infers, or defaults it. The interface is
   * what discloses a pre-existing split to the operator (see
   * `OrgBoardServedWriteNotice`'s `'split'` member), so the interface is what
   * must assert that disclosure happened; a store deciding this for itself
   * would be asserting a disclosure that never took place.
   *
   * Shares {@link generation} with `load()` and `write()`, so a reload
   * (including one this same call's own success triggers) supersedes an
   * in-flight served write exactly as it already does a registry write.
   * @param name - the seat whose served state is changing.
   * @param served - the desired membership: `true` serves the seat, `false` stops serving it.
   * @param acknowledgeSplit - forwarded verbatim to `org.writeServed`; never derived here.
   * @returns nothing; {@link store}'s `servedWrite` field carries the outcome.
   */
  async setSeatServed(name: string, served: boolean, acknowledgeSplit: boolean): Promise<void> {
    const current = this.servedAddresses
    if (current === null) {
      this.store.update((state) => {
        state.servedWrite = { pending: false, notice: { kind: 'invalid', message: 'no served roster is loaded to edit' } }
      })
      return
    }
    const expectedToken = this.servedRosterToken
    if (expectedToken === null) {
      this.store.update((state) => {
        state.servedWrite = { pending: false, notice: { kind: 'invalid', message: 'no served roster is loaded to write against' } }
      })
      return
    }
    const addresses = nextServedAddresses(current, name, served)
    const generation = ++this.generation
    this.store.update((state) => {
      state.servedWrite = { pending: true, notice: null }
    })
    try {
      const response = await this.api.org.writeServed({ addresses, expectedToken, acknowledgeSplit })
      if (generation !== this.generation) return
      if (!response.result.ok) {
        const { error } = response.result
        if (error.code === 'org-served-roster-conflict') {
          this.store.update((state) => {
            state.servedWrite = { pending: false, notice: { kind: 'conflict', message: error.message } }
          })
          await this.load()
          return
        }
        if (error.code === 'org-served-roster-split') {
          // Does NOT reload: the file did not change (the write was refused
          // before it touched disk), so re-reading it would discard the
          // operator's pending intent for nothing — matching org-registry's
          // own rejected/write-failed branches below, never conflict's.
          const { onlyMailboxBridge, onlyToolMailbox } = error.details
          this.store.update((state) => {
            state.servedWrite = { pending: false, notice: { kind: 'split', onlyMailboxBridge, onlyToolMailbox } }
          })
          return
        }
        // org-served-roster-rejected ("fix your content") and
        // org-served-roster-write-failed ("retry the same list") both leave
        // this controller's servedAddresses/servedRosterToken untouched, so
        // the identical verb call reproduces the identical payload — same
        // shape as `write()`'s own non-conflict branch.
        const kind: 'rejected' | 'write-failed' = error.code === 'org-served-roster-rejected' ? 'rejected' : 'write-failed'
        this.store.update((state) => {
          state.servedWrite = { pending: false, notice: { kind, message: error.message } }
        })
        return
      }
      this.store.update((state) => {
        state.servedWrite = { pending: false, notice: null }
      })
      await this.load()
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.servedWrite = {
          pending: false,
          notice: { kind: 'write-failed', message: error instanceof Error ? error.message : String(error) },
        }
      })
    }
  }

  /**
   * Shared verb body: run one `edit.ts` editor against the currently held
   * document, and either publish its local refusal (never touching the
   * server) or hand its result to {@link write}.
   * @param edit - one `edit.ts` editor, partially applied to its own arguments.
   * @returns nothing; {@link store}'s `write` field carries the outcome.
   */
  private async applyEdit(edit: (document: OrgRegistryDocument) => EditOutcome | RemoveSeatOutcome): Promise<void> {
    const document = this.document
    if (document === null) {
      this.store.update((state) => {
        state.write = { pending: false, notice: { kind: 'invalid', message: 'no org registry is loaded to edit' } }
      })
      return
    }
    const outcome = edit(document)
    if (!outcome.ok) {
      this.store.update((state) => {
        state.write = { pending: false, notice: { kind: 'invalid', message: outcome.reason } }
      })
      return
    }
    await this.write(outcome.document)
  }

  /**
   * Submit one proposed document through `org.write`, guarded by the
   * currently held token (never a stale capture — read fresh here, at call
   * time). Handles the three server outcomes as three DISTINCT store
   * effects — see each branch — matching how they were deliberately split
   * apart server-side (host/apiproxy commit c99b35044b) because they demand
   * opposite responses from a caller:
   *
   *   - `org-registry-conflict`: the file changed under us. Auto-reloads so
   *     the viewer sees the true current state, and does NOT retry.
   *   - `org-registry-rejected`: the document was invalid. Does NOT reload
   *     (nothing changed on disk); the caller can fix and resubmit.
   *   - `org-registry-write-failed` (and any thrown transport error): an I/O
   *     problem unrelated to content. Does NOT reload; a caller can retry
   *     the exact same edit unchanged, since a failed write never advances
   *     {@link document}/{@link token} — the next identical verb call
   *     rebuilds the identical payload from the same base.
   *
   * On success: ALWAYS re-issues a full {@link load} rather than hand-patching
   * state from the write response — `org.write`'s response carries only the
   * new `registry`/`token`, never a recomputed `drift`/roster section, so
   * patching locally would leave those stale while presenting them as
   * current.
   * @param document - the proposed next document.
   * @returns nothing; {@link store}'s `write` field carries the outcome.
   */
  private async write(document: OrgRegistryDocument): Promise<void> {
    const expectedToken = this.token
    if (expectedToken === null) {
      this.store.update((state) => {
        state.write = { pending: false, notice: { kind: 'invalid', message: 'no org registry is loaded to write against' } }
      })
      return
    }
    const generation = ++this.generation
    this.store.update((state) => {
      state.write = { pending: true, notice: null }
    })
    try {
      const response = await this.api.org.write({ document, expectedToken })
      if (generation !== this.generation) return
      if (!response.result.ok) {
        const { error } = response.result
        if (error.code === 'org-registry-conflict') {
          this.store.update((state) => {
            state.write = { pending: false, notice: { kind: 'conflict', message: error.message } }
          })
          await this.load()
          return
        }
        // Every other business error code (org-registry-rejected,
        // org-registry-write-failed, or anything else org.write could in
        // principle surface) is retry-the-same-document territory: neither
        // reloads, both keep this controller's document/token exactly as
        // they were so the identical verb call reproduces the identical
        // payload. Only the notice KIND differs, so the UI can still tell
        // "fix your input" (rejected) apart from "just try again" (write-failed).
        const kind: 'rejected' | 'write-failed' = error.code === 'org-registry-rejected' ? 'rejected' : 'write-failed'
        this.store.update((state) => {
          state.write = { pending: false, notice: { kind, message: error.message } }
        })
        return
      }
      this.store.update((state) => {
        state.write = { pending: false, notice: null }
      })
      await this.load()
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.write = {
          pending: false,
          notice: { kind: 'write-failed', message: error instanceof Error ? error.message : String(error) },
        }
      })
    }
  }

  /** Stop in-flight responses from publishing after plugin disposal. */
  dispose(): void {
    this.generation += 1
  }
}

/**
 * Re-issue `org.get` on a `connection/reset` (reconnect or host restart) if
 * this controller has ever loaded -- a no-op before the modal's first open.
 *
 * This board's whole purpose is to tell a viewer the truth about the org's
 * current wiring; a reconnect is exactly when the underlying registry/roster
 * files are most likely to have changed (a restarted host, a redeployed
 * config), so leaving stale pre-reconnect data on screen with nothing
 * marking it stale would have the board confidently report a state the
 * system may no longer be in. Refreshing (never clearing to idle) is the
 * choice: `load()` keeps the previous `value` on screen until the fresh read
 * lands (see `load`'s update -- `status` flips to `'loading'` without
 * touching `value`), so a viewer mid-look never sees the board go blank.
 * Clearing to idle would force a momentary empty/loading render even while
 * the modal is open and being read -- the same "never render as emptiness"
 * shape this whole slice exists to avoid, just self-inflicted instead of
 * host-inflicted.
 * @param controller - the board's controller.
 */
export function refreshOrgBoardIfLoaded(controller: OrgBoardController): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

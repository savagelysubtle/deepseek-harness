/**
 * Org Board controller: one `org.get` read published into a snapshot store,
 * plus (SWD-134 slice 4 step 3) the write path — five document-editing verbs
 * that build the next `OrgRegistryDocument` through the pure functions in
 * `edit.ts` and submit it through `org.write`. This step owns no UI: it only
 * has to leave the store in a state a later component can render correctly.
 */

import type {
  IApiClient, OrgRegistryDocument, ResponseValue,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  addEdge, addSeat, removeEdge, removeSeat, setSeatTools,
} from './edit.ts'
import type { EditOutcome, RemoveSeatOutcome } from './edit.ts'

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
}

const IDLE_WRITE_STATE: OrgBoardWriteState = { pending: false, notice: null }

const IDLE_STATE: OrgBoardState = { status: 'idle', error: null, value: null, write: { ...IDLE_WRITE_STATE } }

/** Controller joining one `org.get` read, the `org.write` write path, and their published snapshot. */
export class OrgBoardController {
  /** Row snapshot consumed through a bound selector hook. */
  readonly store: SnapshotStore<OrgBoardState> = createSnapshotStore({ ...IDLE_STATE, write: { ...IDLE_WRITE_STATE } })

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

  /** @param api - the org domain's wire face. */
  constructor(private readonly api: Pick<IApiClient, 'org'>) {}

  /**
   * (Re-)issue `org.get`. Latest call wins over anything still in flight,
   * including an in-flight `write()` — see {@link generation}.
   *
   * Resets `write.pending` unconditionally: a write superseded by this load
   * will discard its own late response (generation mismatch) and so would
   * never otherwise clear `pending` itself, which would leave the UI showing
   * "still saving" forever. `write.notice` is left untouched on purpose — a
   * background reconnect refresh must not silently erase a
   * rejected/write-failed notice the user hasn't acted on yet (see
   * `write()`'s per-outcome handling for the one case that DOES intend to
   * replace it: `org-registry-conflict` explicitly reloads AND sets its own
   * notice first).
   * @returns nothing; {@link store} carries success or failure.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
      state.write.pending = false
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
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.value = value
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.document = null
      this.token = null
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

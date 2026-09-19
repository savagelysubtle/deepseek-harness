/**
 * Org Board controller: one `org.get` read published into a snapshot store.
 * SWD-134 slice 2 is read-only, so this is the whole data layer — no writes,
 * no mutation verbs, no optimistic state.
 *
 * The response's outer `RpcResult` failing (transport/business error — the
 * call never reached the org domain at all) is a DIFFERENT failure from any
 * of the three inner result unions (`registry`/`mailboxBridge`/`toolMailbox`)
 * failing: an outer failure means there is no `profile` to show either, so it
 * gets its own `status: 'error'` rather than being folded into a "ready with
 * everything unavailable" shape a renderer could mistake for real data.
 */

import type { IApiClient, ResponseValue } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** The full `org.get` payload once the RPC itself succeeds. */
export type OrgBoardValue = ResponseValue<'org.get'>

/** Org Board snapshot: either no successful read yet, or the full `org.get` value. */
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
}

const IDLE_STATE: OrgBoardState = { status: 'idle', error: null, value: null }

/** Controller joining one `org.get` read and its published snapshot. */
export class OrgBoardController {
  /** Row snapshot consumed through a bound selector hook. */
  readonly store: SnapshotStore<OrgBoardState> = createSnapshotStore({ ...IDLE_STATE })

  private generation = 0

  /** @param api - the org domain's wire face. */
  constructor(private readonly api: Pick<IApiClient, 'org'>) {}

  /**
   * (Re-)issue `org.get`. Latest call wins over anything still in flight.
   * @returns nothing; {@link store} carries success or failure.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
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
        this.store.update((state) => {
          state.status = 'error'
          state.error = message
          state.value = null
        })
        return
      }
      const value = response.result.value
      this.store.update((state) => {
        state.status = 'ready'
        state.error = null
        state.value = value
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = error instanceof Error ? error.message : String(error)
        state.value = null
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

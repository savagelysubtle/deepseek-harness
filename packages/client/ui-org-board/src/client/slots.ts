/** Injected face for the one footer-action entry this package registers. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { OrgBoardState } from './org-board-store.ts'

/**
 * Live verb + read snapshot for the Org Board control. Slice 2 was read-only
 * (`load` was the only verb); SWD-134 slice 4 step 3 adds the five
 * document-editing verbs; SWD-134 slice 5 step 3 adds `setSeatServed` — the
 * component still never mutates the snapshot itself, every verb round-trips
 * through `OrgBoardController` and its published `hooks.orgBoard` store the
 * same way `load` always has.
 */
export interface OrgBoardFace {
  hooks: {
    /** Latest org.get outcome (or its absence), plus write-side state, as a snapshot store. */
    orgBoard: SnapshotStore<OrgBoardState>
  }
  /** (Re-)issue `org.get` and publish the outcome into the snapshot. Latest call wins. */
  load: () => Promise<void>
  /** Add one new seat. Publishes its outcome into `hooks.orgBoard`'s `write` field. */
  addSeat: (name: string, cwd: string) => Promise<void>
  /** Remove one seat, cascading over any edge or `callUp` entry naming it. */
  removeSeat: (name: string) => Promise<void>
  /** Add one undirected edge between two seats. */
  addEdge: (from: string, to: string) => Promise<void>
  /** Remove one undirected edge, in whichever direction it is stored. */
  removeEdge: (from: string, to: string) => Promise<void>
  /** Replace one seat's tool restriction; an empty/`undefined` allow AND deny clears it. */
  setSeatTools: (name: string, allow: readonly string[] | undefined, deny: readonly string[] | undefined) => Promise<void>
  /**
   * Set one seat's served / not-served state — the ONE fact the board offers
   * per seat; see `org-board-store.ts`'s `setSeatServed` doc comment for why
   * this always writes BOTH served rosters (`mailbox-bridge` and
   * `tool-mailbox`) identically, never one without the other.
   *
   * REQUIRED, deliberately, exactly like the five verbs above: this whole
   * board briefly shipped with its edit props optional and a silent no-op
   * default, which let every control render fully wired-looking while doing
   * nothing — the board's own tests mount it directly with their own mocks
   * and never cross the seam that only the hosting `OrgBoardControl` closes,
   * so the defect stayed green. A required prop turns an unwired call site
   * into a BUILD failure instead of a passing test suite. Do NOT make this
   * optional, and do NOT give it a default — that reintroduces the exact
   * defect this comment exists to prevent.
   */
  setSeatServed: (name: string, served: boolean, acknowledgeSplit: boolean) => Promise<void>
}

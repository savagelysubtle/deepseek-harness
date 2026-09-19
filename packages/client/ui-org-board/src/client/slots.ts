/** Injected face for the one footer-action entry this package registers. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { OrgBoardState } from './org-board-store.ts'

/**
 * Live verb + read snapshot for the Org Board control (SWD-134 slice 2): a
 * read-only node-graph view of the org registry and its served-roster drift.
 * `hooks.orgBoard` synthesizes into a bound `useOrgBoard` selector hook (the
 * ui-slots `InjectFace` transform); the component never mutates the snapshot
 * itself — `load` is the only verb, and it only re-reads `org.get`.
 */
export interface OrgBoardFace {
  hooks: {
    /** Latest org.get outcome (or its absence) as a snapshot store. */
    orgBoard: SnapshotStore<OrgBoardState>
  }
  /** (Re-)issue `org.get` and publish the outcome into the snapshot. Latest call wins. */
  load: () => Promise<void>
}

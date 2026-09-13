/**
 * Subagent tree derivation for the current conversation's Agents view
 * (SWD-124): the live subagent lineage `sessionVisible()`
 * (`packages/client/ui-workspace/src/client/tree.ts`) hides from the
 * ordinary session tree, scoped to the one conversation currently open.
 * @module @deepseek-ai/dsh-client-ui-agents/client/tree
 */
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
// Side-effect only: merges the `turnStatus` key into SessionProjectionMap so
// `SessionSummary.projectionValues.turnStatus` below type-checks (SWD-120's
// stop/crash/error distinction).
import type {} from '@deepseek-ai/dsh-session-turn-status/client'

/**
 * SWD-120 stop/crash/error distinction, replicated in full from
 * `packages/client/ui-workspace/src/client/tree.ts`'s own (unexported)
 * `sessionEndStatus` rather than imported: that helper is private to its
 * package — neither its client entry nor its package root re-exports it —
 * and `packages/client/AGENTS.md`'s export discipline forbids reaching into
 * a sibling plugin's `src` for a value it has not chosen to export ("the
 * sanctioned routes are the slot system and ctx services... stop and
 * escalate — do not add an export to unblock yourself"). Same algorithm,
 * same doc rationale as the source.
 */
export type SessionEndStatusKind = 'stopped' | 'interrupted' | 'error'

/**
 * Derive the SWD-120 stop/crash/error distinction from the `turnStatus`
 * projection, when the deployment composes it. `open` is read together with
 * the row's own `running` bit: an open turn on a session that is NOT running
 * is the crash-but-not-yet-reloaded gotcha, rendered as `'interrupted'`
 * rather than falling through to the ordinary idle/completed bucket a bare
 * `open` check would land on.
 * @param summary - the session-list row to derive from.
 * @returns the distinguishing status, or undefined to keep the ordinary
 *   running/completed/idle rendering.
 */
export function sessionEndStatus(summary: SessionSummary): SessionEndStatusKind | undefined {
  const turnStatus = summary.projectionValues?.turnStatus
  if (turnStatus === undefined) return undefined
  if (turnStatus.open) return summary.running ? undefined : 'interrupted'
  switch (turnStatus.cause?.kind) {
    case 'aborted': return 'stopped'
    case 'interrupted': return 'interrupted'
    case 'error': return 'error'
    default: return undefined
  }
}

/** One node in the derived Agents tree: a subagent session plus its own nested subagents. */
export interface AgentTreeNode {
  readonly summary: SessionSummary
  /** Nested subagent-origin descendants, running-first then most-recently-updated. */
  readonly children: readonly AgentTreeNode[]
}

/** Running sessions first, then most-recently-updated; id breaks a tie deterministically. */
function compareSummaries(a: SessionSummary, b: SessionSummary): number {
  if (a.running !== b.running) return a.running ? -1 : 1
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

/**
 * Build the subagent forest rooted at one conversation: every session whose
 * `origin` is `'subagent'` and whose `parentId` chain reaches `rootId`,
 * however many levels deep. An ordinary fork also carries a `parentId` but is
 * never `origin: 'subagent'`, so it never enters this tree — the same gate
 * `sessionVisible()` and `indexSubagentDescendants()` both apply.
 *
 * Cycle guard: a malformed `parentId` chain among subagent-only sessions
 * could in principle point back on itself with no real root reaching it.
 * `buildNode` marks a session visited before recursing into its own
 * children, so a repeat encountered lower in the walk is filtered out as a
 * child instead of re-descended — recursion depth is bounded by the number
 * of distinct ids, and a cycle simply stops growing rather than looping.
 * @param byId - retained session summaries keyed by id (`SessionListState.byId`).
 * @param rootId - the conversation currently open; its own row is never part
 *   of the returned forest, only its descendants.
 * @returns direct subagent children of `rootId`, each recursively nested,
 *   running-first then most-recently-updated.
 */
export function deriveSubagentTree(
  byId: Readonly<Record<SessionId, SessionSummary>>,
  rootId: SessionId,
): readonly AgentTreeNode[] {
  const childrenOf = new Map<SessionId, SessionSummary[]>()
  for (const summary of Object.values(byId)) {
    if (summary.origin !== 'subagent' || summary.parentId === undefined) continue
    const siblings = childrenOf.get(summary.parentId)
    if (siblings === undefined) childrenOf.set(summary.parentId, [summary])
    else siblings.push(summary)
  }

  const visited = new Set<SessionId>([rootId])
  function buildNode(summary: SessionSummary): AgentTreeNode {
    visited.add(summary.id)
    const children = (childrenOf.get(summary.id) ?? [])
      .filter(child => !visited.has(child.id))
      .sort(compareSummaries)
      .map(buildNode)
    return { summary, children }
  }

  return (childrenOf.get(rootId) ?? [])
    .filter(child => !visited.has(child.id))
    .sort(compareSummaries)
    .map(buildNode)
}

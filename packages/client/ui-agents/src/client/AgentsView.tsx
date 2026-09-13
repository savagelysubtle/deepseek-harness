/**
 * Agents view (SWD-124): a `conversation.view` ring entry showing the
 * subagents running underneath the conversation currently open — the rows
 * `sessionVisible()` (`packages/client/ui-workspace/src/client/tree.ts`)
 * hides from the ordinary session tree, so today the founder can only see
 * "N agents are running" and never which. Read only: no navigation, no stop
 * controls. A separate lane is landing the cascading-stop RPCs; wiring
 * actions into this view is a deliberate follow-up, not this task.
 */
import { useState } from 'react'
import { DisclosureRow, StateDot, IconAgentPresetOutline16, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deriveSubagentTree, sessionEndStatus, type AgentTreeNode } from './tree.ts'
import css from './AgentsView.module.css'

/** Full Agents view props: the standard conversation-view kit plus the locale seat. */
export type AgentsViewProps = ConvViewProps & PropsLocale<'agents'>

type Translate = AgentsViewProps['t']

interface RowStatus {
  readonly state: StateDotState
  readonly label: string
}

/**
 * Row status dot + label: running outranks everything, then the SWD-120
 * stop/crash/error distinction, then the plain completed/idle fallback —
 * the same precedence order the Workspace browser's row status uses.
 * @param summary - the session-list row to derive from.
 * @param t - the view's locale seat.
 * @returns the dot state and its label.
 */
function rowStatus(summary: SessionSummary, t: Translate): RowStatus {
  if (summary.running) return { state: 'ongoing', label: t('status.running') }
  const endStatus = sessionEndStatus(summary)
  switch (endStatus) {
    case 'stopped': return { state: 'done', label: t('status.stopped') }
    case 'interrupted': return { state: 'warning', label: t('status.interrupted') }
    case 'error': return { state: 'error', label: t('status.error') }
    case undefined: break
  }
  if (summary.completed === true) return { state: 'done', label: t('status.completed') }
  return { state: 'done', label: t('status.idle') }
}

interface AgentRowProps {
  readonly node: AgentTreeNode
  readonly depth: number
  readonly t: Translate
}

/**
 * One subagent row plus its recursively nested subagent children. Purely
 * presentational: the only interaction is this row's own expand/collapse
 * disclosure, local to the row (no lifted state — nothing else in the view
 * depends on which rows are open).
 */
function AgentRow({ node, depth, t }: AgentRowProps) {
  const [open, setOpen] = useState(true)
  const { summary } = node
  const expandable = node.children.length > 0
  const status = rowStatus(summary, t)
  const title = summary.displayTitle
  return (
    <div className={css.rowWrapper} style={{ paddingLeft: depth * 16 }}>
      <DisclosureRow
        icon={<IconAgentPresetOutline16 />}
        title=""
        open={expandable && open}
        expandable={expandable}
        onToggle={() => { setOpen(value => !value) }}
        previewChevron={false}
        keepContentWhenOpen
        rowClassName={css.row}
        collapsedContent={(
          <>
            <span className={css.statusSlot}>
              <StateDot state={status.state} />
              <span className={css.visuallyHidden}>
                {t('row.aria', { name: title, status: status.label })}
              </span>
            </span>
            <span className={css.title}>{title}</span>
            <span className={css.statusLabel} aria-hidden="true">{status.label}</span>
          </>
        )}
      >
        {node.children.map(child => (
          <AgentRow key={child.summary.id} node={child} depth={depth + 1} t={t} />
        ))}
      </DisclosureRow>
    </div>
  )
}

/**
 * Render the Agents view: the subagent tree rooted at the conversation
 * currently open, or a plain empty-state message when it has none — never a
 * blank panel.
 * @param props - standard conversation-view kit (`sessionId`, `useSessions`)
 *   plus the locale seat.
 * @returns the current conversation's subagent tree.
 */
export function AgentsView({ sessionId, useSessions, t }: AgentsViewProps) {
  const byId = useSessions(state => state.byId)
  const tree = deriveSubagentTree(byId, sessionId)
  return (
    <div className={css.root}>
      {tree.length === 0
        ? <div className={css.empty}>{t('empty')}</div>
        : (
          <div className={css.tree} role="tree" aria-label={t('tree.aria')}>
            {tree.map(node => (
              <AgentRow key={node.summary.id} node={node} depth={0} t={t} />
            ))}
          </div>
        )}
    </div>
  )
}

import { useState, type ReactNode } from 'react'
import {
  DisclosureRow, IconChevronRightOutline14, StateDot,
  type DisclosureRowProps, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { shallowEqual, type SessionId, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkflowRunKey } from './locales.ts'
import type {
  WorkflowRunGateRow, WorkflowRunMemberData, WorkflowRunNodeData, WorkflowRunPhaseData,
  WorkflowRunStatus,
} from './workflow-definition.ts'
import css from './WorkflowRunPanel.module.css'

/** Navigation action injected from the plugin's own SessionRuntime access. */
export interface WorkflowRunInjected {
  readonly openSession: (id: SessionId) => void
}

/** Complete keyed Chat renderer props. */
export type WorkflowRunPanelProps =
  PropsRuntime<'conversation.chat.node', 'workflow-run'>
  & PropsLocale<'workflowRun'>
  & WorkflowRunInjected

const STATUS_KEYS = {
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  interrupted: 'status.interrupted',
} as const satisfies Record<WorkflowRunStatus, WorkflowRunKey>

function dotState(status: WorkflowRunStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'cancelled':
    case 'interrupted': return 'warning'
    /* v8 ignore next -- WorkflowRunStatus is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

function readablePhase(phase: string | null, t: WorkflowRunPanelProps['t']): string {
  if (phase === null) return t('phase.unassigned')
  return phase === '' ? t('phase.empty') : phase
}

function readableMember(label: string, t: WorkflowRunPanelProps['t']): string {
  return label === '' ? t('member.empty') : label
}

function statusCount(
  status: WorkflowRunStatus,
  count: number,
  t: WorkflowRunPanelProps['t'],
): string {
  return t(`statusCount.${status}`, { count })
}

function memberCount(count: number, t: WorkflowRunPanelProps['t']): string {
  return t(count === 1 ? 'run.members.one' : 'run.members.other', { count })
}

function phaseRequiresExpansion(phase: WorkflowRunPhaseData): boolean {
  return phase.members.some(member => member.status !== 'completed')
}

type StatusDisclosureProps = Omit<DisclosureRowProps, 'open' | 'expandable' | 'onToggle'>

/* v8 ignore next -- DisclosureRow requires the callback but cannot invoke it when expandable is false. */
const forcedOpenToggle = (): void => {}

function ManualDisclosure(props: StatusDisclosureProps) {
  const [open, setOpen] = useState(false)
  return (
    <DisclosureRow
      {...props}
      open={open}
      expandable
      onToggle={() => { setOpen(value => !value) }}
    />
  )
}

function StatusDisclosure({ cleanCycleKey, requiresExpansion, ...props }: StatusDisclosureProps & {
  /** Remount a clean Phase when its append-only member count changes between batched renders. */
  readonly cleanCycleKey?: number | undefined
  readonly requiresExpansion: boolean
}) {
  if (!requiresExpansion) return <ManualDisclosure key={cleanCycleKey} {...props} />
  return <DisclosureRow {...props} open expandable={false} onToggle={forcedOpenToggle} />
}

function phaseStatusSummary(members: readonly WorkflowRunMemberData[], t: WorkflowRunPanelProps['t']): string {
  const counts = new Map<WorkflowRunStatus, number>()
  for (const member of members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1)
  const count = (status: WorkflowRunStatus): number => counts.get(status) ?? 0
  const active = (['running', 'failed', 'cancelled', 'interrupted'] as const)
    .filter(status => count(status) > 0)
  if (active.length === 0) return statusCount('completed', count('completed'), t)
  const visible = active.includes('interrupted') && count('completed') > 0
    ? ['completed' as const, ...active]
    : active
  return visible.map(status => statusCount(status, count(status), t)).join(' · ')
}

function navigableMembers(
  sessions: SessionListState,
  phases: readonly WorkflowRunPhaseData[],
  parentId: SessionId,
): readonly SessionId[] {
  const ordinary = new Set(sessions.ids)
  const result: SessionId[] = []
  for (const phase of phases) {
    for (const member of phase.members) {
      const summary = sessions.byId[member.childId]
      if (member.status === 'running'
        && ordinary.has(member.childId)
        && summary?.origin === 'subagent'
        && summary.parentId === parentId
        && summary.running) {
        result.push(member.childId)
      }
    }
  }
  return result
}

function RunHeader({ children, count, name, requiresExpansion, status, t }: {
  readonly children: ReactNode
  readonly count: number
  readonly name: string
  readonly requiresExpansion: boolean
  readonly status: WorkflowRunStatus
  readonly t: WorkflowRunPanelProps['t']
}) {
  return (
    <StatusDisclosure
      icon={<IconChevronRightOutline14 />}
      title={t('run.title', { name })}
      requiresExpansion={requiresExpansion}
      expandOnRowClick
      previewChevron={false}
      keepContentWhenOpen
      rowClassName={css.runHeader}
      leadingClassName={css.runLeading}
      titleClassName={css.runTitle}
      collapsedContent={(
        <>
          <span className={css.separator} aria-hidden />
          <span className={css.runSummary}>{memberCount(count, t)}</span>
          <span className={css.statusTail} data-status={status}>
            <StateDot state={dotState(status)} />
            <span>{t(STATUS_KEYS[status])}</span>
          </span>
        </>
      )}
    >
      {children}
    </StatusDisclosure>
  )
}

function MemberRow({ member, navigable, openSession, t }: {
  readonly member: WorkflowRunMemberData
  readonly navigable: boolean
  readonly openSession: WorkflowRunInjected['openSession']
  readonly t: WorkflowRunPanelProps['t']
}) {
  const name = readableMember(member.label, t)
  const content = (
    <>
      <span className={css.dotSlot}><StateDot state={dotState(member.status)} /></span>
      <span className={css.memberLabelWrap} data-member-label-wrap><span className={css.memberLabel} data-member-label>{name}</span></span>
      <span className={css.memberStatus} data-member-status-text>{t(STATUS_KEYS[member.status])}</span>
    </>
  )
  if (!navigable) {
    return <div className={css.memberRow} data-member-status={member.status}>{content}</div>
  }
  return (
    <button
      type="button"
      className={css.memberButton}
      data-member-status={member.status}
      aria-label={t('member.open', { name })}
      onClick={() => { openSession(member.childId) }}
    >
      {content}
    </button>
  )
}

function PhaseSection({ phase, navigable, openSession, t }: {
  readonly phase: WorkflowRunPhaseData
  readonly navigable: readonly SessionId[]
  readonly openSession: WorkflowRunInjected['openSession']
  readonly t: WorkflowRunPanelProps['t']
}) {
  return (
    <StatusDisclosure
      icon={<IconChevronRightOutline14 />}
      title={readablePhase(phase.phase, t)}
      cleanCycleKey={phase.members.length}
      requiresExpansion={phaseRequiresExpansion(phase)}
      expandOnRowClick
      previewChevron={false}
      keepContentWhenOpen
      className={css.phase}
      rowClassName={css.phaseHeader}
      leadingClassName={css.phaseLeading}
      titleClassName={css.phaseTitle}
      collapsedContent={(
        <>
          <span className={css.separator} aria-hidden />
          <span className={css.phaseCount} data-phase-count>{memberCount(phase.members.length, t)}</span>
          <span className={css.phaseStatus} data-phase-status-text>{phaseStatusSummary(phase.members, t)}</span>
        </>
      )}
    >
      <div className={css.members}>
        {phase.members.map(member => (
          <MemberRow
            key={member.seq}
            member={member}
            navigable={navigable.includes(member.childId)}
            openSession={openSession}
            t={t}
          />
        ))}
      </div>
    </StatusDisclosure>
  )
}

const GATE_OUTCOME_KEYS = {
  'fired-pass': 'gate.outcome.fired-pass',
  'fired-block': 'gate.outcome.fired-block',
  skipped: 'gate.outcome.skipped',
  'not-reached': 'gate.outcome.not-reached',
  'never-evaluated': 'gate.outcome.never-evaluated',
} as const satisfies Record<string, WorkflowRunKey>

function gateOutcomeText(outcome: string, t: WorkflowRunPanelProps['t']): string {
  return Object.hasOwn(GATE_OUTCOME_KEYS, outcome)
    ? t(GATE_OUTCOME_KEYS[outcome as keyof typeof GATE_OUTCOME_KEYS])
    : outcome
}

const NODE_STATUS_KEYS = {
  running: 'node.status.running',
  done: 'node.status.done',
  failed: 'node.status.failed',
  skipped: 'node.status.skipped',
  cancelled: 'node.status.cancelled',
  interrupted: 'node.status.interrupted',
} as const satisfies Record<WorkflowRunNodeData['status'], WorkflowRunKey>

const APPROVAL_KEYS = {
  pending: 'approval.pending',
  cancelled: 'approval.cancelled',
  allowed: 'approval.allowed',
  rejected: 'approval.rejected',
  expired: 'approval.expired',
  unavailable: 'approval.unavailable',
} as const satisfies Record<NonNullable<WorkflowRunNodeData['approval']>, WorkflowRunKey>

function nodeDot(status: WorkflowRunNodeData['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'done': return 'done'
    case 'failed': return 'error'
    case 'skipped':
    case 'cancelled':
    case 'interrupted': return 'warning'
    /* v8 ignore next -- the node status union is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

/** Translate function of the `workflowRun` namespace, as the embeddable components take it. */
export type WorkflowRunTranslate = WorkflowRunPanelProps['t']

/**
 * The text badge of one approval state (`data-approval-text`); the state is also spelled out in words.
 * @param props - the approval state and the namespace translate function.
 * @returns the badge element.
 */
export function ApprovalBadge({ state, t }: {
  readonly state: NonNullable<WorkflowRunNodeData['approval']>
  readonly t: WorkflowRunTranslate
}) {
  return <span className={css.approvalBadge} data-approval-text data-approval-badge={state}>{t(APPROVAL_KEYS[state])}</span>
}

/**
 * One node row: status dot and text, exit code and duration, truncation marker, approval badge and the
 * verbatim reason. The row carries `data-workflow-node`, `data-node-id` and `data-node-status`, plus
 * `data-approval-state` when the node has an approval.
 * @param props - the node record and the namespace translate function.
 * @returns the list item.
 */
export function NodeRow({ node, t }: { readonly node: WorkflowRunNodeData; readonly t: WorkflowRunPanelProps['t'] }) {
  const meta = [
    node.exitCode === undefined ? undefined : t('node.exit', { code: node.exitCode }),
    node.durationMs === undefined ? undefined : t('node.duration', { ms: node.durationMs }),
  ].filter((part): part is string => part !== undefined)
  return (
    <li
      className={css.nodeRow}
      data-workflow-node
      data-node-id={node.nodeId}
      data-node-kind={node.kind}
      data-node-status={node.status}
      {...node.approval === undefined ? {} : { 'data-approval-state': node.approval }}
    >
      <span className={css.dotSlot}><StateDot state={nodeDot(node.status)} /></span>
      <span className={css.nodeLabel}>{node.nodeId}</span>
      <span className={css.nodeStatus} data-node-status-text>{t(NODE_STATUS_KEYS[node.status])}</span>
      {node.approval === undefined ? null : <ApprovalBadge state={node.approval} t={t} />}
      {meta.length === 0 ? null : <span className={css.nodeMeta} data-node-meta>{meta.join(' · ')}</span>}
      {node.truncated === true
        ? <span className={css.nodeMeta} data-node-truncated>{t('node.truncated')}</span>
        : null}
      {node.reason === undefined
        ? null
        : <span className={css.nodeReason} data-node-reason>{node.reason}</span>}
    </li>
  )
}

/**
 * The node list of one run (`data-workflow-nodes`).
 * @param props - the node records in display order and the namespace translate function.
 * @returns the node section.
 */
export function NodeList({ nodes, t }: {
  readonly nodes: readonly WorkflowRunNodeData[]
  readonly t: WorkflowRunPanelProps['t']
}) {
  return (
    <div className={css.nodes} data-workflow-nodes>
      <span className={css.sectionHeading}>{t('node.heading')}</span>
      <ul className={css.nodeList}>
        {nodes.map(node => <NodeRow key={node.nodeId} node={node} t={t} />)}
      </ul>
    </div>
  )
}

/**
 * The collapsible gate-report table. Controlled: the caller remembers `open` per run.
 * @param props - the rows, the open flag, the toggle callback and the namespace translate function.
 * @returns the gate-report section.
 */
export function GateReport({ rows, open, onToggle, t }: {
  readonly rows: readonly WorkflowRunGateRow[]
  readonly open: boolean
  readonly onToggle: () => void
  readonly t: WorkflowRunPanelProps['t']
}) {
  return (
    <div className={css.gateReport} data-gate-report data-gate-report-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className={css.gateToggle}
        aria-expanded={open}
        data-gate-toggle
        onClick={onToggle}
      >
        {t('gate.toggle', { count: rows.length })}
      </button>
      {open
        ? rows.length === 0
          ? <span className={css.empty}>{t('gate.empty')}</span>
          : (
            <table className={css.gateTable} data-gate-table>
              <caption className={css.gateCaption}>{t('gate.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('gate.col.node')}</th>
                  <th scope="col">{t('gate.col.kind')}</th>
                  <th scope="col">{t('gate.col.outcome')}</th>
                  <th scope="col">{t('gate.col.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr
                    key={`${row.nodeId}\u0000${row.gateKind}`}
                    data-gate-row
                    data-gate-node={row.nodeId}
                    data-gate-kind={row.gateKind}
                    data-gate-outcome={row.outcome}
                  >
                    <td>{row.nodeId}</td>
                    <td>{row.gateKind}</td>
                    <td>
                      <span className={css.gateBadge} data-gate-badge data-outcome={row.outcome}>
                        {gateOutcomeText(row.outcome, t)}
                      </span>
                    </td>
                    <td data-gate-reason>{row.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        : null}
    </div>
  )
}

/** Render one durable workflow run with status-driven run and phase disclosure. */
export function WorkflowRunPanel({ node, sessionId, useSessions, openSession, t }: WorkflowRunPanelProps) {
  const totalMembers = node.data.phases.reduce((count, phase) => count + phase.members.length, 0)
  const requiresExpansion = node.data.status !== 'completed'
    || node.data.phases.some(phaseRequiresExpansion)
  const { nodes, gateReport } = node.data
  // Remembered per run id in component state; the default opens the report when a gate blocked.
  const [gateOpen, setGateOpen] = useState<Readonly<Record<string, boolean>>>({})
  const reportOpen = gateOpen[node.id] ?? (gateReport?.some(row => row.outcome === 'fired-block') ?? false)
  const navigable = useSessions(
    sessions => navigableMembers(sessions, node.data.phases, sessionId),
    shallowEqual,
  )
  return (
    <section className={css.root} data-workflow-run data-run-status={node.data.status}>
      <RunHeader
        count={totalMembers}
        name={node.data.name}
        requiresExpansion={requiresExpansion}
        status={node.data.status}
        t={t}
      >
        <div className={css.phaseList}>
          {node.data.phases.length === 0 && (nodes === undefined || nodes.length === 0)
            ? <span className={css.empty}>{t('run.empty')}</span>
            : node.data.phases.map(phase => (
              <PhaseSection
                key={phase.key}
                phase={phase}
                navigable={navigable}
                openSession={openSession}
                t={t}
              />
            ))}
          {nodes === undefined || nodes.length === 0 ? null : <NodeList nodes={nodes} t={t} />}
        </div>
      </RunHeader>
      {/* Outside the disclosure so the end-of-run report stays visible once the clean run folds. */}
      {gateReport === undefined
        ? null
        : (
          <GateReport
            rows={gateReport}
            open={reportOpen}
            onToggle={() => { setGateOpen(prev => ({ ...prev, [node.id]: !reportOpen })) }}
            t={t}
          />
        )}
    </section>
  )
}

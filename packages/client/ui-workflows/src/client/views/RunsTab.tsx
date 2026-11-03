/** The Runs tab: pending approvals, the run list, and one run's detail. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkflowRunTranslate, WorkflowRunViewContract } from '@deepseek-ai/dsh-client-ui-workflow-run/client'
import type { WorkflowApprovalView, WorkflowNodeView } from '@deepseek-ai/dsh-workflow-remote/client'
import type { NodeOutputView, RunDetailView, WorkflowsController, WorkflowsState } from '../controller.ts'
import css from '../Workflows.module.css'
import { FailureNotice, statusLabel } from './shared.tsx'
import type { T } from './shared.tsx'

/** Approve / reject controls for one waiting approval. */
function ApprovalActions({ controller, runId, approvalId, t }: {
  controller: WorkflowsController
  runId: string
  approvalId: string
  t: T
}) {
  const [reason, setReason] = useState('')
  return (
    <span className={css.approvalActions}>
      <input
        className={css.textInput}
        data-reject-reason
        aria-label={t('approvals.reason')}
        placeholder={t('approvals.reason')}
        value={reason}
        onChange={(event) => { setReason(event.target.value) }}
      />
      <Button size="sm" variant="primary" data-approve onClick={() => { void controller.approve(runId, approvalId) }}>{t('approvals.approve')}</Button>
      <Button size="sm" variant="outline" data-reject onClick={() => { void controller.reject(runId, approvalId, reason) }}>{t('approvals.reject')}</Button>
    </span>
  )
}

const APPROVAL_STATES: ReadonlySet<string> = new Set(['pending', 'allowed', 'rejected', 'expired', 'cancelled', 'unavailable'])

/** The shared approval badge for a known state, the Host's own token otherwise. */
function ApprovalState({ state, t, view }: { state: string; t: WorkflowRunTranslate; view: WorkflowRunViewContract }) {
  return APPROVAL_STATES.has(state)
    ? <view.ApprovalBadge state={state as 'pending'} t={t} />
    : <span data-approval-text>{state}</span>
}

/** One node's raw-output reader; the node rows themselves come from `ui-workflow-run`. */
function NodeOutput({ node, output, controller, t }: {
  node: WorkflowNodeView
  output: NodeOutputView | undefined
  controller: WorkflowsController
  t: T
}) {
  return (
    <li className={css.node} data-node-output-row data-node-id={node.nodeId}>
      <span className={css.rowTitle}>{node.nodeId}</span>
      <button type="button" className={css.linkButton} data-node-output-button onClick={() => { void controller.loadOutput(node.nodeId) }}>
        {output?.nextOffset === undefined ? t('detail.showOutput') : t('detail.moreOutput')}
      </button>
      {output?.failure !== undefined && <FailureNotice failure={output.failure} scope="output" t={t} />}
      {output !== undefined && output.failure === undefined && !output.loading && (
        <>
          <pre className={css.pre} data-node-output>{output.text === '' ? t('detail.outputEmpty') : output.text}</pre>
          <span className={css.muted}>{t('detail.outputTotal', { bytes: output.totalBytes })}{output.truncated ? ` · ${t('detail.truncated')}` : ''}</span>
        </>
      )}
    </li>
  )
}

function RunDetail({ controller, view, t, runT, runView }: {
  controller: WorkflowsController
  view: RunDetailView
  t: T
  runT: WorkflowRunTranslate
  runView: WorkflowRunViewContract
}) {
  const detail = view.detail
  const mapped = detail === undefined ? undefined : runView.runDetailToNodeData(detail)
  // The gate report is collapsed unless a gate blocked, as in the chat node; the choice is kept while this run stays open.
  const [gateOpen, setGateOpen] = useState<boolean | undefined>(undefined)
  return (
    <section className={css.detail} data-run-detail data-run-id={view.runId} data-run-status={detail?.status ?? view.status}>
      <div className={css.sectionHead}>
        <h3 className={css.heading}>{t('detail.heading')}</h3>
        <button type="button" className={css.linkButton} data-detail-close onClick={() => { controller.closeDetail() }}>{t('detail.back')}</button>
      </div>
      {view.status === 'loading' && <p className={css.muted} data-detail-loading>{t('detail.loading')}</p>}
      {view.failure !== undefined && <FailureNotice failure={view.failure} scope="detail" t={t} />}
      {detail !== undefined && (
        <>
          <p className={css.rowTitle}>
            <span data-run-name>{detail.name}</span> · <span data-run-status-text>{statusLabel(t, detail.status)}</span>
          </p>
          {detail.error !== undefined && <p className={css.problem} data-run-error>{t('detail.error', { error: detail.error })}</p>}
          {detail.fileChanged && <p className={css.warn} data-file-changed>{t('detail.fileChanged')}</p>}
          <div className={css.actions}>
            {detail.status === 'running' && (
              <Button size="sm" variant="outline" data-run-cancel onClick={() => { void controller.cancel(detail.runId) }}>{t('detail.cancel')}</Button>
            )}
            {detail.status !== 'running' && detail.status !== 'success' && detail.status !== 'completed' && (
              <Button size="sm" variant="outline" data-run-resume onClick={() => { void controller.resume(detail.runId) }}>{t('detail.resume')}</Button>
            )}
          </div>
          {detail.inputs !== undefined && Object.keys(detail.inputs).length > 0 && (
            <>
              <h4 className={css.subheading}>{t('detail.inputs')}</h4>
              <ul className={css.plain} data-run-inputs>
                {Object.entries(detail.inputs).map(([key, value]) => (
                  <li key={key} data-run-input data-input-name={key}>{key} = {String(value)}</li>
                ))}
              </ul>
            </>
          )}
          {mapped !== undefined && <runView.NodeList nodes={mapped.nodes} t={runT} />}
          {detail.nodes.some(node => node.hasOutput) && (
            <ul className={css.plain} data-node-outputs>
              {detail.nodes.filter(node => node.hasOutput).map(node => (
                <NodeOutput key={node.nodeId} node={node} output={view.outputs[node.nodeId]} controller={controller} t={t} />
              ))}
            </ul>
          )}
          {mapped !== undefined && mapped.gateReport.length > 0 && (
            <runView.GateReport
              rows={mapped.gateReport}
              open={gateOpen ?? mapped.gateReport.some(row => row.outcome === 'fired-block')}
              onToggle={() => { setGateOpen(!(gateOpen ?? mapped.gateReport.some(row => row.outcome === 'fired-block'))) }}
              t={runT}
            />
          )}
          {detail.approvals.length > 0 && (
            <>
              <h4 className={css.subheading}>{t('detail.approvals')}</h4>
              <ul className={css.plain} data-run-approvals>
                {detail.approvals.map((approval: WorkflowApprovalView) => (
                  <li
                    key={approval.approvalId}
                    className={css.node}
                    data-approval-row
                    data-run-id={detail.runId}
                    data-approval-id={approval.approvalId}
                    data-approval-state={approval.state}
                  >
                    <span>{approval.message}</span>
                    <ApprovalState state={approval.state} t={runT} view={runView} />
                    {approval.reason !== undefined && <span className={css.muted} data-approval-reason>{approval.reason}</span>}
                    {approval.state === 'pending' && <ApprovalActions controller={controller} runId={detail.runId} approvalId={approval.approvalId} t={t} />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}

/**
 * Render the Runs tab.
 * @param props.state - controller snapshot.
 */
export function RunsTab({ controller, state, t, runT, runView }: {
  controller: WorkflowsController
  state: WorkflowsState
  t: T
  runT: WorkflowRunTranslate
  runView: WorkflowRunViewContract
}) {
  const { runs, approvals, detail } = state
  return (
    <div className={css.split} data-workflows-tab-panel="runs">
      <aside className={css.sidebar}>
        <div className={css.sectionHead}>
          <h3 className={css.heading}>{t('approvals.heading')}</h3>
        </div>
        {approvals.failure !== undefined && <FailureNotice failure={approvals.failure} scope="approvals" t={t} />}
        {approvals.status === 'ready' && approvals.items.length === 0 && <p className={css.muted} data-approvals-empty>{t('approvals.empty')}</p>}
        <ul className={css.plain} data-pending-approvals>
          {approvals.items.map(approval => (
            <li key={approval.approvalId} className={css.node} data-approval-row data-run-id={approval.runId} data-approval-id={approval.approvalId} data-approval-state="pending">
              <span className={css.muted}>{approval.runId} · {approval.nodeId}</span>
              <span data-approval-message>{approval.message}</span>
              <ApprovalActions controller={controller} runId={approval.runId} approvalId={approval.approvalId} t={t} />
            </li>
          ))}
        </ul>
        <div className={css.sectionHead}>
          <h3 className={css.heading}>{t('runs.heading')}</h3>
          <button type="button" className={css.linkButton} data-runs-refresh onClick={() => { void controller.loadRuns() }}>{t('runs.refresh')}</button>
        </div>
        {runs.failure !== undefined && <FailureNotice failure={runs.failure} scope="runs" t={t} />}
        {runs.status === 'loading' && runs.items.length === 0 && <p className={css.muted} data-runs-loading>{t('runs.loading')}</p>}
        {runs.status === 'ready' && runs.items.length === 0 && <p className={css.muted} data-runs-empty>{t('runs.empty')}</p>}
        <ul className={css.rows} data-run-list>
          {runs.items.map(run => (
            <li key={run.runId}>
              <button
                type="button"
                className={css.row}
                data-run-row
                data-run-id={run.runId}
                data-run-name={run.name}
                data-run-status={run.status}
                data-selected={detail?.runId === run.runId ? 'true' : 'false'}
                onClick={() => { void controller.openRun(run.runId) }}
              >
                <span className={css.rowTitle}>{run.name}</span>
                <span>{statusLabel(t, run.status)}</span>
                <span className={css.muted}>{t('runs.startedAt', { time: new Date(run.startedAt).toLocaleString() })}</span>
              </button>
            </li>
          ))}
        </ul>
        {runs.nextCursor !== undefined && (
          <button type="button" className={css.linkButton} data-runs-more onClick={() => { void controller.loadMoreRuns() }}>{t('runs.more')}</button>
        )}
      </aside>
      <section className={css.main}>
        {state.actionFailure !== undefined && (
          <FailureNotice failure={state.actionFailure} scope="action" t={t} onDismiss={() => { controller.dismissActionFailure() }} />
        )}
        {detail === null
          ? null
          : <RunDetail key={detail.runId} controller={controller} view={detail} t={t} runT={runT} runView={runView} />}
      </section>
    </div>
  )
}

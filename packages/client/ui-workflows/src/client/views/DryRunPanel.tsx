/** Dry-run view: the plan, the gate manifest, every shell command, and the trust confirmation flow. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { WORKFLOW_LAYOUT } from '@deepseek-ai/dsh-workflow-remote/client'
import type { WorkflowDryRunOk, WorkflowInputSpec, WorkflowInputValue } from '@deepseek-ai/dsh-workflow-remote/client'
import type { DryRunView, WorkflowsController } from '../controller.ts'
import css from '../Workflows.module.css'
import { FailureNotice } from './shared.tsx'
import type { T } from './shared.tsx'

function InputField({ spec, value, onChange, t }: {
  spec: WorkflowInputSpec
  value: WorkflowInputValue | undefined
  onChange: (value: WorkflowInputValue | undefined) => void
  t: T
}) {
  const label = `${spec.name}${spec.required ? ` (${t('dryrun.required')})` : ''}`
  return (
    <label className={css.inputField} data-input-field data-input-name={spec.name}>
      <span>{label}</span>
      {spec.type === 'boolean'
        ? (
          <input
            type="checkbox"
            data-input-control
            checked={value === true}
            onChange={(event) => { onChange(event.target.checked) }}
          />
        )
        : (
          <input
            className={css.textInput}
            data-input-control
            type={spec.type === 'number' ? 'number' : 'text'}
            placeholder={spec.default === undefined ? '' : String(spec.default)}
            value={value === undefined ? '' : String(value)}
            onChange={(event) => {
              const raw = event.target.value
              if (raw === '') onChange(undefined)
              else onChange(spec.type === 'number' ? Number(raw) : raw)
            }}
          />
        )}
      {spec.description !== undefined && <span className={css.muted}>{spec.description}</span>}
    </label>
  )
}

/** The dependency graph drawn from the Host's layered layout; edges are plain SVG lines. */
function PlanGraph({ plan, t }: { plan: WorkflowDryRunOk; t: T }) {
  const { positions, width, height } = plan.layout
  const { nodeW, nodeH } = WORKFLOW_LAYOUT
  const center = (id: string, dx: number): { x: number; y: number } | undefined => {
    const at = positions[id]
    return at === undefined ? undefined : { x: at.x + dx, y: at.y + nodeH / 2 }
  }
  return (
    <div className={css.graphScroll} data-plan-graph aria-label={t('dryrun.graph')}>
      <div className={css.graph} style={{ width: width + nodeW, height: height + nodeH }}>
        <svg className={css.graphEdges} width={width + nodeW} height={height + nodeH} aria-hidden="true">
          {plan.graph.edges.map((edge) => {
            const from = center(edge.from, nodeW)
            const to = center(edge.to, 0)
            return from === undefined || to === undefined
              ? null
              : (
                <line
                  key={`${edge.from}>${edge.to}`}
                  data-graph-edge
                  data-from={edge.from}
                  data-to={edge.to}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                />
              )
          })}
        </svg>
        {plan.graph.nodes.map((node) => {
          const at = positions[node.id]
          return (
            <div
              key={node.id}
              className={css.graphNode}
              style={{ left: at?.x ?? 0, top: at?.y ?? 0, width: nodeW, height: nodeH }}
              data-graph-node
              data-node-id={node.id}
              data-node-kind={node.kind}
              data-node-gate={node.gate ? 'true' : 'false'}
              data-layer={node.layer}
            >
              <strong>{node.label}</strong>
              <span className={css.muted}>{node.kind}{node.gate ? ' · gate' : ''}{node.tier === undefined ? '' : ` · ${node.tier}`}</span>
              {node.when !== undefined && <code className={css.mono} data-node-when>{node.when}</code>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PlanDetails({ plan, t }: { plan: WorkflowDryRunOk; t: T }) {
  return (
    <>
      <h4 className={css.subheading}>{t('dryrun.plan')}</h4>
      <ol className={css.planList} data-plan-list>
        {plan.plan.map(id => <li key={id} data-plan-node data-node-id={id}>{id}</li>)}
      </ol>
      <PlanGraph plan={plan} t={t} />
      <h4 className={css.subheading}>{t('dryrun.manifest')}</h4>
      {plan.manifest.length === 0
        ? <p className={css.muted} data-manifest-empty>{t('dryrun.manifestEmpty')}</p>
        : (
          <ul className={css.plain} data-gate-manifest>
            {plan.manifest.map(entry => (
              <li key={`${entry.nodeId}:${entry.gateKind}`} data-gate-entry data-gate-node={entry.nodeId} data-gate-kind={entry.gateKind}>
                {entry.nodeId} · {entry.gateKind}
              </li>
            ))}
          </ul>
        )}
      <h4 className={css.subheading}>{t('dryrun.commands')}</h4>
      {plan.trust.bashCommands.length === 0
        ? <p className={css.muted} data-commands-empty>{t('dryrun.commandsEmpty')}</p>
        : (
          <ul className={css.plain} data-trust-commands>
            {plan.trust.bashCommands.map((command, index) => (
              <li key={`${command.nodeId}:${command.field}:${index}`} data-trust-command data-node-id={command.nodeId} data-command-field={command.field}>
                <span className={css.muted}>{command.nodeId} · {command.field}</span>
                <pre className={css.pre} data-command>{command.command}</pre>
                {command.workdir !== undefined && <span className={css.muted}>{t('dryrun.workdir', { workdir: command.workdir })}</span>}
                {command.envKeys.length > 0 && <span className={css.muted}>{t('dryrun.env', { keys: command.envKeys.join(', ') })}</span>}
              </li>
            ))}
          </ul>
        )}
      {plan.trust.agents.length > 0 && (
        <>
          <h4 className={css.subheading}>{t('dryrun.agents')}</h4>
          <ul className={css.plain} data-trust-agents>
            {plan.trust.agents.map(agent => (
              <li key={agent.nodeId} data-trust-agent data-node-id={agent.nodeId}>
                {[agent.nodeId, agent.tier, agent.model, agent.provider].filter(part => part !== undefined).join(' · ')}
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.trust.promptFiles.length > 0 && (
        <>
          <h4 className={css.subheading}>{t('dryrun.promptFiles')}</h4>
          <ul className={css.plain} data-trust-prompt-files>
            {plan.trust.promptFiles.map(file => <li key={file}>{file}</li>)}
          </ul>
        </>
      )}
      {plan.trust.approvalNodes > 0 && <p className={css.muted} data-trust-approvals>{t('dryrun.approvals', { count: plan.trust.approvalNodes })}</p>}
      {plan.warnings.length > 0 && (
        <>
          <h4 className={css.subheading}>{t('dryrun.warnings')}</h4>
          <ul className={css.plain} data-plan-warnings>
            {plan.warnings.map((warning, index) => (
              <li key={`${warning.code}:${warning.line}:${index}`} data-plan-warning>{warning.line}:{warning.column} {warning.message}</li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * Render the dry-run view and its trust flow.
 * @param props.dryRun - the plan state.
 * @param props.inputs - declared inputs from the last validation.
 */
export function DryRunPanel({ controller, dryRun, inputs, t }: {
  controller: WorkflowsController
  dryRun: DryRunView
  inputs: readonly WorkflowInputSpec[]
  t: T
}) {
  const [ack, setAck] = useState(false)
  const plan = dryRun.plan
  const untrusted = plan !== undefined && !plan.trusted
  return (
    <section className={css.dryrun} data-dryrun-view data-dryrun-status={dryRun.status}>
      <div className={css.sectionHead}>
        <h3 className={css.heading}>{t('dryrun.heading')}</h3>
        <span>
          <button type="button" className={css.linkButton} data-dryrun-refresh onClick={() => { setAck(false); void controller.dryRun() }}>{t('dryrun.refresh')}</button>
          <button type="button" className={css.linkButton} data-dryrun-close onClick={() => { controller.closeDryRun() }}>{t('dryrun.close')}</button>
        </span>
      </div>
      {inputs.length > 0 && (
        <fieldset className={css.inputs} data-dryrun-inputs>
          <legend>{t('dryrun.inputs')}</legend>
          {inputs.map(spec => (
            <InputField
              key={spec.name}
              spec={spec}
              value={dryRun.inputValues[spec.name]}
              onChange={(value) => { controller.setInput(spec.name, value) }}
              t={t}
            />
          ))}
        </fieldset>
      )}
      {dryRun.status === 'loading' && <p className={css.muted} data-dryrun-loading>{t('dryrun.loading')}</p>}
      {dryRun.failure !== undefined && <FailureNotice failure={dryRun.failure} scope="dryrun" t={t} />}
      {dryRun.stale && <p className={css.warn} role="status" data-dryrun-stale>{t('dryrun.stale')}</p>}
      {plan !== undefined && (
        <>
          <PlanDetails plan={plan} t={t} />
          <div className={css.trust} data-trust-state={plan.trusted ? 'trusted' : 'untrusted'}>
            <p data-trust-summary>{plan.trusted ? t('dryrun.trusted') : t('dryrun.untrusted')}</p>
            {untrusted && plan.confirmText !== undefined && (
              <>
                <h4 className={css.subheading}>{t('dryrun.confirmText')}</h4>
                <pre className={css.pre} data-confirm-text>{plan.confirmText}</pre>
              </>
            )}
            {untrusted && (
              <label className={css.ack}>
                <input
                  type="checkbox"
                  data-trust-ack
                  checked={ack}
                  disabled={dryRun.spent}
                  onChange={(event) => { setAck(event.target.checked) }}
                />
                <span>{t('dryrun.ack')}</span>
              </label>
            )}
            {dryRun.spent && <p className={css.warn} role="status" data-trust-spent>{t('dryrun.spent')}</p>}
            {dryRun.startFailure !== undefined && <FailureNotice failure={dryRun.startFailure} scope="run" t={t} />}
            {dryRun.startedRunId !== undefined && <p className={css.ok} role="status" data-run-started data-run-id={dryRun.startedRunId}>{t('dryrun.started', { runId: dryRun.startedRunId })}</p>}
            <Button
              variant="primary"
              size="sm"
              data-run-start
              data-trust-run={untrusted ? 'true' : 'false'}
              disabled={dryRun.starting || dryRun.stale || dryRun.spent || (untrusted && !ack)}
              onClick={() => { void controller.startRun(ack) }}
            >
              {untrusted ? t('dryrun.trustRun') : t('dryrun.run')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

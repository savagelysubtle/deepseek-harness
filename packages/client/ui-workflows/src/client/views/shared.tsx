/** Small pieces every Workflows view shares: the failure notice, status labels, and the controller hook. */
import { useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiFailure } from '../api.ts'
import type { WorkflowsController, WorkflowsState } from '../controller.ts'
import css from '../Workflows.module.css'

/** The bound translate seat of the `workflows` namespace. */
export type T = PropsLocale<'workflows'>['t']

/**
 * Subscribe a component to the controller's snapshot.
 * @param controller - the overlay's controller.
 * @returns the current snapshot.
 */
export function useWorkflows(controller: WorkflowsController): WorkflowsState {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
}

/**
 * A failure shown in full: what happened, and what to do. A refusal is never a bare status code.
 * @param props.failure - the failure to show.
 * @param props.scope - stable pilot selector for where the failure belongs.
 * @param props.onDismiss - when given, shows a dismiss button.
 */
export function FailureNotice({ failure, scope, t, onDismiss }: {
  failure: UiFailure
  scope: string
  t: T
  onDismiss?: () => void
}) {
  const remedy = failure.remedy ?? (failure.loopbackOnly === true ? t('failure.loopbackRemedy') : undefined)
  return (
    <div className={css.failure} role="alert" data-failure data-failure-scope={scope} data-failure-code={failure.error}>
      <span data-failure-message>{failure.message}</span>
      {remedy !== undefined && <span className={css.remedy} data-failure-remedy>{t('failure.remedy', { remedy })}</span>}
      {onDismiss !== undefined && (
        <button type="button" className={css.linkButton} data-failure-dismiss onClick={onDismiss}>{t('failure.dismiss')}</button>
      )}
    </div>
  )
}

const KNOWN_STATUS = new Set([
  'running', 'success', 'completed', 'failed', 'skipped', 'cancelled', 'cancelling', 'interrupted',
])

/**
 * Localize a run or node status; an unknown token passes through verbatim.
 * @param t - translate seat.
 * @param status - Host status token.
 * @returns display text.
 */
export function statusLabel(t: T, status: string): string {
  return KNOWN_STATUS.has(status) ? t(`status.${status}` as 'status.running') : status
}

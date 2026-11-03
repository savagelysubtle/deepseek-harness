/** Workflows overlay: the panel registered into `shell.overlay`. Owns the controller (and so the lease) for as long as it is open. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkflowsController } from './controller.ts'
import type { WorkflowsFace } from './store.ts'
import css from './Workflows.module.css'
import { LeaseIndicator } from './views/LeaseIndicator.tsx'
import { RunsTab } from './views/RunsTab.tsx'
import { useWorkflows } from './views/shared.tsx'
import { WorkflowsTab } from './views/WorkflowsTab.tsx'

/** Full component props: the injected face and the bound locale seat. */
export type WorkflowsOverlayProps = InjectFace<WorkflowsFace> & PropsLocale<'workflows'>

function Panel({ controller, t, runT, runView }: {
  controller: WorkflowsController
  t: WorkflowsOverlayProps['t']
  runT: WorkflowsOverlayProps['runT']
  runView: WorkflowsOverlayProps['runView']
}) {
  const state = useWorkflows(controller)
  const pending = state.approvals.items.length
  return (
    <div className={css.panel} data-workflows-overlay data-workflows-tab={state.tab}>
      <div className={css.header}>
        <LeaseIndicator lease={state.lease} t={t} />
        <div className={css.tabs} role="tablist">
          <Pill active={state.tab === 'workflows'} role="tab" aria-selected={state.tab === 'workflows'} data-workflows-tab-button="workflows" onClick={() => { controller.setTab('workflows') }}>
            {t('tab.workflows')}
          </Pill>
          <Pill active={state.tab === 'runs'} role="tab" aria-selected={state.tab === 'runs'} data-workflows-tab-button="runs" onClick={() => { controller.setTab('runs') }}>
            {t('tab.runs')}
          </Pill>
          {pending > 0 && <span className={css.badgeBad} data-pending-approvals-count={pending}>{t('pending.count', { count: pending })}</span>}
        </div>
      </div>
      {state.tab === 'workflows'
        ? <WorkflowsTab controller={controller} state={state} t={t} />
        : <RunsTab controller={controller} state={state} t={t} runT={runT} runView={runView} />}
    </div>
  )
}

/**
 * Render the Workflows panel while the shared store says it is open. The controller exists exactly
 * while the overlay is open: opening attaches the live-approvals lease and closing (or unmounting)
 * releases it.
 * @param props - the shared overlay store, API factory, event source, and the bound `t`.
 */
export function WorkflowsOverlay({ overlay, createApi, events, runT, runView, t }: WorkflowsOverlayProps) {
  const { open, sessionId } = useSyncExternalStore(overlay.subscribe, overlay.getSnapshot)
  const [controller, setController] = useState<WorkflowsController | null>(null)
  useEffect(() => {
    if (!open || sessionId === null) return undefined
    const next = new WorkflowsController(createApi(sessionId), events)
    setController(next)
    next.start()
    return () => {
      next.dispose()
      setController(null)
    }
  }, [open, sessionId, createApi, events])
  return (
    <Modal open={open} onClose={() => { overlay.close() }} title={t('title')} closeLabel={t('close')} className={css.modal}>
      {controller !== null && <Panel controller={controller} t={t} runT={runT} runView={runView} />}
    </Modal>
  )
}

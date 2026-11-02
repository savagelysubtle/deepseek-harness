/** Workflows overlay: the placeholder panel registered into `shell.overlay`. */
import { useSyncExternalStore } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowsFace } from './store.ts'
import css from './Workflows.module.css'

/** Full component props: the injected face and the bound locale seat. */
export type WorkflowsOverlayProps = InjectFace<WorkflowsFace> & PropsLocale<'workflows'>

/**
 * Render the Workflows panel while the shared store says it is open.
 * @param props - the shared overlay store and the bound `t`.
 */
export function WorkflowsOverlay({ overlay, t }: WorkflowsOverlayProps) {
  const open = useSyncExternalStore(overlay.subscribe, overlay.getSnapshot)
  return (
    <Modal open={open} onClose={() => { overlay.setOpen(false) }} title={t('title')}>
      <div className={css.panel} data-workflows-overlay>
        <p className={css.placeholder}>{t('placeholder')}</p>
      </div>
    </Modal>
  )
}

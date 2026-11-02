/** Session-header Workflows control: a button that opens the Workflows overlay. */
import { useSyncExternalStore } from 'react'
import { IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowsFace } from './store.ts'
import css from './Workflows.module.css'

/** Full component props: the injected face and the bound locale seat. */
export type WorkflowsControlProps = InjectFace<WorkflowsFace> & PropsLocale<'workflows'>

/**
 * Render the Workflows trigger.
 * @param props - the shared overlay store and the bound `t`.
 */
export function WorkflowsControl({ overlay, t }: WorkflowsControlProps) {
  const open = useSyncExternalStore(overlay.subscribe, overlay.getSnapshot)
  const label = t('trigger')
  return (
    <div className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-label={label}
        aria-expanded={open}
        title={label}
        data-workflows-button
        onClick={() => { overlay.setOpen(true) }}
      >
        <IconListPenOutline16 size={16} />
        <span className={css.label}>{label}</span>
      </button>
    </div>
  )
}

/**
 * Sidebar-foot Org Board control (SWD-134 slice 2): opens a large modal
 * showing the org registry as a node graph. Read-only — the one verb this
 * control exposes is `load` (issue `org.get` again), never a mutation.
 * `org.get` is (re-)issued whenever the modal opens, so it never reads stale
 * data from before the modal was last shown.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, IconBranchOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { OrgBoardFace } from './slots.ts'
import { OrgBoard } from './OrgBoard.tsx'
import css from './OrgBoard.module.css'

/** Full component props: the footer-action runtime share, the live verb + snapshot, and the bound locale seat. */
export type OrgBoardControlProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<OrgBoardFace> & PropsLocale<'orgBoard'>

/**
 * Render the Org Board trigger and its modal.
 * @param props - runtime share, `useOrgBoard`/`load`, the five edit verbs
 * forwarded to the board, and the bound `t`.
 */
export function OrgBoardControl({
  wide, useOrgBoard, load, addSeat, removeSeat, addEdge, removeEdge, setSeatTools, setSeatServed, t,
}: OrgBoardControlProps) {
  const [open, setOpen] = useState(false)
  const state = useOrgBoard(snapshot => snapshot)

  useEffect(() => {
    if (!open) return
    void load()
    // Intentionally re-fires on every open (not once ever): a stale board
    // from a previous open is exactly the "clean board that is actually
    // wrong" failure mode this slice exists to avoid.
  }, [open, load])

  const triggerLabel = t('trigger')

  return (
    <div className={wide ? css.root : `${css.root} ${css.rail}`}>
      <button
        type="button"
        className={css.trigger}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => { setOpen(true) }}
      >
        <IconBranchOutline16 size={wide ? 16 : 18} />
        {wide && <span className={css.label}>{triggerLabel}</span>}
      </button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('modal.title')}
        className={clsx(css.dialog)}
      >
        <div className={css.refreshRow}>
          <Button
            variant="ghost"
            size="sm"
            disabled={state.status === 'loading'}
            onClick={() => { void load() }}
          >
            {t('refresh')}
          </Button>
        </div>
        <OrgBoard
          state={state}
          t={t}
          addSeat={addSeat}
          removeSeat={removeSeat}
          addEdge={addEdge}
          removeEdge={removeEdge}
          setSeatTools={setSeatTools}
          setSeatServed={setSeatServed}
        />
      </Modal>
    </div>
  )
}

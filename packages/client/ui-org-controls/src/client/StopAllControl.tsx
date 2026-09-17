/**
 * Sidebar-foot Stop All control (SWD-130): a confirm-first button that stops
 * every live top-level session and its whole descendant forest in one host
 * call. There was no client surface for `sessions.stopAll` before this
 * package; the RPC already cascaded correctly, the gap was purely the
 * missing button.
 */
import { useState } from 'react'
import { Button, IconStopFill16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { StopAllFace } from './slots.ts'
import css from './OrgControls.module.css'

/** Full component props: the footer-action runtime share, the live verb, and the bound locale seat. */
export type StopAllControlProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<StopAllFace> & PropsLocale<'orgControls'>

/**
 * Outcome banner shown after a Stop All attempt. A dedicated `partial` member
 * (rather than folding `descendants: { failed }` into `success`) is what
 * makes surfacing the failure mandatory: there is no code path that reaches
 * `success` while a descendant cascade failed.
 */
type ResultBanner =
  | { kind: 'success'; count: number }
  | { kind: 'partial'; count: number; reason: string }
  | { kind: 'error'; reason: string }

/**
 * Render the Stop All trigger, its confirm dialog, and a persistent
 * (non-auto-fading) outcome banner.
 * @param props - runtime share, `onStopAll`, and the bound `t`.
 */
export function StopAllControl({ wide, useSessions, onStopAll, t }: StopAllControlProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ResultBanner | undefined>(undefined)

  const runningCount = useSessions(state => state.ids.reduce((count, id) => {
    const row = state.byId[id]
    return row !== undefined && row.running && row.origin !== 'subagent' ? count + 1 : count
  }, 0))
  const disabled = runningCount === 0

  const runStopAll = () => {
    setBusy(true)
    onStopAll().then((answer) => {
      if (!answer.ok) {
        setResult({ kind: 'error', reason: answer.error.message })
      } else if (answer.value.descendants === 'ok') {
        setResult({ kind: 'success', count: answer.value.stoppedCount })
      } else {
        // Founder ruling: a `{ failed }` descendants outcome must surface as
        // a failure, never be swallowed into the stoppedCount success line.
        setResult({ kind: 'partial', count: answer.value.stoppedCount, reason: answer.value.descendants.failed })
      }
    }).catch((error: unknown) => {
      setResult({ kind: 'error', reason: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      setBusy(false)
      setConfirmOpen(false)
    })
  }

  const triggerLabel = disabled ? t('stopAll.trigger.disabledAria') : t('stopAll.trigger')

  return (
    <div className={wide ? css.root : `${css.root} ${css.rail}`}>
      {result !== undefined && (
        <div className={css.banner} data-variant={result.kind} role="alert">
          <span>
            {result.kind === 'success' && t('stopAll.result.success', { count: result.count })}
            {result.kind === 'partial' && t('stopAll.result.partial', { count: result.count, reason: result.reason })}
            {result.kind === 'error' && t('stopAll.result.error', { reason: result.reason })}
          </span>
          <button
            type="button"
            className={css.dismiss}
            aria-label={t('stopAll.result.dismiss')}
            onClick={() => { setResult(undefined) }}
          >
            <span aria-hidden="true">{'×'}</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className={css.trigger}
        disabled={disabled}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => { setConfirmOpen(true) }}
      >
        <IconStopFill16 size={wide ? 16 : 18} />
        {wide && <span className={css.label}>{t('stopAll.trigger')}</span>}
      </button>
      {disabled && (
        // Visible on screen, not just a hover title/aria-label - a fence
        // that removes the ability to drive must say so where it can be
        // seen without hovering to find it.
        <span className={css.disabledReason}>{t('stopAll.trigger.disabledReason')}</span>
      )}
      <Modal
        open={confirmOpen}
        onClose={() => { setConfirmOpen(false) }}
        title={t('stopAll.confirm.title')}
        description={t('stopAll.confirm.description', { count: runningCount })}
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => { setConfirmOpen(false) }}>
              {t('stopAll.confirm.cancel')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={runStopAll}>
              {t('stopAll.confirm.confirm')}
            </Button>
          </>
        )}
      />
    </div>
  )
}

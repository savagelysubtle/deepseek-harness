/**
 * Sidebar-foot Send All control (SWD-131): compose one message and broadcast
 * it to every live top-level session immediately (mid-turn, never queued)
 * via `Agent.steer`. Nothing like this existed before this package — both
 * the host mechanism (`sessions.sendAll`) and this control are new.
 *
 * No separate confirm step, by founder ruling (removing an earlier draft of
 * this control that had one): composing a message is already a deliberate
 * act, and Send All is reached for precisely when something needs to change
 * right now — a second "yes, all of them" gate sitting on the single most
 * urgent path in the app was the wrong trade. Stop All keeps its own
 * confirm; that is unrelated and untouched. The reachable count and the
 * mid-turn-interruption warning that a confirm step would have carried both
 * live in the compose description below instead, so nothing meaningful was
 * lost with the extra click.
 */
import { useState } from 'react'
import { Button, IconSendOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SendAllFace } from './slots.ts'
import css from './OrgControls.module.css'

/** Full component props: the footer-action runtime share, the live verb, and the bound locale seat. */
export type SendAllControlProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<SendAllFace> & PropsLocale<'orgControls'>

/**
 * Outcome banner shown after a Send All attempt. A dedicated `partial`
 * member (rather than folding `result: { failed }` into `success`) is what
 * makes surfacing the failure mandatory: there is no code path that reaches
 * `success` while a recipient failed to receive the message.
 */
type ResultBanner =
  | { kind: 'success'; count: number }
  | { kind: 'partial'; count: number; reason: string }
  | { kind: 'error'; reason: string }

/**
 * Render the Send All trigger, its one-step compose dialog, and a persistent
 * (non-auto-fading) outcome banner.
 * @param props - runtime share, `onSendAll`, and the bound `t`.
 */
export function SendAllControl({ wide, useSessions, onSendAll, t }: SendAllControlProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ResultBanner | undefined>(undefined)

  // `attached` (a live host Agent exists), not `running`: the host's own
  // sendAll root selection reaches an idle-between-turns session exactly as
  // readily as a mid-turn one, and idle roots are most of a broadcast's real
  // audience. Counting `origin !== 'subagent'` alone over-counted cold,
  // never-attached historical rows the host would silently skip — the exact
  // defect this field exists to close (see host SessionSummary.attached doc).
  const rootCount = useSessions(state => state.ids.reduce((count, id) => {
    const row = state.byId[id]
    return row !== undefined && row.origin !== 'subagent' && row.attached ? count + 1 : count
  }, 0))
  const disabled = rootCount === 0

  const close = () => {
    setOpen(false)
    setText('')
  }

  const runSendAll = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    setBusy(true)
    onSendAll([{ type: 'text', text: trimmed }]).then((answer) => {
      if (!answer.ok) {
        setResult({ kind: 'error', reason: answer.error.message })
      } else if (answer.value.result === 'ok') {
        setResult({ kind: 'success', count: answer.value.sentCount })
      } else {
        // Founder ruling: a `{ failed }` result must surface as a failure,
        // never be swallowed into the sentCount success line.
        setResult({ kind: 'partial', count: answer.value.sentCount, reason: answer.value.result.failed })
      }
    }).catch((error: unknown) => {
      setResult({ kind: 'error', reason: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      setBusy(false)
      close()
    })
  }

  const triggerLabel = disabled ? t('sendAll.trigger.disabledAria') : t('sendAll.trigger')
  const trimmed = text.trim()

  return (
    <div className={wide ? css.root : `${css.root} ${css.rail}`}>
      {result !== undefined && (
        <div className={css.banner} data-variant={result.kind} role="alert">
          <span>
            {result.kind === 'success' && t('sendAll.result.success', { count: result.count })}
            {result.kind === 'partial' && t('sendAll.result.partial', { count: result.count, reason: result.reason })}
            {result.kind === 'error' && t('sendAll.result.error', { reason: result.reason })}
          </span>
          <button
            type="button"
            className={css.dismiss}
            aria-label={t('sendAll.result.dismiss')}
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
        onClick={() => { setOpen(true) }}
      >
        <IconSendOutline16 size={wide ? 16 : 18} />
        {wide && <span className={css.label}>{t('sendAll.trigger')}</span>}
      </button>
      {disabled && (
        // Visible on screen, not just a hover title/aria-label - a fence
        // that removes the ability to drive must say so where it can be
        // seen without hovering to find it.
        <span className={css.disabledReason}>{t('sendAll.trigger.disabledReason')}</span>
      )}
      <Modal
        open={open}
        onClose={close}
        title={t('sendAll.compose.title')}
        description={t('sendAll.compose.description', { count: rootCount })}
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={close}>{t('sendAll.compose.cancel')}</Button>
            <Button variant="primary" disabled={busy || trimmed === ''} onClick={runSendAll}>
              {t('sendAll.compose.send')}
            </Button>
          </>
        )}
      >
        <textarea
          className={css.composer}
          value={text}
          placeholder={t('sendAll.compose.placeholder')}
          onChange={(event) => { setText(event.target.value) }}
          autoFocus
        />
      </Modal>
    </div>
  )
}

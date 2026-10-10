/**
 * Tools settings section: one row per registered MCP server, its live
 * connection state as a plain-word badge, and the three actions a server can
 * need — Authorize (OAuth consent), Reconnect (retry after giving up), and
 * an Enable/Disable toggle over the Loader mount. Every rejected action
 * shows loud inline failure text in its own row; nothing fails silently.
 */

import { useId, useState, type ReactNode } from 'react'
import type { McpServerState, McpServerStatus } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconRefreshOutline16, RiskConfirmation, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { McpToolsStore, ToolsSettingsState } from './store.ts'
import { messageOf } from './store.ts'
import type { ToolsLocaleKey } from './locales.ts'
import css from './ToolsSection.module.css'

/** Translate a dictionary key of this section's namespace. */
export type ToolsTranslate = (key: ToolsLocaleKey) => string

/** Registration-side business face for the section. */
export interface ToolsSectionInjected {
  /** The page store (loaded on mount and Refresh; folds `mcp/status-changed` pushes). */
  controller: McpToolsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<ToolsSettingsState>
  /** Begin (or resume) OAuth consent for one server; resolves with the consent URL. */
  authorize: (serverName: string) => Promise<string>
  /** Manually retry a given-up server now. */
  reconnect: (serverName: string) => Promise<void>
  /** Persist one server's Loader-mount enabled flag. */
  setEnabled: (serverName: string, enabled: boolean) => Promise<void>
  /** Section copy. */
  t: ToolsTranslate
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type ToolsSectionProps = Partial<ToolsSectionInjected>

/**
 * Visual family {@link StateDot} renders for a server state; `disabled`
 * omits the dot entirely (precedent: ui-settings-plugin-inventory).
 */
const STATE_DOT: Partial<Record<McpServerState, 'done' | 'warning' | 'ongoing' | 'error'>> = {
  connected: 'done',
  connecting: 'ongoing',
  'needs-authorization': 'warning',
  'gave-up': 'error',
}

/** Locale key for one server state's plain-word badge. */
const STATE_LABEL_KEYS = {
  connected: 'stateConnected',
  connecting: 'stateConnecting',
  'needs-authorization': 'stateNeedsAuthorization',
  'gave-up': 'stateGaveUp',
  disabled: 'stateDisabled',
} satisfies Record<McpServerState, ToolsLocaleKey>

/** Localized plain-word label for one server's current state, with the gave-up attempt count substituted. */
function stateLabel(status: McpServerStatus, t: ToolsTranslate): string {
  const label = t(STATE_LABEL_KEYS[status.state])
  return status.state === 'gave-up' ? label.replace('{attempts}', String(status.attempts)) : label
}

/**
 * Render the Tools section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ToolsSection(props: ToolsSectionProps): ReactNode {
  const { controller, useSnapshot, authorize, reconnect, setEnabled, t } = props
  if (controller === undefined || useSnapshot === undefined || authorize === undefined
    || reconnect === undefined || setEnabled === undefined || t === undefined) return null
  return (
    <Loaded injected={{ controller, useSnapshot, authorize, reconnect, setEnabled, t }} />
  )
}

function Loaded({ injected }: { injected: ToolsSectionInjected }): ReactNode {
  const { controller, authorize, reconnect, setEnabled, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)

  // First mount only: a push or an explicit Refresh carries every later load.
  if (state.status === 'idle') void controller.load()

  return (
    <div className={css.section}>
      <div className={css.heading}>
        <h2 className={css.title}>{t('title')}</h2>
        <button type="button" className={css.refreshButton} onClick={() => { void controller.load() }}>
          <IconRefreshOutline16 size={14} />
          {t('refresh')}
        </button>
      </div>
      <p className={css.intro}>{t('intro')}</p>
      {state.status === 'loading' && state.rows.length === 0 ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" className={css.secondaryButton} onClick={() => { void controller.load() }}>
            {t('retry')}
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && state.rows.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
      {state.rows.length > 0 ? (
        <ul className={css.rows}>
          {state.rows.map(row => (
            <ServerRow
              key={row.serverName}
              status={row}
              authorize={authorize}
              reconnect={reconnect}
              setEnabled={setEnabled}
              t={t}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

interface ServerRowProps {
  status: McpServerStatus
  authorize: (serverName: string) => Promise<string>
  reconnect: (serverName: string) => Promise<void>
  setEnabled: (serverName: string, enabled: boolean) => Promise<void>
  t: ToolsTranslate
}

/** One MCP server row: state badge, last-error text, and its available actions. */
function ServerRow({ status, authorize, reconnect, setEnabled, t }: ServerRowProps): ReactNode {
  const headingId = useId()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [confirmingDisable, setConfirmingDisable] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const dot = STATE_DOT[status.state]
  const label = stateLabel(status, t)
  const canAuthorize = status.state === 'needs-authorization' || status.state === 'gave-up'
  const canReconnect = status.state === 'gave-up'
  const disabled = status.state === 'disabled'

  const onAuthorize = (): void => {
    setActionError(undefined)
    // Synchronous, inside the click handler, before any await: a tab opened
    // after an await loses the user-gesture token and browsers block it.
    // The 'noopener' feature makes `window.open` itself return null (the
    // opener relationship — and the handle to the new window — is what it
    // severs), so a real handle needs the feature left off; the opener is
    // severed by hand instead, immediately, while the tab is still the
    // same-origin 'about:blank' (before it ever navigates cross-origin).
    const tab = window.open('about:blank', '_blank')
    if (tab === null) {
      setActionError(t('popupBlocked'))
      return
    }
    tab.opener = null
    setBusy(true)
    authorize(status.serverName).then(
      (url) => {
        tab.location.href = url
        setBusy(false)
      },
      (error: unknown) => {
        tab.close()
        setBusy(false)
        setActionError(messageOf(error))
      },
    )
  }

  const onReconnect = (): void => {
    setActionError(undefined)
    setBusy(true)
    reconnect(status.serverName).then(
      () => { setBusy(false) },
      (error: unknown) => {
        setBusy(false)
        setActionError(messageOf(error))
      },
    )
  }

  const onEnable = (): void => {
    setActionError(undefined)
    setBusy(true)
    setEnabled(status.serverName, true).then(
      () => { setBusy(false) },
      (error: unknown) => {
        setBusy(false)
        setActionError(messageOf(error))
      },
    )
  }

  const closeDisableConfirm = (): void => {
    if (busy) return
    setConfirmingDisable(false)
    setAcknowledged(false)
  }

  const confirmDisable = (): void => {
    setActionError(undefined)
    setBusy(true)
    setEnabled(status.serverName, false).then(
      () => {
        setBusy(false)
        setConfirmingDisable(false)
        setAcknowledged(false)
      },
      (error: unknown) => {
        setBusy(false)
        setActionError(messageOf(error))
      },
    )
  }

  return (
    <li className={css.row}>
      <div className={css.rowHead}>
        <span className={css.identity}>
          {dot !== undefined ? <StateDot state={dot} /> : null}
          <strong id={headingId} className={css.serverName}>{status.serverName}</strong>
          <span className={css.stateTag} data-state={status.state}>{label}</span>
        </span>
        <span className={css.actions}>
          {canAuthorize ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onAuthorize}>
              {t('authorize')}
            </Button>
          ) : null}
          {canReconnect ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onReconnect}>
              {t('reconnect')}
            </Button>
          ) : null}
          {disabled ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onEnable}>
              {t('enable')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setActionError(undefined)
                setAcknowledged(false)
                setConfirmingDisable(true)
              }}
            >
              {t('disable')}
            </Button>
          )}
        </span>
      </div>
      {status.lastError !== undefined ? (
        <p className={css.lastError}>{`${t('lastError')}: ${status.lastError}`}</p>
      ) : null}
      {actionError !== undefined ? <p className={css.error} role="alert">{actionError}</p> : null}
      <RiskConfirmation
        open={confirmingDisable}
        title={t('disableConfirmTitle')}
        description={t('disableConfirmDescription')}
        acknowledgeLabel={t('disableConfirmAcknowledge')}
        cancelLabel={t('disableConfirmCancel')}
        confirmLabel={busy ? t('disabling') : t('disableConfirmConfirm')}
        acknowledged={acknowledged}
        disabled={busy}
        onAcknowledgedChange={setAcknowledged}
        onCancel={closeDisableConfirm}
        onConfirm={confirmDisable}
      />
    </li>
  )
}

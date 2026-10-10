/**
 * Small in-chat notice: when any configured MCP server is stuck in
 * `needs-authorization` or has `gave-up` reconnecting, name it above the
 * composer with a link into Settings. Same strip/dismiss shape as
 * InputBar's founderNotice, but mounted in ConversationRoot instead of the
 * per-session composer bar — the fact it names is Host-wide, not
 * per-conversation (see `../mcp-status-store.ts`).
 */
import { useState } from 'react'
import { IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationSlotProps } from '../contract/slots.ts'
import type { McpAttentionStatus } from '../mcp-status-store.ts'
import css from './ToolsStatusBanner.module.css'

export interface ToolsStatusBannerProps {
  servers: readonly McpAttentionStatus[]
  /** Open Settings directly on one registered section; the banner always passes `'tools'`. */
  openSettingsSection: (sectionId: string) => void
  t: ConversationSlotProps['t']
}

/** Comma-joined server names for one locale interpolation slot. */
function names(servers: readonly McpAttentionStatus[]): string {
  return servers.map(s => s.serverName).join(', ')
}

/**
 * Render the Tools attention banner, or nothing while every server is quiet.
 * @param props - affected servers, the Settings-open callback, and the locale seat.
 * @returns the banner element, or null when `servers` is empty.
 */
export function ToolsStatusBanner({ servers, openSettingsSection, t }: ToolsStatusBannerProps) {
  // Dismissed by value, not by a boolean latch: a dismissal's signature is
  // the exact affected-name set it was shown for (founderNotice's object-
  // identity precedent, restated for a derived list). A later status change
  // that produces a different set compares unequal and the banner reopens;
  // the SAME set never does, satisfying "dismissable until the state changes".
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null)
  const signature = servers.map(s => `${s.serverName}:${s.state}`).sort().join('|')

  if (servers.length === 0 || signature === dismissedSignature) return null

  const needsAuth = servers.filter(s => s.state === 'needs-authorization')
  const gaveUp = servers.filter(s => s.state === 'gave-up')
  const clauses = [
    ...(needsAuth.length > 0 ? [t('tools.needsAuthorization', { names: names(needsAuth) })] : []),
    ...(gaveUp.length > 0 ? [t('tools.gaveUp', { names: names(gaveUp) })] : []),
  ]

  return (
    <div className={css.banner} role="status" data-tools-status-banner="">
      <IconWarningOutline16 className={css.icon} />
      <span className={css.text}>{clauses.join(' ')}</span>
      <button type="button" className={css.action} onClick={() => { openSettingsSection('tools') }}>
        {t('tools.openSettings')}
      </button>
      <button
        type="button"
        className={css.dismiss}
        aria-label={t('tools.dismiss')}
        onClick={() => { setDismissedSignature(signature) }}
      >
        <span aria-hidden="true">{'×'}</span>
      </button>
    </div>
  )
}

/**
 * Tools settings section, browser half: one Settings nav row (sibling of
 * `models`/`agent-presets`/`plugins`) listing every registered MCP server's
 * live connection status, with Authorize/Reconnect/Enable-Disable actions
 * over the Host's `mcp` Remote namespace (`@deepseek-ai/dsh-mcp-status`'s
 * status registry, mounted centrally by `@deepseek-ai/dsh-api-remotes`).
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.remote Context merge, the forwarded-event key face
// ('mcp/status-changed' is in the allowlist), and the mcp namespace's own
// generated Remote shape (McpServerStatus / McpAuthorizeStartResult).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { ToolsSection } from './ToolsSection.tsx'
import type { ToolsSectionInjected } from './ToolsSection.tsx'
import { McpToolsStore } from './store.ts'
import { en, zh } from './locales.ts'

export type { ToolsSectionInjected, ToolsSectionProps, ToolsTranslate } from './ToolsSection.tsx'
export type { McpToolsStore, ToolsSettingsState } from './store.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.tools'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Tools settings section copy. */
    'settings.tools': import('./locales.ts').ToolsLocaleKey
  }
}

/** Required services (cordis fiber inject). Waits specifically on the `mcp` Remote namespace, not just any `remote` mount. */
export const inject = ['slots', 'locale', 'remote', 'remote.mcp']

/**
 * Register the Tools section once the `settings.section` declaration is on
 * the ledger, wire its store to the Host's `mcp` Remote namespace, and keep
 * it live on every `mcp/status-changed` push.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-tools: section dictionaries')

  const controller = new McpToolsStore({
    status: async () => {
      const result = await ctx.remote.mcp.status()
      if (!result.ok) throw new Error(`mcp.status failed: ${result.error.code}: ${result.error.message}`)
      return result.value
    },
  })
  const useSnapshot = bindSnapshotSelector(controller.store)

  const authorize = async (serverName: string): Promise<string> => {
    const result = await ctx.remote.mcp['authorize-start'](serverName)
    if (!result.ok) throw new Error(`mcp.authorize-start failed: ${result.error.code}: ${result.error.message}`)
    return result.value.consentUrl
  }
  const reconnect = async (serverName: string): Promise<void> => {
    const result = await ctx.remote.mcp.reconnect(serverName)
    if (!result.ok) throw new Error(`mcp.reconnect failed: ${result.error.code}: ${result.error.message}`)
  }
  const setEnabled = async (serverName: string, enabled: boolean): Promise<void> => {
    const result = await ctx.remote.mcp['set-enabled'](serverName, enabled)
    if (!result.ok) throw new Error(`mcp.set-enabled failed: ${result.error.code}: ${result.error.message}`)
  }

  // Live update: fold each push straight into the roster without a reload.
  ctx.effect(
    () => ctx.remote.$on('mcp/status-changed', (status) => { controller.applyStatus(status) }),
    'ui-settings-tools: live status updates',
  )

  const t = ctx.locale.bind(NS) as ToolsSectionInjected['t']
  const injected = (): ToolsSectionInjected => ({
    controller, useSnapshot, authorize, reconnect, setEnabled, t,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'tools',
    order: 25,
    label: () => t('nav'),
    inject: injected,
  }, ToolsSection))
}

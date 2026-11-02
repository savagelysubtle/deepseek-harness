/**
 * Browser Workflows surface: one button in the conversation session header's
 * `conversation.session.header.actions` list (after the org board) that opens a `shell.overlay`
 * entry. This revision is the scaffold: the overlay shows a placeholder panel; the workflow
 * list, graph, editor, and run view land in later slices of OP-240 over the Host's `workflow`
 * Remote namespace (`@deepseek-ai/dsh-workflow-remote`).
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.session.header.actions' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the ctx.remote Context merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the graph library the later overlay slices render with (the range ui-org-board uses).
import type {} from '@xyflow/react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { en, NS, zh } from './locales.ts'
import { WorkflowsOverlayStore } from './store.ts'
import type { WorkflowsFace } from './store.ts'
import { WorkflowsControl } from './WorkflowsControl.tsx'
import { WorkflowsOverlay } from './WorkflowsOverlay.tsx'

export type { WorkflowsKey } from './locales.ts'
export type { WorkflowsFace } from './store.ts'
export type { WorkflowsControlProps } from './WorkflowsControl.tsx'
export type { WorkflowsOverlayProps } from './WorkflowsOverlay.tsx'
export { NS } from './locales.ts'
export { VALIDATE_DEBOUNCE_MS, WorkflowEditor } from './editor/WorkflowEditor.tsx'
export type { WorkflowEditorLabels, WorkflowEditorProps } from './editor/WorkflowEditor.tsx'

/** Required services: slots, locale, and the `workflow` Remote namespace (waits specifically on it, not any `remote` mount). */
export const inject = ['slots', 'locale', 'remote', 'remote.workflow']

/**
 * Register the dictionary, the header button, and the overlay entry. Every registration rides
 * the slot service's effect wrapper, so plugin unload removes them.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflows: dictionaries')

  const overlay = new WorkflowsOverlayStore()
  const injected = (): WorkflowsFace => ({ overlay })

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'workflows',
    order: 45,
    locale: NS,
    inject: injected,
  }, WorkflowsControl))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'workflows',
    order: 45,
    locale: NS,
    inject: injected,
  }, WorkflowsOverlay))
}

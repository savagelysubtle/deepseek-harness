/**
 * Browser Workflows surface: one button in the conversation session header's
 * `conversation.session.header.actions` list (after the org board) that opens a `shell.overlay`
 * entry. The overlay lists, edits, validates, dry-runs, runs and supervises YAML workflows over
 * the Host's `workflow` Remote namespace (`@deepseek-ai/dsh-workflow-remote`), holds the
 * live-approvals lease while it is open, and filters pushed events by workspace key.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.session.header.actions' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the 'shell.overlay' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the ctx.remote Context merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the `workflowRun` locale namespace (and its embeddable components) the run detail borrows.
import type {} from '@deepseek-ai/dsh-client-ui-workflow-run/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createWorkflowApi } from './api.ts'
import type { WorkflowEventSource } from './controller.ts'
import { en, NS, zh } from './locales.ts'
import { WorkflowsOverlayStore } from './store.ts'
import type { WorkflowsFace } from './store.ts'
import { WorkflowsControl } from './WorkflowsControl.tsx'
import { WorkflowsOverlay } from './WorkflowsOverlay.tsx'

export type { WorkflowsKey } from './locales.ts'
export { createWorkflowApi, isFailure, transportFailure } from './api.ts'
export type { Outcome, UiFailure, WorkflowApi, WorkflowRemote } from './api.ts'
export { WorkflowsController, workflowTemplate, WORKFLOW_NAME } from './controller.ts'
export type {
  DryRunView, EditorView, LeaseState, LeaseView, Loadable, NodeOutputView, RunDetailView,
  WorkflowEventSource, WorkflowsState, WorkflowsTab,
} from './controller.ts'
export { WorkflowsOverlayStore } from './store.ts'
export type { OverlayState } from './store.ts'
export type { WorkflowsFace } from './store.ts'
export type { WorkflowsControlProps } from './WorkflowsControl.tsx'
export type { WorkflowsOverlayProps } from './WorkflowsOverlay.tsx'
export { NS } from './locales.ts'
export { VALIDATE_DEBOUNCE_MS, WorkflowEditor } from './editor/WorkflowEditor.tsx'
export type { WorkflowEditorLabels, WorkflowEditorProps } from './editor/WorkflowEditor.tsx'

/** Required services: slots, locale, and the `workflow` Remote namespace (waits specifically on it, not any `remote` mount). */
export const inject = ['slots', 'locale', 'remote', 'remote.workflow', 'workflowRunView']

/**
 * Register the dictionary, the header button, and the overlay entry. Every registration rides
 * the slot service's effect wrapper, so plugin unload removes them.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflows: dictionaries')

  const overlay = new WorkflowsOverlayStore()
  const events: WorkflowEventSource = {
    subscribe: (handlers) => {
      const disposers = [
        ctx.remote.$on('workflow/run-changed', (change) => { handlers.runChanged(change) }),
        ctx.remote.$on('workflow/approval-pending', (approval) => { handlers.approvalPending(approval) }),
        ctx.remote.$on('workflow/approval-decided', (decision) => { handlers.approvalDecided(decision) }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    },
  }
  const createApi = (sessionId: SessionId) => createWorkflowApi(ctx.remote.workflow, sessionId)
  const injected = (): WorkflowsFace => ({ overlay, createApi, events, runT: ctx.locale.bind('workflowRun'), runView: ctx.workflowRunView })

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

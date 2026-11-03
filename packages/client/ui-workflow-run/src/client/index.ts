/** Browser plugin for durable workflow-run Conversation Nodes. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { WorkflowRunPanel, type WorkflowRunInjected } from './WorkflowRunPanel.tsx'
import { en, NS, type WorkflowRunKey, zh } from './locales.ts'
import { WorkflowRunViewService } from './view-service.ts'
import { workflowRunDefinition } from './workflow-definition.ts'

export { WorkflowRunViewService, type WorkflowRunViewContract } from './view-service.ts'
export {
  ApprovalBadge, GateReport, NodeList, NodeRow, type WorkflowRunTranslate,
} from './WorkflowRunPanel.tsx'
export {
  runDetailToNodeData, type RunDetailApprovalInput, type RunDetailGateInput, type RunDetailInput,
  type RunDetailNodeInput, type RunDetailView,
} from './run-detail.ts'
export type {
  WorkflowApprovalDisplayState, WorkflowGateDisplayOutcome, WorkflowNodeDisplayStatus,
  WorkflowRunGateRow, WorkflowRunNodeData,
} from './workflow-definition.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Reusable workflow-run view components and the `runDetail` mapper. */
    workflowRunView: WorkflowRunViewService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Durable workflow-run node copy. */
    workflowRun: WorkflowRunKey
  }
}

/** Required services for Definition, keyed renderer, navigation, and copy. */
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']

/** Register the workflow Definition, dictionary, and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.plugin(WorkflowRunViewService)
  ctx.conversationEvents.register(workflowRunDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflow-run: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'workflow-run',
    locale: NS,
    inject: (): WorkflowRunInjected => ({
      openSession: (id: SessionId) => { ctx.sessions.open(id) },
    }),
  }, WorkflowRunPanel))
}

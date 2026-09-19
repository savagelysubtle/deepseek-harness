/**
 * Browser Agents plugin contributing one entry to the conversation view
 * slot without defining a service (pure consumer: `useSessions` off the
 * standard session-scope kit is the only data source this view needs).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh } from './locales.ts'
import { AgentsView } from './AgentsView.tsx'

/** Required services: the conversation slot ring and the locale service. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the Agents view tab. The registration rides
 * the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-agents: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  // Ordered after Chat (0) and Trajectory (10): the third ring entry, never
  // the default view.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'agents',
    order: 20,
    locale: NS,
    label: () => t('view.agents'),
  }, AgentsView))
}

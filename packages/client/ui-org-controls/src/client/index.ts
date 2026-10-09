/**
 * Browser org-controls plugin: Stop All (SWD-130) and Send All (SWD-131),
 * two independent entries in the conversation session header's
 * `conversation.session.header.actions` list slot (SWD-162 moved them off
 * the sidebar foot, beside the Chat/Trajectory tabs instead of Settings).
 * Both are pure consumers of `ctx.sessions` — neither declares a service of
 * its own — so the whole package is this one registration file plus its two
 * components.
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.session.header.actions' SlotMap row (declared
// by the slot's owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { en, NS, zh } from './locales.ts'
import { StopAllControl } from './StopAllControl.tsx'
import { SendAllControl } from './SendAllControl.tsx'
import type { SendAllFace, StopAllFace } from './slots.ts'

export type { SendAllFace, StopAllFace } from './slots.ts'
export type { StopAllControlProps } from './StopAllControl.tsx'
export type { SendAllControlProps } from './SendAllControl.tsx'
export type { OrgControlsKey } from './locales.ts'

/** Required services: the session header-action ring, the locale service, and the sessions domain. */
export const inject = ['slots', 'locale', 'sessions']

/**
 * Client plugin body: register the dictionaries and both header-action
 * entries. Each registration rides the slot service's effect wrapper, so
 * plugin unload removes both buttons.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-org-controls: dictionaries')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'stop-all',
    order: 20,
    locale: NS,
    inject: (): StopAllFace => ({
      onStopAll: () => ctx.sessions.stopAll(),
    }),
  }, StopAllControl))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'send-all',
    order: 30,
    locale: NS,
    inject: (): SendAllFace => ({
      onSendAll: content => ctx.sessions.sendAll(content),
    }),
  }, SendAllControl))
}

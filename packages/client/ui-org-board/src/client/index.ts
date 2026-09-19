/**
 * Browser org-board plugin: one entry in the sidebar's existing
 * `sidebar.footer.action` list slot, beside Stop All / Send All. Slice 2 was
 * read-only (`load` was the only verb); SWD-134 slice 4 step 3 wires in the
 * five write verbs `OrgBoardController` now exposes — this step still owns
 * no UI, so nothing here renders a control for them yet.
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'sidebar.footer.action' SlotMap row (declared by the slot's
// owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { en, NS, zh } from './locales.ts'
import { OrgBoardControl } from './OrgBoardControl.tsx'
import { OrgBoardController, refreshOrgBoardIfLoaded } from './org-board-store.ts'
import type { OrgBoardFace } from './slots.ts'

export type { OrgBoardFace } from './slots.ts'
export type { OrgBoardControlProps } from './OrgBoardControl.tsx'
export type { OrgBoardKey } from './locales.ts'
export type { OrgBoardState, OrgBoardValue } from './org-board-store.ts'

/** Required services: the sidebar footer-action ring, the locale service, and the connection api client. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Client plugin body: register the dictionary and the footer-action entry.
 * The registration rides the slot service's effect wrapper, so plugin unload
 * removes the button; the controller's own disposer stops any in-flight
 * `org.get` response from publishing after that, and a `connection/reset`
 * listener refreshes a loaded board so a reconnect never leaves stale data
 * on screen.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-org-board: dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new OrgBoardController(connection.api)
  const load = (): Promise<void> => controller.load()
  const addSeat = (name: string, cwd: string): Promise<void> => controller.addSeat(name, cwd)
  const removeSeat = (name: string): Promise<void> => controller.removeSeat(name)
  const addEdge = (from: string, to: string): Promise<void> => controller.addEdge(from, to)
  const removeEdge = (from: string, to: string): Promise<void> => controller.removeEdge(from, to)
  const setSeatTools = (
    name: string, allow: readonly string[] | undefined, deny: readonly string[] | undefined,
  ): Promise<void> => controller.setSeatTools(name, allow, deny)
  const injected = (): OrgBoardFace => ({
    hooks: { orgBoard: controller.store },
    load,
    addSeat,
    removeSeat,
    addEdge,
    removeEdge,
    setSeatTools,
  })

  ctx.effect(() => () => { controller.dispose() }, 'ui-org-board: controller lifecycle')

  // A reconnect (or host restart) is exactly when the org registry/rosters
  // this board reports on are most likely to have changed; refreshing (never
  // clearing to idle) keeps a viewer from being shown pre-reconnect data
  // with nothing marking it stale -- see refreshOrgBoardIfLoaded for why
  // refresh rather than clear.
  ctx.effect(() => ctx.on('connection/reset', () => {
    refreshOrgBoardIfLoaded(controller)
  }), 'ui-org-board: reconnect refresh')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'org-board',
    order: 120,
    locale: NS,
    inject: injected,
  }, OrgBoardControl))
}

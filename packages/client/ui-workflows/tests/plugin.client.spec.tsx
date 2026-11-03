// @vitest-environment jsdom
/**
 * Registration acceptance on the real framework stack: the Workflows entry lands in the
 * conversation session header's `conversation.session.header.actions` list at order 45 beside
 * existing occupants, the overlay lands in `shell.overlay`, the button opens the real Workflows
 * panel for the pressing session over the `workflow` Remote, the three pushed events are
 * subscribed through `ctx.remote.$on`, and fiber disposal removes both.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import type { WorkflowsFace } from '../src/client/index.ts'
import { WorkflowsControl } from '../src/client/WorkflowsControl.tsx'
import type { WorkflowsControlProps } from '../src/client/WorkflowsControl.tsx'
import { WorkflowsOverlay } from '../src/client/WorkflowsOverlay.tsx'
import { en } from '../src/client/locales.ts'
import { WorkflowRunViewService } from '@deepseek-ai/dsh-client-ui-workflow-run/src/client/view-service.ts'
import { makeRemote, SESSION } from './fixtures.client.ts'

// The locale service reads its initial language from the browser; these specs assert the
// English copy, so they state the browser they assume.
usePinnedBrowserLanguages('en-US')
afterEach(cleanup)

/**
 * Minimal `remote` service test double extending Cordis's `Service` base so dotted-namespace
 * access (`ctx.remote.workflow`) resolves through the same Proxy mechanism production uses.
 */
class RemoteService extends Service {
  readonly subscriptions: string[] = []
  readonly unsubscribed = vi.fn()

  constructor(serviceCtx: Context) {
    super(serviceCtx, 'remote')
  }

  $on(event: string): () => void {
    this.subscriptions.push(event)
    return this.unsubscribed
  }
}

/** Real-stack bench: root Context, real SlotRegistry, real locale, a `remote.workflow` stub. */
async function bench() {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  slots.register(
    { name: 'conversation.session.header.actions', id: 'org-board', order: 40 } as never,
    (() => null) as never,
  )
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const remoteService = new RemoteService(ctx)
  new WorkflowRunViewService(ctx)
  const remote = makeRemote()
  ctx.provide('remote.workflow', remote.asRemote)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, locale, fiber, remoteService, remote }
}

const translate = ((key: keyof typeof en) => en[key]) as never

describe('ui-workflows browser plugin', () => {
  it('declares the workflow Remote namespace specifically, not just any remote mount', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.workflow', 'workflowRunView'])
  })

  it('registers the header button id workflows at order 45 after the org board', async () => {
    const b = await bench()
    const entries = b.slots.entries('conversation.session.header.actions')
    expect(entries.map(entry => entry.options.id)).toEqual(['org-board', 'workflows'])
    const entry = entries.find(candidate => candidate.options.id === 'workflows')!
    expect(entry.options).toMatchObject({ id: 'workflows', order: 45 })
    expect(entry.component).toBe(WorkflowsControl)
    await b.ctx.fiber.dispose()
  })

  it('registers the overlay entry in shell.overlay', async () => {
    const b = await bench()
    const entries = b.slots.entries('shell.overlay')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options).toMatchObject({ id: 'workflows' })
    expect(entries[0]!.component).toBe(WorkflowsOverlay)
    await b.ctx.fiber.dispose()
  })

  it('follows the active locale for its dictionary', async () => {
    const b = await bench()
    expect(b.locale.bind(NS)('trigger')).toBe('Workflows')
    b.locale.setLocale('zh')
    expect(b.locale.bind(NS)('trigger')).toBe('工作流')
    b.locale.setLocale('en')
    await b.ctx.fiber.dispose()
  })

  it('opens the real overlay for the pressing session and subscribes the three workflow events', async () => {
    const b = await bench()
    const control = b.slots.entries('conversation.session.header.actions').find(e => e.options.id === 'workflows')!
    const overlay = b.slots.entries('shell.overlay')[0]!
    const controlFace = (control.inject as unknown as () => WorkflowsFace)()
    const overlayFace = (overlay.inject as unknown as () => WorkflowsFace)()
    expect(controlFace.overlay).toBe(overlayFace.overlay)

    render(
      <>
        <WorkflowsControl {...{ ...controlFace, sessionId: SESSION, t: translate } as unknown as WorkflowsControlProps} />
        <WorkflowsOverlay {...{ ...overlayFace, t: translate }} />
      </>,
    )
    expect(document.querySelector('[data-workflows-overlay]')).toBeNull()
    fireEvent.click(document.querySelector('[data-workflows-button]')!)
    await waitFor(() => { expect(document.querySelector('[data-workflow-row]')).not.toBeNull() })
    expect(document.querySelector('[data-workflows-overlay]')).not.toBeNull()
    expect(b.remote.list).toHaveBeenCalledWith(SESSION)
    expect(b.remoteService.subscriptions).toEqual(['workflow/run-changed', 'workflow/approval-pending', 'workflow/approval-decided'])
    fireEvent.click(document.querySelector('[aria-label="Close"]')!)
    await waitFor(() => { expect(b.remoteService.unsubscribed).toHaveBeenCalledTimes(3) })
    expect(b.remote.detachUi).toHaveBeenCalledTimes(1)
    await b.ctx.fiber.dispose()
  })

  it('fiber disposal removes both registrations and leaves other entries standing', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(b.slots.entries('conversation.session.header.actions').map(e => e.options.id)).toEqual(['org-board'])
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
  })
})

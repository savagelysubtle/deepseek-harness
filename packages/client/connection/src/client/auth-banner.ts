/**
 * Visible notice for a refused caller token (OP-270). A privileged action that the host refuses
 * must never fail silently: while the token state is `rejected`, a fixed strip across the top of the
 * page says why and how to recover. Plain DOM, so it works before the React shell mounts and
 * without a mount seat in the layout.
 */
import type { CallerAuthView } from './caller-auth.ts'

const BANNER_ATTRIBUTE = 'data-dsh-auth-banner'

/**
 * Show the strip while the token state is `rejected`; remove it when it recovers.
 * @param view - observable token state.
 * @param doc - page document.
 * @returns disposer that unsubscribes and removes the strip.
 */
export function mountAuthBanner(view: CallerAuthView, doc: Pick<Document, 'body' | 'createElement'>): () => void {
  let strip: HTMLElement | undefined
  const render = (): void => {
    const message = view.getState() === 'rejected' ? view.getMessage() : undefined
    if (message === undefined) {
      strip?.remove()
      strip = undefined
      return
    }
    if (strip === undefined) {
      strip = doc.createElement('div')
      strip.setAttribute(BANNER_ATTRIBUTE, '')
      strip.setAttribute('role', 'alert')
      strip.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;padding:6px 12px;text-align:center;'
        + 'font:13px/18px system-ui,sans-serif;background:#b3261e;color:#fff'
      doc.body.prepend(strip)
    }
    strip.textContent = message
  }
  render()
  const unsubscribe = view.subscribe(render)
  return () => {
    unsubscribe()
    strip?.remove()
    strip = undefined
  }
}

// Modal: controlled full-viewport dialog (create-workspace and similar).
// The overlay portals to this document's body so ancestor stacking contexts
// cannot leave sticky page controls above the mask. This is still an in-page
// WebUI dialog; it never creates or targets another browser/native window.
//
// SWD-155: while open, a Modal traps focus and makes the rest of the page
// inert -- previously the mask/portal were CSS-only, so the content
// underneath kept receiving clicks and keyboard focus even though it was
// visually covered. See `setupModalTrap` below for the mechanism; nested
// Modals (e.g. a RiskConfirmation opened from inside another Modal's body)
// share one module-level stack so only the topmost dialog ever traps.

import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

/** One entry in the open-dialog stack: the inner `role="dialog"` element
 * (focus/Tab scope) and its portal root (the `css.root` wrapper, which also
 * contains the mask -- the background-inert pass exempts this whole root,
 * not just the dialog, so clicking the mask still reaches its own onClick). */
interface ModalStackEntry {
  dialog: HTMLElement
  root: HTMLElement
}

/** Every currently-open Modal, bottom (opened first) to top (opened last).
 * Shared module-level state on purpose: Tab-wrap and the background click/
 * focus guard below must act only for the TOPMOST dialog, which a per-
 * instance `useRef` cannot answer -- each instance needs to see every other
 * open instance to know whether it is still the top. */
const modalStack: ModalStackEntry[] = []

/** Body children this module itself set `inert` on, so closing restores
 * exactly those -- never a sibling that was already `inert` before any
 * Modal opened, and never a currently-stacked dialog's own portal root. */
const inertSetByModal = new Set<HTMLElement>()

/**
 * Keep every direct child of `document.body` inert except the portal roots
 * of every currently stacked dialog. Recomputed on every push/pop (not just
 * on first open/last close) so a second, nested dialog opening or closing
 * never fights the first over the same background elements -- the set is
 * idempotent either way.
 */
function syncBackgroundInert(): void {
  if (modalStack.length === 0) {
    for (const element of inertSetByModal) element.inert = false
    inertSetByModal.clear()
    return
  }
  const exemptRoots = new Set(modalStack.map(entry => entry.root))
  // Document.body's direct children are always elements (`.children`, not
  // `.childNodes`, never yields text/comment nodes); this app only ever
  // mounts element roots (its own `#root`, RTL's test container, other
  // portals) directly under body, so this cast reflects an actual layout
  // guarantee rather than hiding a real possibility.
  const bodyChildren = Array.from(document.body.children) as HTMLElement[]
  for (const child of bodyChildren) {
    if (exemptRoots.has(child) || child.inert) continue
    child.inert = true
    inertSetByModal.add(child)
  }
}

/** Tabbable per the ticket's own selector list, filtered for `:disabled` --
 * jsdom's selector engine (nwsapi) supports the pseudo-class, so this needs
 * no manual per-tag-name disabled check. */
const TABBABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** Tabbable elements inside `container`, in DOM order. */
function tabbablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR))
    .filter(element => !element.matches(':disabled'))
}

/** True when `target` is not inside `root` -- the background-guard
 * listeners below only ever run on a real, already-dispatched DOM event
 * (focusin/pointerdown/mousedown/click) delivered through `addEventListener`,
 * whose `target` the platform always sets to a `Node`; the cast reflects
 * that runtime guarantee rather than hiding a real null case. */
function isOutside(root: HTMLElement, target: EventTarget | null): boolean {
  return !root.contains(target as Node)
}

/**
 * Wire one open dialog into the shared stack: push/pop, keep the background
 * inert while it is open, claim initial focus, trap Tab inside it while it
 * is the topmost dialog, swallow outside pointer/focus activity while it is
 * topmost, and hand focus back to whatever had it on open once this dialog
 * closes.
 * @param dialog - the mounted `role="dialog"` element (never `null`: this is
 * only ever invoked from the dialog's own callback ref, which React calls
 * with the real node on attach).
 * @returns the teardown to run on this dialog's unmount.
 */
function setupModalTrap(dialog: HTMLDivElement): () => void {
  // Modal's own JSX (below) always renders `dialog` as the sole non-mask
  // child of the portal's root wrapper -- asserting that structural
  // invariant rather than branching on a parent that this file guarantees
  // is never absent.
  const root = dialog.parentElement as HTMLElement
  const entry: ModalStackEntry = { dialog, root }
  const openerFocus = document.activeElement

  modalStack.push(entry)
  syncBackgroundInert()

  // Respect focus a child already claimed on mount (e.g. a consumer's own
  // `autoFocus` input/button) rather than fighting it -- only move focus
  // when nothing inside this dialog has it yet. React applies `autoFocus`
  // during commit, strictly before this effect-driven ref callback fires,
  // so `document.activeElement` already reflects it here.
  if (!dialog.contains(document.activeElement)) {
    const tabbables = tabbablesIn(dialog)
    if (tabbables.length > 0) (tabbables[0] as HTMLElement).focus()
    else dialog.focus()
  }

  const isTop = (): boolean => modalStack[modalStack.length - 1] === entry

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || !isTop()) return
    const tabbables = tabbablesIn(dialog)
    if (tabbables.length === 0) {
      // Nothing to cycle through -- never let Tab escape to the (inert)
      // background.
      event.preventDefault()
      return
    }
    const first = tabbables[0] as HTMLElement
    const last = tabbables[tabbables.length - 1] as HTMLElement
    if (event.shiftKey) {
      if (document.activeElement !== first) return
      event.preventDefault()
      last.focus()
    } else {
      if (document.activeElement !== last) return
      event.preventDefault()
      first.focus()
    }
  }

  const guardOutsideActivity = (event: Event): void => {
    if (!isTop() || !isOutside(root, event.target)) return
    event.preventDefault()
    event.stopPropagation()
  }

  const guardOutsideFocus = (event: FocusEvent): void => {
    if (!isTop() || !isOutside(root, event.target)) return
    event.preventDefault()
    event.stopPropagation()
    const tabbables = tabbablesIn(dialog)
    const fallback = tabbables.length > 0 ? (tabbables[0] as HTMLElement) : dialog
    fallback.focus()
  }

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('pointerdown', guardOutsideActivity, true)
  document.addEventListener('mousedown', guardOutsideActivity, true)
  document.addEventListener('click', guardOutsideActivity, true)
  document.addEventListener('focusin', guardOutsideFocus, true)

  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('pointerdown', guardOutsideActivity, true)
    document.removeEventListener('mousedown', guardOutsideActivity, true)
    document.removeEventListener('click', guardOutsideActivity, true)
    document.removeEventListener('focusin', guardOutsideFocus, true)

    // Filter rather than indexOf+splice: this entry is pushed exactly once
    // and this cleanup runs exactly once for it, so a plain removal needs no
    // "was it actually there" branch to guard a case that never occurs.
    modalStack.splice(0, modalStack.length, ...modalStack.filter(item => item !== entry))
    syncBackgroundInert()

    if (openerFocus instanceof HTMLElement && openerFocus.isConnected) {
      openerFocus.focus()
    }
  }
}

/**
 * Render a centered modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape or mask click.
 * @param props.title - dialog heading (aria-label in every mode).
 * @param props.closeLabel - accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome) for dialogs whose figma frame owns its own
 * header structure; mask, card, Escape, and aria-label remain.
 * @param props.closeLabel - close-button aria label; the owner passes
 * localized copy (this package is cordis-free, so copy arrives via props).
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, closeLabel = 'Close', description, children, footer, className, contentClassName, headless = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  headless?: boolean
}) {
  // Holds setupModalTrap's own teardown between this dialog's attach and
  // detach -- a plain ref, not component state, since nothing here should
  // ever trigger a re-render.
  const trapCleanupRef = useRef<(() => void) | null>(null)
  // Stable for the component's lifetime (empty deps): a callback ref whose
  // identity changed on every render would make React detach-then-reattach
  // it on every re-render while open, re-running the trap (and re-stealing
  // focus) on every keystroke inside the dialog instead of once per real
  // mount/unmount.
  const dialogRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) {
      trapCleanupRef.current?.()
      trapCleanupRef.current = null
      return
    }
    trapCleanupRef.current = setupModalTrap(node)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])

  if (!open) return null

  return createPortal((
    <div className={css.root} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        className={clsx(css.dialog, className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}

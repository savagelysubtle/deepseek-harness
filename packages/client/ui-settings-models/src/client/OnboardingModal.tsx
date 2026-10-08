/** Shared modal chrome for every step registered by this onboarding plugin. */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './OnboardingModal.module.css'

const ignoreImplicitDismiss = (): void => {}

/**
 * Render a blocking onboarding dialog.
 * @param props.title - accessible and visible dialog title.
 * @param props.focusTitle - focus the title when the step has no form control
 * worth focusing instead (e.g. WelcomeNotice's own Continue button would
 * otherwise win Modal's default first-tabbable focus).
 * @param props.children - step-owned body and actions.
 * @returns the body-portaled modal.
 */
export function OnboardingModal({
  title, focusTitle = false, children,
}: {
  title: string
  focusTitle?: boolean
  children: ReactNode
}): ReactNode {
  const titleRef = useRef<HTMLHeadingElement | null>(null)

  // SWD-155: Modal itself now traps focus and makes the rest of the page
  // (including #root) inert while open -- this used to be this component's
  // own job (a separate effect capturing and restoring #root.inert), which
  // raced Modal's own trap: Modal's commit-phase callback ref already set
  // #root.inert = true before this effect ran, so it captured `previous`
  // as true, then stomped #root back to inert on unmount after Modal's own
  // cleanup had just cleared it -- leaving the whole app permanently inert
  // once an onboarding dialog had opened and closed. Removed; Modal owns it.

  useEffect(() => {
    if (focusTitle) titleRef.current?.focus()
  }, [focusTitle])

  return (
    <Modal
      open
      title={title}
      onClose={ignoreImplicitDismiss}
      headless
      className={css.dialog as string}
    >
      <div className={css.content}>
        <h2 ref={titleRef} className={css.title} tabIndex={focusTitle ? -1 : undefined}>{title}</h2>
        <div className={css.body}>{children}</div>
      </div>
    </Modal>
  )
}

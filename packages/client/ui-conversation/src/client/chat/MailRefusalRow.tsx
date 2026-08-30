import { useState } from 'react'
import type { ContextMessageNode, MailboxRefusalView } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { contextBody } from './ContextBody.tsx'
import { formatMessageClock } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MailRefusalRow.module.css'

type Translate = ChatViewSlotProps['t']

/** Props for the mailbox-refusal context presentation. */
export interface MailRefusalRowProps {
  content: ContextMessageNode['content']
  source: ContextMessageNode['source']
  /**
   * Producer-declared form, forwarded to {@link contextBody} for the notice
   * body only — the header below is refusal-specific and does not depend on it.
   */
  form: ContextMessageNode['form']
  /** Fields this UI version can read off the refusal's durable source ({@link mailboxRefusal}). */
  refusal: MailboxRefusalView
  /**
   * Unix epoch ms the session logged this notice at
   * ({@link ContextMessageNode.time}). NOT part of the durable mailbox
   * source, which carries no timestamp of its own — this is the event-log
   * time the caller already has for every context node.
   */
  time: number
  /** The owning view's locale seat, passed down as a plain prop. */
  t: Translate
}

/**
 * Render one mailbox refusal notice as its own card: the harness reporting
 * the session's OWN refused send — never correspondence. The geometry follows
 * {@link MailInjectionRow} so mail and refusal read as one family, but the
 * warning icon and red error accent (where the mail card carries a mail icon
 * and the business blue) make the failure unmistakable: this is the harness
 * declining a send, not a peer writing in.
 *
 * Interaction mirrors the mail card — a click or Enter/Space toggles, and the
 * body only mounts while open — but the notice starts COLLAPSED, like
 * non-blocking mail: a refusal interrupts nothing, so it never claims the
 * open state the way a blocking message earns it. The attempted recipient and
 * the terminal reason stay visible whether the card is open or closed, so the
 * one fact the sender needs — what was dropped, and why — reads without a
 * click.
 *
 * The body is the model-facing text under the row's declared `notice` form; a
 * source whose summary is unreadable degrades that body to the opaque
 * presentation (text plus the remaining source fields) rather than blanking.
 * A source missing its recipient or reason never reaches this card at all —
 * {@link mailboxRefusal} reads it null and the generic notice row takes over.
 *
 * @param props - Durable content, the readable refusal fields, the logging time, and the locale seat.
 * @returns The mail-refusal context card.
 */
export function MailRefusalRow({ content, source, form, refusal, time, t }: MailRefusalRowProps) {
  const [open, setOpen] = useState(false)
  const day = useCalendarDay()
  const { body } = contextBody(form, { content, source, t })
  const toggle = (): void => { setOpen(value => !value) }

  return (
    <div className={css.card} data-context-mail-refusal data-open={open || undefined}>
      <div
        className={css.header}
        data-context-mail-refusal-header
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggle()
        }}
      >
        <IconWarningOutline16 size={14} className={css.icon} />
        <span className={css.title} data-context-mail-refusal-title>
          {t('message.context.mail.refusal.title')}
        </span>
        <span className={css.time} data-context-mail-refusal-time>{formatMessageClock(time, t, day)}</span>
        <IconChevronDownOutline14 className={css.chevron} />
      </div>
      <p className={css.recipient} data-context-mail-refusal-recipient>
        {t('message.context.mail.refusal.to', { to: refusal.refusedTo })}
      </p>
      <p className={css.reason} data-context-mail-refusal-reason>
        {t('message.context.mail.refusal.reason', { reason: refusal.reason })}
      </p>
      {open && (
        <div className={css.body} data-context-injection-body data-context-mail-refusal-body>
          {body}
        </div>
      )}
    </div>
  )
}

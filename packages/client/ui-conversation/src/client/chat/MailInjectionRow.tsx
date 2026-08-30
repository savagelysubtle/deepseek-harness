import { useState } from 'react'
import type { ContextMessageNode, MailboxRelayView, MailboxSenderClass } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, IconMailOutline16, IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { contextBody } from './ContextBody.tsx'
import { formatMessageClock } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MailInjectionRow.module.css'

type Translate = ChatViewSlotProps['t']

/** Props for the delivered-mail context presentation. */
export interface MailInjectionRowProps {
  content: ContextMessageNode['content']
  source: ContextMessageNode['source']
  /**
   * Producer-declared form, forwarded to {@link contextBody} for the message
   * body only — the header below is mail-specific and does not depend on it.
   */
  form: ContextMessageNode['form']
  /** Fields this UI version can read off the delivered mail's durable source ({@link mailboxRelay}). */
  mail: MailboxRelayView
  /**
   * Unix epoch ms the session logged this delivery at
   * ({@link ContextMessageNode.time}). NOT part of the durable mailbox
   * source, which does not carry its own timestamp today — this is the
   * event-log time the caller already has for every context node.
   */
  time: number
  /** The owning view's locale seat, passed down as a plain prop. */
  t: Translate
}

/** Locale key for one sender class annotation, e.g. `(seat)` / `(unverified)`. */
function senderClassKey(
  senderClass: MailboxSenderClass,
): 'message.context.mail.class.seat' | 'message.context.mail.class.unverified' {
  return senderClass === 'seat' ? 'message.context.mail.class.seat' : 'message.context.mail.class.unverified'
}

/** The card's title text: sender alone, or sender with its class annotated. */
function senderTitle(mail: MailboxRelayView, t: Translate): string {
  return mail.senderClass === null
    ? mail.from
    : t('message.context.mail.senderWithClass', {
      sender: mail.from,
      class: t(senderClassKey(mail.senderClass)),
    })
}

/**
 * Render one delivered mailbox message as its own card, deliberately distinct
 * from the generic {@link ContextInjectionRow} disclosure chrome: a peer
 * seat's mail must never be mistaken for founder input or a routine system
 * injection.
 *
 * Interaction mirrors the generic row — a click or Enter/Space toggles, and
 * the body only mounts while open — but the header is bespoke: sender,
 * sender class, and delivery time stay visible whether the card is open or
 * closed. A blocking message starts OPEN, because the thing that interrupted
 * the agent must be readable without a click; an FYI message starts
 * collapsed, like every other context row.
 *
 * `senderClass`, `subject`, and `blocking` render only when the durable source
 * actually carries them. The bridge stamps `senderClass` on every delivery and
 * the other two whenever the message carried them, so a blocking message with a
 * subject renders the full card; a plain FYI with no subject correctly renders
 * neither. A message logged before that stamping landed still reads all three
 * null and degrades to sender + time, which is why every field is optional here
 * rather than required.
 *
 * @param props - Durable content, the readable mail fields, the delivery time, and the locale seat.
 * @returns The mail context card.
 */
export function MailInjectionRow({ content, source, form, mail, time, t }: MailInjectionRowProps) {
  const [open, setOpen] = useState(mail.blocking === true)
  const day = useCalendarDay()
  const { body } = contextBody(form, { content, source, t })
  const toggle = (): void => { setOpen(value => !value) }

  return (
    <div className={css.card} data-context-mail-card data-open={open || undefined}>
      <div
        className={css.header}
        data-context-mail-header
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
        <IconMailOutline16 size={14} className={css.icon} />
        <span className={css.sender} data-context-mail-sender>{senderTitle(mail, t)}</span>
        <span className={css.time} data-context-mail-time>{formatMessageClock(time, t, day)}</span>
        <IconChevronDownOutline14 className={css.chevron} />
      </div>
      {mail.subject !== null && (
        <p className={css.subject} data-context-mail-subject>{mail.subject}</p>
      )}
      {mail.blocking === true && (
        <p className={css.blocking} data-context-mail-blocking>
          <IconWarningOutline16 size={12} className={css.blockingIcon} />
          {t('message.context.mail.blocking')}
        </p>
      )}
      {open && (
        <div className={css.body} data-context-injection-body data-context-mail-body>
          {body}
        </div>
      )}
    </div>
  )
}

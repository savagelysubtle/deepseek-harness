import { useState } from 'react'
import type { ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { mailboxRefusal, mailboxRelay } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { DisclosureRow, IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { contextBody } from './ContextBody.tsx'
import { MailInjectionRow } from './MailInjectionRow.tsx'
import { MailRefusalRow } from './MailRefusalRow.tsx'
import css from './ContextInjectionRow.module.css'

/** Props for the logged non-user message presentation. */
export interface ContextInjectionRowProps {
  content: ContextMessageNode['content']
  source: ContextMessageNode['source']
  /** Role and producer name projected from the durable source. */
  provenance: ContextMessageNode['provenance']
  /** Producer-declared information form; null renders the opaque body. */
  form: ContextMessageNode['form']
  /** Unix epoch ms the session logged this context at ({@link ContextMessageNode.time}); the mail card's delivery time. */
  time: number
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Render logged context with the Tool calls disclosure chrome from Figma.
 *
 * The header names the role the context plays and, beside it, the producer the
 * durable source identifies, so a reader can tell an injected skill catalog
 * from a workspace instruction file or a recalled session without expanding.
 * The expanded body follows the producer-declared form; an absent or unknown
 * form renders the opaque body.
 *
 * Delivered mail is one producer this row does NOT present with this chrome:
 * a readable mailbox source ({@link mailboxRelay}) dispatches to
 * {@link MailInjectionRow} instead, so a peer seat's message reads as
 * unmistakably mail rather than a generic context injection. A mailbox
 * refusal notice ({@link mailboxRefusal} — the harness reporting the
 * session's own refused send, which carries no `from` and so never matches
 * the mail gate) dispatches to {@link MailRefusalRow} the same way.
 * @param props - Durable content, its projected producer role/name and form, delivery time, and the locale seat.
 * @returns A collapsed context row with a bounded, form-specific body, the dedicated mail card, or the dedicated refusal card.
 */
export function ContextInjectionRow({ content, source, provenance, form, time, t }: ContextInjectionRowProps) {
  const mail = mailboxRelay(source)
  if (mail !== null) {
    return <MailInjectionRow content={content} source={source} form={form} mail={mail} time={time} t={t} />
  }
  const refusal = mailboxRefusal(source)
  if (refusal !== null) {
    return <MailRefusalRow content={content} source={source} form={form} refusal={refusal} time={time} t={t} />
  }

  return <GenericContextInjectionRow content={content} source={source} provenance={provenance} form={form} t={t} />
}

/** The pre-existing disclosure presentation, unchanged, for every non-mail context. */
function GenericContextInjectionRow({ content, source, provenance, form, t }: Omit<ContextInjectionRowProps, 'time'>) {
  const [open, setOpen] = useState(false)
  // Resolved rather than declared: a form whose fields are unreadable renders
  // the opaque body, and the marker must say what the row actually shows.
  const { rendered, summary, body } = contextBody(form, { content, source, t })

  return (
    <DisclosureRow
      className={css.root}
      icon={<IconBrowseOutline16 size={14} />}
      chevronClassName={css.chevron}
      title={t(provenance.role === 'recall' ? 'message.contextRecall' : 'message.contextInjection')}
      collapsedContent={provenance.label === null ? undefined : (
        /* ToolRow's separator shape: an aria-hidden dot, so the accessible name
           stays the two readable parts and the two disclosure rows expose one
           name shape. A source that names no producer drops the dot with it. */
        <>
          <span className={css.sep} aria-hidden />
          <span className={css.source} data-context-source>{provenance.label}</span>
          {summary !== null && (
            <>
              <span className={css.sep} aria-hidden />
              <span className={css.summary} data-context-summary>{summary}</span>
            </>
          )}
        </>
      )}
      keepContentWhenOpen
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(value => !value) }}
    >
      <div className={css.body} data-context-injection-body data-context-form={rendered ?? undefined}>
        {body}
      </div>
    </DisclosureRow>
  )
}

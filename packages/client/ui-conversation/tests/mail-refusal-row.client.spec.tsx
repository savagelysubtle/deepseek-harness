// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { ContextInjectionRow } from '../src/client/chat/ContextInjectionRow.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const REFUSAL_REASON = 'org-registry-denied: "tt-ping" may not mail "t2-loner" — no edge connects them'

/** The durable notice source exactly as the bridge stamps it (no `from`). */
const REFUSAL_SOURCE = {
  kind: 'mailbox',
  form: 'notice',
  refusedTo: 't2-loner',
  messageId: 'm-1',
  reason: REFUSAL_REASON,
  summary: 'Mail to "t2-loner" was refused',
}

/** The model-facing account the notice turn carries. */
const REFUSAL_CONTENT: ContextMessageNode['content'] = [
  { type: 'text', text: `Mail refused. Your message (id m-1) to "t2-loner" was NOT delivered: ${REFUSAL_REASON}` },
]

/** The shared row props: injected role, mailbox producer label, notice form. */
function rowProps(overrides: {
  content?: ContextMessageNode['content']
  source?: unknown
  form?: ContextMessageNode['form']
}) {
  return {
    content: overrides.content ?? REFUSAL_CONTENT,
    source: overrides.source ?? REFUSAL_SOURCE,
    provenance: { role: 'inject' as const, label: 'mailbox' },
    form: overrides.form ?? ('notice' as const),
    time: Date.UTC(2026, 7, 29, 12, 0, 0),
    t,
  }
}

describe('ContextInjectionRow — mailbox refusal notice', () => {
  it('renders the dedicated refusal card, never the mail card', () => {
    const view = render(<ContextInjectionRow {...rowProps({})} />)
    expect(view.container.querySelector('[data-context-mail-refusal]')).not.toBeNull()
    expect(view.container.querySelector('[data-context-mail-card]')).toBeNull()
    expect(view.getByText('邮件被拒绝')).toBeTruthy()
    expect(view.container.querySelector('[data-context-mail-refusal-recipient]')?.textContent).toContain('t2-loner')
    expect(view.container.querySelector('[data-context-mail-refusal-reason]')?.textContent).toContain('no edge connects them')
  })

  it('starts collapsed with the recipient and reason visible, and toggles the body like the mail card', () => {
    const view = render(<ContextInjectionRow {...rowProps({})} />)
    expect(view.container.querySelector('[data-context-mail-refusal-body]')).toBeNull()
    const header = view.container.querySelector('[data-context-mail-refusal-header]')
    expect(header?.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(header as Element)
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelector('[data-context-mail-refusal-body]')?.textContent).toContain('NOT delivered')

    fireEvent.click(header as Element)
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-context-mail-refusal-body]')).toBeNull()
  })

  it('keeps the mail card rendering for delivered relay sources — the refusal gate is form-specific', () => {
    const view = render(<ContextInjectionRow {...rowProps({
      source: { kind: 'mailbox', form: 'relay', address: 't2-loner', from: 'tt-ping', messageId: 'm-2' },
      form: 'relay',
    })} />)
    expect(view.container.querySelector('[data-context-mail-card]')).not.toBeNull()
    expect(view.container.querySelector('[data-context-mail-refusal]')).toBeNull()
  })

  it('a notice missing its recipient or reason degrades to the generic context row', () => {
    const view = render(<ContextInjectionRow {...rowProps({
      source: { kind: 'mailbox', form: 'notice', messageId: 'm-3', reason: 'sender-not-admitted' },
    })} />)
    expect(view.container.querySelector('[data-context-mail-refusal]')).toBeNull()
    expect(view.container.querySelector('[data-context-mail-card]')).toBeNull()
    // The generic row still renders something sane rather than blank.
    expect(view.getByText('上下文注入')).toBeTruthy()
  })
})

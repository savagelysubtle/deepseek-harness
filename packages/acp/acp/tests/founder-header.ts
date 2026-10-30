import { expect } from 'vitest'
import { FOUNDER_MARKER_TEXT } from '@deepseek-ai/dsh-agent-loop'

const escaped = FOUNDER_MARKER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/**
 * Matcher for block 0 of a dispatched founder message: the per-message stamp
 * (`[Thu 2026-10-30 11:54 PDT]`), a space, the founder marker, a blank line.
 * Real-clock tests cannot pin the stamp text, so its shape is matched.
 * @returns an asymmetric matcher usable inside `toEqual`.
 */
export function founderHeader(): { type: 'text'; text: unknown } {
  return {
    type: 'text',
    text: expect.stringMatching(
      new RegExp(String.raw`^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]]+\] ${escaped}\n\n$`),
    ) as unknown,
  }
}

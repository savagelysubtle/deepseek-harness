/**
 * Shared assertions helpers for the per-message dispatch stamp: tests that run
 * on the real clock cannot pin the stamp text, so they match its shape.
 */

import { expect } from 'vitest'

/** Shape of one dispatch stamp, `[Thu 2026-10-30 11:54 PDT]`. */
export const STAMP_SHAPE = String.raw`\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]]+\]`

/** A header block of any time: stamp, blank line, nothing else. */
export function anyStampBlock(): { type: 'text'; text: unknown } {
  return { type: 'text', text: expect.stringMatching(new RegExp(`^${STAMP_SHAPE}\\n\\n$`)) as unknown }
}

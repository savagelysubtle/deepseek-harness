/**
 * Pure-function coverage for loop-abort.ts's `boundFragment` helper.
 * loop-abort.spec.ts proves the wiring end to end, but every fragment it
 * exercises there is already pre-bounded by `FragmentTail` (reasoning
 * channel) or short enough to stay under the default cap (tool-call
 * channel), so the truncating branch of `boundFragment` itself is never
 * reached through that path. Exercise it directly here.
 */

import { describe, expect, it } from 'vitest'
import { boundFragment } from '../src/loop-abort.ts'

describe('boundFragment', () => {
  it('returns text unchanged when it is at or under the max', () => {
    expect(boundFragment('short', 10)).toBe('short')
    // Exactly at the boundary: still the <= branch, not the truncating one.
    expect(boundFragment('0123456789', 10)).toBe('0123456789')
  })

  it('truncates to the trailing `max` characters, prefixed with an ellipsis, once text exceeds the max', () => {
    const text = '0123456789ABCDEF'
    expect(boundFragment(text, 10)).toBe('…6789ABCDEF')
  })

  it('keeps the tail — the most recent characters — not the head', () => {
    const text = 'x'.repeat(50) + 'the-recent-part'
    const bounded = boundFragment(text, 15)
    expect(bounded).toBe('…the-recent-part')
    expect(bounded.startsWith('…')).toBe(true)
    expect(bounded).not.toContain('x')
  })

  it('uses the default max (500) when none is supplied', () => {
    const long = 'a'.repeat(600)
    const bounded = boundFragment(long)
    expect(bounded).toBe(`…${'a'.repeat(500)}`)
    expect(bounded.length).toBe(501)
  })
})

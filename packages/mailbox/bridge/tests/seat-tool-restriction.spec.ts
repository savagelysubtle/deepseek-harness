/**
 * Unit suite for the seat tool-restriction helper, entirely against a
 * hand-built fake registry context — no real `@deepseek-ai/dsh-tools`
 * involved, because the helper is meant to be testable in complete
 * isolation from the bridge's plumbing.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  applySeatToolRestriction,
  type SeatToolRegistryContext,
  type SeatToolRestrictionRule,
} from '../src/seat-tool-restriction.ts'

/** One fake registry context: a spyable schema list and a spyable restrict call, both recording call order into a shared log. */
function fakeContext(knownNames: readonly string[]): {
  readonly ctx: SeatToolRegistryContext
  readonly schemas: ReturnType<typeof vi.fn>
  readonly restrict: ReturnType<typeof vi.fn>
  readonly callOrder: string[]
} {
  const callOrder: string[] = []
  const schemas = vi.fn(() => {
    callOrder.push('schemas')
    return knownNames.map(name => ({ name }))
  })
  const restrict = vi.fn((_rule: { allow?: readonly string[]; deny?: readonly string[] }) => {
    callOrder.push('restrict')
  })
  return { ctx: { tools: { schemas, restrict } }, schemas, restrict, callOrder }
}

describe('applySeatToolRestriction', () => {
  it('does nothing and returns undefined when the seat has no rule', () => {
    const { ctx, schemas, restrict } = fakeContext(['read', 'bash'])

    const outcome = applySeatToolRestriction(ctx, 'target', undefined)

    expect(outcome).toBeUndefined()
    expect(schemas).not.toHaveBeenCalled()
    expect(restrict).not.toHaveBeenCalled()
  })

  it('passes a fully-matching rule through verbatim with nothing reported missing', () => {
    const { ctx, restrict } = fakeContext(['read', 'bash', 'web'])
    const rule: SeatToolRestrictionRule = { allow: ['read', 'bash'], deny: ['web'] }

    const outcome = applySeatToolRestriction(ctx, 'target', rule)

    expect(restrict).toHaveBeenCalledExactlyOnceWith({ allow: ['read', 'bash'], deny: ['web'] })
    expect(outcome).toEqual({
      rule: { allow: ['read', 'bash'], deny: ['web'] },
      missing: [],
    })
  })

  it('intersects a partially-matching allow list and reports the missing names', () => {
    const { ctx, restrict } = fakeContext(['read', 'bash'])
    const rule: SeatToolRestrictionRule = { allow: ['read', 'ghost', 'bash', 'wraith'] }

    const outcome = applySeatToolRestriction(ctx, 'target', rule)

    expect(restrict).toHaveBeenCalledExactlyOnceWith({ allow: ['read', 'bash'] })
    expect(outcome).toEqual({
      rule: { allow: ['read', 'bash'] },
      missing: ['ghost', 'wraith'],
    })
  })

  it('intersects a partially-matching deny list and reports the missing names', () => {
    const { ctx, restrict } = fakeContext(['read', 'bash'])
    const rule: SeatToolRestrictionRule = { deny: ['bash', 'ghost'] }

    const outcome = applySeatToolRestriction(ctx, 'target', rule)

    expect(restrict).toHaveBeenCalledExactlyOnceWith({ deny: ['bash'] })
    expect(outcome).toEqual({
      rule: { deny: ['bash'] },
      missing: ['ghost'],
    })
  })

  it('degrades an allow list CLOSED to empty when every named tool is currently missing', () => {
    // Deliberate: an allow list is a narrowing, so when its entire configured
    // contents have vanished at runtime the seat ends up with an EMPTY allow
    // list (no tools) rather than falling back to unrestricted — silently
    // widening the boundary is the one outcome that is unacceptable here.
    // A future reader must not "fix" this into a deny-style no-op.
    const { ctx, restrict } = fakeContext(['read', 'bash'])
    const rule: SeatToolRestrictionRule = { allow: ['ghost', 'wraith'] }

    const outcome = applySeatToolRestriction(ctx, 'target', rule)

    expect(restrict).toHaveBeenCalledExactlyOnceWith({ allow: [] })
    expect(outcome).toEqual({
      rule: { allow: [] },
      missing: ['ghost', 'wraith'],
    })
  })

  it('degrades a deny list to a no-op for names that are all currently missing', () => {
    const { ctx, restrict } = fakeContext(['read', 'bash'])
    const rule: SeatToolRestrictionRule = { deny: ['ghost', 'wraith'] }

    const outcome = applySeatToolRestriction(ctx, 'target', rule)

    expect(restrict).toHaveBeenCalledExactlyOnceWith({ deny: [] })
    expect(outcome).toEqual({
      rule: { deny: [] },
      missing: ['ghost', 'wraith'],
    })
  })

  it('reads the known-tool set BEFORE calling restrict, never after', () => {
    // The registry's schema-listing method returns tools visible AFTER
    // restrictions are applied. Calling it after restrict() would make every
    // configured name look satisfied (the visible set is by definition a
    // subset of what was just restricted to), hiding exactly the gap this
    // helper exists to surface. Assert the call order explicitly, not just
    // the outcome, so a reordering regresses this test even when the
    // fixture's known set would otherwise still "look" correct.
    const { ctx, callOrder } = fakeContext(['read', 'bash'])
    const rule: SeatToolRestrictionRule = { allow: ['read'] }

    applySeatToolRestriction(ctx, 'target', rule)

    expect(callOrder).toEqual(['schemas', 'restrict'])
  })

  it('attributes a registry restrict() failure to the seat that caused it', () => {
    const { ctx, restrict } = fakeContext(['read', 'run_code'])
    restrict.mockImplementation(() => {
      throw new Error('tools.restrict() cannot name reserved Code Mode presentation transport "run_code"')
    })
    const rule: SeatToolRestrictionRule = { allow: ['run_code'] }

    expect(() => applySeatToolRestriction(ctx, 'target', rule)).toThrow(/seat "target"/)
  })
})

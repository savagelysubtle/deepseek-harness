import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { describe, expect, it } from 'vitest'
import { CLONE_HOOKS_CHECK_ID, CloneCheckError, CloneCheckRegistry } from '../src/clone-checks.ts'

describe('CloneCheckError', () => {
  it('is a SeatMutedByPolicyError carrying a code, the seat and the reason', () => {
    const error = new CloneCheckError('coder-one', 'hooks-path', 'core.hooksPath is set; remove it')
    expect(error).toBeInstanceOf(SeatMutedByPolicyError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('CloneCheckError')
    expect(error.code).toBe('hooks-path')
    expect(error.seat).toBe('coder-one')
    expect(error.reason).toBe('core.hooksPath is set; remove it')
    expect(error.message).toBe('seat coder-one muted by policy: core.hooksPath is set; remove it')
  })
})

describe('CloneCheckRegistry', () => {
  it('registers, finds by id and lists checks per role in registration order', () => {
    const registry = new CloneCheckRegistry()
    expect(registry.has(CLONE_HOOKS_CHECK_ID)).toBe(false)
    expect(registry.checksFor('coder')).toEqual([])
    registry.register({ id: CLONE_HOOKS_CHECK_ID, roles: ['coder'], check: () => undefined })
    registry.register({ id: 'both', roles: ['coder', 'lead'], check: () => undefined })
    expect(registry.has(CLONE_HOOKS_CHECK_ID)).toBe(true)
    expect(registry.checksFor('coder').map(entry => entry.id)).toEqual([CLONE_HOOKS_CHECK_ID, 'both'])
    expect(registry.checksFor('lead').map(entry => entry.id)).toEqual(['both'])
  })

  it('fails loud on a duplicate id', () => {
    const registry = new CloneCheckRegistry()
    registry.register({ id: 'a', roles: ['coder'], check: () => undefined })
    expect(() => { registry.register({ id: 'a', roles: ['lead'], check: () => undefined }) }).toThrow('clone check a is already registered')
  })

  it('keeps its own copy of the roles', () => {
    const registry = new CloneCheckRegistry()
    const roles: ('coder' | 'lead')[] = ['coder']
    registry.register({ id: 'a', roles, check: () => undefined })
    roles.push('lead')
    expect(registry.checksFor('lead')).toEqual([])
  })
})

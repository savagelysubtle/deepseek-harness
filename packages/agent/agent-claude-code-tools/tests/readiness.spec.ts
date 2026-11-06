import { describe, expect, it } from 'vitest'
import { ReadinessRegistry } from '../src/readiness.ts'

describe('ReadinessRegistry notes', () => {
  it('has no notes text by default and notes never change readiness or version', () => {
    const registry = new ReadinessRegistry()
    expect(registry.notesText()).toBe('')
    registry.note('guard-boot-canary', 'canary FAILED attest')
    expect(registry.version).toBe(0)
    expect(registry.readiness().missing).toEqual(['sandbox', 'canary', 'rules-hooks'])
    expect([...registry.readiness().roles]).toEqual(['lead'])
    expect(Object.keys(registry.readiness()).sort()).toEqual(['missing', 'roles'])
  })

  it('renders id: code pairs and replaces by id', () => {
    const registry = new ReadinessRegistry()
    registry.note('a', 'first')
    registry.note('b', 'canary FAILED exit')
    registry.note('a', 'second')
    expect(registry.notesText()).toBe('; a: second; b: canary FAILED exit')
  })

  it('never carries a path, a hash, a line break or a long excerpt', () => {
    const registry = new ReadinessRegistry()
    registry.note('x1', '/home/steve/.dsh/policy/seat-guard.js changed')
    registry.note('x2', 'a'.repeat(64))
    registry.note('x3', 'two\nlines')
    registry.note('x4', 'canary FAILED '.repeat(10))
    registry.note('/bad id/', 'canary FAILED attest')
    const text = registry.notesText()
    expect(text).toBe('; x1: see host log; x2: see host log; x3: see host log; x4: see host log; unknown: canary FAILED attest')
    expect(text).not.toMatch(/\/(?!bad)|[0-9a-f]{24}/)
  })

  it('keeps at most 64 note ids, but still updates a known one', () => {
    const registry = new ReadinessRegistry()
    for (let i = 0; i < 70; i += 1) registry.note(`id-${i}`, 'one')
    expect(registry.notesText().split('; ').length - 1).toBe(64)
    registry.note('id-0', 'two')
    registry.note('id-69', 'dropped')
    expect(registry.notesText()).toContain('id-0: two')
    expect(registry.notesText()).not.toContain('id-69')
  })
})

import { describe, expect, it } from 'vitest'
import { ReadinessRegistry } from '../src/readiness.ts'

describe('ReadinessRegistry notes', () => {
  it('has no notes text by default and notes never change readiness or version', () => {
    const registry = new ReadinessRegistry()
    expect(registry.notesText()).toBe('')
    registry.note('guard-boot-canary', 'canary FAILED exit')
    expect(registry.version).toBe(0)
    expect(registry.readiness().missing).toEqual(['sandbox', 'canary', 'rules-hooks'])
    expect([...registry.readiness().roles]).toEqual(['lead'])
    expect(Object.keys(registry.readiness()).sort()).toEqual(['missing', 'roles'])
  })

  it('renders id: reason pairs, replaces by id, flattens line breaks and caps the length', () => {
    const registry = new ReadinessRegistry()
    registry.note('a', 'first')
    registry.note('b', 'two\r\nlines')
    registry.note('a', 'x'.repeat(500))
    expect(registry.notesText()).toBe(`; a: ${'x'.repeat(300)}; b: two lines`)
  })
})

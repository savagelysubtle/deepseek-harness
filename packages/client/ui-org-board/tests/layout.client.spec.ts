/** Deterministic grid layout: alphabetical order, fixed column wrap. */
import { describe, expect, it } from 'vitest'
import { gridPositions } from '../src/client/layout.ts'

describe('gridPositions', () => {
  it('returns an empty map for no names', () => {
    expect(gridPositions([]).size).toBe(0)
  })

  it('places names in alphabetical reading order regardless of input order', () => {
    const positions = gridPositions(['charlie', 'alfred', 'bruce'])
    const order = ['alfred', 'bruce', 'charlie'].map(name => positions.get(name))
    expect(order[0]).toEqual({ x: 0, y: 0 })
    expect(order[1]).toEqual({ x: 220, y: 0 })
    expect(order[2]).toEqual({ x: 440, y: 0 })
  })

  it('wraps to a new row after 4 columns', () => {
    const names = ['a', 'b', 'c', 'd', 'e']
    const positions = gridPositions(names)
    expect(positions.get('e')).toEqual({ x: 0, y: 130 })
  })

  it('is deterministic across calls with the same input', () => {
    const names = ['zed', 'anna', 'mid']
    expect(gridPositions(names)).toEqual(gridPositions([...names]))
  })
})

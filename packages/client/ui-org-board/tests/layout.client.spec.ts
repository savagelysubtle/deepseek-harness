/** Deterministic grid layout: alphabetical order, fixed column wrap. */
import { describe, expect, it } from 'vitest'
import {
  columnsForWidth, fitWidthZoom, gridPositions, gridWidth, isPhoneWidth, NODE_WIDTH, PHONE_MAX_WIDTH,
} from '../src/client/layout.ts'

describe('gridPositions', () => {
  it('returns an empty map for no names', () => {
    expect(gridPositions([]).size).toBe(0)
  })

  it('places names in alphabetical reading order regardless of input order', () => {
    const positions = gridPositions(['charlie', 'alfred', 'bruce'])
    const order = ['alfred', 'bruce', 'charlie'].map(name => positions.get(name))
    expect(order[0]).toEqual({ x: 0, y: 0 })
    expect(order[1]).toEqual({ x: 232, y: 0 })
    expect(order[2]).toEqual({ x: 464, y: 0 })
  })

  it('wraps to a new row after 4 columns', () => {
    const names = ['a', 'b', 'c', 'd', 'e']
    const positions = gridPositions(names)
    expect(positions.get('e')).toEqual({ x: 0, y: 112 })
  })

  it('honours an explicit column count', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const six = gridPositions(names, 6)
    expect(six.get('f')).toEqual({ x: 1160, y: 0 })
    expect(six.get('g')).toEqual({ x: 0, y: 112 })
    const two = gridPositions(names, 2)
    expect(two.get('b')).toEqual({ x: 232, y: 0 })
    expect(two.get('c')).toEqual({ x: 0, y: 112 })
    const one = gridPositions(names, 1)
    expect(one.get('c')).toEqual({ x: 0, y: 224 })
  })

  it('is deterministic across calls with the same input', () => {
    const names = ['zed', 'anna', 'mid']
    expect(gridPositions(names)).toEqual(gridPositions([...names]))
  })
})

describe('columnsForWidth', () => {
  it('falls back to the default 4 when the width is unmeasured or not a usable number', () => {
    expect(columnsForWidth(0)).toBe(4)
    expect(columnsForWidth(-5)).toBe(4)
    expect(columnsForWidth(Number.NaN)).toBe(4)
    expect(columnsForWidth(Number.POSITIVE_INFINITY)).toBe(4)
  })

  it('picks 2 columns below 640px', () => {
    expect(columnsForWidth(1)).toBe(2)
    expect(columnsForWidth(639)).toBe(2)
  })

  it('picks 4 columns from 640px up to 1199px', () => {
    expect(columnsForWidth(640)).toBe(4)
    expect(columnsForWidth(1199)).toBe(4)
  })

  it('picks 5 columns from 1200px up to 1499px', () => {
    expect(columnsForWidth(1200)).toBe(5)
    expect(columnsForWidth(1284)).toBe(5)
    expect(columnsForWidth(1499)).toBe(5)
  })

  it('picks 6 columns from 1500px', () => {
    expect(columnsForWidth(1500)).toBe(6)
    expect(columnsForWidth(2400)).toBe(6)
  })
})

describe('isPhoneWidth', () => {
  it('is true only for a measured width below the phone limit', () => {
    expect(isPhoneWidth(1)).toBe(true)
    expect(isPhoneWidth(PHONE_MAX_WIDTH - 1)).toBe(true)
    expect(isPhoneWidth(PHONE_MAX_WIDTH)).toBe(false)
    expect(isPhoneWidth(0)).toBe(false)
    expect(isPhoneWidth(-1)).toBe(false)
    expect(isPhoneWidth(Number.NaN)).toBe(false)
    expect(isPhoneWidth(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('gridWidth / fitWidthZoom', () => {
  it('measures the grid from the first card to the last column card', () => {
    expect(gridWidth(1)).toBe(NODE_WIDTH)
    expect(gridWidth(2)).toBe(232 + NODE_WIDTH)
    expect(gridWidth(5)).toBe(4 * 232 + NODE_WIDTH)
  })

  it('fits the grid width into a phone canvas, minus the margins', () => {
    // 2 columns = 440px wide; a 366px canvas leaves 350px after 8px margins.
    expect(fitWidthZoom(366, 2)).toBeCloseTo(350 / 440, 10)
  })

  it('never zooms above 1', () => {
    expect(fitWidthZoom(2000, 2)).toBe(1)
  })
})

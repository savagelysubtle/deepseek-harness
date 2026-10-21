/** How the chart frames itself: whole-layout fit on desktop, width fit from the top-left on a phone. */
import { describe, expect, it, vi } from 'vitest'
import { applyFit, FIT_VIEW_OPTIONS } from '../src/client/fit.ts'
import { bandLayout, columnsForWidth, fitWidthZoom } from '../src/client/layout.ts'

/** The founder 25-seat layout at 5 columns: 3 shelves of 244 plus two 8px gaps. */
const FOUNDER = { width: 1152, height: 748 }

describe('applyFit', () => {
  it('fits the whole layout when it reads at least as large as a width fit (tall, wide canvas)', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 1844, 980, FOUNDER.width, FOUNDER.height)
    expect(target.fitView).toHaveBeenCalledWith(FIT_VIEW_OPTIONS)
    expect(target.setViewport).not.toHaveBeenCalled()
  })

  it('fits the whole layout on a very tall canvas', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 1500, 1200, FOUNDER.width, FOUNDER.height)
    expect(target.fitView).toHaveBeenCalledTimes(1)
    expect(target.setViewport).not.toHaveBeenCalled()
  })

  it('fits the width at full size, centred, top anchored, when the whole board would shrink the cards', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 1284, 590, FOUNDER.width, FOUNDER.height)
    expect(target.fitView).not.toHaveBeenCalled()
    expect(target.setViewport).toHaveBeenCalledWith({ x: (1284 - 1152) / 2, y: 8, zoom: 1 })
  })

  it('shrinks to the width on a narrower desktop canvas and anchors at the left margin', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 1000, 500, FOUNDER.width, FOUNDER.height)
    const zoom = (1000 - 16) / 1152
    expect(target.setViewport).toHaveBeenCalledWith({ x: 8, y: 8, zoom })
  })

  it('fits the whole layout when the canvas is not measured yet (no width, or no height)', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 0, 590, 920, 384)
    applyFit(target, 1284, 0, 920, 384)
    expect(target.fitView).toHaveBeenCalledTimes(2)
    expect(target.setViewport).not.toHaveBeenCalled()
  })

  it('fits to width, top-left anchored, on a phone-width canvas', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 366, 700, 456, 900)
    expect(target.fitView).not.toHaveBeenCalled()
    expect(target.setViewport).toHaveBeenCalledWith({ x: 8, y: 8, zoom: fitWidthZoom(366, 456) })
  })
})

/** The founder's registry shape: 25 seats in 7 bands (2, 6, 4, 4, 4, 4 and 1 unassigned). */
function founderSeats() {
  const band = (department: string | undefined, prefix: string, count: number, leads = 0, test = false) =>
    Array.from({ length: count }, (_, i) => ({
      name: `${prefix}${i + 1}${test ? '-test' : ''}`, lead: i < leads, department,
    }))
  return [
    ...band('Alpha', 'a', 2, 1), ...band('Bravo', 'b', 6, 1), ...band('Charlie', 'c', 4, 1), ...band('Delta', 'd', 4, 1),
    ...band('Echo', 'e', 4), ...band('Foxtrot', 'f', 4, 1, true), ...band(undefined, 'u', 1),
  ]
}

describe('legibility at the founder screen size', () => {
  it('lays the 25 seats in 7 bands on 3 shelves at 5 columns, 1152x748', () => {
    const layout = bandLayout(founderSeats(), columnsForWidth(1284))
    expect(founderSeats()).toHaveLength(25)
    expect(columnsForWidth(1284)).toBe(5)
    expect(new Set(layout.bands.map(band => band.y)).size).toBe(3)
    expect([layout.width, layout.height]).toEqual([FOUNDER.width, FOUNDER.height])
  })

  it('keeps full-size cards (zoom 1.0) on the 1284x590 dialog canvas', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 1284, 590, FOUNDER.width, FOUNDER.height)
    expect(target.setViewport.mock.calls[0]?.[0]).toMatchObject({ zoom: 1, y: 8 })
  })
})

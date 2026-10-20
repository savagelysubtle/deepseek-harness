/** How the chart frames itself: whole-grid fit on desktop, width fit from the top-left on a phone. */
import { describe, expect, it, vi } from 'vitest'
import { applyFit, FIT_VIEW_OPTIONS } from '../src/client/fit.ts'
import {
  columnsForWidth, fitWidthZoom, gridWidth, ROW_HEIGHT,
} from '../src/client/layout.ts'

describe('applyFit', () => {
  it('fits the whole grid on a desktop-width canvas', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 1284, 5)
    expect(target.fitView).toHaveBeenCalledWith(FIT_VIEW_OPTIONS)
    expect(target.setViewport).not.toHaveBeenCalled()
  })

  it('fits the whole grid when the canvas is not measured yet', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 0, 4)
    expect(target.fitView).toHaveBeenCalledTimes(1)
    expect(target.setViewport).not.toHaveBeenCalled()
  })

  it('fits to width, top-left anchored, on a phone-width canvas', () => {
    const target = { fitView: vi.fn(), setViewport: vi.fn() }
    applyFit(target, 366, 2)
    expect(target.fitView).not.toHaveBeenCalled()
    expect(target.setViewport).toHaveBeenCalledWith({ x: 8, y: 8, zoom: fitWidthZoom(366, 2) })
  })
})

describe('legibility at the founder screen size', () => {
  it('keeps 25 seats at >= 0.95 scale on a 1284x592 canvas with 0.08 padding', () => {
    const columns = columnsForWidth(1284)
    const rows = Math.ceil(25 / columns)
    // A tall card (name row + two chip rows) is ~88px.
    const usable = (viewport: number) => viewport / 1.08
    const widthScale = usable(1284) / gridWidth(columns)
    const heightScale = usable(592) / ((rows - 1) * ROW_HEIGHT + 88)
    expect(columns).toBe(5)
    expect(Math.min(widthScale, heightScale)).toBeGreaterThanOrEqual(0.95)
  })
})

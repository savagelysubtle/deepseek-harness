// @vitest-environment jsdom
/** The canvas-width hook: ResizeObserver-driven column count, with a safe default when there is no observer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useCanvasColumns } from '../src/client/use-canvas-columns.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Probe({ show = true }: { show?: boolean }) {
  const {
    ref, columns, width, height, measured,
  } = useCanvasColumns()
  return (
    <div>
      {show && <div ref={ref} data-testid="wrap" />}
      <span data-testid="columns">{columns}</span>
      <span data-testid="size">{`${width}x${height}|${measured}`}</span>
    </div>
  )
}

function setWidth(width: number, height = 0): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => height })
}

describe('useCanvasColumns', () => {
  it('reads the size once and stays put when there is no ResizeObserver (jsdom)', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    setWidth(1200)
    render(<Probe />)
    // Measured once (1200 -> 5): the absent observer only means no LIVE updates.
    expect(screen.getByTestId('columns').textContent).toBe('5')
    expect(screen.getByTestId('size').textContent).toBe('1200x0|true')
  })

  it('defaults to 4 when the width is unmeasured (0) and no observer exists', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    setWidth(0)
    render(<Probe />)
    expect(screen.getByTestId('columns').textContent).toBe('4')
    expect(screen.getByTestId('size').textContent).toBe('0x0|true')
  })

  it('tracks width changes through the ResizeObserver and disconnects on unmount', () => {
    let notify: () => void = () => {}
    const disconnect = vi.fn()
    const observe = vi.fn()
    class Observer {
      constructor(callback: () => void) { notify = callback }
      observe = observe
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', Observer)
    setWidth(500)
    const view = render(<Probe />)
    expect(screen.getByTestId('columns').textContent).toBe('2')
    expect(observe).toHaveBeenCalledTimes(1)
    setWidth(700)
    act(() => { notify() })
    expect(screen.getByTestId('columns').textContent).toBe('4')
    setWidth(1600, 600)
    act(() => { notify() })
    expect(screen.getByTestId('columns').textContent).toBe('6')
    expect(screen.getByTestId('size').textContent).toBe('1600x600|true')
    // A height-only change is reported too (the drift panel shrinking the chart).
    setWidth(1600, 500)
    act(() => { notify() })
    expect(screen.getByTestId('size').textContent).toBe('1600x500|true')
    view.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('does nothing while the container is not mounted', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    render(<Probe show={false} />)
    expect(screen.getByTestId('columns').textContent).toBe('4')
    expect(screen.getByTestId('size').textContent).toBe('0x0|false')
  })
})

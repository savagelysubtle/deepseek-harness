/**
 * Reads the canvas container's size: the width becomes a grid column count,
 * and any width OR height change is reported so the chart can refit. Without a
 * `ResizeObserver` (jsdom, very old engines) the size is read once and never
 * updates.
 */
import { useCallback, useEffect, useState } from 'react'
import { columnsForWidth } from './layout.ts'

/** What the hook reports about the container. */
export interface CanvasSize {
  /** Callback ref for the container. */
  ref: (element: HTMLElement | null) => void
  /** Grid column count for the current width. */
  columns: number
  /** Container width in px (0 until measured). */
  width: number
  /** Container height in px (0 until measured). */
  height: number
  /** True once the container has been measured at least once. */
  measured: boolean
}

/**
 * Measure a container and derive the board's column count.
 * @returns the callback ref and the measured size.
 */
export function useCanvasColumns(): CanvasSize {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const [measured, setMeasured] = useState(false)
  const ref = useCallback((node: HTMLElement | null) => { setElement(node) }, [])

  useEffect(() => {
    if (element === null) return undefined
    const measure = () => {
      setWidth(element.clientWidth)
      setHeight(element.clientHeight)
      setMeasured(true)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [element])

  return { ref, columns: columnsForWidth(width), width, height, measured }
}

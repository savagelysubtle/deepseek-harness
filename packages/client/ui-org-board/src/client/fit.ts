/**
 * How the chart frames itself. Desktop fits the whole grid; a phone fits to
 * WIDTH from the top-left (a whole-grid fit would clamp at the minimum zoom and
 * still crop, with rows too small to read), and the user pans down.
 */
import type { FitViewOptions } from '@xyflow/react'
import { FIT_ANCHOR, fitWidthZoom, isPhoneWidth } from './layout.ts'

/** Roomy enough to read the chips, never zoomed past 1.2x. */
export const FIT_VIEW_OPTIONS: FitViewOptions = { padding: 0.08, minZoom: 0.6, maxZoom: 1.2 }

/** The slice of React Flow's instance the fit needs. */
export interface FitTarget {
  fitView: (options: FitViewOptions) => unknown
  setViewport: (viewport: { x: number; y: number; zoom: number }) => unknown
}

/**
 * Frame the chart for the canvas's current width.
 * @param target - React Flow's instance.
 * @param width - the canvas container's width in px.
 * @param columns - columns in the current grid.
 */
export function applyFit(target: FitTarget, width: number, columns: number): void {
  if (isPhoneWidth(width)) {
    void target.setViewport({ x: FIT_ANCHOR, y: FIT_ANCHOR, zoom: fitWidthZoom(width, columns) })
    return
  }
  void target.fitView(FIT_VIEW_OPTIONS)
}

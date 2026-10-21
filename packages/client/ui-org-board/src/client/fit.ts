/**
 * How the chart frames itself. Desktop fits the whole layout when that stays
 * legible, otherwise fits the WIDTH and lets the user scroll down; a phone fits
 * to WIDTH from the top-left (a whole-layout fit would clamp at the minimum zoom
 * and still crop, with bands too small to read), and the user pans down.
 */
import type { FitViewOptions } from '@xyflow/react'
import { FIT_ANCHOR, fitWidthZoom, isPhoneWidth } from './layout.ts'

const FIT_PADDING = 0.08
const FIT_MAX_ZOOM = 1.2
/** Whole-board fit: roomy enough to read the chips, never zoomed past 1.2x. */
export const FIT_VIEW_OPTIONS: FitViewOptions = { padding: FIT_PADDING, minZoom: 0.6, maxZoom: FIT_MAX_ZOOM }

/** The slice of React Flow's instance the fit needs. */
export interface FitTarget {
  fitView: (options: FitViewOptions) => unknown
  setViewport: (viewport: { x: number; y: number; zoom: number }) => unknown
}

/**
 * Frame the chart for the canvas's current size. A phone fits to width. A
 * desktop fits the whole board when that is at least as large as a width fit;
 * otherwise it fits the WIDTH (cards at full size, centred) and anchors the
 * top, so the user scrolls down through the shelves rather than reading
 * shrunken chips.
 * @param target - React Flow's instance.
 * @param width - the canvas container's width in px.
 * @param height - the canvas container's height in px.
 * @param layoutWidth - the layout's content width in px (see `bandLayout`).
 * @param layoutHeight - the layout's content height in px.
 */
export function applyFit(
  target: FitTarget,
  width: number,
  height: number,
  layoutWidth: number,
  layoutHeight: number,
): void {
  if (isPhoneWidth(width)) {
    void target.setViewport({ x: FIT_ANCHOR, y: FIT_ANCHOR, zoom: fitWidthZoom(width, layoutWidth) })
    return
  }
  // Not measured yet: let fitView queue until the nodes are.
  if (!(width > 0 && height > 0)) {
    void target.fitView(FIT_VIEW_OPTIONS)
    return
  }
  const keep = 1 - 2 * FIT_PADDING
  const wholeZoom = Math.min(FIT_MAX_ZOOM, (width * keep) / layoutWidth, (height * keep) / layoutHeight)
  const widthZoom = fitWidthZoom(width, layoutWidth)
  if (wholeZoom >= widthZoom) {
    void target.fitView(FIT_VIEW_OPTIONS)
    return
  }
  void target.setViewport({ x: Math.max(FIT_ANCHOR, (width - layoutWidth * widthZoom) / 2), y: FIT_ANCHOR, zoom: widthZoom })
}

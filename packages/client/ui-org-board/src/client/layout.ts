/**
 * Deterministic grid layout: the registry carries no seat positions, and
 * dragging seats around is deliberately not offered -- there is nowhere to
 * persist an arrangement, so it would be lost on every reload. Seats are
 * placed in a fixed alphabetical grid rather than pulling in an auto-layout
 * dependency for one board's worth of graph.
 */

/** Default node columns before wrapping to the next row. */
const COLUMNS = 4
/** Seat card width in canvas px (the `.node` width in OrgBoard.module.css). */
export const NODE_WIDTH = 208
/** Canvas widths below this are a phone: fit to width instead of whole. */
export const PHONE_MAX_WIDTH = 640
/** Breathing room around the grid when fitting to width, in px. */
const PHONE_MARGIN = 8
/** Horizontal spacing between column origins, in canvas px. */
const COLUMN_WIDTH = 232
/** Vertical spacing between row origins, in canvas px. */
export const ROW_HEIGHT = 112

/** One seat's canvas position. */
export interface GridPosition {
  x: number
  y: number
}

/**
 * Place every name in reading-order alphabetical grid cells.
 * @param names - seat names (registry key order is not meaningful; sorted for a stable layout).
 * @param columns - columns before wrapping (default 4; see {@link columnsForWidth}).
 * @returns name → position, one entry per input name (duplicates collapse to their last position).
 */
export function gridPositions(names: readonly string[], columns: number = COLUMNS): Map<string, GridPosition> {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const positions = new Map<string, GridPosition>()
  sorted.forEach((name, index) => {
    positions.set(name, {
      x: (index % columns) * COLUMN_WIDTH,
      y: Math.floor(index / columns) * ROW_HEIGHT,
    })
  })
  return positions
}

/**
 * Pick a column count for the canvas's measured width, so a wide screen
 * gets a wide grid and a phone gets a tall narrow one. The steps are set so a
 * ~25-seat board still fits at a readable scale: past 1200px a 5-column grid
 * is 1136px wide, and 6 columns (1368px) is only used from 1500px.
 * @param width - the canvas container's width in px (0 / non-finite when not yet measured).
 * @returns 6 columns from 1500px, 5 from 1200px, 4 from 640px, otherwise 2; the default 4 when unmeasured.
 */
export function columnsForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return COLUMNS
  if (width >= 1500) return 6
  if (width >= 1200) return 5
  if (width >= PHONE_MAX_WIDTH) return 4
  return 2
}

/**
 * Whether a measured canvas width is a phone (measured, and narrower than {@link PHONE_MAX_WIDTH}).
 * @param width - the canvas container's width in px.
 * @returns true for a measured width below the phone limit.
 */
export function isPhoneWidth(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < PHONE_MAX_WIDTH
}

/**
 * Natural width of the grid in canvas px for a column count.
 * @param columns - columns in the grid.
 * @returns the left edge of the first card to the right edge of the last column's card.
 */
export function gridWidth(columns: number): number {
  return (columns - 1) * COLUMN_WIDTH + NODE_WIDTH
}

/**
 * Zoom that fits the grid's WIDTH into the canvas (never above 1), leaving a small margin each side.
 * @param canvasWidth - the canvas container's width in px.
 * @param columns - columns in the grid.
 * @returns the zoom factor.
 */
export function fitWidthZoom(canvasWidth: number, columns: number): number {
  return Math.min(1, (canvasWidth - PHONE_MARGIN * 2) / gridWidth(columns))
}

/** Top-left offset the width fit anchors the grid at, in screen px. */
export const FIT_ANCHOR = PHONE_MARGIN

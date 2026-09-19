/**
 * Deterministic grid layout: the registry carries no seat positions, and
 * dragging seats around is deliberately not offered -- there is nowhere to
 * persist an arrangement, so it would be lost on every reload. Seats are
 * placed in a fixed alphabetical grid rather than pulling in an auto-layout
 * dependency for one board's worth of graph.
 */

/** Node columns before wrapping to the next row. */
const COLUMNS = 4
/** Horizontal spacing between column origins, in canvas px. */
const COLUMN_WIDTH = 220
/** Vertical spacing between row origins, in canvas px. */
const ROW_HEIGHT = 130

/** One seat's canvas position. */
export interface GridPosition {
  x: number
  y: number
}

/**
 * Place every name in reading-order alphabetical grid cells.
 * @param names - seat names (registry key order is not meaningful; sorted for a stable layout).
 * @returns name → position, one entry per input name (duplicates collapse to their last position).
 */
export function gridPositions(names: readonly string[]): Map<string, GridPosition> {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const positions = new Map<string, GridPosition>()
  sorted.forEach((name, index) => {
    positions.set(name, {
      x: (index % COLUMNS) * COLUMN_WIDTH,
      y: Math.floor(index / COLUMNS) * ROW_HEIGHT,
    })
  })
  return positions
}

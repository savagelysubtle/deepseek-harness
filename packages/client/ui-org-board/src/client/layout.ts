/**
 * Deterministic department-band layout: the registry carries no seat
 * positions, and dragging seats around is deliberately not offered -- there is
 * nowhere to persist an arrangement, so it would be lost on every reload.
 * Seats are grouped into one bordered band per department (a comms grouping,
 * not rank), bands are packed onto shelves of whole columns, and the lead
 * card is simply first in its band. No auto-layout dependency is pulled in
 * for one board's worth of graph.
 */

/** Default node columns before wrapping to the next row. */
const COLUMNS = 4
/** Seat card width in canvas px (the `.node` width in OrgBoard.module.css). */
export const NODE_WIDTH = 208
/** Canvas widths below this are a phone: fit to width instead of whole. */
export const PHONE_MAX_WIDTH = 640
/** Breathing room around the layout when fitting to width, in px. */
const PHONE_MARGIN = 8
/** Horizontal spacing between column origins, in canvas px. */
const COLUMN_WIDTH = 232
/** Vertical spacing between row origins, in canvas px. */
export const ROW_HEIGHT = 112

/** Padding inside a band box, in canvas px. */
export const BAND_PAD = 8
/** Height of a band's title row, in canvas px. */
export const BAND_TITLE_H = 28
/** Vertical gap between shelves of bands, in canvas px. */
export const BAND_SHELF_GAP = 8
/** Height of the tallest seat card (name row plus two chip rows), in canvas px. */
export const CARD_H = 88
/** Horizontal gap between adjacent band boxes, in canvas px (a band is whole columns minus this). */
const COLUMN_GAP = 8

/** One seat's canvas position. */
export interface SeatPosition {
  x: number
  y: number
}

/** The seat fields the band layout reads. */
export interface BandSeat {
  name: string
  lead?: boolean | undefined
  department?: string | undefined
}

/** One department band's box and members. */
export interface Band {
  /** Stable id; never collides between a real department and the unassigned group. */
  key: string
  /** The department name, or `null` for the unassigned group (the UI localises it). */
  title: string | null
  count: number
  x: number
  y: number
  width: number
  height: number
  /** Member names in display order (leads first, then alphabetical). */
  seatNames: string[]
}

/** The whole board's layout. */
export interface BandLayout {
  seats: Map<string, SeatPosition>
  bands: Band[]
  width: number
  height: number
}

const UNASSIGNED_KEY = 'unassigned'

/** Working record for one band while packing. */
interface Packed {
  key: string
  title: string | null
  names: string[]
  w: number
  rows: number
  x: number
  y: number
}

const bandHeight = (rows: number): number => BAND_TITLE_H + 2 * BAND_PAD + (rows - 1) * ROW_HEIGHT + CARD_H

/**
 * Group seats into department bands and pack the bands onto shelves.
 * @param seats - every seat (registry key order is not meaningful; sorted for a stable layout).
 * @param columns - canvas columns (see {@link columnsForWidth}).
 * @returns seat positions, band boxes, and the content width / height.
 */
export function bandLayout(seats: ReadonlyArray<BandSeat>, columns: number): BandLayout {
  const groups = new Map<string, { title: string | null; members: BandSeat[] }>()
  for (const seat of seats) {
    const title = seat.department?.trim() ?? ''
    const key = title === '' ? UNASSIGNED_KEY : `dept:${title}`
    const group = groups.get(key) ?? { title: title === '' ? null : title, members: [] }
    group.members.push(seat)
    groups.set(key, group)
  }
  const maxBandCols = columns >= 4 ? Math.ceil(columns / 2) : columns
  const ordered = [...groups.entries()].sort(([, a], [, b]) => {
    if (a.title === null) return 1
    if (b.title === null) return -1
    return a.title.localeCompare(b.title)
  })
  const packed: Packed[] = ordered.map(([key, group]) => {
    const members = [...group.members].sort((a, b) => {
      if ((a.lead === true) !== (b.lead === true)) return a.lead === true ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    const w = Math.min(Math.ceil(members.length / 2), maxBandCols)
    return { key, title: group.title, names: members.map(m => m.name), w, rows: Math.ceil(members.length / w), x: 0, y: 0 }
  })

  const shelves: Packed[][] = []
  let current: Packed[] = []
  let used = 0
  for (const band of packed) {
    if (used + band.w > columns) {
      shelves.push(current)
      current = []
      used = 0
    }
    current.push(band)
    used += band.w
  }
  if (current.length > 0) shelves.push(current)

  let y = 0
  let width = 0
  for (const shelf of shelves) {
    const leftover = columns - shelf.reduce((sum, band) => sum + band.w, 0)
    // Only a UNIQUE tallest band can shorten the shelf; widening one of
    // several equally tall bands would change nothing but the shape.
    const maxRows = Math.max(...shelf.map(band => band.rows))
    const tallest = shelf.filter(band => band.rows === maxRows)
    const lone = tallest.length === 1 ? tallest[0] : undefined
    if (lone !== undefined) {
      const rows = Math.ceil(lone.names.length / Math.min(lone.w + leftover, lone.names.length))
      if (rows < lone.rows) {
        lone.rows = rows
        lone.w = Math.ceil(lone.names.length / rows)
      }
    }
    let col = 0
    for (const band of shelf) {
      band.x = col * COLUMN_WIDTH
      band.y = y
      col += band.w
    }
    width = Math.max(width, col * COLUMN_WIDTH - COLUMN_GAP)
    y += Math.max(...shelf.map(band => bandHeight(band.rows))) + BAND_SHELF_GAP
  }

  const positions = new Map<string, SeatPosition>()
  const bands: Band[] = []
  for (const band of packed) {
    band.names.forEach((name, index) => {
      positions.set(name, {
        x: band.x + BAND_PAD + (index % band.w) * COLUMN_WIDTH,
        y: band.y + BAND_TITLE_H + BAND_PAD + Math.floor(index / band.w) * ROW_HEIGHT,
      })
    })
    bands.push({
      key: band.key,
      title: band.title,
      count: band.names.length,
      x: band.x,
      y: band.y,
      width: band.w * COLUMN_WIDTH - COLUMN_GAP,
      height: bandHeight(band.rows),
      seatNames: band.names,
    })
  }
  return { seats: positions, bands, width, height: shelves.length === 0 ? 0 : y - BAND_SHELF_GAP }
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
 * Zoom that fits the layout's WIDTH into the canvas (never above 1), leaving a small margin each side.
 * @param canvasWidth - the canvas container's width in px.
 * @param contentWidth - the layout's content width in px (see {@link bandLayout}).
 * @returns the zoom factor.
 */
export function fitWidthZoom(canvasWidth: number, contentWidth: number): number {
  return Math.min(1, (canvasWidth - PHONE_MARGIN * 2) / contentWidth)
}

/** Top-left offset the width fit anchors the grid at, in screen px. */
export const FIT_ANCHOR = PHONE_MARGIN

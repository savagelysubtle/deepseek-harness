/** Department-band layout: grouping, ordering, shelf packing, and the width-based fit zoom. */
import { describe, expect, it } from 'vitest'
import {
  BAND_PAD, BAND_SHELF_GAP, BAND_TITLE_H, bandLayout, CARD_H, columnsForWidth, fitWidthZoom, isPhoneWidth,
  PHONE_MAX_WIDTH, ROW_HEIGHT,
} from '../src/client/layout.ts'

/** `count` seats in one department, named `<prefix>01`.. so alphabetical order is index order. */
const dept = (department: string | undefined, prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `${prefix}${String(i + 1).padStart(2, '0')}`, department }))

describe('bandLayout constants', () => {
  it('derives the documented band heights', () => {
    expect(BAND_TITLE_H + 2 * BAND_PAD + CARD_H).toBe(132)
    expect(BAND_TITLE_H + 2 * BAND_PAD + ROW_HEIGHT + CARD_H).toBe(244)
    expect(BAND_TITLE_H + 2 * BAND_PAD + 2 * ROW_HEIGHT + CARD_H).toBe(356)
  })
})

describe('bandLayout grouping and order', () => {
  it('returns empty maps and zero size for no seats', () => {
    const layout = bandLayout([], 5)
    expect(layout.seats.size).toBe(0)
    expect(layout.bands).toEqual([])
    expect(layout.width).toBe(0)
    expect(layout.height).toBe(0)
  })

  it('orders bands alphabetically with Unassigned last, whatever the input order', () => {
    const layout = bandLayout([
      { name: 'u1' }, { name: 'z1', department: 'Zeta' }, { name: 'a1', department: 'alpha' }, { name: 'm1', department: 'Mid' },
    ], 5)
    expect(layout.bands.map(band => band.title)).toEqual(['alpha', 'Mid', 'Zeta', null])
    expect(layout.bands.map(band => band.key)).toEqual(['dept:alpha', 'dept:Mid', 'dept:Zeta', 'unassigned'])
  })

  it('puts lead seats first, each group alphabetical', () => {
    const layout = bandLayout([
      { name: 'zed', lead: true, department: 'Ops' },
      { name: 'bob', department: 'Ops' },
      { name: 'amy', lead: true, department: 'Ops' },
      { name: 'cat', lead: false, department: 'Ops' },
    ], 5)
    expect(layout.bands[0]?.seatNames).toEqual(['amy', 'zed', 'bob', 'cat'])
  })

  it('trims department names and treats a blank one as no department', () => {
    const layout = bandLayout([
      { name: 'a', department: ' Ops ' }, { name: 'b', department: 'Ops' }, { name: 'c', department: '   ' }, { name: 'd', department: '' },
    ], 5)
    expect(layout.bands.map(band => [band.title, band.count])).toEqual([['Ops', 2], [null, 2]])
  })

  it('keeps a department literally named Unassigned apart from the no-department group', () => {
    const layout = bandLayout([{ name: 'a', department: 'Unassigned' }, { name: 'b' }], 5)
    expect(layout.bands.map(band => [band.key, band.title])).toEqual([['dept:Unassigned', 'Unassigned'], ['unassigned', null]])
  })

  it('lays out an all-Unassigned board as one band', () => {
    const layout = bandLayout([{ name: 'b' }, { name: 'a' }], 5)
    expect(layout.bands).toHaveLength(1)
    expect(layout.bands[0]).toMatchObject({ key: 'unassigned', title: null, count: 2, seatNames: ['a', 'b'] })
  })
})

describe('bandLayout sizing', () => {
  // [seats, columns, expected band columns, expected rows]. A lone band is
  // then widened by the leftover-column grant, so these are the final sizes.
  const cases: Array<[number, number, number, number]> = [
    [1, 5, 1, 1], [2, 5, 2, 1], [5, 5, 5, 1], [8, 5, 4, 2],
    [1, 4, 1, 1], [2, 4, 2, 1], [5, 4, 3, 2], [8, 4, 4, 2],
    [1, 2, 1, 1], [2, 2, 2, 1], [5, 2, 2, 3], [8, 2, 2, 4],
  ]
  it.each(cases)('sizes a single band of %i seats at %i columns as %i wide x %i rows', (n, columns, w, rows) => {
    const [band] = bandLayout(dept('Ops', 's', n), columns).bands
    expect(band?.width).toBe(w * 232 - 8)
    expect(band?.height).toBe(BAND_TITLE_H + 2 * BAND_PAD + (rows - 1) * ROW_HEIGHT + CARD_H)
  })

  it('reports the single band as the whole content size', () => {
    const layout = bandLayout(dept('Ops', 's', 2), 5)
    expect(layout.width).toBe(456)
    expect(layout.height).toBe(132)
  })
})

describe('bandLayout shelves', () => {
  it('starts a new shelf when the next band no longer fits the columns', () => {
    // C=5: Alpha 2 seats (1 col), Bravo 6 (3 cols), Charlie 4 (2 cols) -> 1+3+2 > 5.
    const layout = bandLayout([...dept('Alpha', 'a', 2), ...dept('Bravo', 'b', 6), ...dept('Charlie', 'c', 4)], 5)
    const [alpha, bravo, charlie] = layout.bands
    expect([alpha?.x, alpha?.y, alpha?.width]).toEqual([0, 0, 224])
    expect([bravo?.x, bravo?.y, bravo?.width]).toEqual([232, 0, 688])
    // Shelf 1 is Bravo's two rows (244) tall, plus the gap.
    expect([charlie?.x, charlie?.y]).toEqual([0, 244 + BAND_SHELF_GAP])
    // Charlie is alone on shelf 2, so the grant widens it to one row (132).
    expect(charlie?.width).toBe(4 * 232 - 8)
    expect(layout.height).toBe(244 + BAND_SHELF_GAP + 132)
    expect(layout.width).toBe(4 * 232 - 8)
  })

  it('gives leftover columns to the tallest band when that removes a row', () => {
    // C=4: Alpha 5 seats (2 cols, 3 rows) + Bravo 2 seats (1 col, 2 rows): 1 column is left over.
    const layout = bandLayout([...dept('Alpha', 'a', 5), ...dept('Bravo', 'b', 2)], 4)
    const [alpha, bravo] = layout.bands
    expect(alpha?.width).toBe(3 * 232 - 8)
    expect(alpha?.height).toBe(244)
    expect(bravo?.x).toBe(3 * 232)
    expect(layout.height).toBe(244)
  })

  it('does not widen one of several equally tall bands', () => {
    // C=5: Alpha 2 seats and Bravo 6 seats are both 2 rows; widening Alpha would not shorten the shelf.
    const layout = bandLayout([...dept('Alpha', 'a', 2), ...dept('Bravo', 'b', 6)], 5)
    expect(layout.bands[0]?.width).toBe(232 - 8)
  })

  it('leaves the columns alone when a grant would not remove a row', () => {
    // C=5: Alpha 6 seats (3 cols, 2 rows) + Bravo 2 seats (1 col): widening Alpha to 4 is still 2 rows.
    const layout = bandLayout([...dept('Alpha', 'a', 6), ...dept('Bravo', 'b', 2)], 5)
    expect(layout.bands[0]?.width).toBe(3 * 232 - 8)
    expect(layout.bands[1]?.x).toBe(3 * 232)
  })

  it('places the 25-seat founder shape on three shelves at five columns', () => {
    const seats = [
      ...dept('Alpha', 'a', 2), ...dept('Bravo', 'b', 6), ...dept('Charlie', 'c', 4), ...dept('Delta', 'd', 4),
      ...dept('Echo', 'e', 4), ...dept('Foxtrot', 'f', 4), ...dept(undefined, 'u', 1),
    ]
    const layout = bandLayout(seats, 5)
    expect([...new Set(layout.bands.map(band => band.y))]).toEqual([0, 252, 504])
    expect(layout.width).toBe(1152)
    expect(layout.height).toBe(3 * 244 + 2 * BAND_SHELF_GAP)
  })
})

describe('bandLayout seat positions', () => {
  it('places seats inside the band, left to right then wrapping to the next row', () => {
    // C=4, 5 seats -> a 3-wide, 2-row band after the grant.
    const layout = bandLayout(dept('Ops', 's', 5), 4)
    const at = (name: string) => layout.seats.get(name)
    const top = BAND_TITLE_H + BAND_PAD
    expect(at('s01')).toEqual({ x: BAND_PAD, y: top })
    expect(at('s02')).toEqual({ x: BAND_PAD + 232, y: top })
    expect(at('s03')).toEqual({ x: BAND_PAD + 464, y: top })
    expect(at('s04')).toEqual({ x: BAND_PAD, y: top + ROW_HEIGHT })
    expect(at('s05')).toEqual({ x: BAND_PAD + 232, y: top + ROW_HEIGHT })
  })

  it('offsets seats by their band origin', () => {
    const layout = bandLayout([...dept('Alpha', 'a', 2), ...dept('Bravo', 'b', 6), ...dept('Charlie', 'c', 4)], 5)
    expect(layout.seats.get('b01')).toEqual({ x: 232 + BAND_PAD, y: BAND_TITLE_H + BAND_PAD })
    expect(layout.seats.get('c01')).toEqual({ x: BAND_PAD, y: 252 + BAND_TITLE_H + BAND_PAD })
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

describe('fitWidthZoom', () => {
  it('fits the layout width into a phone canvas, minus the margins', () => {
    // A 440px-wide layout in a 366px canvas leaves 350px after 8px margins.
    expect(fitWidthZoom(366, 440)).toBeCloseTo(350 / 440, 10)
  })

  it('never zooms above 1', () => {
    expect(fitWidthZoom(2000, 440)).toBe(1)
  })
})

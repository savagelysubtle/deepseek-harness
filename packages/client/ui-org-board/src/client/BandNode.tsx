/**
 * Custom React Flow node: one department band's backdrop surface. Purely
 * decorative and non-interactive -- the seats sit on top of it as their own
 * nodes. A department is a comms grouping, not rank, so the surface carries
 * only its title and seat count. Labels arrive already localised in `data`
 * (like {@link SeatNode}), so the node needs no translate hook.
 */
import type { Node, NodeProps } from '@xyflow/react'
import clsx from 'clsx'
import css from './OrgBoard.module.css'

/** Data carried by every band node; must satisfy React Flow's `Record<string, unknown>` node-data bound. */
export interface BandNodeData extends Record<string, unknown> {
  /** Department name, or the localised Unassigned label. */
  title: string
  /** Localised "N seats" text. */
  countLabel: string
  /** True when a filter is active and no seat in this band matches it. */
  dimmed: boolean
}

/** The band node type this board registers. */
export type BandNodeType = Node<BandNodeData, 'band'>

/**
 * Render one band surface.
 * @param props - React Flow's node props; `data` is {@link BandNodeData}.
 * @returns the band surface with its title row.
 */
export function BandNode({ data }: NodeProps<BandNodeType>) {
  const { title, countLabel, dimmed } = data
  return (
    <div className={clsx(css.band, dimmed && css.nodeDimmed)} aria-hidden="true">
      <div className={css.bandTitleRow}>
        <span className={css.bandTitle}>{title}</span>
        <span className={css.bandCount}>{countLabel}</span>
      </div>
    </div>
  )
}

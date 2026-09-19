/**
 * Custom React Flow node: a seat's name plus its distinguishing badge row
 * (lead / test seat / not fully served / may mail anyone). Selection state
 * is NOT React Flow's own built-in `selected` flag — the board owns which
 * seat is selected (so a click can also drive the side detail panel) and
 * passes that decision down through `data.selected`.
 */
import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import clsx from 'clsx'
import css from './OrgBoard.module.css'
import type { SeatBadge } from './derive.ts'

/** Data carried by every seat node; must satisfy React Flow's `Record<string, unknown>` node-data bound. */
export interface SeatNodeData extends Record<string, unknown> {
  name: string
  badges: readonly SeatBadge[]
  selected: boolean
}

/** The one custom node type this board registers. */
export type SeatNodeType = Node<SeatNodeData, 'seat'>

// `string | undefined` is what the CSS-module declaration honestly provides: a class
// name may be absent. The mapped key type still forces every badge kind to appear, so a
// new kind is a compile error here rather than a silently unstyled badge. `clsx` below
// drops an absent one.
const BADGE_CLASS: Record<SeatBadge['kind'], string | undefined> = {
  lead: css.badgeLead,
  test: css.badgeTest,
  unserved: css.badgeUnserved,
  callUp: css.badgeCallUp,
}

/**
 * Render one seat node.
 * @param props - React Flow's node props; `data` is {@link SeatNodeData}.
 * @returns the node card.
 */
export function SeatNode({ data }: NodeProps<SeatNodeType>) {
  const { name, badges, selected } = data
  const unserved = badges.some(badge => badge.kind === 'unserved')
  return (
    <div className={clsx(css.node, selected && css.nodeSelected, unserved && css.nodeUnserved)}>
      {/* Registry edges are undirected; every node needs both handle types
          since it may play either side of any [from, to] pair. */}
      <Handle type="target" position={Position.Left} className={css.handle} />
      <Handle type="source" position={Position.Right} className={css.handle} />
      <div className={css.nodeName}>{name}</div>
      {badges.length > 0 && (
        <div className={css.badgeRow}>
          {badges.map(badge => (
            <span key={badge.kind} className={clsx(css.badge, BADGE_CLASS[badge.kind])}>{badge.label}</span>
          ))}
        </div>
      )}
    </div>
  )
}

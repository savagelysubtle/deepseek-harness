/**
 * The board's whole body: profile line, drift summary, and the seat graph +
 * detail panel. Every failure state below has ITS OWN visible reason — the
 * hard requirement this slice exists to satisfy is that a failure must never
 * render as emptiness (an unreadable registry must never look like "no
 * seats") and must never render as a clean board (an unreadable roster must
 * suppress the drift verdict, not let it read as "nothing to report").
 *
 * `useState` is the only Hook this component calls, and it is called
 * unconditionally before every early return — every other value below is a
 * plain computed constant, not a Hook, so there is no Rules-of-Hooks hazard
 * from the status branches returning early.
 */
import { useState } from 'react'
import { Background, ReactFlow } from '@xyflow/react'
import type { Edge } from '@xyflow/react'
import './xyflow-base.module.css'
import css from './OrgBoard.module.css'
import type { OrgBoardState } from './org-board-store.ts'
import {
  driftLists, missingRosterLabels, seatBadges, seatNamesOf, servedRosterLabels, unservedByName,
  type DriftLists, type OrgBoardTranslate,
} from './derive.ts'
import { gridPositions } from './layout.ts'
import { SeatNode, type SeatNodeType } from './SeatNode.tsx'

const NODE_TYPES = { seat: SeatNode }

/** Props for the board body rendered inside the modal. */
export interface OrgBoardProps {
  state: OrgBoardState
  t: OrgBoardTranslate
}

/**
 * Render the org board body.
 * @param props - the latest `org.get` snapshot and the bound translate.
 * @returns the status banner, or the full board once a response has landed.
 */
export function OrgBoard({ state, t }: OrgBoardProps) {
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null)

  if (state.status === 'error') {
    return (
      <div className={css.content}>
        <div className={css.banner} data-variant="error" role="alert">
          {t('error.rpc', { reason: state.error ?? '' })}
        </div>
      </div>
    )
  }

  if (state.value === null) {
    return (
      <div className={css.content}>
        <p className={css.profileLine}>{t('loading')}</p>
      </div>
    )
  }

  const {
    profile, registry, mailboxBridge, toolMailbox, drift,
  } = state.value
  const lists = driftLists(drift)
  const driftLookup = unservedByName(lists?.unserved)
  const seatNames = registry.ok ? seatNamesOf(registry.registry) : []
  const positions = gridPositions(seatNames)

  const nodes: SeatNodeType[] = registry.ok
    ? seatNames.map((name) => {
      const seat = registry.registry.seats[name]
      // Present for every name from seatNamesOf(registry.registry) (its own
      // keys), so this can only miss under a concurrent registry replace —
      // fall back to an empty seat rather than crashing mid-render.
      /* v8 ignore next -- defensive: seat is always present for a name drawn from this same registry's own keys. */
      const record = seat ?? { cwd: '' }
      return {
        id: name,
        type: 'seat',
        // positions is gridPositions(seatNames), so it always has this name.
        /* v8 ignore next -- defensive: positions.get(name) is always set for a name drawn from seatNames. */
        position: positions.get(name) ?? { x: 0, y: 0 },
        data: {
          name,
          badges: seatBadges(name, record, registry.registry.callUp, driftLookup.get(name), t),
          selected: name === selectedSeat,
        },
      }
    })
    : []

  const edges: Edge[] = registry.ok
    ? registry.registry.edges.map(([from, to]) => ({
      id: `${from}--${to}`,
      source: from,
      target: to,
      type: 'straight',
    }))
    : []

  const selectedRecord = registry.ok && selectedSeat !== null ? registry.registry.seats[selectedSeat] : undefined
  const hasAllow = selectedRecord?.tools?.allow !== undefined && selectedRecord.tools.allow.length > 0
  const hasDeny = selectedRecord?.tools?.deny !== undefined && selectedRecord.tools.deny.length > 0

  return (
    <div className={css.content}>
      <p className={css.profileLine}>{t('profile.label', { profile })}</p>

      {!registry.ok && (
        <div className={css.banner} data-variant="error" role="alert">
          {t('error.registry', { reason: registry.reason })}
        </div>
      )}
      {!mailboxBridge.ok && (
        <div className={css.banner} data-variant="error" role="alert">
          {t('error.mailboxBridge', { reason: mailboxBridge.reason })}
        </div>
      )}
      {!toolMailbox.ok && (
        <div className={css.banner} data-variant="error" role="alert">
          {t('error.toolMailbox', { reason: toolMailbox.reason })}
        </div>
      )}

      <div className={css.section}>
        <h3 className={css.sectionTitle}>{t('drift.title')}</h3>
        {!drift.ok
          ? (
            <div className={css.banner} data-variant="error" role="alert">
              {t('error.drift', { reason: drift.reason })}
            </div>
          )
          : (() => {
            // drift.ok is true in this branch, and driftLists() only ever
            // returns undefined for a failed drift result, so lists is
            // always populated here -- narrow once instead of every usage
            // below needing an optional-chain fallback that can never fire.
            const rows = lists as DriftLists
            return (
              <div className={css.driftGrid}>
                <div className={css.driftColumn}>
                  <p className={css.driftColumnTitle}>
                    {t('drift.unserved.title', { count: rows.unserved.length })}
                  </p>
                  {rows.unserved.length > 0
                    ? (
                      <ul className={css.driftList}>
                        {rows.unserved.map(row => (
                          <li key={row.seat} className={css.driftItem}>
                            {t('drift.unserved.item', { seat: row.seat, rosters: missingRosterLabels(row, t).join(', ') })}
                          </li>
                        ))}
                      </ul>
                    )
                    : <p className={css.driftEmpty}>{t('drift.unserved.empty')}</p>}
                </div>
                <div className={css.driftColumn}>
                  <p className={css.driftColumnTitle}>
                    {t('drift.unregistered.title', { count: rows.unregistered.length })}
                  </p>
                  {rows.unregistered.length > 0
                    ? (
                      <ul className={css.driftList}>
                        {rows.unregistered.map(row => (
                          <li key={row.seat} className={css.driftItem}>
                            {t('drift.unregistered.item', { seat: row.seat, rosters: servedRosterLabels(row, t).join(', ') })}
                          </li>
                        ))}
                      </ul>
                    )
                    : <p className={css.driftEmpty}>{t('drift.unregistered.empty')}</p>}
                </div>
              </div>
            )
          })()}
      </div>

      {registry.ok && (
        <div className={css.section}>
          <h3 className={css.sectionTitle}>
            {t('graph.title')}
            {' — '}
            {t('graph.seatCount', { count: seatNames.length })}
          </h3>
          <div className={css.layoutRow}>
            <div className={css.canvasWrap}>
              {seatNames.length === 0
                ? <div className={css.canvasEmpty}>{t('graph.empty')}</div>
                : (
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={NODE_TYPES}
                    onNodeClick={(_event, node) => { setSelectedSeat(node.id) }}
                    onPaneClick={() => { setSelectedSeat(null) }}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    panOnScroll
                    zoomOnScroll
                    fitView
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background />
                  </ReactFlow>
                )}
            </div>
            <div className={css.detailPanel}>
              {selectedRecord === undefined
                ? <p className={css.detailHint}>{t('detail.hint')}</p>
                : (
                  <>
                    <p className={css.detailName}>{selectedSeat}</p>
                    <div className={css.detailRow}>
                      <p className={css.detailLabel}>{t('detail.cwd')}</p>
                      <p className={css.detailValue}>{selectedRecord.cwd}</p>
                    </div>
                    <div className={css.detailRow}>
                      <p className={css.detailLabel}>{t('detail.session')}</p>
                      <p className={css.detailValue}>{selectedRecord.sessionId ?? t('detail.session.none')}</p>
                    </div>
                    {hasAllow && (
                      <div className={css.detailRow}>
                        <p className={css.detailLabel}>{t('detail.tools.allow')}</p>
                        <ul className={css.detailList}>
                          {selectedRecord.tools.allow.map(tool => <li key={tool}>{tool}</li>)}
                        </ul>
                      </div>
                    )}
                    {hasDeny && (
                      <div className={css.detailRow}>
                        <p className={css.detailLabel}>{t('detail.tools.deny')}</p>
                        <ul className={css.detailList}>
                          {selectedRecord.tools.deny.map(tool => <li key={tool}>{tool}</li>)}
                        </ul>
                      </div>
                    )}
                    {!hasAllow && !hasDeny && (
                      <p className={css.detailValue}>{t('detail.tools.none')}</p>
                    )}
                  </>
                )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

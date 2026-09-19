/**
 * The board's whole body: profile line, write notice, drift summary, and the
 * seat graph + detail panel. Every failure state below has ITS OWN visible
 * reason — the hard requirement this slice exists to satisfy is that a
 * failure must never render as emptiness (an unreadable registry must never
 * look like "no seats") and must never render as a clean board (an unreadable
 * roster must suppress the drift verdict, not let it read as "nothing to
 * report").
 *
 * SWD-134 slice 4 step 4 adds the visible editing controls: dragging a line
 * between two seats (`onConnect` → `addEdge`), clicking a line to remove it
 * (`onEdgeClick` → a confirmation → `removeEdge`), an inline add-seat form,
 * a remove-seat action in the detail panel (confirmed, cascade named first),
 * and editable tool allow/deny lists on the detail panel. `elementsSelectable`
 * and `nodesDraggable` stay `false` — see the note on the `ReactFlow` element
 * below for why that is load-bearing, not an oversight.
 *
 * `useState` is the only Hook `OrgBoard` itself calls, and every call is made
 * unconditionally before the two early returns — every other value below is a
 * plain computed constant, not a Hook, so there is no Rules-of-Hooks hazard
 * from the status branches returning early. `SeatToolsEditor`, a separate
 * component defined further down, keeps its own Hook and is mounted fresh
 * (via a `key={selectedSeat}`) whenever the selection changes, rather than
 * `OrgBoard` reaching for `useEffect` to resync a shared buffer.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Background, ReactFlow } from '@xyflow/react'
import type { Connection, Edge } from '@xyflow/react'
import { Button, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import './xyflow-base.module.css'
import css from './OrgBoard.module.css'
import { removeSeat as previewRemoveSeat } from './edit.ts'
import type { OrgBoardWriteNotice, OrgBoardState } from './org-board-store.ts'
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
  /**
   * Add one new seat. See {@link OrgBoardFace.addSeat} in `slots.ts` -- these
   * five verbs share that exact signature, so `OrgBoardControl.tsx` forwards
   * its own injected verbs straight through unchanged.
   *
   * ALL FIVE ARE REQUIRED, deliberately. They were briefly optional with a
   * no-op fallback so an unforwarded call site could keep compiling, which
   * rendered every control on this board inert while looking live -- a
   * button that silently does nothing is the exact failure this board was
   * built to expose. Required props make an unwired call site a build
   * error instead of a quiet one.
   */
  addSeat: (name: string, cwd: string) => Promise<void>
  /** Remove one seat, cascading over any edge or `callUp` entry naming it. */
  removeSeat: (name: string) => Promise<void>
  /** Add one undirected edge between two seats. */
  addEdge: (from: string, to: string) => Promise<void>
  /** Remove one undirected edge, in whichever direction it is stored. */
  removeEdge: (from: string, to: string) => Promise<void>
  /** Replace one seat's tool restriction; an empty/`undefined` allow AND deny clears it. */
  setSeatTools: (name: string, allow: readonly string[] | undefined, deny: readonly string[] | undefined) => Promise<void>
}

/**
 * Split a comma-separated tool list into trimmed, non-empty tokens.
 * @param text - the editable field's raw value.
 * @returns tool names, in the order typed.
 */
function parseToolList(text: string): string[] {
  return text.split(',').map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * The write-side notice's user-facing text. Each of the four kinds asks for a
 * genuinely different next action from the viewer — see `OrgBoardWriteNotice`
 * in `org-board-store.ts` for why they are never folded into one generic
 * failure — so this never collapses them into shared wording.
 * @param notice - the store's most recent write outcome.
 * @param t - namespace-bound translate.
 * @returns the message to show.
 */
function writeNoticeText(notice: OrgBoardWriteNotice, t: OrgBoardTranslate): string {
  switch (notice.kind) {
    case 'invalid': return t('write.notice.invalid', { reason: notice.message })
    case 'conflict': return t('write.notice.conflict')
    case 'rejected': return t('write.notice.rejected', { reason: notice.message })
    case 'write-failed': return t('write.notice.writeFailed')
  }
}

/** The banner's `data-variant`: `conflict` is informational (a reload already fixed it), the other three are refusals/failures. */
function writeNoticeVariant(kind: OrgBoardWriteNotice['kind']): 'error' | 'warning' {
  return kind === 'conflict' ? 'warning' : 'error'
}

/** Props for the detail panel's editable tool allow/deny lists. */
interface SeatToolsEditorProps {
  allow: readonly string[]
  deny: readonly string[]
  disabled: boolean
  allowLabel: string
  denyLabel: string
  saveLabel: string
  onSave: (allow: readonly string[] | undefined, deny: readonly string[] | undefined) => void
}

/**
 * Editable allow/deny tool lists for the currently selected seat. A separate
 * component (rather than a buffer inside `OrgBoard`'s own state) so that
 * mounting a fresh instance per seat — via `key={selectedSeat}` at the call
 * site — resets the local text buffers to that seat's own persisted lists
 * without `OrgBoard` needing a `useEffect` to resync them on every selection
 * change.
 * @param props - the seat's current lists, the save verb, and bound labels.
 * @returns the two fields and a Save button.
 */
function SeatToolsEditor({
  allow, deny, disabled, allowLabel, denyLabel, saveLabel, onSave,
}: SeatToolsEditorProps) {
  const [allowText, setAllowText] = useState(() => allow.join(', '))
  const [denyText, setDenyText] = useState(() => deny.join(', '))
  return (
    <div className={css.detailRow}>
      <label className={css.toolsField}>
        <span className={css.detailLabel}>{allowLabel}</span>
        <input
          className={css.toolsInput}
          value={allowText}
          disabled={disabled}
          onChange={(event) => { setAllowText(event.currentTarget.value) }}
        />
      </label>
      <label className={css.toolsField}>
        <span className={css.detailLabel}>{denyLabel}</span>
        <input
          className={css.toolsInput}
          value={denyText}
          disabled={disabled}
          onChange={(event) => { setDenyText(event.currentTarget.value) }}
        />
      </label>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => {
          const allowList = parseToolList(allowText)
          const denyList = parseToolList(denyText)
          onSave(allowList.length > 0 ? allowList : undefined, denyList.length > 0 ? denyList : undefined)
        }}
      >
        {saveLabel}
      </Button>
    </div>
  )
}

/**
 * Render the org board body.
 * @param props - the latest `org.get` snapshot, the bound translate, and the five write verbs.
 * @returns the status banner, or the full board once a response has landed.
 */
export function OrgBoard({
  state, t,
  addSeat,
  removeSeat,
  addEdge,
  removeEdge,
  setSeatTools,
}: OrgBoardProps) {
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null)
  const [addSeatOpen, setAddSeatOpen] = useState(false)
  const [addSeatName, setAddSeatName] = useState('')
  const [addSeatCwd, setAddSeatCwd] = useState('')
  const [addSeatValidationError, setAddSeatValidationError] = useState<string | null>(null)
  const [seatToRemove, setSeatToRemove] = useState<string | null>(null)
  const [removeAcknowledged, setRemoveAcknowledged] = useState(false)
  const [edgeToRemove, setEdgeToRemove] = useState<{ from: string; to: string } | null>(null)
  const [edgeRemoveAcknowledged, setEdgeRemoveAcknowledged] = useState(false)
  // The most recently attempted write, re-invocable verbatim -- 'write-failed'
  // is retry-the-same-payload territory (see org-board-store.ts's `write()`
  // doc comment: a failed write never advances the controller's held
  // document/token, so the identical verb call reproduces the identical
  // payload). Never read for anything but Retry.
  const [lastAttempt, setLastAttempt] = useState<(() => Promise<void>) | null>(null)

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
  const pending = state.write.pending
  const notice = state.write.notice
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

  // Cascade preview for the pending seat-removal confirmation, computed from
  // the UNRESOLVED document (never `registry.registry`, which is a display
  // view) via edit.ts's own pure `removeSeat` -- the exact function the real
  // removal verb runs, so the preview can never drift from what actually
  // gets cascaded. Pure and side-effect-free: safe to compute on every
  // render rather than only when the confirmation opens.
  const removePreview = seatToRemove !== null && registry.ok
    ? previewRemoveSeat(registry.document, seatToRemove)
    : null
  const removeCascadedEdges = removePreview !== null && removePreview.ok ? removePreview.cascadedEdges : []
  const removeCascadedCallUp = removePreview !== null && removePreview.ok ? removePreview.cascadedCallUp : []
  const removeEdgesLabel = removeCascadedEdges.length > 0
    ? removeCascadedEdges.map(([from, to]) => `${from} ↔ ${to}`).join(', ')
    : t('seat.remove.cascade.none')
  const removeDescription = seatToRemove === null
    ? ''
    : t('seat.remove.cascade', { seat: seatToRemove, count: removeCascadedEdges.length, edges: removeEdgesLabel })
      + (removeCascadedCallUp.length > 0 ? ` ${t('seat.remove.cascadeCallUp', { seat: seatToRemove })}` : '')

  const handleAddSeatSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = addSeatName.trim()
    const cwd = addSeatCwd.trim()
    if (name === '' || cwd === '') {
      setAddSeatValidationError(t('addSeat.validation.required'))
      return
    }
    setAddSeatValidationError(null)
    setLastAttempt(() => () => addSeat(name, cwd))
    void addSeat(name, cwd)
    setAddSeatName('')
    setAddSeatCwd('')
    setAddSeatOpen(false)
  }

  return (
    <div className={css.content}>
      <p className={css.profileLine}>{t('profile.label', { profile })}</p>

      {notice !== null && (
        <div className={css.banner} data-variant={writeNoticeVariant(notice.kind)} role="alert">
          <span>{writeNoticeText(notice, t)}</span>
          {notice.kind === 'write-failed' && lastAttempt !== null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={css.noticeRetry}
              disabled={pending}
              onClick={() => { void lastAttempt() }}
            >
              {t('write.notice.retry')}
            </Button>
          )}
        </div>
      )}

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
          <div className={css.sectionHeaderRow}>
            <h3 className={css.sectionTitle}>
              {t('graph.title')}
              {' — '}
              {t('graph.seatCount', { count: seatNames.length })}
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                setAddSeatValidationError(null)
                setAddSeatOpen(open => !open)
              }}
            >
              {addSeatOpen ? t('action.cancel') : t('addSeat.trigger')}
            </Button>
          </div>
          {addSeatOpen && (
            <form className={css.addSeatForm} onSubmit={handleAddSeatSubmit}>
              <label className={css.addSeatField}>
                <span className={css.detailLabel}>{t('addSeat.name.label')}</span>
                <input
                  className={css.addSeatInput}
                  value={addSeatName}
                  disabled={pending}
                  onChange={(event) => { setAddSeatName(event.currentTarget.value) }}
                />
              </label>
              <label className={css.addSeatField}>
                <span className={css.detailLabel}>{t('addSeat.cwd.label')}</span>
                <input
                  className={css.addSeatInput}
                  value={addSeatCwd}
                  disabled={pending}
                  onChange={(event) => { setAddSeatCwd(event.currentTarget.value) }}
                />
              </label>
              {addSeatValidationError !== null && (
                <p className={css.addSeatError} role="alert">{addSeatValidationError}</p>
              )}
              <Button type="submit" variant="primary" size="sm" disabled={pending}>
                {t('action.add')}
              </Button>
            </form>
          )}
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
                    onConnect={(connection: Connection) => {
                      if (pending) return
                      setLastAttempt(() => () => addEdge(connection.source, connection.target))
                      void addEdge(connection.source, connection.target)
                    }}
                    onEdgeClick={(_event, edge) => {
                      if (pending) return
                      setEdgeToRemove({ from: edge.source, to: edge.target })
                    }}
                    // nodesConnectable drives dragging a line between two
                    // seats (addEdge); elementsSelectable and nodesDraggable
                    // stay false -- DELIBERATE and load-bearing. If elements
                    // became selectable, React Flow's own default
                    // Backspace-deletes-the-selection behaviour goes live and
                    // removes edges PURELY IN THE BROWSER WITH NO SAVE AT
                    // ALL: a board that looks edited, is not, and silently
                    // reverts on reload -- exactly the defect this whole
                    // ticket exists to remove. onNodeClick/onEdgeClick both
                    // still fire with elementsSelectable false (verified:
                    // React Flow attaches onClick directly to each edge's
                    // wrapping <g> regardless of its selectable state, and to
                    // each node's wrapper the same way; the existing
                    // "clicking a seat node opens its detail panel" test
                    // already proved onNodeClick fires here, and this slice
                    // adds the matching onEdgeClick coverage below).
                    nodesDraggable={false}
                    nodesConnectable={!pending}
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
                    <div className={css.detailHeaderRow}>
                      <p className={css.detailName}>{selectedSeat}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => { setSeatToRemove(selectedSeat) }}
                      >
                        {t('seat.remove.trigger')}
                      </Button>
                    </div>
                    <div className={css.detailRow}>
                      <p className={css.detailLabel}>{t('detail.cwd')}</p>
                      <p className={css.detailValue}>{selectedRecord.cwd}</p>
                    </div>
                    <div className={css.detailRow}>
                      <p className={css.detailLabel}>{t('detail.session')}</p>
                      <p className={css.detailValue}>{selectedRecord.sessionId ?? t('detail.session.none')}</p>
                    </div>
                    {!hasAllow && !hasDeny && (
                      <p className={css.detailValue}>{t('detail.tools.none')}</p>
                    )}
                    <SeatToolsEditor
                      key={selectedSeat}
                      allow={selectedRecord.tools?.allow ?? []}
                      deny={selectedRecord.tools?.deny ?? []}
                      disabled={pending}
                      allowLabel={t('detail.tools.allow')}
                      denyLabel={t('detail.tools.deny')}
                      saveLabel={t('action.save')}
                      onSave={(allow, deny) => {
                        if (selectedSeat === null) return
                        const name = selectedSeat
                        setLastAttempt(() => () => setSeatTools(name, allow, deny))
                        void setSeatTools(name, allow, deny)
                      }}
                    />
                  </>
                )}
            </div>
          </div>

          <RiskConfirmation
            open={seatToRemove !== null}
            title={t('seat.remove.title')}
            description={removeDescription}
            acknowledgeLabel={t('seat.remove.acknowledge')}
            cancelLabel={t('action.cancel')}
            confirmLabel={t('action.remove')}
            acknowledged={removeAcknowledged}
            disabled={pending}
            onAcknowledgedChange={setRemoveAcknowledged}
            onCancel={() => { setSeatToRemove(null); setRemoveAcknowledged(false) }}
            onConfirm={() => {
              if (seatToRemove === null) return
              const name = seatToRemove
              setSeatToRemove(null)
              setRemoveAcknowledged(false)
              setSelectedSeat(current => (current === name ? null : current))
              setLastAttempt(() => () => removeSeat(name))
              void removeSeat(name)
            }}
          />

          <RiskConfirmation
            open={edgeToRemove !== null}
            title={t('edge.remove.title')}
            description={edgeToRemove !== null ? t('edge.remove.description', { from: edgeToRemove.from, to: edgeToRemove.to }) : ''}
            acknowledgeLabel={t('edge.remove.acknowledge')}
            cancelLabel={t('action.cancel')}
            confirmLabel={t('action.remove')}
            acknowledged={edgeRemoveAcknowledged}
            disabled={pending}
            onAcknowledgedChange={setEdgeRemoveAcknowledged}
            onCancel={() => { setEdgeToRemove(null); setEdgeRemoveAcknowledged(false) }}
            onConfirm={() => {
              if (edgeToRemove === null) return
              const { from, to } = edgeToRemove
              setEdgeToRemove(null)
              setEdgeRemoveAcknowledged(false)
              setLastAttempt(() => () => removeEdge(from, to))
              void removeEdge(from, to)
            }}
          />
        </div>
      )}
    </div>
  )
}

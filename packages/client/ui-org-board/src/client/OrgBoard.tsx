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
import type { OrgBoardServedWriteNotice, OrgBoardWriteNotice, OrgBoardState } from './org-board-store.ts'
import {
  driftLists, missingRosterLabels, seatBadges, seatNamesOf, seatServedStatus, servedRosterLabels, unservedByName,
  type DriftLists, type OrgBoardTranslate, type SeatServedStatus,
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
   * six verbs share that exact signature shape, so `OrgBoardControl.tsx`
   * forwards its own injected verbs straight through unchanged.
   *
   * ALL SIX ARE REQUIRED, deliberately. They were briefly optional with a
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
  /**
   * Set one seat's served / not-served state, writing BOTH served rosters
   * identically. See {@link OrgBoardFace.setSeatServed} in `slots.ts` for the
   * full account of why this is REQUIRED and must never gain a default --
   * this board once shipped an entire edit surface wired to nothing because
   * its props were optional, with the full suite green throughout, since the
   * board's own tests mount it directly and never cross the seam only
   * `OrgBoardControl` closes. A required prop turns an unwired call site
   * into a build error instead of a silently inert button.
   */
  setSeatServed: (name: string, served: boolean, acknowledgeSplit: boolean) => Promise<void>
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

/**
 * The served-write notice's user-facing text -- {@link writeNoticeText}'s own
 * shape, extended with the `split` kind's own message: the two served
 * rosters already disagreed before this write ever ran, naming exactly which
 * addresses only one side currently serves.
 * @param notice - the store's most recent `setSeatServed` outcome.
 * @param t - namespace-bound translate.
 * @returns the message to show.
 */
function servedWriteNoticeText(notice: OrgBoardServedWriteNotice, t: OrgBoardTranslate): string {
  switch (notice.kind) {
    case 'invalid': return t('servedWrite.notice.invalid', { reason: notice.message })
    case 'conflict': return t('servedWrite.notice.conflict')
    case 'rejected': return t('servedWrite.notice.rejected', { reason: notice.message })
    case 'write-failed': return t('servedWrite.notice.writeFailed')
    case 'split': return t('servedWrite.notice.split', {
      onlyMailboxBridge: notice.onlyMailboxBridge.length > 0 ? notice.onlyMailboxBridge.join(', ') : t('drift.unserved.empty'),
      onlyToolMailbox: notice.onlyToolMailbox.length > 0 ? notice.onlyToolMailbox.join(', ') : t('drift.unserved.empty'),
    })
  }
}

/** The served-write banner's `data-variant`: `conflict` is informational, everything else (incl. `split`) is a refusal/failure. */
function servedWriteNoticeVariant(kind: OrgBoardServedWriteNotice['kind']): 'error' | 'warning' {
  return kind === 'conflict' ? 'warning' : 'error'
}

/**
 * The served-status indicator's text for one of the three classified states
 * -- reads {@link SeatServedStatus} literally, so it can never show a value
 * `seatServedStatus` did not itself produce.
 * @param status - the seat's classified served status.
 * @param t - namespace-bound translate.
 * @returns the label to show.
 */
function servedStatusLabel(status: SeatServedStatus, t: OrgBoardTranslate): string {
  switch (status) {
    case 'served': return t('detail.served.value.served')
    case 'unserved': return t('detail.served.value.unserved')
    case 'split': return t('detail.served.value.split')
  }
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
  setSeatServed,
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
  // The seat whose served state is pending confirmation, and the boolean it
  // would be set to on confirm -- `nextServed` is captured at trigger-click
  // time (never re-derived at confirm time) so a concurrent background
  // reload landing while the confirmation is open can't silently flip which
  // direction "confirm" commits to.
  const [servedToggle, setServedToggle] = useState<{ name: string; nextServed: boolean } | null>(null)
  const [servedAcknowledged, setServedAcknowledged] = useState(false)
  // The most recently attempted write, re-invocable verbatim -- 'write-failed'
  // is retry-the-same-payload territory (see org-board-store.ts's `write()`
  // doc comment: a failed write never advances the controller's held
  // document/token, so the identical verb call reproduces the identical
  // payload). Never read for anything but Retry.
  const [lastAttempt, setLastAttempt] = useState<(() => Promise<void>) | null>(null)
  // The served-roster counterpart, kept separate so a failed registry write
  // and a failed served write never offer each other's Retry. Only
  // 'write-failed' is retried: 'rejected' means the content itself was
  // refused, 'conflict' has already reloaded underneath the operator, and
  // 'split' needs the confirmation's disclosure again rather than a silent
  // resend of the same unacknowledged payload.
  const [servedLastAttempt, setServedLastAttempt] = useState<(() => Promise<void>) | null>(null)

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
  const servedPending = state.servedWrite.pending
  const servedNotice = state.servedWrite.notice
  const lists = driftLists(drift)
  const driftLookup = unservedByName(lists?.unserved)
  // Every currently-split REGISTERED seat, via `seatServedStatus`. This is a
  // DIFFERENT reading of the same drift rows than the drift section renders
  // below (`missingRosterLabels`/`servedRosterLabels` against
  // `row.servedByMailboxBridge`/`row.servedByToolMailbox` directly, around
  // line 469) -- that section answers "which specific roster(s) is this seat
  // missing from", which needs the individual booleans, not a three-value
  // summary, so it correctly never calls `seatServedStatus` at all. Two
  // readings of the same row data are fine here: they answer different
  // questions, not the same one twice.
  //
  // Scoped to REGISTERED rows only (`lists.unserved`), same scope as the
  // drift section's own "unserved" column -- an address served by only one
  // roster with no matching registry seat (e.g. a stray "ghost" entry) is
  // just as split but never appears here, because it is `registered: false`
  // and so lands in `lists.unregistered` instead. `servedConfirmDescription`
  // below prefers the SERVER's own authoritative split lists over this one
  // whenever a split-refusal notice is showing, which is exactly what covers
  // that gap -- see that computation's own comment for why.
  //
  // `lists` (and so `driftLookup`) is `undefined`/empty whenever drift
  // itself failed (per `driftLists`), so this reads as "none known" rather
  // than crashing -- never confused with "no splits exist", since the
  // toggle trigger is separately disabled whenever `!drift.ok` (see the
  // detail panel below).
  const splitSeatNames = (lists?.unserved ?? []).filter(row => seatServedStatus(row) === 'split').map(row => row.seat)
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

  // The selected seat's drift row, and its served status through the ONE
  // shared classifier -- gated on `drift.ok` (never just "row is absent"):
  // when drift itself failed, `driftLookup` reads empty for every name
  // regardless of the real underlying state, so treating that as "served"
  // would be exactly the silently-wrong confident answer this whole feature
  // exists to prevent. `null` here means "unknown", not "served".
  const selectedDriftRow = selectedSeat !== null ? driftLookup.get(selectedSeat) : undefined
  const selectedServedStatus: SeatServedStatus | null =
    selectedRecord !== undefined && drift.ok ? seatServedStatus(selectedDriftRow) : null
  // What `setSeatServed`'s `served` argument should flip TO on the next
  // toggle click -- the opposite of whether `mailbox-bridge` (the base list
  // `served-edit.ts`'s `nextServedAddresses` toggles against; see
  // `org-board-store.ts`'s `servedAddresses` doc comment on why always that
  // side, never `toolMailbox`) currently includes this seat. Only ever read
  // from the trigger's `onClick`, which is itself disabled whenever
  // `!drift.ok` -- see the toggle button below -- so an unknown baseline here
  // is never acted on.
  const selectedCurrentlyServedByMailboxBridge = selectedDriftRow === undefined ? true : selectedDriftRow.servedByMailboxBridge

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

  // The served-toggle confirmation's description, and whether this write
  // must carry `acknowledgeSplit: true`: whenever ANY seat is currently split
  // (per `splitSeatNames`, derived above through the shared `seatServedStatus`
  // classifier), not only the seat being toggled -- `writeServed` replaces
  // BOTH mounts with ONE list built off `mailbox-bridge`'s current addresses,
  // so every other split seat's `tool-mailbox` side is unified onto that same
  // list by this write too (see `org-board-store.ts`'s `setSeatServed` doc
  // comment on why `servedAddresses` is always the `mailbox-bridge` list).
  //
  // TWO SOURCES, AND THE SERVER'S WINS. A split-refusal notice carries the
  // split the server measured on the file it had just read; `splitSeatNames`
  // is only this board's own reading. They agree in the ordinary case -- a
  // split refusal can only be raised AFTER the content token matched, so the
  // file has not moved since the board read it -- but they are scoped
  // differently, and that difference is reachable: `splitSeatNames` covers
  // REGISTERED seats only, while the server compares the two address lists
  // whole. An address served by one roster with no registry seat behind it is
  // split to the server and invisible here. Deriving the disclosure from the
  // client alone would then refuse the save, show no split, and refuse again
  // on every retry -- forever, with nothing on screen explaining why.
  const serverSplitSeats = servedNotice?.kind === 'split'
    ? [...new Set([...servedNotice.onlyMailboxBridge, ...servedNotice.onlyToolMailbox])].sort()
    : null
  const disclosedSplitSeats = serverSplitSeats ?? splitSeatNames
  const servedAcknowledgeSplit = disclosedSplitSeats.length > 0
  const servedConfirmDescription = servedToggle === null
    ? ''
    : t('servedConfirm.description', { seat: servedToggle.name })
      + (servedAcknowledgeSplit ? ` ${t('servedConfirm.split', { seats: disclosedSplitSeats.join(', ') })}` : '')

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

      {servedNotice !== null && (
        <div className={css.banner} data-variant={servedWriteNoticeVariant(servedNotice.kind)} role="alert">
          <span>{servedWriteNoticeText(servedNotice, t)}</span>
          {servedNotice.kind === 'write-failed' && servedLastAttempt !== null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={css.noticeRetry}
              disabled={servedPending}
              onClick={() => { void servedLastAttempt() }}
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
                    // Remount when the seat set changes so the view re-fits.
                    // `fitView` alone only fits on mount, so an added seat
                    // landed outside the canvas with nothing to bring it back
                    // -- the save had worked and the board looked like it had
                    // done nothing, which is the failure this board exists to
                    // expose. Keyed on the seat names because that is exactly
                    // what changes the layout's extent.
                    key={seatNames.join('\u0000')}
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
                    <div className={css.detailRow}>
                      <p className={css.detailLabel}>{t('detail.served.label')}</p>
                      {selectedServedStatus !== null && (
                        <p className={css.detailValue}>{servedStatusLabel(selectedServedStatus, t)}</p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        // Genuinely disabled -- a real `disabled` attribute,
                        // never a CSS-only affordance -- whenever `!drift.ok`:
                        // with no honest baseline to toggle from, acting on a
                        // guessed empty list would write a roster derived
                        // from nothing. The existing `error.drift` banner
                        // above already explains why; this adds no new text.
                        disabled={pending || servedPending || !drift.ok}
                        onClick={() => {
                          if (selectedSeat === null) return
                          setServedToggle({ name: selectedSeat, nextServed: !selectedCurrentlyServedByMailboxBridge })
                        }}
                      >
                        {t('detail.served.toggle')}
                      </Button>
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

          <RiskConfirmation
            open={servedToggle !== null}
            title={t('servedConfirm.title')}
            description={servedConfirmDescription}
            acknowledgeLabel={servedAcknowledgeSplit ? t('servedConfirm.acknowledgeSplit') : t('servedConfirm.acknowledge')}
            cancelLabel={t('action.cancel')}
            // Distinct per direction -- deliberately never the generic "Save"
            // SeatToolsEditor already uses in this same detail panel: both
            // buttons can be on screen together (the modal overlays the
            // panel, it does not unmount it), and a shared label would make
            // them indistinguishable by accessible name.
            confirmLabel={servedToggle !== null && servedToggle.nextServed ? t('action.serve') : t('action.stopServing')}
            acknowledged={servedAcknowledged}
            disabled={servedPending}
            onAcknowledgedChange={setServedAcknowledged}
            onCancel={() => { setServedToggle(null); setServedAcknowledged(false) }}
            onConfirm={() => {
              if (servedToggle === null) return
              const { name, nextServed } = servedToggle
              const acknowledgeSplit = servedAcknowledgeSplit
              setServedToggle(null)
              setServedAcknowledged(false)
              setServedLastAttempt(() => () => setSeatServed(name, nextServed, acknowledgeSplit))
              void setSeatServed(name, nextServed, acknowledgeSplit)
            }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — every piece of text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve to that content (trigger: its own text; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Modal, IconAgentPresetOutline16, IconApiOutline14, IconCloseOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  if (id === 'tools') return <IconApiOutline14 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * The panel body, rendered through the shared Modal primitive (OP-197): the
 * Modal owns the portal, mask, `role="dialog"`/aria-modal, Escape, Tab trap,
 * background inert pass, initial focus and focus restore to the opener, and
 * stacks correctly under nested Modals (the Delete confirmation). Close
 * paths: the header button, a mask click, and Escape (all via Modal).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  // Entry lands on the close button rather than Modal's default first
  // tabbable (the first nav cell). This must be an effect, not `autoFocus`:
  // React applies autoFocus during commit, before Modal captures the opener
  // in its ref callback, which would make the close button "the opener" and
  // break restore-to-trigger. Effects run after the ref callback.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className={css.panel} headless>
      <nav className={css.nav}>
        <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
        <div className={css.navList}>
          {rows.map(row => (
            <button
              key={row.id}
              type="button"
              className={clsx(css.navCell, row.id === active && css.active)}
              aria-current={row.id === active ? 'true' : undefined}
              onClick={() => { onSelect(row.id) }}
            >
              {navIcon(row.id)}
              <span className={css.navLabel}>{row.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className={css.content}>
        <div className={css.header}>
          <div className={css.actions}>{renderSlot('settings.action', {})}</div>
          <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
            <IconCloseOutline16 size={14} />
            <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
          </button>
        </div>
        <div className={css.options}>
          {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, useSections, useOnboardingSteps, useOpenRequests, useSessions, renderSlot,
  } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // Cross-package "open Settings to this section" requests (settings/open-section):
  // a fresh request object per occurrence, so a repeated id still re-opens.
  // apply() has already resolved an unknown id to `section: undefined` (and
  // logged the warning) — that case opens on the default section instead of
  // a specific one, by leaving activeId alone so the panel's own
  // fallback-to-first-row logic (SettingsPanel's `active` derivation) picks it.
  // The request source lives in apply()'s plugin-lifetime closure, not this
  // component's — a remount (HMR, or any parent re-mounting this tree) sees
  // whatever the LAST real event already left there. `consumedRequest`
  // captures the value present at THIS mount's first render (useRef's
  // initializer only runs once), so that already-seen value compares equal
  // to itself on the first effect run and is treated as handled; only a
  // genuinely new object (a request that arrives while mounted) differs from
  // it and gets acted on.
  const openRequest = useOpenRequests(s => s)
  const consumedRequest = useRef(openRequest)
  useEffect(() => {
    if (openRequest === consumedRequest.current) return
    consumedRequest.current = openRequest
    if (openRequest === undefined) return
    if (openRequest.section !== undefined) {
      openSection(openRequest.section)
    } else {
      setActiveId(undefined)
      setOpen(true)
    }
  }, [openRequest, openSection])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}

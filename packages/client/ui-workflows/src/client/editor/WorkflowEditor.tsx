/** In-house workflow YAML editor: a textarea with a scroll-synced line-number gutter, no highlighting. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, UIEvent } from 'react'
import type { Diagnostic } from '@deepseek-ai/dsh-workflow-yaml'
import css from './WorkflowEditor.module.css'

/** Debounce between the last edit and the automatic validate call, in milliseconds. */
export const VALIDATE_DEBOUNCE_MS = 400

/** Row height in px; pairs with `line-height` on `.mono` in WorkflowEditor.module.css (keep both in step). */
const LINE_HEIGHT_PX = 20

/** Visible strings; every field is optional and defaults to English. */
export interface WorkflowEditorLabels {
  textarea?: (name: string) => string
  save?: string
  validate?: string
  dryRun?: string
  run?: string
  dirty?: string
  conflict?: string
  reload?: string
  diagnostics?: string
}

/** Props for {@link WorkflowEditor}. */
export interface WorkflowEditorProps {
  /** Workflow name; used for the title and the textarea's accessible label. */
  name: string
  /** Current (controlled) editor text. */
  text: string
  /**
   * File version token the host returned with the loaded text. A new token means the text was
   * (re)loaded or saved: the dirty baseline resets to the `text` seen with that token.
   */
  token: string
  /** Latest validation result for `text`. */
  diagnostics: readonly Diagnostic[]
  /**
   * Conflict signalling: the parent sets `conflict` true (for example after the host rejected a
   * save on a token mismatch). While true the editor shows the "file changed on disk" state and
   * disables Save; it does not catch rejections from `onSave`.
   */
  conflict?: boolean
  /**
   * The text has no file behind it yet (a new workflow), so it counts as unsaved even though it
   * equals the baseline; Save is enabled without an edit.
   */
  unsaved?: boolean
  /** Called with the new text on each edit. */
  onChange: (text: string) => void
  /** Save request carrying the text and the token it was loaded with. Fired by the button and Ctrl/Cmd+S. */
  onSave: (text: string, token: string) => void
  /** Validate request; fired 400 ms after an edit and by the Validate button. */
  onValidate: (text: string) => void
  /** Dry-run request. */
  onDryRun: () => void
  /** Run request. */
  onRun: () => void
  /** Reload action shown in the conflict state; the parent refetches text and token. */
  onReload?: () => void
  /** Optional label overrides. */
  labels?: WorkflowEditorLabels
}

const DEFAULT_LABELS = {
  textarea: (name: string) => `Workflow YAML: ${name}`,
  save: 'Save',
  validate: 'Validate',
  dryRun: 'Dry-run',
  run: 'Run',
  dirty: 'Unsaved changes',
  conflict: 'File changed on disk, reload',
  reload: 'Reload',
  diagnostics: 'Diagnostics',
}

/** Char offset of a 1-based line:column in `text`, clamped to the text. */
function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) offset += (lines[i] ?? '').length + 1
  const target = lines[Math.min(line, lines.length) - 1] ?? ''
  return Math.min(offset + Math.max(column - 1, 0), offset + target.length, text.length)
}

/**
 * Workflow YAML editor. Validates on a 400 ms debounce and on demand, shows gutter markers and a
 * clickable diagnostics list, and saves via button or Ctrl/Cmd+S. Save is disabled while an
 * error diagnostic exists, the text is clean, or `conflict` is set.
 * Known cosmetic limit: the gutter reserves a fixed 15px at its bottom for the textarea's
 * horizontal scrollbar; on platforms with overlay or differently sized scrollbars the bottom
 * rows can sit slightly off.
 * @param props - see {@link WorkflowEditorProps}.
 * @returns the editor element.
 */
export function WorkflowEditor(props: WorkflowEditorProps) {
  const {
    name, text, token, diagnostics, conflict = false, unsaved = false, onChange, onSave, onValidate, onDryRun, onRun, onReload,
  } = props
  const l = { ...DEFAULT_LABELS, ...props.labels }
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [baseline, setBaseline] = useState({ token, text })
  if (baseline.token !== token) setBaseline({ token, text })

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  useEffect(() => {
    const el = areaRef.current
    if (pendingCaret.current !== null && el) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  })

  const lineCount = text.split('\n').length
  const severityByLine = useMemo(() => {
    const map = new Map<number, 'error' | 'warning'>()
    for (const d of diagnostics) {
      if (map.get(d.line) !== 'error') map.set(d.line, d.severity === 'error' ? 'error' : 'warning')
    }
    return map
  }, [diagnostics])
  const hasError = diagnostics.some(d => d.severity === 'error')
  const dirty = unsaved || text !== baseline.text
  const canSave = dirty && !hasError && !conflict

  const edit = (next: string): void => {
    onChange(next)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      onValidate(next)
    }, VALIDATE_DEBOUNCE_MS)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (canSave) onSave(text, token)
      return
    }
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      const el = event.currentTarget
      const { selectionStart: start, selectionEnd: end } = el
      pendingCaret.current = start + 2
      edit(`${text.slice(0, start)}  ${text.slice(end)}`)
    }
  }

  const jump = (d: Diagnostic): void => {
    const el = areaRef.current
    if (!el) return
    const offset = offsetOf(text, d.line, d.column)
    el.focus()
    el.setSelectionRange(offset, offset)
    el.scrollTop = Math.max((d.line - 1) * LINE_HEIGHT_PX - el.clientHeight / 2, 0)
  }

  const lines = Array.from({ length: lineCount }, (_unused, i) => i + 1)
  return (
    <div className={css.root} data-workflow-editor>
      <div className={css.toolbar}>
        <span className={css.title}>{name}</span>
        {dirty && <span className={css.dirty} data-dirty>{l.dirty}</span>}
        <span className={css.spacer} />
        <button type="button" className={css.button} data-validate onClick={() => { onValidate(text) }}>{l.validate}</button>
        <button type="button" className={css.button} data-save disabled={!canSave} onClick={() => { onSave(text, token) }}>{l.save}</button>
        <button type="button" className={css.button} data-dryrun onClick={onDryRun}>{l.dryRun}</button>
        <button type="button" className={css.button} data-run onClick={onRun}>{l.run}</button>
      </div>
      {conflict && (
        <div className={css.conflict} data-conflict role="alert">
          <span>{l.conflict}</span>
          <button type="button" className={css.button} data-reload onClick={() => { onReload?.() }}>{l.reload}</button>
        </div>
      )}
      <div className={css.frame}>
        <div className={`${css.gutter} ${css.mono}`} data-editor-gutter aria-hidden="true">
          <div className={css.gutterInner} style={{ transform: `translateY(${-scrollTop}px)` }}>
            {lines.map((n) => {
              const severity = severityByLine.get(n)
              return (
                <div key={n} className={css.line} data-line-number={n}>
                  {severity && <span className={css.marker} data-line-marker data-severity={severity} />}
                  {n}
                </div>
              )
            })}
          </div>
        </div>
        <textarea
          ref={areaRef}
          className={`${css.textarea} ${css.mono}`}
          data-editor-textarea
          aria-label={l.textarea(name)}
          wrap="off"
          spellCheck={false}
          value={text}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => { edit(e.target.value) }}
          onKeyDown={onKeyDown}
          onScroll={(e: UIEvent<HTMLTextAreaElement>) => { setScrollTop(e.currentTarget.scrollTop) }}
        />
      </div>
      {diagnostics.length > 0 && (
        <ul className={css.diagnostics} aria-label={l.diagnostics}>
          {diagnostics.map((d, i) => (
            <li key={`${d.code}:${d.line}:${d.column}:${i}`}>
              <button
                type="button"
                className={css.diagnostic}
                data-diagnostic
                data-line={d.line}
                data-column={d.column}
                data-severity={d.severity}
                data-code={d.code}
                onClick={() => { jump(d) }}
              >
                <span className={css.severity}>{d.severity}</span>
                <span className={css.where}>{d.line}:{d.column}</span>
                <span>{d.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

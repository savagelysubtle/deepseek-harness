/** The Workflows tab: file list, editor, and the dry-run/run panel under it. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkflowEditor } from '../editor/WorkflowEditor.tsx'
import type { WorkflowEditorLabels } from '../editor/WorkflowEditor.tsx'
import type { WorkflowsController, WorkflowsState } from '../controller.ts'
import css from '../Workflows.module.css'
import { DryRunPanel } from './DryRunPanel.tsx'
import { FailureNotice, statusLabel } from './shared.tsx'
import type { T } from './shared.tsx'

function editorLabels(t: T): WorkflowEditorLabels {
  return {
    textarea: name => t('editor.textarea', { name }),
    save: t('editor.save'),
    validate: t('editor.validate'),
    dryRun: t('editor.dryRun'),
    run: t('editor.run'),
    dirty: t('editor.dirty'),
    conflict: t('editor.conflict'),
    reload: t('editor.reload'),
    diagnostics: t('editor.diagnostics'),
  }
}

function NewWorkflow({ controller, t }: { controller: WorkflowsController; t: T }) {
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<'invalid' | 'exists' | undefined>(undefined)
  const create = (): void => {
    const result = controller.newWorkflow(name.trim())
    setProblem(result)
    if (result === undefined) setName('')
  }
  return (
    <div className={css.newRow} data-new-workflow-form>
      <input
        className={css.textInput}
        data-new-workflow-name
        aria-label={t('list.newName')}
        placeholder={t('list.newName')}
        value={name}
        onChange={(event) => { setName(event.target.value); setProblem(undefined) }}
        onKeyDown={(event) => { if (event.key === 'Enter') create() }}
      />
      <Button size="sm" variant="outline" data-new-workflow onClick={create}>{t('list.newCreate')}</Button>
      {problem !== undefined && (
        <span className={css.problem} role="alert" data-new-workflow-problem={problem}>
          {problem === 'invalid' ? t('list.newInvalid') : t('list.newExists')}
        </span>
      )}
    </div>
  )
}

/**
 * Render the Workflows tab.
 * @param props.state - controller snapshot.
 */
export function WorkflowsTab({ controller, state, t }: { controller: WorkflowsController; state: WorkflowsState; t: T }) {
  const { list, editor } = state
  // A file that could not be read has no text or token; an editor over it would invite saving an empty file.
  const readFailed = editor !== null && !editor.isNew && editor.token === '' && editor.failure !== undefined
  return (
    <div className={css.split} data-workflows-tab-panel="workflows">
      <aside className={css.sidebar} data-workflow-list>
        <div className={css.sectionHead}>
          <h3 className={css.heading}>{t('list.heading')}</h3>
          <button type="button" className={css.linkButton} data-list-refresh onClick={() => { void controller.loadList() }}>{t('list.refresh')}</button>
        </div>
        <NewWorkflow controller={controller} t={t} />
        {list.failure !== undefined && <FailureNotice failure={list.failure} scope="list" t={t} />}
        {list.status === 'loading' && list.items.length === 0 && <p className={css.muted} data-list-loading>{t('list.loading')}</p>}
        {list.status === 'ready' && list.items.length === 0 && <p className={css.muted} data-list-empty>{t('list.empty')}</p>}
        <ul className={css.rows}>
          {list.items.map(entry => (
            <li key={entry.name}>
              <button
                type="button"
                className={css.row}
                data-workflow-row
                data-workflow-name={entry.name}
                data-workflow-valid={entry.valid ? 'true' : 'false'}
                data-selected={editor?.name === entry.name ? 'true' : 'false'}
                onClick={() => { void controller.selectWorkflow(entry.name) }}
              >
                <span className={css.rowTitle}>{entry.name}</span>
                <span className={entry.valid ? css.badgeOk : css.badgeBad} data-workflow-validity>
                  {entry.valid ? t('list.valid') : t('list.invalid')}
                </span>
                {entry.description !== '' && <span className={css.muted}>{entry.description}</span>}
                <span className={css.muted}>
                  {t('list.nodes', { count: entry.nodeCount })}
                  {entry.diagnosticCount > 0 && ` · ${t('list.diagnostics', { count: entry.diagnosticCount })}`}
                  {entry.lastRun !== undefined && ` · ${t('list.lastRun', { status: statusLabel(t, entry.lastRun.status) })}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className={css.main} data-workflow-main>
        {editor === null && <p className={css.muted} data-editor-empty>{t('editor.empty')}</p>}
        {editor !== null && (
          <>
            {editor.isNew && <p className={css.muted} data-editor-new>{t('editor.new')}</p>}
            {editor.loading && <p className={css.muted} data-editor-loading>{t('editor.loading')}</p>}
            {!editor.loading && !readFailed && (
              <WorkflowEditor
                name={editor.name}
                text={editor.text}
                token={editor.token}
                diagnostics={editor.diagnostics}
                conflict={editor.conflict}
                unsaved={editor.isNew}
                labels={editorLabels(t)}
                onChange={(text) => { controller.edit(text) }}
                onSave={(text, token) => { void controller.save(text, token) }}
                onValidate={(text) => { void controller.validate(text) }}
                onDryRun={() => { void controller.dryRun() }}
                onRun={() => { void controller.dryRun() }}
                onReload={() => { void controller.reload() }}
              />
            )}
            {editor.justSaved && editor.warning === undefined && <p className={css.ok} role="status" data-save-ok>{t('editor.saved')}</p>}
            {editor.warning !== undefined && (
              <p className={css.warn} role="status" data-save-warning>
                <strong>{t('editor.saveWarningTitle')}</strong> <span data-save-warning-text>{editor.warning}</span>
              </p>
            )}
            {editor.saveFirst && <p className={css.warn} role="alert" data-save-first>{t('editor.saveFirst')}</p>}
            {editor.failure !== undefined && <FailureNotice failure={editor.failure} scope="editor" t={t} />}
            {state.dryRun !== null && <DryRunPanel controller={controller} dryRun={state.dryRun} inputs={editor.inputs} t={t} />}
          </>
        )}
      </section>
    </div>
  )
}

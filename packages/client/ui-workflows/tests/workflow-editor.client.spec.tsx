// @vitest-environment jsdom
/** WorkflowEditor: gutter, scroll sync, caret jump, save/dirty/conflict, Tab, and validate debounce. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { Diagnostic } from '@deepseek-ai/dsh-workflow-yaml'
import { useState } from 'react'
import { WorkflowEditor } from '../src/client/editor/WorkflowEditor.tsx'
import type { WorkflowEditorProps } from '../src/client/editor/WorkflowEditor.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const diag = (over: Partial<Diagnostic>): Diagnostic => ({
  severity: 'error', code: 'x', message: 'bad', line: 1, column: 1, path: [], ...over,
})

function setup(over: Partial<WorkflowEditorProps> = {}) {
  const fns = { onChange: vi.fn(), onSave: vi.fn(), onValidate: vi.fn(), onDryRun: vi.fn(), onRun: vi.fn(), onReload: vi.fn() }
  const props: WorkflowEditorProps = { name: 'wf', text: 'a: 1\nb: 2', token: 't1', diagnostics: [], ...fns, ...over }
  const view = render(<WorkflowEditor {...props} />)
  const q = (s: string) => view.container.querySelector(s)
  return { ...view, fns, q, area: () => q('[data-editor-textarea]') as HTMLTextAreaElement }
}

/** Stateful host so edits flow back into `text`. */
function Host(p: { fns: ReturnType<typeof setup>['fns']; initial: string }) {
  const [text, setText] = useState(p.initial)
  return <WorkflowEditor name="wf" text={text} token="t1" diagnostics={[]} {...p.fns} onChange={setText} />
}

describe('WorkflowEditor', () => {
  it('renders one gutter number per line including a trailing newline line', () => {
    const a = setup({ text: 'a\nb' })
    expect(a.container.querySelectorAll('[data-line-number]')).toHaveLength(2)
    cleanup()
    const b = setup({ text: 'a\nb\n' })
    expect(b.container.querySelectorAll('[data-line-number]')).toHaveLength(3)
    expect(b.area().getAttribute('wrap')).toBe('off')
    expect(b.area().getAttribute('aria-label')).toContain('wf')
  })

  it('marks lines, error beating warning', () => {
    const { container } = setup({
      diagnostics: [
        diag({ severity: 'warning', line: 2 }),
        diag({ severity: 'error', line: 2, code: 'y' }),
        diag({ severity: 'warning', line: 1 }),
      ],
    })
    const m = (n: number) => container.querySelector(`[data-line-number="${n}"] [data-line-marker]`)?.getAttribute('data-severity')
    expect(m(1)).toBe('warning')
    expect(m(2)).toBe('error')
  })

  it('syncs gutter to textarea scroll', () => {
    const { area, q } = setup()
    area().scrollTop = 40
    fireEvent.scroll(area())
    expect((q('[data-editor-gutter] > div') as HTMLElement).style.transform).toBe('translateY(-40px)')
  })

  it('moves the caret to a clicked diagnostic', () => {
    const { area, q } = setup({ diagnostics: [diag({ line: 2, column: 3, code: 'zz' })] })
    const row = q('[data-diagnostic][data-code="zz"]') as HTMLButtonElement
    expect(row.getAttribute('data-line')).toBe('2')
    fireEvent.click(row)
    expect(area().selectionStart).toBe(7)
    expect(area().selectionEnd).toBe(7)
    expect(document.activeElement).toBe(area())
  })

  it('Ctrl+S saves once with the token and prevents default', () => {
    const { area, fns, rerender } = setup()
    rerender(<WorkflowEditor name="wf" text="changed" token="t1" diagnostics={[]} {...fns} />)
    const notPrevented = fireEvent.keyDown(area(), { key: 's', ctrlKey: true })
    expect(notPrevented).toBe(false)
    expect(fns.onSave).toHaveBeenCalledTimes(1)
    expect(fns.onSave).toHaveBeenCalledWith('changed', 't1')
  })

  it('tracks dirty and gates Save on errors', () => {
    const clean = setup()
    expect(clean.q('[data-dirty]')).toBeNull()
    expect((clean.q('[data-save]') as HTMLButtonElement).disabled).toBe(true)
    clean.rerender(<WorkflowEditor {...{ name: 'wf', text: 'new', token: 't1', diagnostics: [], ...clean.fns }} />)
    expect(clean.q('[data-dirty]')).not.toBeNull()
    expect((clean.q('[data-save]') as HTMLButtonElement).disabled).toBe(false)
    clean.rerender(<WorkflowEditor {...{ name: 'wf', text: 'new', token: 't1', diagnostics: [diag({})], ...clean.fns }} />)
    expect((clean.q('[data-save]') as HTMLButtonElement).disabled).toBe(true)
    clean.rerender(<WorkflowEditor {...{ name: 'wf', text: 'new', token: 't2', diagnostics: [], ...clean.fns }} />)
    expect(clean.q('[data-dirty]')).toBeNull()
  })

  it('shows conflict state and reloads', () => {
    const { q, fns } = setup({ conflict: true, text: 'x' })
    expect(q('[data-conflict]')?.textContent).toMatch(/reload/i)
    expect((q('[data-save]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(q('[data-reload]') as HTMLButtonElement)
    expect(fns.onReload).toHaveBeenCalledTimes(1)
  })

  it('Tab inserts two spaces at the caret', () => {
    const { area, fns } = setup({ text: 'ab' })
    area().setSelectionRange(1, 1)
    const notPrevented = fireEvent.keyDown(area(), { key: 'Tab' })
    expect(notPrevented).toBe(false)
    expect(fns.onChange).toHaveBeenCalledWith('a  b')
  })

  it('places the caret after the inserted spaces', () => {
    const fns = setup().fns
    cleanup()
    const { container } = render(<Host fns={fns} initial="ab" />)
    const el = container.querySelector('textarea') as HTMLTextAreaElement
    el.setSelectionRange(1, 1)
    fireEvent.keyDown(el, { key: 'Tab' })
    expect(el.value).toBe('a  b')
    expect(el.selectionStart).toBe(3)
  })

  it('debounces validate by 400 ms and the button validates immediately', () => {
    vi.useFakeTimers()
    const { area, fns, q } = setup()
    fireEvent.change(area(), { target: { value: 'z' } })
    act(() => { vi.advanceTimersByTime(399) })
    expect(fns.onValidate).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(fns.onValidate).toHaveBeenCalledTimes(1)
    expect(fns.onValidate).toHaveBeenCalledWith('z')
    fireEvent.click(q('[data-validate]') as HTMLButtonElement)
    expect(fns.onValidate).toHaveBeenCalledTimes(2)
  })

  it('does not validate after unmount', () => {
    vi.useFakeTimers()
    const { area, fns, unmount } = setup()
    fireEvent.change(area(), { target: { value: 'z' } })
    unmount()
    act(() => { vi.advanceTimersByTime(400) })
    expect(fns.onValidate).not.toHaveBeenCalled()
  })

  it('Ctrl+S with Save disabled prevents default and does not save', () => {
    const { area, fns } = setup()
    const notPrevented = fireEvent.keyDown(area(), { key: 's', metaKey: true })
    expect(notPrevented).toBe(false)
    expect(fns.onSave).not.toHaveBeenCalled()
  })

  it('wires dry-run and run', () => {
    const { q, fns } = setup()
    fireEvent.click(q('[data-dryrun]') as HTMLButtonElement)
    fireEvent.click(q('[data-run]') as HTMLButtonElement)
    expect(fns.onDryRun).toHaveBeenCalledTimes(1)
    expect(fns.onRun).toHaveBeenCalledTimes(1)
  })
})

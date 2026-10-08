// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, ConnectionBanner, Input, Menu, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { POINTER_GRACE_MS } from '../src/pointer-grace.ts'

afterEach(cleanup)

describe('Button', () => {
  it('renders children, icon, and forwards clicks', () => {
    const onClick = vi.fn()
    render(<Button variant="primary" icon={<svg data-testid="ic" />} onClick={onClick}>Go</Button>)
    const button = screen.getByRole('button', { name: 'Go' })
    expect(screen.getByTestId('ic')).toBeDefined()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('disabled blocks interaction', () => {
    const onClick = vi.fn()
    render(<Button disabled onClick={onClick}>No</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('outline variant renders a bordered cancel-style button', () => {
    render(<Button variant="outline">Cancel</Button>)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })
})

describe('Pill', () => {
  it('is a span when static, a button when clickable', () => {
    const { rerender } = render(<Pill active>tab</Pill>)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<Pill onClick={() => {}}>tab</Pill>)
    expect(screen.getByRole('button', { name: 'tab' })).toBeDefined()
  })

  it('active and className land on both static and interactive forms', () => {
    const { container, rerender } = render(<Pill className="x">tab</Pill>)
    const asSpan = container.firstElementChild as HTMLElement
    expect(asSpan.classList.contains('x')).toBe(true)
    rerender(<Pill active className="x" onClick={() => {}}>tab</Pill>)
    const asButton = screen.getByRole('button')
    expect(asButton.classList.contains('x')).toBe(true)
  })
})

describe('Input', () => {
  it('forwards value/onChange and renders the leading icon', () => {
    const onChange = vi.fn()
    render(<Input icon={<svg data-testid="ic" />} value="q" onChange={onChange} placeholder="search" />)
    const input = screen.getByPlaceholderText<HTMLInputElement>('search')
    expect(input.value).toBe('q')
    fireEvent.change(input, { target: { value: 'qq' } })
    expect(onChange).toHaveBeenCalled()
    expect(screen.getByTestId('ic')).toBeDefined()
  })
})

describe('Menu', () => {
  const items = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta', disabled: true },
  ]

  it('shows items only while open; select fires onSelect', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <Menu open={false} anchor={<span>trigger</span>} items={items} onSelect={onSelect} onClose={() => {}} />)
    expect(screen.queryByRole('menu')).toBeNull()
    rerender(
      <Menu open anchor={<span>trigger</span>} items={items} selectedId="a" onSelect={onSelect} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('disabled item does not select; Escape and outside pointerdown close', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <Menu open anchor={<span>trigger</span>} items={items} onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }))
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('inside pointerdown does not close', () => {
    const onClose = vi.fn()
    render(
      <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('selected item shows the trailing check; align=end, side=top, and className apply', () => {
    const { container } = render(
      <Menu
        open
        align="end"
        side="top"
        className="x"
        anchor={<span>trigger</span>}
        items={items}
        selectedId="a"
        onSelect={() => {}}
        onClose={() => {}}
      />)
    expect((container.firstElementChild as HTMLElement).classList.contains('x')).toBe(true)
    const menu = screen.getByRole('menu')
    expect(menu.className).toMatch(/sideTop|alignEnd/)
    const selected = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(selected.querySelector('svg')).not.toBeNull()
    const other = screen.getByRole('menuitem', { name: 'Beta' })
    expect(other.querySelector('svg')).toBeNull()
    fireEvent.keyDown(document, { key: 'a' })
  })

  it('renders a leading icon and a separator between groups', () => {
    render(
      <Menu
        open
        compact
        anchor={<span>trigger</span>}
        items={[
          { id: 'a', label: 'Alpha', icon: <svg data-testid="ic" /> },
          { type: 'separator', id: 's1' },
          { id: 'c', label: 'Create' },
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />)
    expect(screen.getByTestId('ic')).toBeDefined()
    expect(screen.getByRole('separator')).toBeDefined()
  })

  it('renders a non-interactive heading label and a danger row', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        open
        anchor={<span>trigger</span>}
        items={[
          { type: 'label', id: 'h', text: 'Group by' },
          { id: 'del', label: 'Delete', danger: true },
        ]}
        onSelect={onSelect}
        onClose={() => {}}
      />)
    const heading = screen.getByText('Group by')
    expect(heading.getAttribute('role')).toBe('presentation')
    // The heading is not a menu item — only the danger row is interactive.
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    const danger = screen.getByRole('menuitem', { name: 'Delete' })
    expect(danger.className).toMatch(/danger/)
    fireEvent.click(danger)
    expect(onSelect).toHaveBeenCalledWith('del')
  })

  it('closeOnPointerLeave closes a grace after the pointer leaves trigger and list; default never does', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      const { rerender } = render(
        <Menu open closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      const wrapper = screen.getByText('trigger').parentElement as HTMLElement
      fireEvent.pointerLeave(wrapper)
      // Still open through the grace: the pointer may be crossing the gap.
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS - 1) })
      expect(onClose).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(onClose).toHaveBeenCalledTimes(1)
      rerender(
        <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      fireEvent.pointerLeave(wrapper)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 10) })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coming back inside the grace keeps the list open (trigger and list are one region)', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      render(
        <Menu open closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      const wrapper = screen.getByText('trigger').parentElement as HTMLElement
      fireEvent.pointerLeave(wrapper)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS - 50) })
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 10) })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a close from selection disarms the pending grace close', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      const { rerender } = render(
        <Menu open closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      const wrapper = screen.getByText('trigger').parentElement as HTMLElement
      fireEvent.pointerLeave(wrapper)
      // The owner closes for its own reason (selection/Escape) mid-grace; the
      // armed timer must not survive to shut a list reopened right after.
      rerender(
        <Menu open={false} closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 10) })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaving a closed list arms nothing', () => {
    vi.useFakeTimers()
    try {
      const onClose = vi.fn()
      render(
        <Menu open={false} closeOnPointerLeave anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={onClose} />)
      fireEvent.pointerLeave(screen.getByText('trigger').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS * 10) })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a list click does not bubble to the anchor row (portal synthetic-event path)', () => {
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={() => {}} />
      </div>)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('opens a submenu on hover and selects a nested item', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        open
        compact
        anchor={<span>trigger</span>}
        items={[
          { id: 'plain', label: 'Plain' },
          {
            id: 'new',
            label: 'New Workspace',
            submenu: [
              { id: 'ok', label: 'Create ok', icon: <svg data-testid="sub-ic" /> },
            ],
          },
        ]}
        onSelect={onSelect}
        onClose={() => {}}
      />)
    const plain = screen.getByRole('menuitem', { name: 'Plain' })
    fireEvent.mouseEnter(plain.parentElement as HTMLElement)
    fireEvent.focus(plain)
    const parent = screen.getByRole('menuitem', { name: 'New Workspace' })
    const wrap = parent.parentElement as HTMLElement
    fireEvent.click(parent)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.focus(parent)
    fireEvent.mouseEnter(wrap)
    expect(screen.getByTestId('sub-ic')).toBeDefined()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create ok' }))
    expect(onSelect).toHaveBeenCalledWith('ok')
    fireEvent.mouseLeave(wrap)
    expect(screen.queryByRole('menuitem', { name: 'Create ok' })).toBeNull()
  })

  it('portal mode prefers getAnchorRect over measuring its own wrapper', () => {
    const rect = { left: 40, right: 72, top: 100, bottom: 128, width: 32, height: 28, x: 40, y: 100, toJSON: () => ({}) } as DOMRect
    render(
      <Menu
        portal
        open
        getAnchorRect={() => rect}
        anchor={null}
        items={items}
        onSelect={() => {}}
        onClose={() => {}}
      />)
    const menu = screen.getByRole('menu')
    // side=bottom, align=start: below the host-supplied rect, left-aligned.
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('132px')
  })

  it('portal mode skips the frame when getAnchorRect returns null (no menu until a rect exists)', () => {
    render(
      <Menu
        portal
        open
        getAnchorRect={() => null}
        anchor={null}
        items={items}
        onSelect={() => {}}
        onClose={() => {}}
      />)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('portal mode renders the list under body, positions it fixed, and still closes on outside pointerdown', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const { container } = render(
      <Menu portal open anchor={<span>trigger</span>} items={items} onSelect={onSelect} onClose={onClose} />)
    const menu = screen.getByRole('menu')
    // Outside the anchor wrapper subtree — overflow-clipping ancestors can't crop it.
    expect(container.contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.top).not.toBe('')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onSelect).toHaveBeenCalledWith('a')
    fireEvent.pointerDown(menu)
    expect(onClose).not.toHaveBeenCalled()
    // Non-Node targets (e.g. window itself) are ignored, not treated as outside.
    const nonNodeTarget = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(nonNodeTarget, 'target', { value: window })
    document.dispatchEvent(nonNodeTarget)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('portal mode resolves align=end / side=top to clamped left/top coordinates', () => {
    render(
      <Menu portal open align="end" side="top" anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={() => {}} />)
    const menu = screen.getByRole('menu')
    expect(menu.style.left).not.toBe('')
    expect(menu.style.top).not.toBe('')
    expect(menu.style.right).toBe('')
    expect(menu.style.bottom).toBe('')
  })

  it('renders footer rows in a pinned section below the items; they still select', () => {
    const onSelect = vi.fn()
    render(
      <Menu
        open
        anchor={<span>trigger</span>}
        items={items}
        footer={[{ id: 'new', label: 'Create new' }]}
        onSelect={onSelect}
        onClose={() => {}}
      />)
    const footerItem = screen.getByRole('menuitem', { name: 'Create new' })
    expect((footerItem.closest('div[class*="footer"]'))).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Alpha' }).closest('div[class*="footer"]')).toBeNull()
    fireEvent.click(footerItem)
    expect(onSelect).toHaveBeenCalledWith('new')
  })

  it('caps the list height for internal scrolling unless a submenu row is present', () => {
    const { rerender } = render(
      <Menu open anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('menu').className).toMatch(/scrollable/)
    rerender(
      <Menu
        open
        anchor={<span>trigger</span>}
        items={[{ id: 'p', label: 'Parent', submenu: [{ id: 's', label: 'Sub' }] }]}
        onSelect={() => {}}
        onClose={() => {}}
      />)
    expect(screen.getByRole('menu').className).not.toMatch(/scrollable/)
  })
})

describe('Modal', () => {
  it('is absent while closed; Escape and mask click call onClose', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open={false} onClose={onClose} title="Create new workspace">body</Modal>)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(
      <Modal open onClose={onClose} title="Create new workspace" closeLabel="Configure later" description="Name it." contentClassName="scrolling-content" footer={<button type="button">Create</button>}>
        <input aria-label="name" />
      </Modal>)
    const dialog = screen.getByRole('dialog', { name: 'Create new workspace' })
    expect(dialog).toBeDefined()
    // The full-page layer escapes caller stacking contexts but remains in
    // this document/current WebUI window.
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(screen.getByRole('button', { name: 'Configure later' })).toBeDefined()
    expect(screen.getByText('Name it.')).toBeDefined()
    expect(screen.getByText('Name it.').parentElement?.className).toContain('scrolling-content')
    fireEvent.keyDown(document, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    // Mask is the presentation sibling behind the dialog.
    const mask = document.querySelector('[aria-hidden="true"]') as HTMLElement
    fireEvent.click(mask)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('Modal focus trap, background inert, and focus restore (SWD-155)', () => {
  it('initial focus goes to the first tabbable element inside the dialog', () => {
    render(
      <Modal open onClose={() => {}} title="Pick" headless>
        <button type="button">First</button>
        <button type="button">Second</button>
      </Modal>,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
  })

  it('focuses the dialog container itself when it has no tabbable content', () => {
    render(
      <Modal open onClose={() => {}} title="Notice" headless>
        <p>Nothing to click.</p>
      </Modal>,
    )
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Notice' }))
  })

  it("leaves a child's own autoFocus alone instead of stealing it to the first tabbable", () => {
    // Mirrors RiskConfirmation's own checkbox autoFocus and ModelsSection's
    // Cancel-button autoFocus -- Modal must not fight a consumer's own
    // deliberate initial-focus choice.
    render(
      <Modal open onClose={() => {}} title="Form" headless>
        <button type="button">First</button>
        <input aria-label="named" autoFocus />
      </Modal>,
    )
    expect(document.activeElement).toBe(screen.getByLabelText('named'))
  })

  it('Tab from the last tabbable wraps to the first, and Shift+Tab from the first wraps to the last', () => {
    render(
      <Modal open onClose={() => {}} title="Pick" headless>
        <button type="button">First</button>
        <button type="button">Middle</button>
        <button type="button">Last</button>
      </Modal>,
    )
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('does not wrap Tab or Shift+Tab away from a tabbable that is not at either edge', () => {
    render(
      <Modal open onClose={() => {}} title="Pick" headless>
        <button type="button">First</button>
        <button type="button">Middle</button>
        <button type="button">Last</button>
      </Modal>,
    )
    const middle = screen.getByRole('button', { name: 'Middle' })
    middle.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(middle)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(middle)
  })

  it('swallows (preventDefault) Tab when the dialog has no tabbable content', () => {
    render(
      <Modal open onClose={() => {}} title="Notice" headless>
        <p>Nothing to click.</p>
      </Modal>,
    )
    const notCancelled = fireEvent.keyDown(document, { key: 'Tab' })
    expect(notCancelled).toBe(false)
  })

  it('pulls focus back inside when something outside receives focus while open', () => {
    render(
      <>
        <button type="button">Outside</button>
        <Modal open onClose={() => {}} title="Pick" headless>
          <button type="button">First</button>
        </Modal>
      </>,
    )
    const outside = screen.getByRole('button', { name: 'Outside' })
    outside.focus()
    expect(document.activeElement).not.toBe(outside)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
  })

  it('pulls focus back onto the dialog container when it has no tabbable content either', () => {
    render(
      <>
        <button type="button">Outside</button>
        <Modal open onClose={() => {}} title="Notice" headless>
          <p>Nothing to click.</p>
        </Modal>
      </>,
    )
    screen.getByRole('button', { name: 'Outside' }).focus()
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Notice' }))
  })

  it('swallows pointerdown, mousedown, and click on an outside element while open (none reach their own handlers)', () => {
    const onOutsideClick = vi.fn()
    const onOutsideMouseDown = vi.fn()
    const onOutsidePointerDown = vi.fn()
    render(
      <>
        <button
          type="button"
          onClick={onOutsideClick}
          onMouseDown={onOutsideMouseDown}
          onPointerDown={onOutsidePointerDown}
        >
          Outside
        </button>
        <Modal open onClose={() => {}} title="Pick" headless>
          <button type="button">First</button>
        </Modal>
      </>,
    )
    const outside = screen.getByRole('button', { name: 'Outside' })
    fireEvent.pointerDown(outside)
    fireEvent.mouseDown(outside)
    fireEvent.click(outside)
    expect(onOutsidePointerDown).not.toHaveBeenCalled()
    expect(onOutsideMouseDown).not.toHaveBeenCalled()
    expect(onOutsideClick).not.toHaveBeenCalled()
  })

  it('makes background siblings inert while open, restores them on close, and never clobbers a pre-existing inert sibling', () => {
    const preExisting = document.createElement('div')
    preExisting.inert = true
    document.body.appendChild(preExisting)

    const { rerender } = render(
      <Modal open onClose={() => {}} title="Pick" headless>
        <button type="button">First</button>
      </Modal>,
    )
    const portalRoot = screen.getByRole('presentation')
    const siblings = Array.from(document.body.children).filter(el => el !== portalRoot) as HTMLElement[]
    expect(siblings.length).toBeGreaterThan(0)
    for (const sibling of siblings) expect(sibling.inert).toBe(true)

    rerender(
      <Modal open={false} onClose={() => {}} title="Pick" headless>
        <button type="button">First</button>
      </Modal>,
    )
    for (const sibling of siblings) expect(sibling.inert).toBe(sibling === preExisting)

    preExisting.remove()
  })

  it('restores focus to whatever had it before open, once closed', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => { setOpen(true) }}>Open</button>
          <Modal open={open} onClose={() => { setOpen(false) }} title="Pick" headless>
            <button type="button">First</button>
          </Modal>
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })

  it('does not try to restore focus to an opener removed from the document while the dialog was open', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open'
    document.body.appendChild(opener)
    opener.focus()
    const focusSpy = vi.spyOn(opener, 'focus')

    const { rerender } = render(
      <Modal open onClose={() => {}} title="Pick" headless>
        <button type="button">First</button>
      </Modal>,
    )
    opener.remove()
    rerender(
      <Modal open={false} onClose={() => {}} title="Pick" headless>
        <button type="button">First</button>
      </Modal>,
    )
    expect(focusSpy).not.toHaveBeenCalled()
  })

  it('traps only the topmost dialog when two Modals are open, and hands the trap back to the outer one when the inner closes', () => {
    const onOuterButtonClick = vi.fn()
    const onTrulyOutsideClick = vi.fn()
    function Harness({ innerOpen }: { innerOpen: boolean }) {
      return (
        <>
          <button type="button" onClick={onTrulyOutsideClick}>TrulyOutside</button>
          <Modal open onClose={() => {}} title="Outer" headless>
            <button type="button" onClick={onOuterButtonClick}>OuterButton</button>
            <Modal open={innerOpen} onClose={() => {}} title="Inner" headless>
              <button type="button">InnerButton</button>
            </Modal>
          </Modal>
        </>
      )
    }
    // Mounted in two separate commits (outer alone first, inner afterward) --
    // matching OrgBoardControl's real sequence (the board's own Modal opens
    // first; a RiskConfirmation inside it opens later, on its own click) --
    // so the stack ends up [outer, inner] regardless of React's child-before-
    // parent ref-attach order for a single simultaneous mount.
    const { rerender } = render(<Harness innerOpen={false} />)
    rerender(<Harness innerOpen />)

    fireEvent.click(screen.getByRole('button', { name: 'OuterButton' }))
    expect(onOuterButtonClick).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'TrulyOutside' }))
    expect(onTrulyOutsideClick).not.toHaveBeenCalled()

    rerender(<Harness innerOpen={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'OuterButton' }))
    expect(onOuterButtonClick).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'TrulyOutside' }))
    expect(onTrulyOutsideClick).not.toHaveBeenCalled()
  })
})

describe('ConnectionBanner', () => {
  it('renders only while reconnecting', () => {
    const { container, rerender } = render(<ConnectionBanner reconnecting={false} />)
    expect(container.firstChild).toBeNull()
    rerender(<ConnectionBanner reconnecting />)
    expect(container.textContent).toContain('重连')
  })
})

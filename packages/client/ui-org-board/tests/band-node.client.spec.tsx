// @vitest-environment jsdom
/** The band surface: title row, optional dimming, and no a11y noise. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { NodeProps } from '@xyflow/react'
import { BandNode, type BandNodeData, type BandNodeType } from '../src/client/BandNode.tsx'

afterEach(cleanup)

function renderBand(data: BandNodeData) {
  // BandNode reads only `data`; the rest of React Flow's node props are irrelevant here.
  return render(<BandNode {...({ data } as unknown as NodeProps<BandNodeType>)} />)
}

describe('BandNode', () => {
  it('renders the title and the count label', () => {
    renderBand({ title: 'Ops', countLabel: '3 seats', dimmed: false })
    expect(screen.getByText('Ops')).toBeTruthy()
    expect(screen.getByText('3 seats')).toBeTruthy()
  })

  it('renders a localised Unassigned title as given', () => {
    renderBand({ title: 'Unassigned', countLabel: '1 seats', dimmed: false })
    expect(screen.getByText('Unassigned')).toBeTruthy()
  })

  it('is hidden from assistive tech', () => {
    const { container } = renderBand({ title: 'Ops', countLabel: '3 seats', dimmed: false })
    expect((container.firstElementChild as HTMLElement).getAttribute('aria-hidden')).toBe('true')
  })

  it('toggles the dimmed class', () => {
    const { container, rerender } = renderBand({ title: 'Ops', countLabel: '3 seats', dimmed: false })
    const surface = () => container.firstElementChild as HTMLElement
    expect(surface().className).not.toMatch(/nodeDimmed/)
    rerender(<BandNode {...({ data: { title: 'Ops', countLabel: '3 seats', dimmed: true } } as unknown as NodeProps<BandNodeType>)} />)
    expect(surface().className).toMatch(/nodeDimmed/)
  })
})

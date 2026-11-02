import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyze, describeGraph, layout } from '../src/index.ts'
import type { LayoutOptions, WorkflowGraph } from '../src/index.ts'
import { FEATURE_LOOP, MAIL_TRIAGE } from './fixtures.ts'

const golden = (name: string): unknown => JSON.parse(readFileSync(new URL(`./golden/${name}.graph.json`, import.meta.url), 'utf8'))
const OPTS: LayoutOptions = { xGap: 40, yGap: 20, nodeW: 160, nodeH: 60 }

const graphOf = (text: string): WorkflowGraph => describeGraph(analyze(text).doc!)

describe('describeGraph', () => {
  it('matches the golden for feature-loop', () => {
    expect(graphOf(FEATURE_LOOP)).toEqual(golden('feature-loop'))
  })

  it('matches the golden for mail-triage', () => {
    expect(graphOf(MAIL_TRIAGE)).toEqual(golden('mail-triage'))
  })

  it('layers by longest path and carries conditions onto edges', () => {
    const graph = graphOf('version: 1\nname: d\ndescription: d\nnodes:\n  - {id: a, kind: bash, bash: x}\n'
        + '  - {id: b, kind: bash, bash: x, depends_on: [a]}\n'
        + '  - {id: c, kind: bash, bash: x, depends_on: [a, b], when: "$b.status == \'success\'"}\n'
        + '  - {id: d, kind: bash, bash: x}\n')
    expect(graph.nodes.map(n => `${n.id}:${n.layer}.${n.order}`)).toEqual(['a:0.0', 'b:1.0', 'c:2.0', 'd:0.1'])
    expect(graph.edges.filter(e => e.to === 'c')).toEqual([
      { from: 'a', to: 'c', when: "$b.status == 'success'" }, { from: 'b', to: 'c', when: "$b.status == 'success'" },
    ])
    expect(graph.layers).toBe(3)
  })
})

describe('layout', () => {
  const wide = graphOf(`version: 1
name: wide
description: d
nodes:
  - {id: root, kind: bash, bash: x}
  - {id: a1, kind: bash, bash: x, depends_on: [root]}
  - {id: a2, kind: bash, bash: x, depends_on: [root]}
  - {id: a3, kind: bash, bash: x, depends_on: [root]}
  - {id: b1, kind: bash, bash: x, depends_on: [a3]}
  - {id: b2, kind: bash, bash: x, depends_on: [a1]}
  - {id: b3, kind: bash, bash: x, depends_on: [a2]}
  - {id: end, kind: bash, bash: x, depends_on: [b1, b2, b3]}
`)

  it('is deterministic', () => {
    const first = layout(wide, OPTS)
    for (let i = 0; i < 5; i++) expect(layout(structuredClone(wide), OPTS)).toEqual(first)
    expect(JSON.stringify(layout(graphOf(FEATURE_LOOP), OPTS))).toBe(JSON.stringify(layout(graphOf(FEATURE_LOOP), OPTS)))
  })

  it('puts layers left to right and never overlaps two nodes', () => {
    for (const graph of [wide, graphOf(FEATURE_LOOP), graphOf(MAIL_TRIAGE)]) {
      const { positions } = layout(graph, OPTS)
      expect(Object.keys(positions).sort()).toEqual(graph.nodes.map(n => n.id).sort())
      for (const node of graph.nodes) expect(positions[node.id]!.x).toBe(node.layer * (OPTS.nodeW + OPTS.xGap))
      const boxes = graph.nodes.map(n => ({ id: n.id, ...positions[n.id]! }))
      for (const a of boxes) {
        for (const b of boxes) {
          if (a.id >= b.id) continue
          const overlap = a.x < b.x + OPTS.nodeW && b.x < a.x + OPTS.nodeW && a.y < b.y + OPTS.nodeH && b.y < a.y + OPTS.nodeH
          expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false)
        }
      }
    }
  })

  it('orders by barycenter to untangle crossings', () => {
    const { positions } = layout(wide, OPTS)
    // b1 hangs off a3, b2 off a1, b3 off a2: the second layer follows the first layer's order.
    const order = (ids: string[]): string[] => [...ids].sort((x, y) => positions[x]!.y - positions[y]!.y)
    expect(order(['a1', 'a2', 'a3'])).toEqual(['a1', 'a2', 'a3'])
    expect(order(['b1', 'b2', 'b3'])).toEqual(['b2', 'b3', 'b1'])
    // Edges a->b are then non-crossing: sorted a-order maps to ascending y of children.
    const crossings = countCrossings(wide, positions)
    expect(crossings).toBe(0)
  })

  it('reports the bounding box and tolerates negative gaps and one node', () => {
    const single = graphOf('version: 1\nname: d\ndescription: d\nnodes:\n  - {id: only, kind: bash, bash: x}\n')
    const squeezed = layout(single, { xGap: -5, yGap: -5, nodeW: 100, nodeH: 50 })
    expect(squeezed).toEqual({ positions: { only: { x: 0, y: 0 } }, width: 100, height: 50 })
    const result = layout(wide, OPTS)
    expect(result.width).toBe(4 * 160 + 3 * 40)
    expect(result.height).toBe(3 * 60 + 2 * 20)
  })
})

function countCrossings(graph: WorkflowGraph, positions: Record<string, { x: number; y: number }>): number {
  let count = 0
  const edges = graph.edges
  for (const e1 of edges) {
    for (const e2 of edges) {
      if (e1 === e2 || positions[e1.from]!.x !== positions[e2.from]!.x || positions[e1.to]!.x !== positions[e2.to]!.x) continue
      const a = positions[e1.from]!.y - positions[e2.from]!.y
      const b = positions[e1.to]!.y - positions[e2.to]!.y
      if (a * b < 0) count += 1
    }
  }
  return count / 2
}

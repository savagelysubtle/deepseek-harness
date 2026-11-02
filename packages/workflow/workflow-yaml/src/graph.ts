/**
 * Display graph, gate manifest, and the deterministic layered layout the Workflows view draws.
 * Pure: no I/O, no browser or Node-only APIs.
 * @module @deepseek-ai/dsh-workflow-yaml/graph
 */

import type { GraphEdge, GraphNode, ManifestEntry, WorkflowDoc, WorkflowGraph } from './types.ts'

/** The gates a document declares, in node order. */
export function buildManifest(doc: WorkflowDoc): ManifestEntry[] {
  const out: ManifestEntry[] = []
  for (const node of doc.nodes) {
    if (node.kind === 'bash' && node.gate) out.push({ nodeId: node.id, gateKind: 'bash' })
    else if (node.kind === 'approval' && node.gate) out.push({ nodeId: node.id, gateKind: 'approval' })
    else if (node.kind === 'loop' && node.gate) out.push({ nodeId: node.id, gateKind: 'until_bash' })
    else if (node.kind === 'prompt') {
      if (node.gate) out.push({ nodeId: node.id, gateKind: 'verifier' })
      if (node.doneWhen !== undefined) out.push({ nodeId: node.id, gateKind: 'done_when' })
    }
  }
  return out
}

/** Describe a validated document as a layered graph. */
export function describeGraph(doc: WorkflowDoc): WorkflowGraph {
  const layerOf = new Map<string, number>()
  const byId = new Map(doc.nodes.map(n => [n.id, n] as const))
  const depth = (id: string): number => {
    const known = layerOf.get(id)
    if (known !== undefined) return known
    const deps = byId.get(id)?.dependsOn ?? []
    const layer = deps.length === 0 ? 0 : Math.max(...deps.map(depth)) + 1
    layerOf.set(id, layer)
    return layer
  }
  const counts = new Map<number, number>()
  const nodes: GraphNode[] = doc.nodes.map((node) => {
    const layer = depth(node.id)
    const order = counts.get(layer) ?? 0
    counts.set(layer, order + 1)
    const tier = node.kind === 'prompt' || node.kind === 'loop' ? (node.tier ?? doc.defaults.tier ?? 'standard') : undefined
    return {
      id: node.id,
      kind: node.kind,
      layer,
      order,
      gate: node.gate,
      ...node.when === undefined ? {} : { when: node.when },
      triggerRule: node.triggerRule,
      dependsOn: [...node.dependsOn],
      ...tier === undefined ? {} : { tier },
      label: node.label ?? node.id,
    }
  })
  const edges: GraphEdge[] = doc.nodes.flatMap(node =>
    node.dependsOn.map(from => ({ from, to: node.id, ...node.when === undefined ? {} : { when: node.when } })))
  return {
    nodes,
    edges,
    layers: counts.size,
    manifest: buildManifest(doc),
    inputs: doc.inputs.map(input => ({ ...input })),
  }
}

/** Spacing and node size for {@link layout}. */
export interface LayoutOptions {
  xGap: number
  yGap: number
  nodeW: number
  nodeH: number
}

/** Result of {@link layout}: top-left corner of every node plus the bounding box. */
export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>
  width: number
  height: number
}

/**
 * Layered layout: layers from the topological sort run left to right (x); within a layer, nodes
 * are ordered by the barycenter of their neighbours over alternating sweeps to reduce edge
 * crossings (y). Ties break on the previous order, then the id, so output is deterministic.
 */
export function layout(graph: WorkflowGraph, options: LayoutOptions): LayoutResult {
  const xGap = Math.max(0, options.xGap)
  const yGap = Math.max(0, options.yGap)
  const layers: string[][] = Array.from({ length: graph.layers }, () => [])
  const sorted = [...graph.nodes].sort((a, b) => a.layer - b.layer || a.order - b.order || (a.id < b.id ? -1 : 1))
  for (const node of sorted) layers[node.layer]?.push(node.id)
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const edge of graph.edges) {
    preds.set(edge.to, [...(preds.get(edge.to) ?? []), edge.from])
    succs.set(edge.from, [...(succs.get(edge.from) ?? []), edge.to])
  }
  const slot = new Map<string, number>()
  const reindex = (): void => { for (const layer of layers) layer.forEach((id, i) => slot.set(id, i)) }
  reindex()
  const sweep = (layer: string[], neighbours: Map<string, string[]>): void => {
    const keyed = layer.map((id, i) => {
      const around = neighbours.get(id) ?? []
      const mean = around.length === 0 ? i : around.reduce((sum, n) => sum + (slot.get(n) ?? 0), 0) / around.length
      return { id, i, mean }
    })
    keyed.sort((a, b) => a.mean - b.mean || a.i - b.i || (a.id < b.id ? -1 : 1))
    keyed.forEach((entry, i) => { layer[i] = entry.id })
    reindex()
  }
  for (let pass = 0; pass < 4; pass++) {
    for (const layer of layers.slice(1)) sweep(layer, preds)
    for (const layer of layers.slice(0, -1).reverse()) sweep(layer, succs)
  }
  const widest = Math.max(1, ...layers.map(layer => layer.length))
  const pitchY = options.nodeH + yGap
  const positions: Record<string, { x: number; y: number }> = {}
  layers.forEach((layer, l) => {
    const offset = ((widest - layer.length) * pitchY) / 2
    layer.forEach((id, i) => {
      positions[id] = { x: l * (options.nodeW + xGap), y: offset + i * pitchY }
    })
  })
  return {
    positions,
    width: Math.max(0, layers.length * options.nodeW + (layers.length - 1) * xGap),
    height: widest * options.nodeH + (widest - 1) * yGap,
  }
}

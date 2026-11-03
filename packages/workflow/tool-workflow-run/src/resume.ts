/**
 * Resume planning. A resumed run reads the store only: nodes that succeeded with a recoverable
 * output are skipped and their output is fed back into the pinned script; a successful mutating
 * node whose output cannot be recovered stops the resume with a reason, so a mutating node is
 * never silently run twice.
 * @module @deepseek-ai/dsh-tool-workflow-run/resume
 */

import type { RunDetail, WorkflowRunStore } from '@deepseek-ai/dsh-workflow-run-store'
import type { WorkflowDoc, WorkflowNode } from '@deepseek-ai/dsh-workflow-yaml'

/** The prelude line of the compiled script that every node goes through. */
const EXEC_ANCHOR = 'const exec = async (id, kind, deps, rule, cond, gates, body) => {\n'

/** Largest output a seed may carry, in bytes. */
export const MAX_SEED_BYTES = 1024 * 1024

/** One node a resumed run does not execute again. */
export interface Seed {
  readonly status: 'success'
  readonly output: string
  readonly exitCode?: number
}

/** The decision of {@link planResume}. */
export type ResumePlan =
  | {
    readonly ok: true
    /** Seeds by node id. */
    readonly seeds: ReadonlyMap<string, Seed>
    /** Gate outcomes the earlier run recorded for the seeded nodes, by node id and kind. */
    readonly gates: readonly { nodeId: string; gateKind: string; outcome: string }[]
  }
  | { readonly ok: false; readonly reason: string }

/**
 * Whether re-running this node could change the checkout or the world a second time.
 * @param node - the compiled workflow node.
 * @returns true for bash, loop, and prompt nodes marked as mutating the checkout.
 */
export function isMutating(node: WorkflowNode): boolean {
  switch (node.kind) {
    case 'bash':
    case 'loop': return true
    case 'prompt': return node.mutatesCheckout
    case 'approval':
    case 'cancel': return false
  }
}

async function readFullOutput(store: WorkflowRunStore, runId: string, nodeId: string): Promise<string | undefined> {
  let text = ''
  let offset: number | undefined = 0
  while (offset !== undefined) {
    const slice = await store.readOutput(runId, nodeId, offset, 256 * 1024)
    if (slice.truncated) return undefined
    text += slice.text
    if (Buffer.byteLength(text, 'utf8') > MAX_SEED_BYTES) return undefined
    offset = slice.nextOffset
  }
  return text
}

/**
 * Decide which nodes of an earlier run can be skipped.
 * @param store - the run store holding the earlier run.
 * @param detail - the earlier run, from `getRun`.
 * @param doc - the document compiled from that run's pinned source.
 * @returns the seeds, or the reason the resume is refused.
 */
export async function planResume(store: WorkflowRunStore, detail: RunDetail, doc: WorkflowDoc): Promise<ResumePlan> {
  const latest = new Map<string, RunDetail['nodeStates'][number]>()
  for (const state of detail.nodeStates) {
    const known = latest.get(state.nodeId)
    if (known === undefined || state.attempt >= known.attempt) latest.set(state.nodeId, state)
  }
  const seeds = new Map<string, Seed>()
  const byId = new Map(doc.nodes.map(n => [n.id, n] as const))
  const unrecoverable: string[] = []
  const candidates = new Map<string, Seed>()
  for (const node of doc.nodes) {
    const state = latest.get(node.id)
    if (state === undefined || state.running || state.record.status !== 'success') continue
    const record = state.record
    let output: string | undefined
    if (!record.truncated) {
      output = record.outputRef !== undefined
        ? await readFullOutput(store, detail.header.runId, node.id)
        : record.output ?? record.outputTail
    }
    // An approval's output is the constant answer, so it is always recoverable.
    if (node.kind === 'approval') output = 'allowed-once'
    if (output === undefined) {
      if (isMutating(node)) unrecoverable.push(node.id)
      continue
    }
    candidates.set(node.id, { status: 'success', output, ...record.exitCode === undefined ? {} : { exitCode: record.exitCode } })
  }
  if (unrecoverable.length > 0) {
    return {
      ok: false,
      reason: `cannot resume: node${unrecoverable.length === 1 ? '' : 's'} ${unrecoverable.map(n => `'${n}'`).join(', ')} succeeded earlier and change${unrecoverable.length === 1 ? 's' : ''} the workspace, `
        + 'but the stored output is incomplete, so the node cannot be skipped and must not run a second time. Start a fresh run instead.',
    }
  }
  // A node is skipped only when every node it depends on is skipped too. A successful mutating node
  // that would have to run again because a dependency is not recoverable stops the resume instead.
  const blocked: { id: string; dep: string }[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const [id] of candidates) {
      const node = byId.get(id)
      const missing = node?.dependsOn.find(dep => !candidates.has(dep))
      if (node !== undefined && missing !== undefined) {
        candidates.delete(id)
        if (isMutating(node)) blocked.push({ id, dep: missing })
        changed = true
      }
    }
  }
  if (blocked.length > 0) {
    const named = blocked.map(b => `'${b.id}' (needs '${b.dep}')`).join(', ')
    return {
      ok: false,
      reason: `cannot resume: node${blocked.length === 1 ? '' : 's'} ${named} succeeded earlier and change${blocked.length === 1 ? 's' : ''} the workspace, `
        + 'but a node it depends on has no recoverable output, so it would have to run a second time. Start a fresh run instead.',
    }
  }
  for (const [id, seed] of candidates) seeds.set(id, seed)
  const gates = detail.gates
    .filter(g => seeds.has(g.nodeId))
    .map(g => ({ nodeId: g.nodeId, gateKind: g.gateKind, outcome: g.outcome }))
  return { ok: true, seeds, gates }
}

/**
 * Add the seed map to a compiled script so seeded nodes return their earlier result without
 * running. The seed is a JSON string parsed into a Map.
 * @param script - the compiled script text.
 * @param seeds - nodes to skip.
 * @returns the script with the skip check, or undefined when the compiler's prelude no longer has the expected node wrapper.
 */
export function seedScript(script: string, seeds: ReadonlyMap<string, Seed>): string | undefined {
  if (seeds.size === 0) return script
  const first = script.indexOf(EXEC_ANCHOR)
  if (first === -1 || script.indexOf(EXEC_ANCHOR, first + 1) !== -1) return undefined
  // Data only: a JSON string parsed at run time into a Map, so a node id can never act as an object key.
  const literal = JSON.stringify(JSON.stringify([...seeds]))
  const head = `const SEED = new Map(JSON.parse(${literal}));\n`
  const check = '  { const seeded = SEED.get(id); if (seeded !== undefined) return Object.assign({}, seeded); }\n'
  return head + script.slice(0, first + EXEC_ANCHOR.length) + check + script.slice(first + EXEC_ANCHOR.length)
}

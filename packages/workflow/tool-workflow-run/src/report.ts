/**
 * Gate-report computation and the text a finished run is shown as. The report is derived from the
 * compiler's gate manifest and the gate outcomes the run recorded: a declared gate with no record
 * reads `not-reached`.
 * @module @deepseek-ai/dsh-tool-workflow-run/report
 */

import { GATE_NOT_REACHED } from '@deepseek-ai/dsh-workflow-run-store'
import type { GateReportRow, RunOutcome } from './types.ts'

/**
 * The key a gate outcome is stored under.
 * @param nodeId - the node that owns the gate.
 * @param gateKind - the gate kind.
 * @returns a stable lookup key.
 */
export function gateKey(nodeId: string, gateKind: string): string {
  return `${nodeId}\u0000${gateKind}`
}

/**
 * Compute the gate report.
 * @param manifest - the declared gates, in manifest order.
 * @param outcomes - recorded outcomes by {@link gateKey}.
 * @param reasons - block reasons by node id.
 * @returns one row per declared gate; gates without a record read `not-reached`.
 */
export function buildGateReport(
  manifest: readonly { nodeId: string; gateKind: string }[],
  outcomes: ReadonlyMap<string, string>,
  reasons: ReadonlyMap<string, string>,
): GateReportRow[] {
  return manifest.map(({ nodeId, gateKind }) => {
    const outcome = outcomes.get(gateKey(nodeId, gateKind)) ?? GATE_NOT_REACHED
    const reason = outcome === 'fired-block' || outcome === GATE_NOT_REACHED || outcome === 'never-evaluated' ? reasons.get(nodeId)
      : undefined
    return { nodeId, gateKind, outcome, ...reason === undefined ? {} : { reason } }
  })
}

/** Collapse a cell to one short line. */
function cell(text: string, max = 160): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Render a finished run for the model: status, node table, gate report and the reasons.
 * @param outcome - the run outcome.
 * @param maxChars - ceiling of the returned text.
 * @returns plain text, clipped with a notice past the ceiling.
 */
export function renderOutcome(outcome: RunOutcome, maxChars: number): string {
  const lines = [
    `workflow "${outcome.name}" run ${outcome.runId}: ${outcome.status} (pinned ${outcome.hash.slice(0, 8)})`
    + (outcome.resumedFrom === undefined ? '' : ` — resumed from ${outcome.resumedFrom}`),
  ]
  if (outcome.error !== undefined) lines.push(`error: ${cell(outcome.error, 600)}`)
  if (outcome.nodes.length > 0) {
    lines.push('', 'Nodes:')
    for (const n of outcome.nodes) {
      lines.push(`- ${n.nodeId} (${n.kind}): ${n.status}${n.exitCode === undefined ? '' : ` exit ${n.exitCode}`}${n.durationMs === undefined ? '' : ` ${n.durationMs} ms`}`)
    }
  }
  lines.push('', 'Workflow gate report:')
  if (outcome.report.length === 0) lines.push('- (no gates declared)')
  for (const row of outcome.report) {
    lines.push(`- ${row.nodeId} [${row.gateKind}]: ${row.outcome}${row.reason === undefined ? '' : ` — ${cell(row.reason, 400)}`}`)
  }
  const extra = Object.entries(outcome.reasons).filter(([node]) => !outcome.report.some(r => r.nodeId === node && r.reason !== undefined))
  if (extra.length > 0) {
    lines.push('', 'Reasons:')
    for (const [node, reason] of extra) lines.push(`- ${node}: ${cell(reason, 400)}`)
  }
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated: ${text.length - maxChars} more characters]` : text
}

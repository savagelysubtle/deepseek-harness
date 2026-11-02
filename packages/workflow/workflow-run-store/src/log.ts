/** Reading and folding `runs.jsonl`. */
import { readFile } from 'node:fs/promises'
import { WORKFLOW_RUN_RECORD_VERSION } from './constants.ts'
import { WorkflowStoreError } from './errors.ts'
import {
  GATE_NOT_REACHED,
  type ApprovalRecord,
  type EndRecord,
  type NodeState,
  type RunHeaderRecord,
  type RunSummary,
  type StoreRecord,
  type WorkflowGateRow,
} from './types.ts'

/** Parsed log. */
export interface LogContents {
  readonly records: StoreRecord[]
  /** Bytes in the file at read time. */
  readonly bytes: number
  /** Lines that were not valid JSON records (a torn final line is not counted). */
  readonly skipped: number
}

const KINDS = new Set(['run', 'node', 'gate', 'approval', 'end'])

/** Throw unless `value` carries a supported schema version. */
export function assertSupportedVersion(value: { v?: unknown }, where: string): void {
  if (value.v !== WORKFLOW_RUN_RECORD_VERSION)
    throw new WorkflowStoreError(
      'UNSUPPORTED_VERSION',
      `${where} has schema version ${String(value.v)}, but this build only understands version ` +
        `${WORKFLOW_RUN_RECORD_VERSION}. It was probably written by a newer dsh; upgrade dsh rather than editing it.`,
    )
}

/** Read and validate the whole log. A missing file is an empty log. */
export async function readLog(path: string): Promise<LogContents> {
  let text: string
  let bytes: number
  try {
    const buf = await readFile(path)
    bytes = buf.length
    text = buf.toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], bytes: 0, skipped: 0 }
    throw error
  }
  const records: StoreRecord[] = []
  let skipped = 0
  const lines = text.split('\n')
  const last = lines.length - 1
  for (let i = 0; i <= last; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // The final line without a newline is a write torn by a crash; anything else is damage.
      if (i !== last) skipped++
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) {
      skipped++
      continue
    }
    const rec = parsed as { v?: unknown; kind?: unknown }
    assertSupportedVersion(rec, `A record in ${path}`)
    if (typeof rec.kind !== 'string' || !KINDS.has(rec.kind)) {
      skipped++
      continue
    }
    records.push(parsed as StoreRecord)
  }
  return { records, bytes, skipped }
}

/** Fold records into run summaries, oldest first. */
export function foldSummaries(records: readonly StoreRecord[]): RunSummary[] {
  const byId = new Map<string, RunSummary>()
  for (const rec of records) {
    if (rec.kind === 'run') byId.set(rec.runId, summaryOf(rec))
    else if (rec.kind === 'end') {
      const prev = byId.get(rec.runId)
      if (prev) byId.set(rec.runId, applyEnd(prev, rec))
    }
  }
  return [...byId.values()]
}

/** Summary for a fresh run header. */
export function summaryOf(header: RunHeaderRecord): RunSummary {
  return {
    runId: header.runId,
    name: header.name,
    hash: header.hash,
    startedAt: header.startedAt,
    status: 'running',
    ownerPid: header.ownerPid,
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
  }
}

/** Summary after an end record. */
export function applyEnd(summary: RunSummary, end: EndRecord): RunSummary {
  return { ...summary, status: end.status, endedAt: end.endedAt }
}

/** Latest approval record per approval id for one run. */
export function latestApprovals(records: readonly StoreRecord[], runId: string): ApprovalRecord[] {
  const byId = new Map<string, ApprovalRecord>()
  for (const rec of records) if (rec.kind === 'approval' && rec.runId === runId) byId.set(rec.approvalId, rec)
  return [...byId.values()]
}

/** Gate report: manifest gates (latest outcome or `not-reached`) plus any undeclared gate rows. */
export function computeReport(records: readonly StoreRecord[], header: RunHeaderRecord): WorkflowGateRow[] {
  const seen = new Map<string, WorkflowGateRow>()
  const key = (nodeId: string, gateKind: string): string => `${nodeId}\u0000${gateKind}`
  for (const rec of records)
    if (rec.kind === 'gate' && rec.runId === header.runId)
      seen.set(key(rec.nodeId, rec.gateKind), { nodeId: rec.nodeId, gateKind: rec.gateKind, outcome: rec.outcome })
  const rows: WorkflowGateRow[] = []
  const used = new Set<string>()
  for (const gate of header.manifest.gates ?? []) {
    const k = key(gate.nodeId, gate.gateKind)
    used.add(k)
    rows.push(seen.get(k) ?? { nodeId: gate.nodeId, gateKind: gate.gateKind, outcome: GATE_NOT_REACHED })
  }
  for (const [k, row] of seen) if (!used.has(k)) rows.push(row)
  return rows
}

/** Latest node record per nodeId and attempt, in first-seen order. */
export function foldNodeStates(records: readonly StoreRecord[], runId: string): NodeState[] {
  const states = new Map<string, NodeState>()
  for (const rec of records) {
    if (rec.kind !== 'node' || rec.runId !== runId) continue
    const key = `${rec.nodeId}\u0000${rec.attempt}`
    const prev = states.get(key)
    // An end record is never replaced by a late start record.
    if (prev && !prev.running && rec.status === 'running') continue
    states.set(key, { nodeId: rec.nodeId, attempt: rec.attempt, running: rec.status === 'running', record: rec })
  }
  return [...states.values()]
}

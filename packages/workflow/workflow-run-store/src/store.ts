/** The durable per-workspace run store. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WORKFLOW_RUN_RECORD_VERSION } from './constants.ts'
import { WorkflowStoreError, WRITER_BUSY_REMEDY } from './errors.ts'
import { assertNodeId, assertRunId, ensurePrivateDir, FILE_MODE, joinUnder, writeFileAtomic } from './fs-util.ts'
import {
  acquireLock,
  createProcessProbe,
  holderIsDead,
  leaseStillHeld,
  releaseLock,
  type ProcessProbe,
  type WriterLease,
} from './lock.ts'
import {
  applyEnd,
  assertSupportedVersion,
  computeReport,
  foldNodeStates,
  foldSummaries,
  latestApprovals,
  readLog,
  summaryOf,
} from './log.ts'
import {
  LIMITS,
  type ApprovalRecord,
  type DecideApprovalResult,
  type EndRecord,
  type EndRunInput,
  type GateRecord,
  type IndexFile,
  type ListRunsResult,
  type NodeRecord,
  type OutputSlice,
  type PruneResult,
  type RecordGateInput,
  type RecordNodeInput,
  type RunDetail,
  type RunHeaderRecord,
  type RunSummary,
  type StartRunInput,
  type StoreRecord,
  type SweepResult,
  type WorkflowApprovalState,
} from './types.ts'

/** Options for {@link openStore}. */
export interface OpenStoreOptions {
  /**
   * Store directory, normally from {@link workflowStoreDir}.
   */
  readonly dir: string
  /**
   * Full workspace realpath; `index.json` records it and a mismatch refuses the store.
   */
  readonly workspace: string
  /** Newest runs kept per workspace (default 200). */
  readonly retention?: number
  /** Close crashed runs on open (default true). */
  readonly sweepOnOpen?: boolean
  /** Per-run spill budget in bytes (default {@link LIMITS.runSpillBudgetBytes}). */
  readonly runSpillBudgetBytes?: number
  /** Process facts; injectable for tests. */
  readonly probe?: ProcessProbe
  /** Clock; injectable for tests. */
  readonly now?: () => number
}

/**
 * Resolve the store directory for a workspace: `<dshHome>/workflow-runs/<sha256(realpath)[0:16]>`.
 * @param dshHome - The dsh home directory.
 * @param workspace - Workspace path (symlinks are resolved).
 * @returns The store directory and the workspace realpath.
 */
export async function workflowStoreDir(
  dshHome: string,
  workspace: string,
): Promise<{ dir: string; workspace: string }> {
  const real = await realpath(workspace)
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 16)
  return { dir: join(dshHome, 'workflow-runs', hash), workspace: real }
}

/**
 * Open (creating if needed) the run store for one workspace and sweep crashed runs.
 * @param options - Directory, workspace realpath and tuning options.
 * @returns A handle on the store.
 * @throws WorkflowStoreError `WORKSPACE_MISMATCH` or `UNSUPPORTED_VERSION` for a foreign or newer index.
 */
export async function openStore(options: OpenStoreOptions): Promise<WorkflowRunStore> {
  await ensurePrivateDir(dirname(options.dir))
  await ensurePrivateDir(options.dir)
  const store = new WorkflowRunStore(options, options.probe ?? (await createProcessProbe()))
  await store.init()
  if (options.sweepOnOpen !== false) await store.sweepInterrupted()
  return store
}

function byteAt(buf: Buffer, index: number): number {
  return buf[index] ?? 0
}

function tailOf(bytes: Buffer, max: number): string {
  if (bytes.length <= max) return bytes.toString('utf8')
  let start = bytes.length - max
  while (start < bytes.length && (byteAt(bytes, start) & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

function trimIncompleteTail(buf: Buffer): Buffer {
  let i = buf.length - 1
  let back = 0
  while (i >= 0 && back < 3 && (byteAt(buf, i) & 0xc0) === 0x80) {
    i--
    back++
  }
  if (i < 0) return buf
  const lead = byteAt(buf, i)
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return buf.length - i < need ? buf.subarray(0, i) : buf
}

/** Handle on one workspace's run store. */
export class WorkflowRunStore {
  /** Store directory. */
  readonly dir: string
  /** Full workspace realpath this store belongs to. */
  readonly workspace: string
  private readonly retention: number
  private readonly spillBudget: number
  private readonly probe: ProcessProbe
  private readonly now: () => number
  private lease: WriterLease | undefined
  private acquiredByRun = false
  private activeRun: { runId: string; name: string; startedAt: number } | undefined
  private cache: { logBytes: number; runs: RunSummary[]; skipped: number } | undefined
  private tail: Promise<unknown> = Promise.resolve()

  /** @internal Use {@link openStore}. */
  constructor(options: OpenStoreOptions, probe: ProcessProbe) {
    this.dir = options.dir
    this.workspace = options.workspace
    this.retention = options.retention ?? LIMITS.retention
    this.spillBudget = options.runSpillBudgetBytes ?? LIMITS.runSpillBudgetBytes
    this.probe = probe
    this.now = options.now ?? Date.now
  }

  private get logPath(): string {
    return join(this.dir, 'runs.jsonl')
  }

  private get indexPath(): string {
    return join(this.dir, 'index.json')
  }

  private runDir(runId: string): string {
    assertRunId(runId)
    return joinUnder(this.dir, runId)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next
  }

  /**
   * Validate the existing index (version, workspace), tighten file modes and prime the cache. Internal; use {@link openStore}.
   */
  async init(): Promise<void> {
    for (const name of ['runs.jsonl', 'index.json', 'writer.lock'])
      await chmod(join(this.dir, name), FILE_MODE).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      })
    await this.loadSummaries()
  }

  // ---- writer guard -------------------------------------------------------------------------

  /**
   * Take the single-writer lock for this workspace.
   * @param info - Optional run id and workflow name published in the lock.
   * @throws WorkflowStoreError `WRITER_BUSY` naming the holder.
   */
  async acquireWriter(info: { runId?: string; workflowName?: string } = {}): Promise<void> {
    if (this.lease) return
    this.lease = await acquireLock(this.dir, { ...info, now: this.now() }, this.probe)
  }

  /**
   * Release the writer lock if this handle holds it.
   */
  async releaseWriter(): Promise<void> {
    const lease = this.lease
    this.lease = undefined
    this.acquiredByRun = false
    if (lease) await releaseLock(lease)
  }

  private async requireWriter(): Promise<void> {
    if (!this.lease)
      throw new WorkflowStoreError(
        'NOT_WRITER',
        'This run is owned by another process (or this handle never started it), so it can only be changed there.',
      )
    if (!(await leaseStillHeld(this.lease))) {
      this.lease = undefined
      throw new WorkflowStoreError('NOT_WRITER', 'The workflow run lock was taken over by another process, so this run can no longer write records.')
    }
  }

  // ---- index --------------------------------------------------------------------------------

  private async loadSummaries(force: boolean = false): Promise<{ logBytes: number; runs: RunSummary[]; skipped: number }> {
    const size = await stat(this.logPath).then(s => s.size, (e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw e
    })
    if (!force && this.cache && this.cache.logBytes === size) return this.cache
    const index = force ? undefined : await this.readIndex()
    if (index && index.logBytes === size) {
      this.cache = { logBytes: size, runs: [...index.runs], skipped: index.skipped ?? 0 }
      return this.cache
    }
    const log = await readLog(this.logPath)
    this.cache = { logBytes: log.bytes, runs: foldSummaries(log.records), skipped: log.skipped }
    await this.writeIndex().catch((e: unknown) => {
      if (!(e as NodeJS.ErrnoException).code) throw e // index is a cache: filesystem trouble must not fail a read
    })
    return this.cache
  }

  private async readIndex(): Promise<IndexFile | undefined> {
    let text: string
    try {
      text = await readFile(this.indexPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return undefined // corrupt: rebuilt from the log
    }
    if (typeof raw !== 'object' || raw === null) return undefined
    const parsed = raw as { v?: unknown; workspace?: unknown; logBytes?: unknown; runs?: unknown; skipped?: unknown }
    // Only a numeric version newer than ours is refused; anything else is damage and is rebuilt.
    if (typeof parsed.v !== 'number' || parsed.v < 1) return undefined
    assertSupportedVersion(parsed, this.indexPath)
    if (parsed.workspace !== this.workspace)
      throw new WorkflowStoreError(
        'WORKSPACE_MISMATCH',
        `This store directory belongs to workspace '${String(parsed.workspace)}', not '${this.workspace}' ` +
          '(a hash-prefix collision). Refusing to mix their run history.',
      )
    if (typeof parsed.logBytes !== 'number' || !Array.isArray(parsed.runs)) return undefined
    return parsed as IndexFile
  }

  private async writeIndex(): Promise<void> {
    if (!this.cache) return
    const index: IndexFile = {
      v: WORKFLOW_RUN_RECORD_VERSION,
      workspace: this.workspace,
      logBytes: this.cache.logBytes,
      runs: this.cache.runs,
      skipped: this.cache.skipped,
    }
    await writeFileAtomic(this.indexPath, JSON.stringify(index))
  }

  // ---- appending ----------------------------------------------------------------------------

  private async append(record: StoreRecord): Promise<void> {
    await this.requireWriter()
    const cache = await this.loadSummaries()
    const body = `${JSON.stringify(record)}\n`
    const handle = await open(this.logPath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, FILE_MODE)
    try {
      const preSize = (await handle.stat()).size
      let line = body
      if (preSize > 0) {
        // Checked on every append: another handle or a crash may have left a torn fragment.
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, preSize - 1)
        if (last[0] !== 0x0a) line = `\n${body}`
      }
      try {
        await handle.writeFile(line)
        await handle.sync()
      } catch (error) {
        await handle.truncate(preSize).catch(() => undefined) // never leave a partial record behind
        throw error
      }
      cache.logBytes = preSize + Buffer.byteLength(line)
    } finally {
      await handle.close()
    }
    if (record.kind === 'run') cache.runs.push(summaryOf(record))
    else if (record.kind === 'end') {
      const i = cache.runs.findIndex(r => r.runId === record.runId)
      const current = cache.runs[i]
      if (current) cache.runs[i] = applyEnd(current, record)
    }
    await this.writeIndex()
  }

  // ---- runs ---------------------------------------------------------------------------------

  /**
   * Begin a run: take the writer lock, prune old runs, pin `source.yaml` and append the run header. The lock is released by {@link endRun}.
   * @param input - Run identity, pinned source and manifest.
   * @returns The persisted header record.
   * @throws WorkflowStoreError `WRITER_BUSY` when a run is active here or elsewhere; `INVALID_INPUT` for bad fields.
   */
  startRun(input: StartRunInput): Promise<RunHeaderRecord> {
    return this.serial(async () => {
      assertRunId(input.runId)
      validateStartInput(input)
      if (this.activeRun)
        throw new WorkflowStoreError(
          'WRITER_BUSY',
          `This workspace already has an active run on this handle: workflow '${this.activeRun.name}' (run ${this.activeRun.runId}), ` +
            `started ${new Date(this.activeRun.startedAt).toISOString()}. ${WRITER_BUSY_REMEDY}`,
          {
            pid: this.probe.pid,
            hostname: this.probe.hostname,
            startedAt: this.activeRun.startedAt,
            runId: this.activeRun.runId,
            workflowName: this.activeRun.name,
          },
        )
      let acquired = false
      if (!this.lease) {
        await this.acquireWriter({ runId: input.runId, workflowName: input.name })
        acquired = true
      }
      try {
        const known = await this.loadSummaries()
        if (known.runs.some(r => r.runId === input.runId))
          throw new WorkflowStoreError('RUN_EXISTS', `Run '${input.runId}' already exists in this workspace.`)
        await this.pruneLocked(this.retention - 1)
        const dir = this.runDir(input.runId)
        await ensurePrivateDir(dir)
        const sourcePath = join(dir, 'source.yaml')
        if (!(await writeFileAtomic(sourcePath, input.source, { createIfAbsent: true })))
          throw new WorkflowStoreError('RUN_EXISTS', `Run directory '${input.runId}' already has a pinned source.`)
        const header: RunHeaderRecord = {
          v: WORKFLOW_RUN_RECORD_VERSION,
          kind: 'run',
          runId: input.runId,
          name: input.name,
          hash: input.hash,
          workspace: this.workspace,
          ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
          startedAt: this.now(),
          inputs: boundInputs(input.inputs),
          manifest: input.manifest,
          ownerPid: this.probe.pid,
          ownerHost: this.probe.hostname,
          ownerStartTime: this.probe.startTime(this.probe.pid),
          ownerBootId: this.probe.bootId,
        }
        await this.append(header)
        this.activeRun = { runId: input.runId, name: input.name, startedAt: header.startedAt }
        this.acquiredByRun = acquired || this.acquiredByRun
        return header
      } catch (error) {
        if (acquired) await this.releaseWriter()
        throw error
      }
    })
  }

  private async requireActive(runId: string): Promise<void> {
    assertRunId(runId)
    const { runs } = await this.loadSummaries()
    const run = runs.find(r => r.runId === runId)
    if (!run) throw new WorkflowStoreError('RUN_NOT_FOUND', `Run '${runId}' does not exist.`)
    if (run.status !== 'running') throw new WorkflowStoreError('RUN_NOT_FOUND', `Run '${runId}' has already ended.`)
  }

  /**
   * Append a node-start (`running`) or node-end record; output over 64 KB spills to disk.
   * @param runId - Active run.
   * @param input - Node status, timing and optional output.
   * @returns The persisted node record.
   */
  recordNode(runId: string, input: RecordNodeInput): Promise<NodeRecord> {
    return this.serial(async () => {
      assertNodeId(input.nodeId)
      assertToken('Node kind', input.nodeKind)
      await this.requireWriter()
      await this.requireActive(runId)
      const base = {
        v: WORKFLOW_RUN_RECORD_VERSION,
        kind: 'node',
        runId,
        nodeId: input.nodeId,
        nodeKind: input.nodeKind,
        status: input.status,
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        startedAt: input.startedAt,
        ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        attempt: input.attempt ?? 1,
        ...(input.error ? { error: input.error.slice(0, LIMITS.maxErrorChars) } : {}),
      } as const
      let record: NodeRecord = { ...base, truncated: input.outputTruncated === true }
      if (input.output !== undefined) {
        // Clip the string first so a pathological output never allocates a huge buffer.
        const overChars = input.output.length > LIMITS.maxSpillBytes
        let bytes: Buffer = Buffer.from(overChars ? input.output.slice(0, LIMITS.maxSpillBytes + 1) : input.output, 'utf8')
        const clipped = overChars || bytes.length > LIMITS.maxSpillBytes
        if (bytes.length > LIMITS.maxSpillBytes) bytes = trimIncompleteTail(bytes.subarray(0, LIMITS.maxSpillBytes))
        const outputTail = tailOf(bytes, LIMITS.tailBytes)
        if (bytes.length > LIMITS.spillBytes) {
          const outputRef = `${input.nodeId}.out`
          const runDir = this.runDir(runId)
          await ensurePrivateDir(runDir)
          if ((await this.spillBytesUsed(runDir, outputRef)) + bytes.length > this.spillBudget) {
            record = {
              ...record,
              outputTail,
              truncated: true,
              outputNote: 'The full output was not saved: this run reached its spill budget.',
            }
          } else {
            await writeFileAtomic(joinUnder(runDir, outputRef), bytes)
            record = { ...record, outputTail, outputRef, truncated: record.truncated || clipped }
          }
        } else if (bytes.length > LIMITS.tailBytes) {
          record = { ...record, outputTail, output: bytes.toString('utf8') }
        } else {
          record = { ...record, outputTail }
        }
      }
      await this.append(record)
      return record
    })
  }

  private async spillBytesUsed(runDir: string, except: string): Promise<number> {
    let total = 0
    for (const entry of await readdir(runDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.out') || entry.name === except) continue
      total += (await stat(join(runDir, entry.name))).size
    }
    return total
  }

  /**
   * Append a gate record.
   * @param runId - Active run.
   * @param input - Gate node, kind and outcome token.
   * @returns The persisted gate record.
   */
  recordGate(runId: string, input: RecordGateInput): Promise<GateRecord> {
    return this.serial(async () => {
      assertNodeId(input.nodeId)
      assertToken('Gate kind', input.gateKind)
      assertToken('Gate outcome', input.outcome)
      await this.requireWriter()
      await this.requireActive(runId)
      const record: GateRecord = {
        v: WORKFLOW_RUN_RECORD_VERSION,
        kind: 'gate',
        runId,
        nodeId: input.nodeId,
        gateKind: input.gateKind,
        outcome: input.outcome,
      }
      await this.append(record)
      return record
    })
  }

  /**
   * Write a `pending` approval with a fresh 128-bit random id.
   * @param runId - Active run.
   * @param input - Approval node id and message (capped and cleaned).
   * @returns The pending approval record.
   */
  recordApproval(runId: string, input: { nodeId: string; message: string }): Promise<ApprovalRecord> {
    return this.serial(async () => {
      assertNodeId(input.nodeId)
      await this.requireWriter()
      await this.requireActive(runId)
      const record: ApprovalRecord = {
        v: WORKFLOW_RUN_RECORD_VERSION,
        kind: 'approval',
        runId,
        approvalId: randomBytes(16).toString('hex'),
        nodeId: input.nodeId,
        message: cleanText(input.message, LIMITS.approvalMessageChars, true),
        state: 'pending',
        at: this.now(),
      }
      await this.append(record)
      return record
    })
  }

  /**
   * Decide a pending approval by compare-and-set: the first call flips it, any later call
   * returns the existing decision with `decided: false`.
   * @param runId - Run the approval belongs to.
   * @param approvalId - Id from {@link recordApproval}.
   * @param decision - New state and optional reason.
   * @returns Whether this call decided it, and the winning record.
   * @throws WorkflowStoreError `APPROVAL_NOT_FOUND` for unknown ids; `NOT_WRITER` when the run is owned elsewhere.
   */
  decideApproval(
    runId: string,
    approvalId: string,
    decision: { state: Exclude<WorkflowApprovalState, 'pending'>; reason?: string },
  ): Promise<DecideApprovalResult> {
    return this.serial(async () => {
      assertRunId(runId)
      const log = await readLog(this.logPath)
      const current = latestApprovals(log.records, runId).find(a => a.approvalId === approvalId)
      if (!current) throw new WorkflowStoreError('APPROVAL_NOT_FOUND', `No approval '${approvalId}' exists for run '${runId}'.`)
      if (current.state !== 'pending') return { decided: false, approval: current }
      if (log.records.some(r => r.kind === 'end' && r.runId === runId)) return { decided: false, approval: current }
      await this.requireWriter()
      const summary = (await this.loadSummaries()).runs.find(r => r.runId === runId)
      if (this.activeRun?.runId !== runId || summary?.status !== 'running')
        throw new WorkflowStoreError(
          'NOT_WRITER',
          'This run is owned by another process (or this handle never started it), so it can only be changed there.',
        )
      const record: ApprovalRecord = {
        ...current,
        state: decision.state,
        ...(decision.reason ? { reason: cleanText(decision.reason, LIMITS.approvalReasonChars, false) } : {}),
        at: this.now(),
      }
      await this.append(record)
      return { decided: true, approval: record }
    })
  }

  /**
   * Close the run: cancel pending approvals, compute the gate report, append `end`, free the lock.
   * @param runId - Active run.
   * @param input - Terminal status, optional error and optional explicit report.
   * @returns The persisted end record.
   */
  endRun(runId: string, input: EndRunInput): Promise<EndRecord> {
    return this.serial(async () => {
      for (const row of input.report ?? []) {
        assertNodeId(row.nodeId)
        assertToken('Gate kind', row.gateKind)
        assertToken('Gate outcome', row.outcome)
      }
      await this.requireActive(runId)
      const log = await readLog(this.logPath)
      const end = await this.closeRun(log.records, runId, input.status, input.error, input.report, 'run ended')
      if (this.activeRun?.runId === runId) {
        this.activeRun = undefined
        if (this.acquiredByRun) await this.releaseWriter()
      }
      return end
    })
  }

  private async closeRun(
    records: readonly StoreRecord[],
    runId: string,
    status: EndRecord['status'],
    error: string | undefined,
    report: EndRecord['report'] | undefined,
    reason: string,
  ): Promise<EndRecord> {
    const header = records.find((r): r is RunHeaderRecord => r.kind === 'run' && r.runId === runId)
    if (!header) throw new WorkflowStoreError('RUN_NOT_FOUND', `Run '${runId}' does not exist.`)
    for (const approval of latestApprovals(records, runId))
      if (approval.state === 'pending') await this.append({ ...approval, state: 'cancelled', reason, at: this.now() })
    const end: EndRecord = {
      v: WORKFLOW_RUN_RECORD_VERSION,
      kind: 'end',
      runId,
      status,
      endedAt: this.now(),
      report: report ?? computeReport(records, header),
      ...(error ? { error: error.slice(0, LIMITS.maxErrorChars) } : {}),
    }
    await this.append(end)
    return end
  }

  // ---- reads --------------------------------------------------------------------------------

  /**
   * List runs newest first, backed by `index.json` (rebuilt from the log when stale or corrupt).
   * @param options - Optional name filter, page size (1-200) and cursor.
   * @returns One page of summaries and a cursor for the next.
   */
  async listRuns(options: { name?: string; limit?: number; cursor?: string } = {}): Promise<ListRunsResult> {
    const { runs, skipped } = await this.loadSummaries()
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const skip = options.cursor ? Number.parseInt(options.cursor, 10) : 0
    const matching = runs.filter(r => !options.name || r.name === options.name).reverse()
    const start = Number.isFinite(skip) && skip > 0 ? skip : 0
    const page = matching.slice(start, start + limit)
    const next = start + limit < matching.length ? String(start + limit) : undefined
    return { runs: page, skippedLines: skipped, ...(next ? { nextCursor: next } : {}) }
  }

  /**
   * Full detail of one run.
   * @param runId - Run to read.
   * @returns Header, node rows and folded states, gates, approvals and end record.
   * @throws WorkflowStoreError `RUN_NOT_FOUND` when the run does not exist.
   */
  async getRun(runId: string): Promise<RunDetail> {
    assertRunId(runId)
    const { records, skipped } = await readLog(this.logPath)
    const header = records.find((r): r is RunHeaderRecord => r.kind === 'run' && r.runId === runId)
    if (!header) throw new WorkflowStoreError('RUN_NOT_FOUND', `Run '${runId}' does not exist.`)
    const own = records.filter(r => r.runId === runId)
    const end = own.find((r): r is EndRecord => r.kind === 'end')
    return {
      header,
      status: end ? end.status : 'running',
      nodes: own.filter((r): r is NodeRecord => r.kind === 'node'),
      nodeStates: foldNodeStates(records, runId),
      skippedLines: skipped,
      gates: own.filter((r): r is GateRecord => r.kind === 'gate'),
      approvals: latestApprovals(records, runId),
      ...(end ? { end } : {}),
    }
  }

  /**
   * The workflow source text pinned when the run started.
   * @param runId - Run to read.
   * @returns The pinned `source.yaml` text.
   */
  async readSource(runId: string): Promise<string> {
    try {
      return await readFile(joinUnder(this.runDir(runId), 'source.yaml'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new WorkflowStoreError('RUN_NOT_FOUND', `Run '${runId}' has no pinned source.`)
      throw error
    }
  }

  /**
   * Read a byte range of a node's output (spill file, inline output, or tail), capped per call.
   * @param runId - Run to read.
   * @param nodeId - Node whose latest output is read.
   * @param offset - Starting byte offset.
   * @param limit - Maximum bytes to return (capped at 256 KiB).
   * @returns The text slice, the next offset when more remains, and the total size.
   */
  async readOutput(runId: string, nodeId: string, offset: number = 0, limit: number = LIMITS.readOutputMaxLimit): Promise<OutputSlice> {
    assertNodeId(nodeId)
    const detail = await this.getRun(runId)
    const rec = [...detail.nodes].reverse().find(n => n.nodeId === nodeId && n.status !== 'running') ??
      [...detail.nodes].reverse().find(n => n.nodeId === nodeId)
    if (!rec) throw new WorkflowStoreError('OUTPUT_NOT_FOUND', `Run '${runId}' has no node '${nodeId}'.`)
    const cap = Math.min(Math.max(Math.floor(limit), 1), LIMITS.readOutputMaxLimit)
    const start = Math.max(Math.floor(offset), 0)
    let buf: Buffer
    let total: number
    if (rec.outputRef) {
      const handle = await open(joinUnder(this.runDir(runId), rec.outputRef), constants.O_RDONLY).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
          throw new WorkflowStoreError('OUTPUT_NOT_FOUND', `The full output of node '${nodeId}' was pruned or is missing.`)
        throw e
      })
      try {
        total = (await handle.stat()).size
        const want = Buffer.alloc(cap + 4)
        const { bytesRead } = await handle.read(want, 0, want.length, start)
        buf = want.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    } else {
      const whole = Buffer.from(rec.output ?? rec.outputTail ?? '', 'utf8')
      total = whole.length
      buf = whole.subarray(start, start + cap + 4)
    }
    let s = 0
    if (start > 0) while (s < 3 && s < buf.length && (byteAt(buf, s) & 0xc0) === 0x80) s++
    let slice = buf.subarray(s, s + cap)
    if (start + s + slice.length < total) slice = trimIncompleteTail(slice)
    const next = start + s + slice.length
    return {
      text: slice.toString('utf8'),
      ...(next < total ? { nextOffset: next } : {}),
      totalBytes: total,
      truncated: rec.truncated,
    }
  }

  // ---- recovery and retention ---------------------------------------------------------------

  /**
   * Close every run with no `end` record whose owner process is provably gone, as `interrupted`,
   * with unreached gates marked `not-reached`. Does nothing when another live process holds the
   * writer lock.
   * @returns The swept run ids, or `skipped: 'writer-busy'`.
   */
  sweepInterrupted(): Promise<SweepResult> {
    return this.serial(() => this.withLock<SweepResult>(() => this.sweepLocked(), { swept: [], skipped: 'writer-busy' }))
  }

  /**
   * Remove the oldest finished runs (log records, pinned source, spill files) beyond retention, and reap stale temp files.
   * @param options - Optional `keep` count overriding the configured retention.
   * @returns The removed run ids, or `skipped: 'writer-busy'`.
   */
  prune(options: { keep?: number } = {}): Promise<PruneResult> {
    return this.serial(() =>
      this.withLock<PruneResult>(() => this.pruneLocked(options.keep ?? this.retention), { removed: [], skipped: 'writer-busy' }),
    )
  }

  private async withLock<T>(fn: () => Promise<T>, busy: T): Promise<T> {
    if (this.lease) return fn()
    try {
      await this.acquireWriter()
    } catch (error) {
      if (error instanceof WorkflowStoreError && error.code === 'WRITER_BUSY') return busy
      throw error
    }
    try {
      return await fn()
    } finally {
      await this.releaseWriter()
    }
  }

  private async sweepLocked(): Promise<SweepResult> {
    const log = await readLog(this.logPath)
    const ended = new Set(log.records.filter(r => r.kind === 'end').map(r => r.runId))
    const swept: string[] = []
    for (const rec of log.records) {
      if (rec.kind !== 'run' || ended.has(rec.runId) || rec.runId === this.activeRun?.runId) continue
      const dead = holderIsDead(
        { pid: rec.ownerPid, hostname: rec.ownerHost, startTime: rec.ownerStartTime, bootId: rec.ownerBootId },
        this.probe,
      )
      if (!dead) continue
      await this.closeRun(
        log.records,
        rec.runId,
        'interrupted',
        'The dsh host stopped before this run finished. Commands it started may still be running.',
        undefined,
        'run interrupted',
      )
      swept.push(rec.runId)
    }
    return { swept }
  }

  private async pruneLocked(keep: number): Promise<PruneResult> {
    await this.sweepLocked()
    const log = await readLog(this.logPath)
    const summaries = foldSummaries(log.records)
    let excess = summaries.length - Math.max(keep, 0)
    const removed: string[] = []
    for (const run of summaries) {
      if (excess <= 0) break
      if (run.status === 'running' || run.runId === this.activeRun?.runId) continue
      removed.push(run.runId)
      excess--
    }
    const gone = new Set(removed)
    if (removed.length > 0) {
      const kept = log.records.filter(r => !gone.has(r.runId))
      const text = kept.map(r => JSON.stringify(r)).join('\n')
      await writeFileAtomic(this.logPath, kept.length ? `${text}\n` : '')
      this.cache = undefined
      for (const id of removed) await rm(this.runDir(id), { recursive: true, force: true })
      await this.loadSummaries(true)
    }
    await this.removeOrphanDirs(new Set(summaries.map(s => s.runId)))
    await this.reapTempFiles()
    return { removed }
  }

  /** Delete leftover `.*.tmp` files (crash between write and rename) older than an hour. */
  private async reapTempFiles(): Promise<void> {
    const cutoff = this.now() - LIMITS.tempReapMs
    const dirs = [this.dir]
    for (const entry of await readdir(this.dir, { withFileTypes: true }))
      if (entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.name)) dirs.push(join(this.dir, entry.name))
    for (const dir of dirs)
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!/^\..*\.tmp$/.test(name)) continue
        const path = join(dir, name)
        const info = await stat(path).catch(() => undefined)
        if (info?.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true })
      }
  }

  /** Run directories with no log record (crash between mkdir and header) older than a day. */
  private async removeOrphanDirs(known: ReadonlySet<string>): Promise<void> {
    const dayAgo = this.now() - 24 * 60 * 60 * 1000
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || known.has(entry.name) || entry.name === this.activeRun?.runId) continue
      try {
        assertRunId(entry.name)
      } catch {
        continue // not ours
      }
      const path = join(this.dir, entry.name)
      if ((await stat(path)).mtimeMs < dayAgo) await rm(path, { recursive: true, force: true })
    }
  }
}

function boundInputs(inputs: unknown): unknown {
  if (inputs === undefined) return {}
  const text = JSON.stringify(inputs)
  const bytes = Buffer.byteLength(text)
  return bytes > LIMITS.inputsBytes ? { truncated: true, bytes } : inputs
}

/** Strip control characters (keeping `\n` when asked) and cap the length. */
function cleanText(text: string, max: number, keepNewlines: boolean): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x0a && keepNewlines) out += ch
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
    else out += ch
    if (out.length >= max) break
  }
  return out.slice(0, max)
}

const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** Kinds and outcomes are short lowercase tokens; free text (possible secrets) is refused. */
function assertToken(what: string, value: string): void {
  if (!KIND_RE.test(value))
    throw new WorkflowStoreError('INVALID_INPUT', `${what} '${value.slice(0, 40)}' must be a short lowercase token (a-z, 0-9, '_' or '-').`)
}

function validateStartInput(input: StartRunInput): void {
  for (const gate of input.manifest.gates ?? []) {
    assertNodeId(gate.nodeId)
    assertToken('Gate kind', gate.gateKind)
  }
  const refuse = (what: string): never => {
    throw new WorkflowStoreError('INVALID_INPUT', `Cannot start the run: ${what}.`)
  }
  if (input.name.length === 0 || input.name.length > LIMITS.nameChars) refuse(`the workflow name must be 1-${LIMITS.nameChars} characters`)
  if (!/^[0-9a-f]{64}$/.test(input.hash)) refuse('the workflow hash must be 64 lowercase hex characters (SHA-256)')
  if (input.parentSessionId !== undefined && input.parentSessionId.length > LIMITS.parentSessionIdChars)
    refuse(`the parent session id is longer than ${LIMITS.parentSessionIdChars} characters`)
  if (Buffer.byteLength(JSON.stringify(input.manifest)) > LIMITS.manifestBytes)
    refuse(`the workflow manifest is larger than ${LIMITS.manifestBytes / 1024} KB`)
}

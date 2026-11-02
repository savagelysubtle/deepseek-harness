import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GATE_NOT_REACHED,
  LIMITS,
  openStore,
  WorkflowStoreError,
  workflowStoreDir,
  writeFileAtomic,
  type OpenStoreOptions,
  type ProcessProbe,
  type WorkflowRunStore,
} from '../src/index.ts'

let root: string
let workspace: string
let dir: string
let realWorkspace: string

const manifest = {
  gates: [
    { nodeId: 'build', gateKind: 'exit' },
    { nodeId: 'review', gateKind: 'approval' },
  ],
}

function fakeProbe(overrides: Partial<ProcessProbe> & { alive?: Record<number, string> } = {}): ProcessProbe {
  const alive = overrides.alive ?? {}
  return {
    pid: overrides.pid ?? 4242,
    hostname: overrides.hostname ?? 'testhost',
    bootId: overrides.bootId === undefined ? 'boot-A' : overrides.bootId,
    startTime: pid => (pid === (overrides.pid ?? 4242) ? '1000' : (alive[pid] ?? null)),
  }
}

async function open(extra: Partial<OpenStoreOptions> = {}): Promise<WorkflowRunStore> {
  return openStore({ dir, workspace: realWorkspace, probe: fakeProbe(), ...extra })
}

async function runStart(store: WorkflowRunStore, runId: string, name = 'wf') {
  return store.startRun({ runId, name, hash: 'a'.repeat(64), source: `name: ${name}\n`, manifest })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'run-store-'))
  workspace = join(root, 'ws')
  await mkdir(workspace)
  const resolved = await workflowStoreDir(join(root, 'dsh-home'), workspace)
  dir = resolved.dir
  realWorkspace = resolved.workspace
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('layout and records', () => {
  it('derives the directory from the dsh home and workspace realpath', async () => {
    const link = join(root, 'ws-link')
    await symlink(workspace, link)
    const viaLink = await workflowStoreDir(join(root, 'dsh-home'), link)
    expect(viaLink.dir).toBe(dir)
    expect(dir).toMatch(/dsh-home\/workflow-runs\/[0-9a-f]{16}$/)
  })

  it('creates a run with a pinned source and v:1 on every record', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await store.recordNode('r1', { nodeId: 'build', nodeKind: 'bash', status: 'running', startedAt: 1 })
    await store.recordNode('r1', { nodeId: 'build', nodeKind: 'bash', status: 'success', exitCode: 0, startedAt: 1, endedAt: 2, durationMs: 1, output: 'ok' })
    await store.recordGate('r1', { nodeId: 'build', gateKind: 'exit', outcome: 'pass' })
    const approval = await store.recordApproval('r1', { nodeId: 'review', message: 'ship it?' })
    await store.decideApproval('r1', approval.approvalId, { state: 'allowed' })
    await store.endRun('r1', { status: 'completed' })

    const lines = (await readFile(join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { kind: string; v: number })
    expect(lines.map(l => l.kind)).toEqual(['run', 'node', 'node', 'gate', 'approval', 'approval', 'end'])
    expect(lines.every(l => l.v === 1)).toBe(true)
    expect(await store.readSource('r1')).toBe('name: wf\n')

    const detail = await store.getRun('r1')
    expect(detail.status).toBe('completed')
    expect(detail.approvals).toHaveLength(1)
    expect(detail.approvals[0]?.state).toBe('allowed')
    expect(detail.end?.report).toEqual([
      { nodeId: 'build', gateKind: 'exit', outcome: 'pass' },
      { nodeId: 'review', gateKind: 'approval', outcome: GATE_NOT_REACHED },
    ])
  })

  it('does not change the pinned source when the live file changes', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await writeFile(join(workspace, 'wf.yaml'), 'changed')
    expect(await store.readSource('r1')).toBe('name: wf\n')
  })

  it('rejects ids that could escape the run directory', async () => {
    const store = await open()
    await expect(runStart(store, '../evil')).rejects.toMatchObject({ code: 'INVALID_ID' })
    await runStart(store, 'r1')
    await expect(
      store.recordNode('r1', { nodeId: '../x', nodeKind: 'bash', status: 'running', startedAt: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ID' })
  })

  it('bounds oversized inputs', async () => {
    const store = await open()
    const header = await store.startRun({ runId: 'r1', name: 'wf', hash: 'a'.repeat(64), source: 's', manifest, inputs: { big: 'x'.repeat(20000) } })
    expect(header.inputs).toMatchObject({ truncated: true })
  })
})

describe('modes', () => {
  it('uses 0700 directories and 0600 files', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await store.recordNode('r1', { nodeId: 'build', nodeKind: 'bash', status: 'success', startedAt: 1, output: 'x'.repeat(LIMITS.spillBytes + 1) })
    const mode = async (p: string) => (await stat(p)).mode & 0o777
    expect(await mode(dir)).toBe(0o700)
    expect(await mode(join(dir, 'r1'))).toBe(0o700)
    expect(await mode(join(dir, 'runs.jsonl'))).toBe(0o600)
    expect(await mode(join(dir, 'index.json'))).toBe(0o600)
    expect(await mode(join(dir, 'writer.lock'))).toBe(0o600)
    expect(await mode(join(dir, 'r1', 'source.yaml'))).toBe(0o600)
    expect(await mode(join(dir, 'r1', 'build.out'))).toBe(0o600)
  })

  it('tightens a loose pre-existing store directory', async () => {
    await mkdir(dir, { recursive: true, mode: 0o755 })
    await open()
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })
})

describe('writer lock', () => {
  it('refuses a second writer with a plain-English WRITER_BUSY naming the holder', async () => {
    const a = await open()
    const b = await open()
    await runStart(a, 'r1', 'deploy')
    const err = await runStart(b, 'r2').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowStoreError)
    expect((err as WorkflowStoreError).code).toBe('WRITER_BUSY')
    expect((err as WorkflowStoreError).holder).toMatchObject({ runId: 'r1', workflowName: 'deploy', pid: 4242 })
    expect((err as Error).message).toContain("workflow 'deploy' (run r1)")
    expect((err as Error).message).toContain('Cancel button')
    await a.endRun('r1', { status: 'completed' })
    await expect(runStart(b, 'r2')).resolves.toBeDefined()
  })

  it('lets exactly one of many parallel writers win and never reads an empty lock as abandoned', async () => {
    const stores = await Promise.all(Array.from({ length: 12 }, () => open()))
    const results = await Promise.allSettled(stores.map((s, i) => runStart(s, `p${i}`)))
    const won = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    for (const l of lost) {
      expect(l.reason).toMatchObject({ code: 'WRITER_BUSY' })
      expect((l.reason as WorkflowStoreError).holder).toBeDefined() // lock content was always complete
    }
  })

  it('treats an empty lock file as busy, never as abandoned', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'writer.lock'), '')
    const store = await open({ probe: fakeProbe() })
    await expect(runStart(store, 'r1')).rejects.toMatchObject({ code: 'WRITER_BUSY' })
    expect(await readFile(join(dir, 'writer.lock'), 'utf8')).toBe('')
  })

  async function plantLock(extra: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(dir, 'writer.lock'),
      JSON.stringify({ v: 1, nonce: 'n', pid: 777, hostname: 'testhost', startTime: '500', bootId: 'boot-A', startedAt: 1, runId: 'old', workflowName: 'old-wf', ...extra }),
    )
  }

  it('takes over a lock whose pid is gone', async () => {
    await mkdir(dir, { recursive: true })
    await plantLock({})
    const store = await open({ probe: fakeProbe() }) // pid 777 not alive
    await expect(runStart(store, 'r1')).resolves.toBeDefined()
  })

  it('takes over when the pid was reused (start time differs)', async () => {
    await mkdir(dir, { recursive: true })
    await plantLock({})
    const store = await open({ probe: fakeProbe({ alive: { 777: '9999' } }) })
    await expect(runStart(store, 'r1')).resolves.toBeDefined()
  })

  it('takes over when the boot id differs', async () => {
    await mkdir(dir, { recursive: true })
    await plantLock({ bootId: 'boot-OLD' })
    const store = await open({ probe: fakeProbe({ alive: { 777: '500' } }) })
    await expect(runStart(store, 'r1')).resolves.toBeDefined()
  })

  it('does not take over a live holder (same pid, start time and boot id)', async () => {
    await mkdir(dir, { recursive: true })
    await plantLock({})
    const store = await open({ probe: fakeProbe({ alive: { 777: '500' } }) })
    await expect(runStart(store, 'r1')).rejects.toMatchObject({ code: 'WRITER_BUSY' })
  })

  it('does not take over a lock from another host', async () => {
    await mkdir(dir, { recursive: true })
    await plantLock({ hostname: 'other-box' })
    const store = await open()
    await expect(runStart(store, 'r1')).rejects.toMatchObject({ code: 'WRITER_BUSY' })
  })

  it('writeFileAtomic with createIfAbsent keeps the existing file', async () => {
    await mkdir(dir, { recursive: true })
    const p = join(dir, 'x')
    expect(await writeFileAtomic(p, 'one', { createIfAbsent: true })).toBe(true)
    expect(await writeFileAtomic(p, 'two', { createIfAbsent: true })).toBe(false)
    expect(await readFile(p, 'utf8')).toBe('one')
    expect((await readdir(dir)).filter(n => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('index', () => {
  it('lists newest first with name filter and cursor', async () => {
    const store = await open()
    for (const [i, name] of ['a', 'b', 'a'].entries()) {
      await runStart(store, `r${i}`, name)
      await store.endRun(`r${i}`, { status: 'completed' })
    }
    const all = await store.listRuns({ limit: 2 })
    expect(all.runs.map(r => r.runId)).toEqual(['r2', 'r1'])
    const next = await store.listRuns({ limit: 2, cursor: all.nextCursor! })
    expect(next.runs.map(r => r.runId)).toEqual(['r0'])
    expect((await store.listRuns({ name: 'a' })).runs.map(r => r.runId)).toEqual(['r2', 'r0'])
  })

  it('rebuilds a corrupt index from the log and persists it', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await store.endRun('r1', { status: 'completed' })
    await writeFile(join(dir, 'index.json'), '{not json')
    const fresh = await open()
    expect((await fresh.listRuns()).runs.map(r => r.runId)).toEqual(['r1'])
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as object
    expect(index).toMatchObject({ v: 1, workspace: realWorkspace })
  })

  it('rebuilds a missing or stale index', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await store.endRun('r1', { status: 'completed' })
    await rm(join(dir, 'index.json'))
    expect((await (await open()).listRuns()).runs).toHaveLength(1)
    await writeFile(join(dir, 'index.json'), JSON.stringify({ v: 1, workspace: realWorkspace, logBytes: 1, runs: [] }))
    expect((await (await open()).listRuns()).runs).toHaveLength(1)
  })

  it('refuses an index from a different workspace', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await store.endRun('r1', { status: 'completed' })
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as object
    await writeFile(join(dir, 'index.json'), JSON.stringify({ ...index, workspace: '/somewhere/else' }))
    await expect(open()).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
  })
})

describe('schema version', () => {
  it('refuses a record with an unknown version', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await store.endRun('r1', { status: 'completed' })
    const log = join(dir, 'runs.jsonl')
    await writeFile(log, `${await readFile(log, 'utf8')}${JSON.stringify({ v: 2, kind: 'run', runId: 'zz' })}\n`)
    await expect(store.getRun('r1')).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
    await expect(open()).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
  })

  it('refuses an index with an unknown version', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.json'), JSON.stringify({ v: 9, workspace: realWorkspace, logBytes: 0, runs: [] }))
    await expect(open()).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
  })

  it('ignores a torn final line and keeps appending parseable records', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await store.endRun('r1', { status: 'completed' })
    const log = join(dir, 'runs.jsonl')
    await writeFile(log, `${await readFile(log, 'utf8')}{"v":1,"kind":"nod`)
    const again = await open()
    expect((await again.getRun('r1')).status).toBe('completed')
    await runStart(again, 'r2')
    expect((await again.getRun('r2')).status).toBe('running')
  })
})

describe('output spill', () => {
  it('keeps small output in the tail, mid output inline, and spills beyond 64 KB', async () => {
    const store = await open()
    await runStart(store, 'r1')
    const mk = (nodeId: string, output: string) =>
      store.recordNode('r1', { nodeId, nodeKind: 'bash', status: 'success', startedAt: 1, output })
    const small = await mk('small', 'hello')
    expect(small).toMatchObject({ outputTail: 'hello', truncated: false })
    expect(small.outputRef).toBeUndefined()
    const mid = await mk('mid', 'm'.repeat(20 * 1024))
    expect(mid.outputTail).toHaveLength(LIMITS.tailBytes)
    expect(mid.output).toHaveLength(20 * 1024)

    const big = 'é'.repeat(50 * 1024) // 100 KB in bytes
    const spilled = await mk('big', big)
    expect(spilled.outputRef).toBe('big.out')
    expect(spilled.output).toBeUndefined()
    expect(spilled.truncated).toBe(false)
    expect((await stat(join(dir, 'r1', 'big.out'))).size).toBe(Buffer.byteLength(big))

    let text = ''
    let offset: number | undefined = 0
    let pages = 0
    while (offset !== undefined) {
      const slice = await store.readOutput('r1', 'big', offset, 30000)
      text += slice.text
      offset = slice.nextOffset
      pages++
    }
    expect(text).toBe(big)
    expect(pages).toBeGreaterThan(1)
    expect((await store.readOutput('r1', 'mid')).text).toHaveLength(20 * 1024)
    expect((await store.readOutput('r1', 'small')).text).toBe('hello')
    await expect(store.readOutput('r1', 'nope')).rejects.toMatchObject({ code: 'OUTPUT_NOT_FOUND' })
  })

  it('caps a single read at the per-call limit', async () => {
    const store = await open()
    await runStart(store, 'r1')
    await store.recordNode('r1', { nodeId: 'big', nodeKind: 'bash', status: 'success', startedAt: 1, output: 'x'.repeat(400 * 1024) })
    const slice = await store.readOutput('r1', 'big', 0, 10_000_000)
    expect(slice.text.length).toBe(LIMITS.readOutputMaxLimit)
    expect(slice.nextOffset).toBe(LIMITS.readOutputMaxLimit)
  })
})

describe('approvals', () => {
  it('uses 128-bit random ids and first answer wins', async () => {
    const store = await open()
    await runStart(store, 'r1')
    const a = await store.recordApproval('r1', { nodeId: 'review', message: 'ok?' })
    const b = await store.recordApproval('r1', { nodeId: 'review', message: 'ok?' })
    expect(a.approvalId).toMatch(/^[0-9a-f]{32}$/)
    expect(a.approvalId).not.toBe(b.approvalId)
    const [first, second] = await Promise.all([
      store.decideApproval('r1', a.approvalId, { state: 'allowed' }),
      store.decideApproval('r1', a.approvalId, { state: 'rejected', reason: 'no' }),
    ])
    expect(first.decided).toBe(true)
    expect(second.decided).toBe(false)
    expect(second.approval.state).toBe('allowed')
    await expect(store.decideApproval('r1', 'f'.repeat(32), { state: 'allowed' })).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' })
  })

  it('cancels pending approvals when the run ends', async () => {
    const store = await open()
    await runStart(store, 'r1')
    const a = await store.recordApproval('r1', { nodeId: 'review', message: 'ok?' })
    await store.endRun('r1', { status: 'cancelled' })
    const detail = await store.getRun('r1')
    expect(detail.approvals[0]?.state).toBe('cancelled')
    const late = await store.acquireWriter().then(() => store.decideApproval('r1', a.approvalId, { state: 'allowed' }))
    expect(late).toMatchObject({ decided: false })
  })
})

describe('sweepInterrupted', () => {
  it('closes a crashed run with not-reached rows and cancels its pending approvals', async () => {
    const crashed = await open({ probe: fakeProbe({ pid: 111 }) })
    await runStart(crashed, 'r1')
    await crashed.recordGate('r1', { nodeId: 'build', gateKind: 'exit', outcome: 'pass' })
    await crashed.recordApproval('r1', { nodeId: 'review', message: 'ok?' })
    // process 111 "dies": its lock file stays behind and nothing alive matches it.

    const fresh = await open({ probe: fakeProbe({ pid: 222 }), sweepOnOpen: false })
    const result = await fresh.sweepInterrupted()
    expect(result.swept).toEqual(['r1'])
    const detail = await fresh.getRun('r1')
    expect(detail.status).toBe('interrupted')
    expect(detail.end?.report).toEqual([
      { nodeId: 'build', gateKind: 'exit', outcome: 'pass' },
      { nodeId: 'review', gateKind: 'approval', outcome: 'not-reached' },
    ])
    expect(detail.end?.error).toContain('may still be running')
    expect(detail.approvals[0]?.state).toBe('cancelled')
    expect((await fresh.listRuns()).runs[0]?.status).toBe('interrupted')
  })

  it('sweeps on open and leaves a live owner alone', async () => {
    const live = await open({ probe: fakeProbe({ pid: 111 }) })
    await runStart(live, 'r1')
    const other = await open({ probe: fakeProbe({ pid: 222, alive: { 111: '1000' } }) })
    expect((await other.getRun('r1')).status).toBe('running')
    const result = await other.sweepInterrupted()
    expect(result).toEqual({ swept: [], skipped: 'writer-busy' })
  })
})

describe('retention', () => {
  it('prunes the oldest finished runs including spill directories', async () => {
    const store = await open({ retention: 5 })
    const keep = 5
    for (let i = 0; i < 8; i++) {
      await runStart(store, `r${i}`)
      await store.recordNode(`r${i}`, { nodeId: 'out', nodeKind: 'bash', status: 'success', startedAt: 1, output: 'x'.repeat(LIMITS.spillBytes + 10) })
      await store.endRun(`r${i}`, { status: 'completed' })
    }
    const ids = (await store.listRuns({ limit: 200 })).runs.map(r => r.runId)
    expect(ids).toHaveLength(keep)
    expect(ids).toEqual(['r7', 'r6', 'r5', 'r4', 'r3'])
    const dirs = (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()
    expect(dirs).toEqual(['r3', 'r4', 'r5', 'r6', 'r7'])
    const log = await readFile(join(dir, 'runs.jsonl'), 'utf8')
    expect(log).not.toContain('"runId":"r0"')
  })

  it('never prunes a run that is still running', async () => {
    const owner = await open({ probe: fakeProbe({ pid: 111 }) })
    await runStart(owner, 'live')
    // Prune from the owner's handle: the running run is skipped even when over the limit.
    const result = await owner.prune({ keep: 0 })
    expect(result.removed).toEqual([])
    expect((await owner.listRuns()).runs.map(r => r.runId)).toEqual(['live'])
  })

  it('refuses to prune from a handle while another live process holds the writer', async () => {
    const owner = await open({ probe: fakeProbe({ pid: 111 }) })
    await runStart(owner, 'live')
    const other = await open({ probe: fakeProbe({ pid: 222, alive: { 111: '1000' } }) })
    expect(await other.prune({ keep: 0 })).toEqual({ removed: [], skipped: 'writer-busy' })
  })

  it('keeps 200 by default and removes older runs with more than 200 present', async () => {
    const store = await open()
    for (let i = 0; i < 203; i++) {
      await runStart(store, `r${i}`)
      await store.endRun(`r${i}`, { status: 'completed' })
    }
    const { runs } = await store.listRuns({ limit: 200 })
    expect(runs).toHaveLength(200)
    expect(runs[0]?.runId).toBe('r202')
    expect(runs[199]?.runId).toBe('r3')
  }, 60_000)
})

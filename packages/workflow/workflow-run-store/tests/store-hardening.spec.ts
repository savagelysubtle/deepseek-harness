import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile, chmod } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProcessProbe,
  LIMITS,
  openStore,
  workflowStoreDir,
  type OpenStoreOptions,
  type ProcessProbe,
  type WorkflowRunStore,
} from '../src/index.ts'

let root: string
let dir: string
let realWorkspace: string
const HASH = 'a'.repeat(64)
const manifest = { gates: [{ nodeId: 'build', gateKind: 'exit' }] }

function fakeProbe(pid = 4242, alive: Record<number, string> = {}, hostname = 'testhost'): ProcessProbe {
  return { pid, hostname, bootId: 'boot-A', startTime: p => (p === pid ? '1000' : (alive[p] ?? null)) }
}

function open(extra: Partial<OpenStoreOptions> = {}): Promise<WorkflowRunStore> {
  return openStore({ dir, workspace: realWorkspace, probe: fakeProbe(), ...extra })
}

function start(store: WorkflowRunStore, runId: string, name = 'wf') {
  return store.startRun({ runId, name, hash: HASH, source: 's', manifest })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'run-store-h-'))
  await mkdir(join(root, 'ws'))
  const r = await workflowStoreDir(join(root, 'home'), join(root, 'ws'))
  dir = r.dir
  realWorkspace = r.workspace
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('one handle, one active run (item 1)', () => {
  it('refuses a second startRun on the same handle and keeps the lock after endRun of the first', async () => {
    const store = await open()
    await start(store, 'r1', 'first')
    const err = await start(store, 'r2').catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'WRITER_BUSY', holder: { runId: 'r1', workflowName: 'first' } })
    await store.endRun('r1', { status: 'completed' })
    await expect(start(store, 'r2')).resolves.toBeDefined()
    await expect(stat(join(dir, 'writer.lock'))).resolves.toBeDefined()
    await store.endRun('r2', { status: 'completed' })
    await expect(stat(join(dir, 'writer.lock'))).rejects.toThrow()
  })
})

describe('append integrity (item 2)', () => {
  it('keeps both records when another writer leaves a torn fragment between appends', async () => {
    const store = await open()
    await start(store, 'r1')
    await store.recordGate('r1', { nodeId: 'build', gateKind: 'exit', outcome: 'pass' })
    const log = join(dir, 'runs.jsonl')
    await writeFile(log, `${await readFile(log, 'utf8')}{"v":1,"kind":"nod`)
    await store.recordGate('r1', { nodeId: 'build', gateKind: 'exit', outcome: 'fail' })
    const detail = await store.getRun('r1')
    expect(detail.gates.map(g => g.outcome)).toEqual(['pass', 'fail'])
    expect(detail.skippedLines).toBe(1)
    expect((await store.listRuns()).skippedLines).toBeGreaterThanOrEqual(0)
  })

  it('truncates a partial write so the next append is intact', async () => {
    const store = await open()
    await start(store, 'r1')
    const probeHandle = await fsp.open(join(root, 'probe'), 'w')
    const proto = Object.getPrototypeOf(probeHandle) as { writeFile: (this: unknown, data: string) => Promise<void> }
    await probeHandle.close()
    const original = proto.writeFile
    const spy = vi.spyOn(proto, 'writeFile').mockImplementationOnce(async function (this: unknown, data: string) {
      await original.call(this, data.slice(0, 12))
      throw new Error('disk full')
    })
    await expect(store.recordGate('r1', { nodeId: 'build', gateKind: 'exit', outcome: 'x' })).rejects.toThrow('disk full')
    expect(spy).toHaveBeenCalled()
    await store.recordGate('r1', { nodeId: 'build', gateKind: 'exit', outcome: 'pass' })
    const detail = await store.getRun('r1')
    expect(detail.gates.map(g => g.outcome)).toEqual(['pass'])
    expect(detail.skippedLines).toBe(0)
  })
})

describe('decideApproval without the lock (item 3)', () => {
  it('answers from the log for an ended run and refuses plainly for another process', async () => {
    const owner = await open()
    await start(owner, 'r1')
    const a = await owner.recordApproval('r1', { nodeId: 'review', message: 'ok?' })
    const reader = await open({ probe: fakeProbe(5000, { 4242: '1000' }), sweepOnOpen: false })
    await expect(reader.decideApproval('r1', a.approvalId, { state: 'allowed' })).rejects.toMatchObject({
      code: 'NOT_WRITER',
      message: expect.stringContaining('owned by another process') as string,
    })
    await expect(reader.decideApproval('r1', 'f'.repeat(32), { state: 'allowed' })).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' })
    await owner.endRun('r1', { status: 'cancelled' })
    const late = await reader.decideApproval('r1', a.approvalId, { state: 'allowed' })
    expect(late.decided).toBe(false)
    expect(late.approval.state).toBe('cancelled')
  })
})

describe('takeover mutex and lease loss (item 4)', () => {
  it('lets exactly one of two takers replace a stale lock', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'writer.lock'),
      JSON.stringify({ v: 1, nonce: 'n', pid: 777, hostname: 'testhost', startTime: '5', bootId: 'boot-A', startedAt: 1 }),
    )
    for (let round = 0; round < 5; round++) {
      await writeFile(
        join(dir, 'writer.lock'),
        JSON.stringify({ v: 1, nonce: 'n', pid: 777, hostname: 'testhost', startTime: '5', bootId: 'boot-A', startedAt: 1 }),
      ).catch(() => undefined)
      const a = await open()
      const b = await open()
      const results = await Promise.allSettled([start(a, `a${round}`), start(b, `b${round}`)])
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(lost?.reason).toMatchObject({ code: 'WRITER_BUSY' })
      const winner = results[0]?.status === 'fulfilled' ? a : b
      await winner.endRun(results[0]?.status === 'fulfilled' ? `a${round}` : `b${round}`, { status: 'completed' })
      await expect(stat(join(dir, 'writer.lock.takeover'))).rejects.toThrow()
    }
  })

  it('takes over a stale takeover mutex whose holder is dead', async () => {
    await mkdir(dir, { recursive: true })
    const dead = JSON.stringify({ v: 1, nonce: 'm', pid: 777, hostname: 'testhost', startTime: '5', bootId: 'boot-A', startedAt: 1 })
    await writeFile(join(dir, 'writer.lock'), dead)
    await writeFile(join(dir, 'writer.lock.takeover'), dead)
    const store = await open()
    await expect(start(store, 'r1')).resolves.toBeDefined()
  })

  it('raises NOT_WRITER when writer.lock is replaced under a live handle', async () => {
    const store = await open()
    await start(store, 'r1')
    await writeFile(
      join(dir, 'writer.lock'),
      JSON.stringify({ v: 1, nonce: 'intruder', pid: 1, hostname: 'testhost', startTime: '1', bootId: 'boot-A', startedAt: 1 }),
    )
    await expect(store.recordGate('r1', { nodeId: 'build', gateKind: 'exit', outcome: 'pass' })).rejects.toMatchObject({
      code: 'NOT_WRITER',
    })
    // item 6: the lease check happens before any spill file is written
    await expect(
      store.recordNode('r1', { nodeId: 'big', nodeKind: 'bash', status: 'success', startedAt: 1, output: 'x'.repeat(LIMITS.spillBytes + 5) }),
    ).rejects.toMatchObject({ code: 'NOT_WRITER' })
    await expect(stat(join(dir, 'r1', 'big.out'))).rejects.toThrow()
  })
})

describe('missing /proc (item 5)', () => {
  it('falls back to kill(pid, 0) when the proc filesystem is absent', async () => {
    const probe = await createProcessProbe({ procRoot: join(root, 'no-proc') })
    expect(probe.startTime(process.pid)).toBe('unknown')
    expect(probe.startTime(4194303)).toBeNull()
  })

  it('treats ENOENT as dead only when /proc/self exists', async () => {
    await mkdir(join(root, 'fakeproc', 'self'), { recursive: true })
    await writeFile(join(root, 'fakeproc', 'self', 'stat'), '1 (x) S')
    const probe = await createProcessProbe({ procRoot: join(root, 'fakeproc') })
    expect(probe.startTime(31337)).toBeNull()
  })

  it('does not steal a live lock when /proc is absent', async () => {
    const probe = await createProcessProbe({ procRoot: join(root, 'no-proc') })
    const holder = await openStore({ dir, workspace: realWorkspace, probe, sweepOnOpen: false })
    await start(holder, 'r1')
    const other = await openStore({ dir, workspace: realWorkspace, probe, sweepOnOpen: false })
    await expect(start(other, 'r2')).rejects.toMatchObject({ code: 'WRITER_BUSY' })
  })
})

describe('foreign host lock (item 7)', () => {
  it('names the lock path and says to delete it if the host is gone', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'writer.lock'),
      JSON.stringify({ v: 1, nonce: 'n', pid: 9, hostname: 'other-box', startTime: '5', bootId: 'x', startedAt: 1 }),
    )
    const store = await open()
    const err = (await start(store, 'r1').catch((e: unknown) => e)) as Error
    expect(err).toMatchObject({ code: 'WRITER_BUSY' })
    expect(err.message).toContain(join(dir, 'writer.lock'))
    expect(err.message).toContain('If that host is gone, delete this file')
    expect(await store.sweepInterrupted()).toMatchObject({ skipped: 'writer-busy' })
    expect(await store.prune()).toMatchObject({ skipped: 'writer-busy' })
  })
})

describe('disk hygiene (item 8)', () => {
  it('reaps stale temp files on prune but keeps fresh ones', async () => {
    const store = await open()
    await start(store, 'r1')
    await store.endRun('r1', { status: 'completed' })
    const stale = join(dir, '.deadbeef.tmp')
    const fresh = join(dir, '.cafe.tmp')
    const inRun = join(dir, 'r1', '.old.tmp')
    for (const p of [stale, fresh, inRun]) await writeFile(p, 'x')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    await utimes(inRun, old, old)
    await store.prune()
    const top = await readdir(dir)
    expect(top).not.toContain('.deadbeef.tmp')
    expect(top).toContain('.cafe.tmp')
    expect(await readdir(join(dir, 'r1'))).not.toContain('.old.tmp')
  })

  it('refuses spills beyond the per-run budget and flags the node', async () => {
    const store = await open({ runSpillBudgetBytes: 150 * 1024 })
    await start(store, 'r1')
    const out = 'y'.repeat(100 * 1024)
    const first = await store.recordNode('r1', { nodeId: 'a', nodeKind: 'bash', status: 'success', startedAt: 1, output: out })
    const second = await store.recordNode('r1', { nodeId: 'b', nodeKind: 'bash', status: 'success', startedAt: 1, output: out })
    expect(first.outputRef).toBe('a.out')
    expect(second.outputRef).toBeUndefined()
    expect(second.truncated).toBe(true)
    expect(second.outputNote).toContain('spill budget')
    await expect(stat(join(dir, 'r1', 'b.out'))).rejects.toThrow()
  })
})

describe('field caps (item 9)', () => {
  it('caps and cleans approval text, refuses oversized or malformed run fields', async () => {
    const store = await open()
    await expect(store.startRun({ runId: 'x', name: 'n'.repeat(129), hash: HASH, source: 's', manifest })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.startRun({ runId: 'x', name: 'n', hash: 'nothex', source: 's', manifest })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.startRun({ runId: 'x', name: 'n', hash: HASH, source: 's', manifest, parentSessionId: 'p'.repeat(129) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.startRun({ runId: 'x', name: 'n', hash: HASH, source: 's', manifest: { blob: 'm'.repeat(LIMITS.manifestBytes) } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(stat(join(dir, 'writer.lock'))).rejects.toThrow() // refused before taking the lock
    await start(store, 'r1')
    const a = await store.recordApproval('r1', { nodeId: 'review', message: `line1\nli\u0007ne2\u001b[31m${'z'.repeat(800)}` })
    expect(a.message.startsWith('line1\nline2[31m')).toBe(true)
    expect(a.message).toHaveLength(LIMITS.approvalMessageChars)
    const d = await store.decideApproval('r1', a.approvalId, { state: 'rejected', reason: `no\nway\u0000${'q'.repeat(900)}` })
    expect(d.approval.reason?.startsWith('noway')).toBe(true)
    expect(d.approval.reason).toHaveLength(LIMITS.approvalReasonChars)
  })
})

describe('index.json edge cases (item 10)', () => {
  async function seeded() {
    const store = await open()
    await start(store, 'r1')
    await store.endRun('r1', { status: 'completed' })
  }
  it.each(['null', '[]', '{}', '{"v":"1"}', '{"v":0}', '"text"'])('rebuilds from %s', async (text) => {
    await seeded()
    await writeFile(join(dir, 'index.json'), text)
    expect((await (await open()).listRuns()).runs.map(r => r.runId)).toEqual(['r1'])
  })
  it('refuses only a numeric version newer than ours', async () => {
    await seeded()
    await writeFile(join(dir, 'index.json'), JSON.stringify({ v: 2, workspace: realWorkspace, logBytes: 0, runs: [] }))
    await expect(open()).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
  })
  it('rebuilds the index after a prune rewrite', async () => {
    const store = await open({ retention: 2 })
    for (let i = 0; i < 4; i++) {
      await start(store, `r${i}`)
      await store.endRun(`r${i}`, { status: 'completed' })
    }
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as { runs: { runId: string }[]; logBytes: number }
    expect(index.runs.map(r => r.runId)).toEqual(['r2', 'r3'])
    expect(index.logBytes).toBe((await stat(join(dir, 'runs.jsonl'))).size)
  })
})

describe('retention (item 11)', () => {
  it('keeps a running run and counts finished runs correctly', async () => {
    const store = await open({ retention: 3 })
    for (let i = 0; i < 5; i++) {
      await start(store, `f${i}`)
      await store.endRun(`f${i}`, { status: 'completed' })
    }
    await start(store, 'live')
    expect((await store.listRuns()).runs.map(r => r.runId)).toEqual(['live', 'f4', 'f3'])
    const result = await store.prune({ keep: 0 })
    expect(result.removed).toEqual(['f3', 'f4'])
    expect((await store.listRuns()).runs.map(r => r.runId)).toEqual(['live'])
    expect(await readdir(dir)).toContain('live')
  })

  it('removes orphan run directories older than a day only', async () => {
    const store = await open()
    await mkdir(join(dir, 'orphan-old'))
    await mkdir(join(dir, 'orphan-new'))
    await mkdir(join(dir, 'not a run id'))
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await utimes(join(dir, 'orphan-old'), old, old)
    await utimes(join(dir, 'not a run id'), old, old)
    await store.prune()
    const names = await readdir(dir)
    expect(names).not.toContain('orphan-old')
    expect(names).toContain('orphan-new')
    expect(names).toContain('not a run id')
  })
})

describe('modes on open (item 12)', () => {
  it('tightens pre-existing files and the workflow-runs parent', async () => {
    const parent = join(root, 'home', 'workflow-runs')
    await mkdir(dir, { recursive: true })
    await chmod(parent, 0o755)
    for (const n of ['runs.jsonl', 'index.json', 'writer.lock']) {
      await writeFile(join(dir, n), n === 'runs.jsonl' ? '' : '{}')
      await chmod(join(dir, n), 0o644)
    }
    await open({ sweepOnOpen: false }).catch(() => undefined)
    expect((await stat(parent)).mode & 0o777).toBe(0o700)
    for (const n of ['runs.jsonl', 'index.json', 'writer.lock']) expect((await stat(join(dir, n))).mode & 0o777).toBe(0o600)
  })
})

describe('node states (item 13)', () => {
  it('folds the latest row per node attempt', async () => {
    const store = await open()
    await start(store, 'r1')
    await store.recordNode('r1', { nodeId: 'a', nodeKind: 'bash', status: 'running', startedAt: 1 })
    await store.recordNode('r1', { nodeId: 'b', nodeKind: 'bash', status: 'running', startedAt: 2 })
    await store.recordNode('r1', { nodeId: 'a', nodeKind: 'bash', status: 'failed', startedAt: 1, endedAt: 3, attempt: 1 })
    await store.recordNode('r1', { nodeId: 'a', nodeKind: 'bash', status: 'running', startedAt: 4, attempt: 2 })
    const { nodeStates } = await store.getRun('r1')
    expect(nodeStates.map(n => [n.nodeId, n.attempt, n.running, n.record.status])).toEqual([
      ['a', 1, false, 'failed'],
      ['b', 1, true, 'running'],
      ['a', 2, true, 'running'],
    ])
  })
})

describe('round 2 nits', () => {
  it('refuses a foreign-host or unparsable takeover mutex with the path-and-remedy message', async () => {
    const stale = JSON.stringify({ v: 1, nonce: 'n', pid: 777, hostname: 'testhost', startTime: '5', bootId: 'boot-A', startedAt: 1 })
    for (const mutex of [
      JSON.stringify({ v: 1, nonce: 'm', pid: 9, hostname: 'other-box', startTime: '5', bootId: 'x', startedAt: 1 }),
      '',
    ]) {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'writer.lock'), stale)
      await writeFile(join(dir, 'writer.lock.takeover'), mutex)
      const store = await open()
      const err = (await start(store, 'r1').catch((e: unknown) => e)) as Error
      expect(err).toMatchObject({ code: 'WRITER_BUSY' })
      expect(err.message).toContain(join(dir, 'writer.lock.takeover'))
      expect(err.message).toContain('delete this file')
    }
  })

  it('refuses to decide an approval on a run that is not this handle\'s active run', async () => {
    const store = await open()
    await start(store, 'r1')
    const a = await store.recordApproval('r1', { nodeId: 'review', message: 'ok?' })
    await store.endRun('r1', { status: 'completed' })
    await store.acquireWriter()
    // a pending record on an ended run is impossible through the API, so forge one in the log
    const log = join(dir, 'runs.jsonl')
    const forged = JSON.stringify({ ...a, approvalId: 'e'.repeat(32), state: 'pending', at: 1 })
    await writeFile(log, `${await readFile(log, 'utf8')}${forged}\n`)
    const res = await store.decideApproval('r1', 'e'.repeat(32), { state: 'allowed' })
    expect(res.decided).toBe(false) // ended run: answered from the log
    await start(store, 'r2')
    const b = await store.recordApproval('r2', { nodeId: 'review', message: 'ok?' })
    const other = await open({ probe: fakeProbe(4242), sweepOnOpen: false })
    await expect(other.decideApproval('r2', b.approvalId, { state: 'allowed' })).rejects.toMatchObject({ code: 'NOT_WRITER' })
  })

  it('refuses free text in node kind, gate kind and outcome', async () => {
    const store = await open()
    await start(store, 'r1')
    await expect(
      store.recordNode('r1', { nodeId: 'a', nodeKind: 'token=sk-secret value', status: 'running', startedAt: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.recordGate('r1', { nodeId: 'a', gateKind: 'exit', outcome: 'failed: password=hunter2' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.recordGate('r1', { nodeId: 'a', gateKind: 'Exit Code', outcome: 'pass' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.endRun('r1', { status: 'failed', report: [{ nodeId: 'a', gateKind: 'exit', outcome: 'a b' }] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })
})

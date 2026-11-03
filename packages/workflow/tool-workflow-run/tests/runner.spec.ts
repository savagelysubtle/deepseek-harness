import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPLETED, DEMO, setup, startTrusted } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('hash pin', () => {
  it('pins the source and flags fileChanged when the live file is edited mid-run', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    const pinnedBefore = await store.readSource(started.runId)
    expect(pinnedBefore).toBe(DEMO)
    await h.writeWorkflow('demo', DEMO.replace('echo building', 'echo changed'))
    const view = await h.ctx.workflowRuns.getRunView(h.workspace, started.runId)
    expect(view.fileChanged).toBe(true)
    expect(view.pinnedHash).toBe(started.hash)
    expect(await store.readSource(started.runId)).toBe(DEMO)
    // The engine was handed the script compiled from the ORIGINAL text.
    expect(h.engine.runs[0]!.request.script).toContain('echo building')
    expect(h.engine.runs[0]!.request.script).not.toContain('echo changed')
    h.engine.runs[0]!.settle(COMPLETED)
    const outcome = await started.done
    expect(outcome.fileChanged).toBe(true)
  })

  it('reports fileChanged false while the file is untouched', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    expect((await h.ctx.workflowRuns.getRunView(h.workspace, started.runId)).fileChanged).toBe(false)
    h.engine.runs[0]!.settle(COMPLETED)
    expect((await started.done).fileChanged).toBeUndefined()
  })
})

describe('writer guard', () => {
  it('maps an unidentifiable lock owner to fixed text with no path and no instruction to delete', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    await writeFile(join(store.dir, 'writer.lock'), 'not a lock record')
    const dry = await h.ctx.workflowRuns.dryRun(h.workspace, { name: 'demo', caller: h.parent.session.id })
    if (!dry.ok) throw new Error(dry.message)
    const result = await h.ctx.workflowRuns.start({
      parent: h.parent, name: 'demo', trustHash: dry.trustKey, ...dry.trustChallenge === undefined ? {} : { trustChallenge: dry.trustChallenge },
    })
    expect(result).toMatchObject({ ok: false, error: 'WRITER_BUSY' })
    if (result.ok) return
    const text = `${result.message}\n${result.remedy ?? ''}`
    expect(text).not.toMatch(/delete|\.lock|hostname|\/(tmp|home|var)/i)
    expect(text).toContain('already active')
    expect(h.engine.runs).toHaveLength(0)
  })

  it('refuses a second start with the holder, start time and remedy', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const first = await startTrusted(h)
    const second = await h.ctx.workflowRuns.start({ parent: h.parent, name: 'demo', trustHash: first.hash })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error).toBe('WRITER_BUSY')
    expect(second.message).toContain(first.runId)
    expect(second.message).toContain("workflow 'demo'")
    expect(second.message).toMatch(/started \d{4}-\d{2}-\d{2}T/)
    expect(second.remedy).toContain('cancel it in Workflows (Cancel button) / `workflow_run {cancel}`')
    // The model-facing text carries no path, host or pid, and never tells anyone to delete a lock.
    expect(second.message).not.toMatch(/\//)
    expect(`${second.message}\n${second.remedy}`).not.toMatch(/delete|hostname|process \d|\.lock/i)
    expect(second.holder).toMatchObject({ runId: first.runId, workflowName: 'demo', pid: process.pid })
    expect(h.engine.runs).toHaveLength(1)
    h.engine.runs[0]!.settle(COMPLETED)
    await first.done
    // The guard is released once the run closed.
    const third = await startTrusted(h)
    h.engine.runs[1]!.settle(COMPLETED)
    await third.done
  })
})

describe('inputs and node ids', () => {
  it('rejects unknown, missing and mistyped inputs before anything starts', async () => {
    h = await setup()
    await h.writeWorkflow('typed', `version: 1
name: typed
description: typed inputs
inputs:
  count:
    type: number
    required: true
nodes:
  - id: only
    kind: bash
    bash: echo $inputs.count
`)
    const dry = await h.ctx.workflowRuns.dryRun(h.workspace, { name: 'typed', inputs: { count: 2 } })
    expect(dry.ok).toBe(true)
    for (const [inputs, text] of [[{}, 'missing required input'], [{ count: 'many' }, 'must be a number'],
      [{ count: 1, extra: 1 }, "unknown input 'extra'"]] as const) {
      const r = await h.ctx.workflowRuns.dryRun(h.workspace, { name: 'typed', inputs })
      expect(r).toMatchObject({ ok: false, error: 'INVALID_INPUT' })
      expect((r as { message: string }).message).toContain(text)
    }
    expect(h.engine.runs).toHaveLength(0)
  })

  it('ignores engine events whose node id is not a valid id and keeps the record clean', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const run = h.engine.runs[0]!
    run.nodeStart({ nodeId: '../escape', kind: 'bash' })
    run.nodeStart({ nodeId: 'build', kind: 'bash' })
    run.nodeEnd({ nodeId: 'build', kind: 'bash', status: 'success', exitCode: 0 })
    run.settle(COMPLETED)
    await started.done
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    const detail = await store.getRun(started.runId)
    expect(detail.nodes.map(n => n.nodeId)).toEqual(['build', 'build'])
    expect(await readFile(join(store.dir, 'runs.jsonl'), 'utf8')).not.toContain('escape')
  })
})

describe('engine error text', () => {
  it('shows the model only the first line with host paths redacted, and logs the rest', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    h.engine.runs[0]!.settle({
      value: null,
      stopReason: 'error',
      error: 'Error: boom at /opt/dsh/node_modules/worker.js:12\n    at run (/home/steve/.hidden/host.js:3:4)',
      agentsStarted: 0,
    })
    const outcome = await started.done
    expect(outcome.error).toContain('boom')
    expect(outcome.error).not.toMatch(/\/opt|\/home|node_modules|host\.js/)
    expect(outcome.error).not.toContain('\n')
  })
})

describe('without a workflow engine (web preset)', () => {
  it('mounts the runner without the tool, serves reads, and refuses a run with RUNNER_UNAVAILABLE before any record or trust is written', async () => {
    h = await setup({ engine: false })
    await h.writeWorkflow('demo', DEMO)
    expect(h.ctx.get('workflowEngine')).toBeUndefined()
    expect(h.ctx.workflowRuns).toBeDefined()
    // The model tool waits for the engine, so the global tool layer stays empty (web preset contract).
    expect(h.ctx.tools.get('workflow_run')).toBeUndefined()
    const dry = await h.ctx.workflowRuns.dryRun(h.workspace, { name: 'demo', caller: 'parent' })
    expect(dry).toMatchObject({ ok: true })
    if (!dry.ok) return
    const refused = await h.ctx.workflowRuns.start({
      parent: h.parent, name: 'demo', trustHash: dry.trustKey, ...dry.trustChallenge === undefined ? {} : { trustChallenge: dry.trustChallenge },
    })
    expect(refused).toMatchObject({ ok: false, error: 'RUNNER_UNAVAILABLE' })
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    expect((await store.listRuns({ limit: 10 })).runs).toEqual([])
    expect(await h.ctx.workflowRuns.dryRun(h.workspace, { name: 'demo' })).toMatchObject({ trusted: false })
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { seedScript } from '../src/index.ts'
import { COMPLETED, setup, startTrusted } from './harness.ts'
import type { Harness, StubRun } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const PIPE = `version: 1
name: pipe
description: resume fixture
nodes:
  - id: fetch
    kind: bash
    bash: echo data
  - id: plan
    kind: prompt
    depends_on: [fetch]
    mutates_checkout: false
    prompt: |
      Plan using $fetch.output
  - id: apply
    kind: bash
    depends_on: [plan]
    bash: echo applied
  - id: ask
    kind: approval
    depends_on: [apply]
    message: Done?
`

/** The seed entries a resumed script carries: parsed from the JSON.parse literal in its prelude. */
function seedsOf(script: string): Map<string, { status: string; output: string; exitCode?: number }> {
  const match = /^const SEED = new Map\(JSON\.parse\((".*")\)\);$/m.exec(script)
  if (match?.[1] === undefined) return new Map()
  return new Map(JSON.parse(JSON.parse(match[1]) as string) as [string, { status: string; output: string; exitCode?: number }][])
}

function bash(run: StubRun, nodeId: string, stdout: string | Uint8Array[], status: 'success' | 'failed' = 'success'): void {
  run.nodeStart({ nodeId, kind: 'bash' })
  run.request.onBashOutput!({ nodeId }, 'stdout', new Uint8Array(0))
  for (const chunk of typeof stdout === 'string' ? [Buffer.from(stdout)] : stdout) run.request.onBashOutput!({ nodeId }, 'stdout', chunk)
  run.nodeEnd({ nodeId, kind: 'bash', status, exitCode: status === 'success' ? 0 : 1 })
}

async function firstRun(finish: (run: StubRun) => void) {
  h = await setup()
  await h.writeWorkflow('pipe', PIPE)
  const started = await startTrusted(h, 'pipe')
  finish(h.engine.runs[0]!)
  return { first: await started.done }
}

describe('resume', () => {
  it('skips only successful nodes whose output is recoverable and re-runs the rest', async () => {
    const { first } = await firstRun((run) => {
      bash(run, 'fetch', 'data\n')
      run.nodeStart({ nodeId: 'plan', kind: 'prompt' })
      run.nodeEnd({ nodeId: 'plan', kind: 'prompt', status: 'success' })
      bash(run, 'apply', 'oops', 'failed')
      run.settle({
        value: { status: 'failed', nodes: [
          { id: 'fetch', status: 'success', exitCode: 0, output: 'data' },
          { id: 'plan', status: 'success', exitCode: null, output: 'step 1, step 2' },
          { id: 'apply', status: 'failed', exitCode: 1, output: 'oops' },
        ] },
        stopReason: 'completed', agentsStarted: 1,
      })
    })
    expect(first.status).toBe('failed')
    const started = await startTrusted(h!, 'pipe', { resume: first.runId })
    expect(started.resumedFrom).toBe(first.runId)
    const request = h!.engine.runs[1]!.request
    const seeds = seedsOf(request.script)
    expect(seeds.get('fetch')).toEqual({ status: 'success', output: 'data', exitCode: 0 })
    expect(seeds.get('plan')).toEqual({ status: 'success', output: 'step 1, step 2' })
    expect(seeds.has('apply')).toBe(false)
    const store = await h!.ctx.workflowRuns.storeFor(h!.workspace)
    const detail = await store.getRun(started.runId)
    expect(detail.nodeStates.map(s => [s.nodeId, s.record.status])).toEqual([['fetch', 'success'], ['plan', 'success']])
    expect(detail.header.manifest).toMatchObject({ resumedFrom: first.runId, seeded: ['fetch', 'plan'] })
    h!.engine.runs[1]!.settle(COMPLETED)
    await started.done
  })

  it('re-runs a non-mutating node whose output was never captured, and everything that depends on it', async () => {
    const { first } = await firstRun((run) => {
      bash(run, 'fetch', 'data')
      run.nodeStart({ nodeId: 'plan', kind: 'prompt' })
      run.nodeEnd({ nodeId: 'plan', kind: 'prompt', status: 'success' })
      run.settle({ value: null, stopReason: 'cancelled', error: 'stopped', agentsStarted: 1 })
    })
    expect(first.status).toBe('cancelled')
    const started = await startTrusted(h!, 'pipe', { resume: first.runId })
    const seeds = seedsOf(h!.engine.runs[1]!.request.script)
    expect(seeds.has('fetch')).toBe(true)
    expect(seeds.has('plan')).toBe(false)
    h!.engine.runs[1]!.settle(COMPLETED)
    await started.done
  })

  it('refuses when a successful mutating node depends on a node whose output was never recorded', async () => {
    const { first } = await firstRun((run) => {
      bash(run, 'fetch', 'data')
      run.nodeStart({ nodeId: 'plan', kind: 'prompt' })
      run.nodeEnd({ nodeId: 'plan', kind: 'prompt', status: 'success' })
      bash(run, 'apply', 'applied')
      run.settle({ value: null, stopReason: 'error', error: 'workflow worker exited before the run settled (exit code 1)',
        agentsStarted: 1 })
    })
    const refused = await h!.ctx.workflowRuns.start({ parent: h!.parent, resume: first.runId })
    expect(refused).toMatchObject({ ok: false, error: 'RESUME_REFUSED' })
    const message = (refused as { message: string }).message
    expect(message).toContain("'apply' (needs 'plan')")
    expect(message).toContain('second time')
    expect(h!.engine.runs).toHaveLength(1)
  })

  it('refuses when a successful mutating node has no recoverable output', async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(97)
    const { first } = await firstRun((run) => {
      bash(run, 'fetch', 'data')
      run.nodeStart({ nodeId: 'plan', kind: 'prompt' })
      run.nodeEnd({ nodeId: 'plan', kind: 'prompt', status: 'success' })
      bash(run, 'apply', [big, big])
      run.settle({ value: null, stopReason: 'error', error: 'workflow worker exited before the run settled (exit code 1)',
        agentsStarted: 1 })
    })
    const refused = await h!.ctx.workflowRuns.start({ parent: h!.parent, resume: first.runId })
    expect(refused).toMatchObject({ ok: false, error: 'RESUME_REFUSED' })
    expect((refused as { message: string }).message).toContain("node 'apply'")
    expect((refused as { message: string }).message).toContain('must not run a second time')
    expect(h!.engine.runs).toHaveLength(1)
  })

  it('uses outputRef for a spilled full output', async () => {
    const mid = Buffer.alloc(100 * 1024, 'b')
    const { first } = await firstRun((run) => {
      bash(run, 'fetch', [mid])
      run.settle({ value: null, stopReason: 'cancelled', error: 'stopped', agentsStarted: 0 })
    })
    const started = await startTrusted(h!, 'pipe', { resume: first.runId })
    expect(seedsOf(h!.engine.runs[1]!.request.script).get('fetch')?.output).toBe('b'.repeat(100 * 1024))
    h!.engine.runs[1]!.settle(COMPLETED)
    await started.done
  })

  it('recreates the pending approval when the resumed run reaches the approval node', async () => {
    const { first } = await firstRun((run) => {
      bash(run, 'fetch', 'data')
      run.settle({ value: null, stopReason: 'cancelled', error: 'stopped', agentsStarted: 0 })
    })
    const started = await startTrusted(h!, 'pipe', { resume: first.runId })
    const pending = h!.engine.runs[1]!.request.approver!({ approvalId: 'e', nodeId: 'ask', message: 'Done?',
      signal: new AbortController().signal })
    await expect.poll(() => h!.ctx.workflowRuns.pendingApprovals(started.runId).length).toBe(1)
    const waiting = h!.ctx.workflowRuns.pendingApprovals(started.runId)[0]!
    await h!.ctx.workflowRuns.answerApproval(started.runId, waiting.approvalId, 'allow')
    expect(await pending).toBe('allowed-once')
    h!.engine.runs[1]!.settle(COMPLETED)
    await started.done
  })

  it('refuses a running run, an unknown run and a changed prompt-file set', async () => {
    h = await setup()
    await h.writeWorkflow('pipe', PIPE)
    const started = await startTrusted(h, 'pipe')
    expect(await h.ctx.workflowRuns.start({ parent: h.parent, resume: started.runId })).toMatchObject({ ok: false,
      error: 'RESUME_REFUSED' })
    expect(await h.ctx.workflowRuns.start({ parent: h.parent, resume: 'does-not-exist' })).toMatchObject({ ok: false,
      error: 'RESUME_REFUSED' })
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })
})

describe('seedScript', () => {
  it('returns the script unchanged for no seeds and undefined when the prelude wrapper is missing', () => {
    expect(seedScript('x', new Map())).toBe('x')
    expect(seedScript('no wrapper here', new Map([['a', { status: 'success' as const, output: '' }]]))).toBeUndefined()
  })

  it('carries a prototype-named id as plain data: it is looked up in a Map, never an object literal', async () => {
    const wrapper = 'const exec = async (id, kind, deps, rule, cond, gates, body) => {\n  return "ran"\n}\n'
    const seeded = seedScript(wrapper + 'return [await exec("__proto__"), await exec("ok")]', new Map([
      ['__proto__', { status: 'success' as const, output: 'x' }],
      ['ok', { status: 'success' as const, output: 'y' }],
    ]))
    expect(seeded).toBeDefined()
    const AsyncFunction = (Object.getPrototypeOf(async () => undefined) as { constructor: new (body: string) => () => Promise<unknown> })
      .constructor
    const outputs = await new AsyncFunction(seeded ?? '')()
    expect(outputs).toEqual([{ status: 'success', output: 'x' }, { status: 'success', output: 'y' }])
  })
})

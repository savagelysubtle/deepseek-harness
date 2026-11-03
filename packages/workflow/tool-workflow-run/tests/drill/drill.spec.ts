import { afterEach, describe, expect, it } from 'vitest'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { createProcessProbe, openStore, workflowStoreDir } from '@deepseek-ai/dsh-workflow-run-store'
import { analyze, sha256Hex } from '@deepseek-ai/dsh-workflow-yaml'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import { bootDrill, EXAMPLES_DIR, gateOf, textOf } from './drill-harness.ts'
import type { Drill } from './drill-harness.ts'

let d: Drill | undefined
afterEach(async () => { await d?.cleanup(); d = undefined })

/** The model script of one full feature-loop pass whose first done_when check fails. */
const FEATURE_LOOP_SCRIPT = [
  textResponse('1. add the parser'),
  textResponse('implemented, run 1'),
  textResponse('fixed the typecheck, run 2'),
  toolCallResponse('review-1', STRUCTURED_OUTPUT_TOOL, { pass: true, reasons: 'ran pnpm run test, exit 0' }),
]

const DONE_WHEN = 'pnpm run typecheck && pnpm run test'

describe('drill: discovery and dry run', () => {
  it('discovers the two shipped examples and plans them without running anything', async () => {
    d = await bootDrill()
    expect(await d.ctx.workflowRuns.listWorkflows(d.workspace)).toEqual(['feature-loop', 'mail-triage'])

    const loop = await d.ctx.workflowRuns.dryRun(d.workspace, { name: 'feature-loop', inputs: { feature: 'a parser' } })
    const mail = await d.ctx.workflowRuns.dryRun(d.workspace, { name: 'mail-triage' })
    if (!loop.ok || !mail.ok) throw new Error('dry run refused')
    expect(loop.graph.nodes).toHaveLength(7)
    expect(mail.graph.nodes).toHaveLength(5)
    expect(loop.manifest.map(g => `${g.nodeId}:${g.gateKind}`)).toEqual([
      'implement:done_when', 'gate-tests:bash', 'review:verifier', 'pass-check:bash', 'approve:approval',
    ])
    expect(mail.manifest.map(g => g.gateKind)).toEqual(['bash', 'done_when', 'approval', 'bash'])
    // Both files are untrusted: the human sees every command verbatim and must confirm.
    expect(loop.trusted).toBe(false)
    expect(loop.confirmText).toContain(DONE_WHEN)
    expect(mail.confirmText).toContain('mail-cli send')

    // Nothing ran: no shell call, no model call, and the store holds no run record.
    expect(d.commands).toEqual([])
    expect(d.adapter.requests).toEqual([])
    expect((await (await d.ctx.workflowRuns.storeFor(d.workspace)).listRuns({ limit: 10 })).runs).toEqual([])
    expect(d.ctx.workflowRuns.activeRuns()).toEqual([])
  })

  it('the model-facing dry run says nothing was started and still spawns nothing', async () => {
    d = await bootDrill()
    const result = await d.execute({ name: 'mail-triage', dryRun: true })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('Nothing was started')
    expect(d.commands).toEqual([])
    expect(d.adapter.requests).toEqual([])
  })

  it('both examples are valid against the schema, with every key explained in a comment', async () => {
    for (const name of ['feature-loop', 'mail-triage']) {
      const text = await readFile(join(EXAMPLES_DIR, `${name}.yaml`), 'utf8')
      const result = analyze(text, { expectedName: name })
      expect(result.diagnostics, name).toEqual([])
      expect(result.ok).toBe(true)
      expect(text).not.toContain('!!js')
      const kinds = new Set(result.doc?.nodes.map(n => n.kind))
      expect(kinds.has('approval')).toBe(true)
      expect(kinds.has('bash')).toBe(true)
      expect(result.doc?.nodes.some(n => n.kind === 'prompt' && n.doneWhen !== undefined)).toBe(true)
      // Every schema key the file uses is named, in backticks, in some comment.
      const comments = text.split('\n').filter(line => line.trim().startsWith('#')).join('\n')
      const keys = new Set([...text.matchAll(/^\s*(?:- )?([a-z_]+):/gm)].map(m => m[1]!))
      for (const key of ['pass', 'reasons', 'urgent', 'properties', 'MAIL_PAGER', 'feature', 'folder']) keys.delete(key)
      for (const key of keys) expect(comments, `${name}: key '${key}' has no comment`).toContain(`\`${key}\``)
    }
  })
})

describe('drill: run with approval', () => {
  it('feature-loop: done_when loops once, the approval is granted, every node ends success with a gate report', async () => {
    d = await bootDrill({
      script: [...FEATURE_LOOP_SCRIPT],
      shell: (spec, count) => {
        // The first done_when check fails with a visible tail; every later command passes.
        if (spec.command === DONE_WHEN && count === 1) return { exitCode: 1, stdoutText: 'TS2322: type error in parser.ts' }
        return {}
      },
    })
    const started = await d.startTrusted('feature-loop', { inputs: { feature: 'a parser' } })
    const approval = await d.nextApproval(started.runId)
    expect(approval).toMatchObject({ nodeId: 'approve', message: 'Review passed. Merge the change?' })
    await d.ctx.workflowRuns.answerApproval(started.runId, approval.approvalId, 'allow')
    const outcome = await started.done

    expect(outcome.status).toBe('completed')
    expect(outcome.nodes.map(n => [n.nodeId, n.status])).toEqual([
      ['plan', 'success'], ['implement', 'success'], ['gate-tests', 'success'], ['review', 'success'],
      ['pass-check', 'success'], ['approve', 'success'], ['stop-on-reject', 'skipped'],
    ])
    expect(outcome.report.map(r => [r.nodeId, r.outcome])).toEqual([
      ['implement', 'fired-pass'], ['gate-tests', 'fired-pass'], ['review', 'fired-pass'], ['pass-check', 'fired-pass'], ['approve', 'fired-pass'],
    ])
    // The failed first check sent the failure tail into the second iteration's prompt.
    expect(d.commands.filter(c => c === DONE_WHEN)).toHaveLength(2)
    const prompts = d.adapter.requests.map(r => JSON.stringify(r.messages))
    expect(prompts.some(p => p.includes('TS2322: type error in parser.ts'))).toBe(true)
    // Node statuses were visible live: running first, then a final state, and an approval card in between.
    const seen = d.events.flatMap(e => e.type === 'run-changed' && e.nodeId === 'implement' ? [e.nodeStatus] : [])
    expect(seen[0]).toBe('running')
    expect(seen.at(-1)).toBe('success')
    expect(d.events.some(e => e.type === 'approval-pending' && e.nodeId === 'approve')).toBe(true)
    expect(d.events.some(e => e.type === 'approval-decided' && e.state === 'allowed')).toBe(true)
  }, 30_000)
})

/** Model script of mail-triage up to the approval: classify returns one urgent message, then one draft. */
const MAIL_SCRIPT = (): ReturnType<typeof textResponse>[] => [
  toolCallResponse('classify-1', STRUCTURED_OUTPUT_TOOL, { urgent: [{ id: 'm1', subject: 'server down' }] }),
  textResponse('drafted a reply to m1'),
]

const mailShell = (spec: { command: string }): { stdoutText: string } | Record<string, never> =>
  spec.command.startsWith('mail-cli list') ? { stdoutText: '[{"id":"m1","subject":"server down"}]' } : {}

describe('drill: reject and not-reached', () => {
  it('a rejected approval fails the run, fires its gate as a block and skips the downstream gate', async () => {
    d = await bootDrill({ script: MAIL_SCRIPT(), shell: mailShell })
    const started = await d.startTrusted('mail-triage')
    const approval = await d.nextApproval(started.runId)
    await d.ctx.workflowRuns.answerApproval(started.runId, approval.approvalId, 'reject', 'not today')
    const outcome = await started.done

    expect(outcome.status).toBe('failed')
    expect(gateOf(outcome, 'fetch')).toBe('fired-pass')
    expect(gateOf(outcome, 'draft')).toBe('fired-pass')
    expect(gateOf(outcome, 'approve-send')).toBe('fired-block')
    // Found while drilling: a dependent of the rejected approval is SKIPPED by its trigger rule (the
    // script evaluates it and records `skipped`); `not-reached` is for nodes the run ended before
    // evaluating (cancel, crash, worker death), which the next two tests prove.
    expect(gateOf(outcome, 'send')).toBe('skipped')
    expect(outcome.reasons['approve-send']).toContain('not today')
    // The send command never ran.
    expect(d.commands.some(c => c.startsWith('mail-cli send'))).toBe(false)
    const store = await d.ctx.workflowRuns.storeFor(d.workspace)
    const detail = await store.getRun(started.runId)
    expect(detail.approvals.at(-1)).toMatchObject({ nodeId: 'approve-send', state: 'rejected' })
    expect(detail.status).toBe('failed')
  }, 30_000)
})

const PIPE = `version: 1
name: pipe
description: bash-only pipeline with an approval in the middle.
nodes:
  - id: fetch
    kind: bash
    bash: echo fetched
    gate: true
  - id: build
    kind: bash
    depends_on: [fetch]
    bash: echo built
    gate: true
  - id: ask
    kind: approval
    depends_on: [build]
    message: Deploy?
  - id: deploy
    kind: bash
    depends_on: [ask]
    bash: echo deployed
    gate: true
`

describe('drill: cancel and resume', () => {
  it('cancelling at the approval leaves the unevaluated gate not-reached, and resume re-runs only what had not finished', async () => {
    d = await bootDrill({ examples: false })
    await d.writeWorkflow('pipe', PIPE)
    const first = await d.startTrusted('pipe')
    await d.nextApproval(first.runId)
    const cancelled = await d.ctx.workflowRuns.cancel(first.runId, 'operator stopped it', { workspace: d.workspace })
    expect(cancelled.found).toBe(true)
    const firstOutcome = await first.done
    expect(firstOutcome.status).toBe('cancelled')
    expect(gateOf(firstOutcome, 'fetch')).toBe('fired-pass')
    expect(gateOf(firstOutcome, 'build')).toBe('fired-pass')
    expect(gateOf(firstOutcome, 'ask')).toBe('not-reached')
    expect(gateOf(firstOutcome, 'deploy')).toBe('not-reached')
    expect(d.commands).toEqual(['echo fetched', 'echo built'])

    // Resume: fetch and build are NOT run again; the approval is asked again; once granted, deploy runs.
    const second = await d.startTrusted('pipe', { resume: first.runId })
    expect(second.resumedFrom).toBe(first.runId)
    const approval = await d.nextApproval(second.runId)
    expect(approval.nodeId).toBe('ask')
    await d.ctx.workflowRuns.answerApproval(second.runId, approval.approvalId, 'allow')
    const secondOutcome = await second.done
    expect(secondOutcome.status).toBe('completed')
    expect(d.commands).toEqual(['echo fetched', 'echo built', 'echo deployed'])
    expect(secondOutcome.resumedFrom).toBe(first.runId)
    expect(secondOutcome.report.map(r => [r.nodeId, r.outcome])).toEqual([
      ['fetch', 'fired-pass'], ['build', 'fired-pass'], ['ask', 'fired-pass'], ['deploy', 'fired-pass'],
    ])
  }, 30_000)

  it('mail-triage resume skips its finished fetch; agent outputs of a cancelled run are re-asked (documented limitation)', async () => {
    d = await bootDrill({ script: [...MAIL_SCRIPT(), ...MAIL_SCRIPT()], shell: mailShell })
    const first = await d.startTrusted('mail-triage')
    await d.nextApproval(first.runId)
    await d.ctx.workflowRuns.cancel(first.runId, 'stop', { workspace: d.workspace })
    expect((await first.done).status).toBe('cancelled')
    const second = await d.startTrusted('mail-triage', { resume: first.runId })
    const approval = await d.nextApproval(second.runId)
    await d.ctx.workflowRuns.answerApproval(second.runId, approval.approvalId, 'allow')
    expect((await second.done).status).toBe('completed')
    expect(d.commands.filter(c => c.startsWith('mail-cli list'))).toHaveLength(1)
    expect(d.commands.filter(c => c.startsWith('mail-cli send'))).toHaveLength(1)
    expect(d.adapter.requests).toHaveLength(4)
  }, 30_000)
})

const STALL = `version: 1
name: stall
description: a child that goes silent.
nodes:
  - id: think
    kind: prompt
    mutates_checkout: false
    idle_timeout_ms: 1000
    retry:
      max_attempts: 2
      delay_ms: 100
    prompt: Think, then answer.
`

const NEVER_DONE = `version: 1
name: never-done
description: a child that claims done while the check keeps failing.
nodes:
  - id: work
    kind: prompt
    prompt: Make the checks pass.
    done_when: ./check.sh
    max_iterations: 2
`

describe('drill: stall and done_when', () => {
  it('a silent child is stopped inside the idle window, retried once, and the node then fails', async () => {
    d = await bootDrill({ examples: false, script: ['hang', 'hang'] })
    await d.writeWorkflow('stall', STALL)
    const started = await d.startTrusted('stall')
    const outcome = await started.done
    expect(outcome.status).toBe('failed')
    expect(outcome.nodes.find(n => n.nodeId === 'think')?.status).toBe('failed')
    // One retry: exactly two child attempts, each stopped as stalled. The proof is the reason, not wall time.
    expect(d.adapter.requests).toHaveLength(2)
    const store = await d.ctx.workflowRuns.storeFor(d.workspace)
    const detail = await store.getRun(started.runId)
    const thinkStates = detail.nodeStates.filter(s => s.nodeId === 'think')
    const think = thinkStates.at(-1)
    expect(think?.record.status).toBe('failed')
    // The earlier attempt is closed, never left "running".
    expect(thinkStates.map(s => [s.attempt, s.running])).toEqual([[1, false], [2, false]])
    // The watchdog's own reason survives: coded, naming the idle window and the retry count, with the real attempt count.
    expect(think?.attempt).toBe(2)
    expect(think?.record.error).toContain('NODE_STALLED')
    expect(think?.record.error).toContain('1000 ms')
    expect(think?.record.error).toContain('1 retry')
    expect(think?.record.error).not.toContain('did not complete')
    expect(outcome.nodes.find(n => n.nodeId === 'think')).toMatchObject({ attempts: 2, failureCode: 'NODE_STALLED' })
    expect(outcome.reasons.think).toContain("raise idleTimeoutMs for this node or check the agent's output")
    const nodeEnd = d.parent.session.events.find(e => e.type === 'tool-workflow/node-end' && (e.data as { nodeId?: string }).nodeId === 'think')
    expect(nodeEnd?.data).toMatchObject({ attempts: 2, failure: { code: 'NODE_STALLED' } })
    const types = d.parent.session.events.map(e => e.type)
    expect(types.filter(t => t === 'tool-workflow/agent-start')).toHaveLength(2)
    const ends = d.parent.session.events.filter(e => e.type === 'tool-workflow/agent-end').map(e => (e.data as { outcome?: string }).outcome)
    expect(ends).toEqual(['failed', 'failed'])
  }, 30_000)

  it('done_when exit 1 loops up to the cap, then the node fails with the check output as evidence', async () => {
    d = await bootDrill({
      examples: false,
      script: [textResponse('I think I am done'), textResponse('now I am really done')],
      shell: () => ({ exitCode: 1, stdoutText: 'check.sh: 3 tests failed' }),
    })
    await d.writeWorkflow('never-done', NEVER_DONE)
    const started = await d.startTrusted('never-done')
    const outcome = await started.done
    expect(outcome.status).toBe('failed')
    expect(d.adapter.requests).toHaveLength(2)
    expect(d.commands).toEqual(['./check.sh', './check.sh'])
    // The second iteration's prompt carried the first failure's output.
    expect(JSON.stringify(d.adapter.requests[1]?.messages)).toContain('check.sh: 3 tests failed')
    const store = await d.ctx.workflowRuns.storeFor(d.workspace)
    const detail = await store.getRun(started.runId)
    const work = detail.nodeStates.find(s => s.nodeId === 'work')
    expect(work?.record.status).toBe('failed')
    expect(JSON.stringify(work?.record)).toContain('check.sh: 3 tests failed')
    expect(gateOf(outcome, 'work')).toBe('fired-block')
  }, 30_000)
})

describe('drill: hash pin and writer guard', () => {
  it('a second run is refused with the holder and the remedy; editing the file mid-run changes nothing about the run', async () => {
    d = await bootDrill({ examples: false })
    await d.writeWorkflow('pipe', PIPE)
    const started = await d.startTrusted('pipe')
    const approval = await d.nextApproval(started.runId)

    const second = await d.ctx.workflowRuns.start({ parent: d.parent, name: 'pipe' })
    expect(second).toMatchObject({ ok: false, error: 'WRITER_BUSY', holder: { runId: started.runId, workflowName: 'pipe' } })
    expect((second as { remedy?: string }).remedy).toContain('cancel')
    expect((second as { message: string }).message).toContain('pipe')
    const viaTool = await d.execute({ name: 'pipe' })
    expect(viaTool.isError).toBe(true)
    expect(textOf(viaTool)).toContain(started.runId)

    // Edit the file while the run waits: the run stays pinned to the original bytes.
    const before = await d.ctx.workflowRuns.getRunView(d.workspace, started.runId)
    expect(before.fileChanged).toBe(false)
    const original = await readFile(join(d.workspace, '.workflows', 'pipe.yaml'), 'utf8')
    await d.writeWorkflow('pipe', `${original}# edited while the run was waiting\n`)
    const after = await d.ctx.workflowRuns.getRunView(d.workspace, started.runId)
    expect(after.fileChanged).toBe(true)
    expect(after.pinnedHash).toBe(started.hash)
    expect(after.pinnedHash).toBe(sha256Hex(original))
    const store = await d.ctx.workflowRuns.storeFor(d.workspace)
    expect(await store.readSource(started.runId)).toBe(original)

    await d.ctx.workflowRuns.answerApproval(started.runId, approval.approvalId, 'allow')
    const outcome = await started.done
    expect(outcome.status).toBe('completed')
    expect(outcome.hash).toBe(started.hash)
    expect(outcome.fileChanged).toBe(true)
  }, 30_000)
})

describe('drill: interrupted run', () => {
  it('a run whose host died is closed as interrupted with not-reached rows, and resume re-runs only the unfinished nodes', async () => {
    d = await bootDrill({ examples: false })
    await d.writeWorkflow('pipe', PIPE)
    const source = await readFile(join(d.workspace, '.workflows', 'pipe.yaml'), 'utf8')
    // Trust the file the way a human would, by running it once with the approval rejected.
    const trial = await d.startTrusted('pipe')
    await d.ctx.workflowRuns.answerApproval(trial.runId, (await d.nextApproval(trial.runId)).approvalId, 'reject')
    expect((await trial.done).status).toBe('failed')
    d.commands.length = 0

    // A second host process (a real child that is then killed) owned a run that never finished.
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const exited = new Promise<void>(resolve => owner.once('exit', () => { resolve() }))
    const real = await createProcessProbe()
    const deadPid = owner.pid!
    expect(real.startTime(deadPid)).not.toBeNull()
    const { dir, workspace } = await workflowStoreDir(d.home, d.workspace)
    const crashed = await openStore({
      dir, workspace, sweepOnOpen: false,
      probe: { ...real, pid: deadPid, hostname: hostname() },
    })
    // The crashed store holds the writer lock of the soon-dead process; the live runner has released its own.
    await d.ctx.workflowRuns.storeFor(d.workspace)
    await crashed.startRun({
      runId: 'crashed-run', name: 'pipe', hash: sha256Hex(source), source,
      manifest: { gates: [{ nodeId: 'fetch', gateKind: 'bash' }, { nodeId: 'build', gateKind: 'bash' }, { nodeId: 'ask', gateKind: 'approval' }, { nodeId: 'deploy', gateKind: 'bash' }] },
    })
    await crashed.recordNode('crashed-run', { nodeId: 'fetch', nodeKind: 'bash', status: 'success', exitCode: 0, startedAt: 1, endedAt: 2, durationMs: 1, output: 'fetched\n' })
    await crashed.recordGate('crashed-run', { nodeId: 'fetch', gateKind: 'bash', outcome: 'fired-pass' })
    await crashed.recordNode('crashed-run', { nodeId: 'build', nodeKind: 'bash', status: 'running', startedAt: 3 })
    owner.kill('SIGKILL')
    await exited

    // A restarted host opens the same store: the sweep closes the run.
    const restarted = await bootDrill({ examples: false, home: d.home })
    try {
      const store = await restarted.ctx.workflowRuns.storeFor(d.workspace)
      const detail = await store.getRun('crashed-run')
      expect(detail.status).toBe('interrupted')
      expect(detail.end?.report).toEqual([
        { nodeId: 'fetch', gateKind: 'bash', outcome: 'fired-pass' },
        { nodeId: 'build', gateKind: 'bash', outcome: 'not-reached' },
        { nodeId: 'ask', gateKind: 'approval', outcome: 'not-reached' },
        { nodeId: 'deploy', gateKind: 'bash', outcome: 'not-reached' },
      ])
      const resumed = await d.ctx.workflowRuns.start({ parent: d.parent, resume: 'crashed-run' })
      if (!resumed.ok) throw new Error(`${resumed.error}: ${resumed.message}`)
      const approval = await d.nextApproval(resumed.runId)
      expect(approval.nodeId).toBe('ask')
      await d.ctx.workflowRuns.answerApproval(resumed.runId, approval.approvalId, 'allow')
      expect((await resumed.done).status).toBe('completed')
      // fetch was seeded from the store; only the unfinished nodes ran.
      expect(d.commands).toEqual(['echo built', 'echo deployed'])
    } finally {
      await restarted.cleanup()
    }
  }, 30_000)
})

describe('drill: headless', () => {
  it('rejects the approval at once, with the reason and remedy in the tool result, the store and the gate report', async () => {
    d = await bootDrill({ examples: false, config: { headless: true }, ui: false })
    await d.writeWorkflow('pipe', PIPE)
    // A human confirms the commands once (the trust fact is stored); after that the model tool can run it.
    const confirmed = await d.startTrusted('pipe')
    expect((await confirmed.done).status).toBe('failed')

    const t0 = Date.now()
    const result = await d.execute({ name: 'pipe' })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(result.isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain("Approval node 'ask' rejected: this session is headless")
    expect(text).toContain('Remedy: run with an approval answerer (Workflows UI) or change policy to ask.')
    expect(text).toMatch(/ask \[approval\]: fired-block — .*headless/)
    expect(text).toMatch(/deploy \[bash\]: (skipped|not-reached)/)
    expect(d.commands).not.toContain('echo deployed')

    const store = await d.ctx.workflowRuns.storeFor(d.workspace)
    const runs = (await store.listRuns({ limit: 10 })).runs
    const detail = await store.getRun(runs[0]!.runId)
    expect(detail.approvals.at(-1)).toMatchObject({ nodeId: 'ask', state: 'rejected' })
    expect(detail.approvals.at(-1)?.reason).toContain('headless')
    // Nobody was ever shown a pending approval.
    expect(d.events.some(e => e.type === 'approval-pending')).toBe(false)
  }, 30_000)
})

describe('drill: headless bundle', () => {
  it('the headless bundle sets headless on workflow_run and the base bundle does not', async () => {
    const root = new URL('../../../../bundle/', import.meta.url)
    const headless = await readFile(new URL('headless/cordis.patch.yml', root), 'utf8')
    const base = await readFile(new URL('base/cordis.patch.yml', root), 'utf8')
    expect(headless).toMatch(/- id: tool-workflow-run\n {2}config:\n {4}headless: true\n/)
    expect(base).not.toMatch(/headless: true/)
  })
})

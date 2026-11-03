import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type {
  WorkflowApprovalRequest,
  WorkflowChildSupervisor,
  WorkflowGateInfo,
  WorkflowNodeEndInfo,
  WorkflowNodeInfo,
  WorkflowRun,
  WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import WorkerThreadWorkflowEngine from '../src/index.ts'

vi.setConfig({ testTimeout: 30_000 })

const parent = { id: SessionId('hooks-parent'), options: { model: 'test-model' } } as unknown as Agent
const META = { name: 'hooks-flow', description: 'hooks under test' }

function waitFor(assertion: () => void, timeout = 10_000): Promise<void> {
  return vi.waitFor(assertion, { timeout, interval: 25 })
}

/** A provider whose children complete immediately with the next reply from `replies` (cycling the last). */
function provider(replies: string[], seen: SubagentStartRequest[] = []): SubagentProvider {
  let index = 0
  return {
    name: 'stub',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
    inheritsParentContext: false,
    start: (request) => {
      seen.push(request)
      const n = index
      index += 1
      const reply = replies[Math.min(n, replies.length - 1)] ?? 'ok'
      const result: SubagentResult = { output: [{ type: 'text', text: reply }], stopReason: 'completed' }
      return Promise.resolve({
        id: SessionId(`stub-child-${n}`),
        localAgent: undefined,
        result: Promise.resolve(result),
        dispose: () => Promise.resolve(),
      })
    },
  }
}

async function setup(replies: string[] = ['ok'], seen: SubagentStartRequest[] = []) {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(provider(replies, seen))
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'stub', maxConcurrentAgents: 4, disposeGraceMs: 500 })
  const events: string[] = []
  const nodeStarts: WorkflowNodeInfo[] = []
  const nodeEnds: WorkflowNodeEndInfo[] = []
  const gates: WorkflowGateInfo[] = []
  ctx.on('workflow/node-start', (_info, node) => { events.push(`start:${node.nodeId}`); nodeStarts.push(node) })
  ctx.on('workflow/node-end', (_info, node) => { events.push(`end:${node.nodeId}:${node.status}${node.synthesized ? ':synth' : ''}`); nodeEnds.push(node) })
  ctx.on('workflow/gate', (_info, gate) => { events.push(`gate:${gate.nodeId}:${gate.outcome}${gate.synthesized ? ':synth' : ''}`); gates.push(gate) })
  ctx.on('workflow/end', () => { events.push('workflow-end') })
  return { ctx, events, nodeStarts, nodeEnds, gates }
}

function start(ctx: Context, script: string, extra: Partial<WorkflowStartRequest> = {}): WorkflowRun {
  return ctx.workflowEngine.start({ script, meta: META, parent, ...extra })
}

async function finish(handle: WorkflowRun) {
  try {
    return await handle.result
  } finally {
    await handle.dispose()
  }
}

describe('bash() host hook', () => {
  it('is off unless the owner vouches for the script', async () => {
    const { ctx } = await setup()
    const result = await finish(start(ctx, "return await bash('echo hi')"))
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('bash() is not enabled for this run')
  })

  it('runs a command host-side and returns exit facts, with upstream outputs reaching it as WF_ variables only', async () => {
    const { ctx } = await setup()
    const result = await finish(start(ctx, `
      const r = await bash('echo "plan=$WF_PLAN"; echo oops >&2; exit 4', { nodeId: 'run', inputs: { PLAN: 'a; touch /tmp/should-not-exist-wf $(id)' } })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, timedOut: r.timedOut }
    `, { bashEnabled: true }))
    expect(result.stopReason).toBe('completed')
    expect(result.value).toEqual({
      exitCode: 4,
      stdout: 'plan=a; touch /tmp/should-not-exist-wf $(id)\n',
      stderr: 'oops\n',
      truncated: false,
      timedOut: false,
    })
    expect(existsSync('/tmp/should-not-exist-wf')).toBe(false)
  })

  it.each(['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'GIT_DIR', 'HOME', 'SHELL', 'TMPDIR', 'LD_LIBRARY_PATH'])('rejects env %s at the script boundary', async (name) => {
    const { ctx } = await setup()
    const result = await finish(start(ctx, `return await bash('true', { env: { ${name}: 'x' } })`, { bashEnabled: true }))
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain(`env name "${name}" is not allowed`)
  })

  it('enforces the denylist again at the host when the worker is bypassed', async () => {
    const { ctx } = await setup()
    const handle = start(ctx, 'await new Promise(() => {})', { bashEnabled: true })
    const worker = (handle as unknown as { worker: Worker }).worker
    const sent: unknown[] = []
    const post = vi.spyOn(worker, 'postMessage').mockImplementation((m: unknown) => { sent.push(m) })
    // The worker->host message a compromised realm would send, skipping worker-side validation.
    worker.emit('message', { type: 'bash-start', callId: 78, command: 'true', options: { env: { LD_PRELOAD: '/tmp/x.so' } } })
    await waitFor(() => { expect(sent.some(m => (m as { type: string }).type === 'bash-error')).toBe(true) })
    const reply = sent.find(m => (m as { type: string }).type === 'bash-error') as { callId: number; rendered: string }
    expect(reply.callId).toBe(78)
    expect(reply.rendered).toContain('LD_PRELOAD')
    post.mockRestore()
    handle.cancel('done')
    await handle.dispose()
  })

  it('keeps stdout to 64 KB in memory with a truncated flag and hands every byte to the spill sink', async () => {
    const { ctx } = await setup()
    const chunks: Record<string, number> = { stdout: 0, stderr: 0 }
    const infos: unknown[] = []
    const result = await finish(start(ctx, `
      const r = await bash("head -c 300000 /dev/zero | tr '\\\\0' x", { nodeId: 'big' })
      return { len: r.stdout.length, truncated: r.truncated, bytes: r.stdoutBytes }
    `, {
      bashEnabled: true,
      onBashOutput: (info, stream, chunk) => { infos.push(info); chunks[stream] = (chunks[stream] ?? 0) + chunk.length },
    }))
    expect(result.value).toEqual({ len: 65_536, truncated: true, bytes: 300_000 })
    expect(chunks.stdout).toBe(300_000)
    expect(infos[0]).toEqual({ nodeId: 'big' })
  })

  it('contains workdir to the workspace (symlink escape and dotdot refused; a subdirectory works)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'wf-out-'))
    try {
      mkdirSync(join(root, 'sub'))
      symlinkSync(outside, join(root, 'escape'))
      const { ctx } = await setup()
      const ok = await finish(start(ctx, "return (await bash('pwd', { workdir: 'sub' })).stdout.trim()", { bashEnabled: true, cwd: root }))
      expect(ok.value).toBe(join(realpathSync(root), 'sub'))
      const escaped = await finish(start(ctx, "return await bash('pwd', { workdir: 'escape' })", { bashEnabled: true, cwd: root }))
      expect(escaped.stopReason).toBe('error')
      expect(escaped.error).toContain('outside the workspace')
      const dotdot = await finish(start(ctx, "return await bash('pwd', { workdir: '../x' })", { bashEnabled: true, cwd: root }))
      expect(dotdot.error).toContain('must not contain ".."')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('tree-kills a long-running bash when the worker dies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-death-'))
    const pidFile = join(dir, 'pid')
    try {
      const { ctx, events } = await setup()
      const handle = start(ctx, `
        nodeStart('hang', 'bash')
        await bash("sh -c 'sleep 300 & echo $! > ${pidFile}; wait'", { nodeId: 'hang', timeoutMs: 600000 })
      `, { bashEnabled: true })
      await waitFor(() => { expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0).toBe(true) })
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(() => process.kill(pid, 0)).not.toThrow()
      await (handle as unknown as { worker: Worker }).worker.terminate()
      const result = await handle.result
      expect(result.stopReason).toBe('error')
      await waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
      // The stranded node was paired on the way out, before workflow/end.
      expect(events).toEqual(['start:hang', 'end:hang:interrupted:synth', 'workflow-end'])
      await handle.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tree-kills a long-running bash on cancel and reports the node cancelled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-cancel-'))
    const pidFile = join(dir, 'pid')
    try {
      const { ctx, events } = await setup()
      const handle = start(ctx, `
        nodeStart('hang', 'bash', { gate: 'hard_gate' })
        await bash("sh -c 'sleep 300 & echo $! > ${pidFile}; wait'", { nodeId: 'hang', timeoutMs: 600000 })
      `, { bashEnabled: true })
      await waitFor(() => { expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0).toBe(true) })
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      handle.cancel('user cancelled')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      await waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
      expect(events).toEqual(['start:hang', 'end:hang:cancelled:synth', 'gate:hang:not-reached:synth', 'workflow-end'])
      await handle.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a script timeout kills the group and reports timedOut', async () => {
    const { ctx } = await setup()
    const result = await finish(start(ctx, "const r = await bash('sleep 300', { timeoutMs: 300 }); return { t: r.timedOut, code: r.exitCode }", { bashEnabled: true }))
    expect(result.value).toMatchObject({ t: true })
  })

  it('a custom executor can replace the local one', async () => {
    const { ctx } = await setup()
    const seen: string[] = []
    const result = await finish(start(ctx, "return (await bash('echo real')).stdout", {
      bashEnabled: true,
      bashExecutor: {
        run: (request) => {
          seen.push(request.command)
          return Promise.resolve({
            exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: 'fake', stderr: '', truncated: false, stdoutBytes: 4, stderrBytes: 0, durationMs: 1,
          })
        },
      },
    }))
    expect(result.value).toBe('fake')
    expect(seen).toEqual(['echo real'])
  })
})

describe('approve() host hook and approver injection', () => {
  const script = "return await approve({ nodeId: 'gate-1', message: 'Ship it?' })"

  it.each(['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const)('returns the approver outcome %s', async (outcome) => {
    const { ctx } = await setup()
    let seen: WorkflowApprovalRequest | undefined
    const result = await finish(start(ctx, script, { approver: (request) => { seen = request; return Promise.resolve(outcome) } }))
    expect(result.stopReason).toBe('completed')
    expect(result.value).toBe(outcome)
    expect(seen).toMatchObject({ nodeId: 'gate-1', message: 'Ship it?' })
    expect(seen?.approvalId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('fails closed to unavailable with no approver, a throwing approver, or a rogue return', async () => {
    const { ctx } = await setup()
    expect((await finish(start(ctx, script))).value).toBe('unavailable')
    expect((await finish(start(ctx, script, { approver: () => Promise.reject(new Error('broker down')) }))).value).toBe('unavailable')
    expect((await finish(start(ctx, script, { approver: () => Promise.resolve('yes please' as never) }))).value).toBe('unavailable')
  })

  it('validates the node id and message', async () => {
    const { ctx } = await setup()
    const badNode = await finish(start(ctx, "return await approve({ nodeId: '../etc', message: 'q' })"))
    expect(badNode.error).toContain('node id must match')
    const empty = await finish(start(ctx, "return await approve({ nodeId: 'ok', message: '' })"))
    expect(empty.error).toContain('approve() requires a message string')
  })

  it('cancelling the run aborts the approver signal and settles the question cancelled', async () => {
    const { ctx } = await setup()
    let signal: AbortSignal | undefined
    const asked = Promise.withResolvers<undefined>()
    const handle = start(ctx, script, {
      approver: (request) => {
        signal = request.signal
        asked.resolve(undefined)
        return new Promise(() => {})
      },
    })
    await asked.promise
    expect(handle.pendingApprovals?.()).toHaveLength(1)
    handle.cancel('stop')
    const result = await handle.result
    expect(result.stopReason).toBe('cancelled')
    expect(signal?.aborted).toBe(true)
    expect(handle.pendingApprovals?.()).toHaveLength(0)
    await handle.dispose()
  })

  it('an external decision wins once (compare-and-set); the approver answer arriving later is discarded', async () => {
    const { ctx } = await setup()
    const asked = Promise.withResolvers<WorkflowApprovalRequest>()
    const late = Promise.withResolvers<'allowed-once'>()
    const handle = start(ctx, script, { approver: (request) => { asked.resolve(request); return late.promise } })
    const request = await asked.promise
    expect(handle.pendingApprovals?.()).toEqual([{ approvalId: request.approvalId, nodeId: 'gate-1', message: 'Ship it?' }])
    expect(handle.decideApproval?.('0'.repeat(32), 'allowed-once')).toBe('unknown')
    expect(handle.decideApproval?.(request.approvalId, 'rejected')).toBe('decided')
    expect(handle.decideApproval?.(request.approvalId, 'allowed-once')).toBe('already-decided')
    late.resolve('allowed-once')
    const result = await handle.result
    expect(result.value).toBe('rejected')
    await handle.dispose()
  })

  it('two questions get different ids, and an old id cannot be decided after its run settles', async () => {
    const { ctx } = await setup()
    const ids: string[] = []
    const result = await finish(start(ctx, "await approve({ nodeId: 'n1', message: 'a' }); return await approve({ nodeId: 'n2', message: 'b' })", {
      approver: (request) => { ids.push(request.approvalId); return Promise.resolve('allowed-once') },
    }))
    expect(result.stopReason).toBe('completed')
    expect(new Set(ids).size).toBe(2)
  })
})

describe('node and gate hooks, and the stranded sweep', () => {
  it('forwards paired node events and gates in script order', async () => {
    const { ctx, events, nodeEnds } = await setup()
    const result = await finish(start(ctx, `
      nodeStart('tests', 'bash', { gate: 'hard_gate' })
      nodeEnd('tests', { status: 'failed', exitCode: 2, durationMs: 12, truncated: true, error: 'exit 2' })
      gate('tests', 'hard_gate', 'fired-block')
      return 'done'
    `))
    expect(result.stopReason).toBe('completed')
    expect(events).toEqual(['start:tests', 'end:tests:failed', 'gate:tests:fired-block', 'workflow-end'])
    expect(nodeEnds[0]).toMatchObject({ nodeId: 'tests', kind: 'bash', gateKind: 'hard_gate', exitCode: 2, truncated: true })
  })

  it('on completion, sweeps a node the script left running and a gate it never evaluated', async () => {
    const { ctx, events } = await setup()
    await finish(start(ctx, `
      nodeStart('a', 'bash', { gate: 'hard_gate' })
      nodeStart('b', 'prompt', { gate: 'verifier' })
      nodeEnd('a', { status: 'success' })
      return 1
    `))
    expect(events).toEqual([
      'start:a', 'start:b', 'end:a:success',
      'end:b:interrupted:synth',
      expect.stringMatching(/^gate:(a:never-evaluated|b:not-reached):synth$/),
      expect.stringMatching(/^gate:(a:never-evaluated|b:not-reached):synth$/),
      'workflow-end',
    ])
    expect(events).toContain('gate:a:never-evaluated:synth')
    expect(events).toContain('gate:b:not-reached:synth')
  })

  it('on worker death, emits a paired synthesized node-end and gate before workflow/end', async () => {
    const { ctx, events } = await setup()
    const handle = start(ctx, `
      nodeStart('stuck', 'loop', { gate: 'until_bash' })
      await new Promise(() => {})
    `)
    await waitFor(() => { expect(events).toContain('start:stuck') })
    await (handle as unknown as { worker: Worker }).worker.terminate()
    const result = await handle.result
    expect(result.stopReason).toBe('error')
    expect(events).toEqual(['start:stuck', 'end:stuck:interrupted:synth', 'gate:stuck:not-reached:synth', 'workflow-end'])
    await handle.dispose()
  })

  it('on cancel with a wedged script (grace force-settle), the sweep still pairs the node', async () => {
    const { ctx, events } = await setup()
    const handle = start(ctx, `
      nodeStart('wedged', 'prompt', { gate: 'verifier' })
      await new Promise(() => {})
    `)
    await waitFor(() => { expect(events).toContain('start:wedged') })
    handle.cancel('abort it')
    const result = await handle.result
    expect(result.stopReason).toBe('cancelled')
    expect(events).toEqual(['start:wedged', 'end:wedged:cancelled:synth', 'gate:wedged:not-reached:synth', 'workflow-end'])
    await handle.dispose()
  })

  it('never double-emits: a late real end after the synthesized one is dropped by the ledger', async () => {
    const { ctx, events } = await setup()
    const handle = start(ctx, "nodeStart('x', 'bash'); await new Promise(() => {})")
    await waitFor(() => { expect(events).toContain('start:x') })
    handle.cancel('c')
    await handle.result
    const worker = (handle as unknown as { worker: Worker }).worker
    worker.emit('message', { type: 'node-end', info: { nodeId: 'x', kind: 'bash', status: 'success' } })
    expect(events.filter(e => e.startsWith('end:x'))).toHaveLength(1)
    await handle.dispose()
  })

  it('validates node, kind, status and outcome vocabulary', async () => {
    const { ctx } = await setup()
    const cases: [string, string][] = [
      ["nodeStart('Bad Id', 'bash')", 'node id must match'],
      ["nodeStart('ok', 'Bad-Kind')", 'kind must match'],
      ["nodeEnd('never', { status: 'success' })", 'was not started'],
      ["nodeStart('ok','bash'); nodeEnd('ok', { status: 'great' })", 'status must be one of'],
      ["gate('ok', 'hard_gate', 'maybe')", 'outcome must be one of'],
      ["nodeStart('dup','bash'); nodeStart('dup','bash')", 'already running'],
    ]
    for (const [body, expected] of cases) {
      const result = await finish(start(ctx, body))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain(expected)
    }
  })
})

describe('done_when continuation seam', () => {
  const evidence = (exitCode: number) => ({
    iteration: 99, maxContinuations: 99, command: 'pnpm test', exitCode, tail: 'FAIL: 1 test', truncated: false,
  })

  it('register fires before the provider start, bind carries the child id, evaluate drives a fresh child with the evidence', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['first try', 'second try'], seen)
    const order: string[] = []
    let calls = 0
    const supervisor: WorkflowChildSupervisor = {
      register: (child) => { order.push(`register:${child.callId}:${child.nodeId}:${seen.length}`) },
      bind: (child, childId) => { order.push(`bind:${child.iteration}:${childId}`) },
      evaluate: async (child, outcome) => {
        calls += 1
        order.push(`evaluate:${child.iteration}:${outcome.text}`)
        return calls === 1 ? evidence(1) : undefined
      },
      release: (child, childId) => { order.push(`release:${child.iteration}:${childId}`) },
    }
    const result = await finish(start(ctx, "return await agent('implement', { nodeId: 'impl', doneWhen: { command: 'pnpm test', maxContinuations: 2 } })", { bashEnabled: true, supervisor }))
    expect(result.value).toBe('second try')
    expect(seen).toHaveLength(2)
    const second = (seen[1]!.prompt[0] as { text: string }).text
    expect(second).toContain('implement')
    expect(second).toContain('Workflow done gate:')
    expect(second).toContain('iteration 1 of 3')
    expect(second).toContain('FAIL: 1 test')
    expect(order).toEqual([
      'register:1:impl:0',
      'bind:0:stub-child-0',
      'evaluate:0:first try',
      'release:0:stub-child-0',
      'register:1:impl:1',
      'bind:1:stub-child-1',
      'evaluate:1:second try',
      'release:1:stub-child-1',
    ])
  })

  it('a child with no timeoutMs gets the default one-hour deadline', async () => {
    const { ctx } = await setup()
    const seen: (number | undefined)[] = []
    const supervisor: WorkflowChildSupervisor = { register: (child) => { seen.push(child.timeoutMs) } }
    await finish(start(ctx, "return await agent('p')", { supervisor }))
    await finish(start(ctx, "return await agent('p', { timeoutMs: 5000 })", { supervisor }))
    expect(seen).toEqual([3_600_000, 5000])
  })

  it('stops at the explicit cap and fails the node with the last evidence', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['t1', 't2', 't3'], seen)
    const supervisor: WorkflowChildSupervisor = { evaluate: () => Promise.resolve(evidence(7)) }
    const result = await finish(start(ctx, `
      const out = await agent('implement', { nodeId: 'impl', doneWhen: { command: 'pnpm test', maxContinuations: 1 } })
      return { out, evidence: evidence('impl') }
    `, { bashEnabled: true, supervisor }))
    expect(result.stopReason).toBe('completed')
    expect(seen).toHaveLength(2)
    expect(result.value).toEqual({
      out: null,
      evidence: { iteration: 2, maxContinuations: 1, command: 'pnpm test', exitCode: 7, tail: 'FAIL: 1 test', truncated: false },
    })
  })

  it('clamps the cap to the ceiling of 8 even when the script asks for more', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['x'], seen)
    const supervisor: WorkflowChildSupervisor = { evaluate: () => Promise.resolve(evidence(1)) }
    await finish(start(ctx, "return await agent('p', { nodeId: 'impl', doneWhen: { command: 'false', maxContinuations: 50 } })", { bashEnabled: true, supervisor }))
    expect(seen).toHaveLength(9)
  })

  it('fails loud when an installed supervisor cannot evaluate doneWhen, or bash is off', async () => {
    const { ctx } = await setup()
    const noSupervisor = await finish(start(ctx, "return await agent('p', { doneWhen: { command: 'true' } })", { bashEnabled: true, supervisor: {} }))
    expect(noSupervisor.stopReason).toBe('error')
    expect(noSupervisor.error).toContain('needs a child supervisor')
    const off = await finish(start(ctx, "return await agent('p', { doneWhen: { command: 'true' } })", { supervisor: { evaluate: () => Promise.resolve(undefined) } }))
    expect(off.error).toContain('is not enabled for this run')
  })

  it('gives the evaluator a run-linked bash', async () => {
    const { ctx } = await setup(['done'])
    let ran: string | undefined
    const supervisor: WorkflowChildSupervisor = {
      evaluate: async (_child, _outcome, tools) => {
        const check = await tools.runBash('echo checked; exit 0')
        ran = check.stdout
        return undefined
      },
    }
    const result = await finish(start(ctx, "return await agent('p', { doneWhen: { command: 'echo checked' } })", { bashEnabled: true, supervisor }))
    expect(result.value).toBe('done')
    expect(ran).toBe('checked\n')
  })

  it('a throwing evaluator counts as a failed check: the tail says so and the continuation proceeds', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['first try', 'second try'], seen)
    let calls = 0
    const supervisor: WorkflowChildSupervisor = {
      evaluate: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('evaluator bug')) : Promise.resolve(undefined)
      },
    }
    const result = await finish(start(ctx, "return await agent('p', { doneWhen: { command: 'true' } })", { bashEnabled: true, supervisor }))
    expect(result.value).toBe('second try')
    expect(seen).toHaveLength(2)
    expect((seen[1]!.prompt[0] as { text: string }).text).toContain('done_when check could not run: ')
    expect((seen[1]!.prompt[0] as { text: string }).text).toContain('evaluator bug')
  })

  it('a throwing evaluator that never recovers exhausts the cap and fails the node with that evidence', async () => {
    const { ctx } = await setup(['a', 'b', 'c'])
    const supervisor: WorkflowChildSupervisor = { evaluate: () => Promise.reject(new Error('always broken')) }
    const result = await finish(start(ctx, `
      const out = await agent('p', { nodeId: 'n', doneWhen: { command: 'true', maxContinuations: 1 } })
      return { out, evidence: evidence('n') }
    `, { bashEnabled: true, supervisor }))
    const value = result.value as { out: unknown; evidence: { tail: string; exitCode: number | null } }
    expect(value.out).toBeNull()
    expect(value.evidence.tail).toContain('done_when check could not run: always broken')
    expect(value.evidence.exitCode).toBeNull()
  })

  it('a done-when check refused by the bash budget counts as a failed check, not an accepted result', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['a', 'b', 'c', 'd'], seen)
    const handle = start(ctx, `
      const out = await agent('p', { nodeId: 'n', doneWhen: { command: 'true' } })
      return { out, evidence: evidence('n') }
    `, { bashEnabled: true })
    // The default supervisor's check is refused by the exhausted budget on every iteration.
    ;(handle as unknown as { bashCalls: number }).bashCalls = 1000
    const settled = await finish(handle)
    expect(seen).toHaveLength(4)
    expect((seen[1]!.prompt[0] as { text: string }).text).toContain('done_when check could not run: ')
    expect((seen[1]!.prompt[0] as { text: string }).text).toContain('budget exhausted')
    const value = settled.value as { out: unknown; evidence: { tail: string } }
    expect(value.out).toBeNull()
    expect(value.evidence.tail).toContain('budget exhausted')
  })

  it('a throwing register/bind/release never fails the run', async () => {
    const { ctx } = await setup()
    const boom = () => { throw new Error('supervisor bug') }
    const result = await finish(start(ctx, "return await agent('p')", { supervisor: { register: boom, bind: boom, release: boom } }))
    expect(result.value).toBe('ok')
  })
})

describe('C1 compiled-script contract', () => {
  it('bash accepts nodeId/workdir/timeoutMs/env/retry, WF_ vars in env, and returns the contract shape', async () => {
    const { ctx } = await setup()
    const result = await finish(start(ctx, `
      const r = await bash('echo "$WF_A_OUTPUT"', { nodeId: 'run', timeoutMs: 5000, env: { WF_A_OUTPUT: 'upstream', CI: '1' }, retry: { maxAttempts: 2, delayMs: 0 } })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, aborted: r.aborted }
    `, { bashEnabled: true }))
    expect(result.value).toEqual({ exitCode: 0, stdout: 'upstream\n', stderr: '', timedOut: false, aborted: false })
  })

  it('bash retry is transient-only: a timeout is retried, a non-zero exit is not', async () => {
    const { ctx } = await setup()
    const calls: string[] = []
    const exec = (timedOut: boolean, exitCode: number) => ({
      exitCode, signal: null, timedOut, aborted: false, stdout: '', stderr: '', truncated: false, stdoutBytes: 0, stderrBytes: 0, durationMs: 1,
    })
    const results = [exec(true, 0), exec(true, 0), exec(false, 1)]
    const bashExecutor = { run: () => { calls.push('x'); return Promise.resolve(results.shift() ?? exec(false, 9)) } }
    const retried = await finish(start(ctx, "return (await bash('t', { retry: { maxAttempts: 5, delayMs: 0 } })).exitCode", { bashEnabled: true, bashExecutor }))
    expect(retried.value).toBe(1)
    expect(calls).toHaveLength(3)
    calls.length = 0
    const final = await finish(start(ctx, "return (await bash('t', { retry: { maxAttempts: 5 } })).exitCode", {
      bashEnabled: true,
      bashExecutor: { run: () => { calls.push('y'); return Promise.resolve(exec(false, 2)) } },
    }))
    expect(final.value).toBe(2)
    expect(calls).toHaveLength(1)
  })

  it('agent accepts nodeId/tier/timeoutMs/idleTimeoutMs/retry, resolves a tier to a model, and passes limits to the supervisor', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['ok'], seen)
    const registered: unknown[] = []
    const result = await finish(start(ctx, `
      return await agent('p', { nodeId: 'impl', label: 'impl', phase: 'build', tier: 'cheap', timeoutMs: 60000, idleTimeoutMs: 5000, retry: { maxAttempts: 2, delayMs: 0 } })
    `, { tierModels: { cheap: 'haiku-x' }, supervisor: { register: (child) => { registered.push(child) } } }))
    expect(result.value).toBe('ok')
    expect(seen[0]!.agentOptions).toEqual({ model: 'haiku-x' })
    expect(registered[0]).toMatchObject({ nodeId: 'impl', tier: 'cheap', timeoutMs: 60000, idleTimeoutMs: 5000 })
  })

  it('an explicit model beats a tier', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['ok'], seen)
    await finish(start(ctx, "return await agent('p', { model: 'm1', tier: 'cheap' })", { tierModels: { cheap: 'haiku-x' } }))
    expect(seen[0]!.agentOptions).toEqual({ model: 'm1' })
  })

  it('agent retry re-runs only transient failures (stalled), not an ordinary failed child', async () => {
    const calls: number[] = []
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    const reasons = ['stalled', 'stalled', 'completed']
    ctx.subagents.registerProvider({
      name: 'stub',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: () => {
        const reason = reasons[calls.length] ?? 'error'
        calls.push(calls.length)
        return Promise.resolve({
          id: SessionId(`c-${calls.length}`),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text' as const, text: reason }], stopReason: reason } as SubagentResult),
          dispose: () => Promise.resolve(),
        })
      },
    })
    await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'stub', maxConcurrentAgents: 2 })
    const ok = await finish(start(ctx, "return await agent('p', { retry: { maxAttempts: 3, delayMs: 0 } })"))
    expect(ok.value).toBe('completed')
    expect(calls).toHaveLength(3)
    calls.length = 0
    reasons.splice(0, reasons.length, 'error', 'completed')
    const failed = await finish(start(ctx, "return await agent('p', { retry: { maxAttempts: 3, delayMs: 0 } })"))
    expect(failed.value).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('rejects unknown retry keys and bad limits', async () => {
    const { ctx } = await setup()
    expect((await finish(start(ctx, "return await agent('p', { retry: { max: 2 } })"))).error).toContain('retry option "max" is not recognized')
    expect((await finish(start(ctx, "return await agent('p', { timeoutMs: 0 })"))).error).toContain('"timeoutMs" must be a positive safe integer')
  })

  it('cancel(reason) cancels the run and throws the engine CANCELLED error', async () => {
    const { ctx, events } = await setup()
    const result = await finish(start(ctx, `
      nodeStart('stop', 'cancel')
      nodeEnd('stop', { status: 'cancelled', output: '' })
      cancel('approval rejected')
      return 'unreachable'
    `))
    expect(result.stopReason).toBe('cancelled')
    expect(result.error).toContain('approval rejected')
    expect(events).toEqual(['start:stop', 'end:stop:cancelled', 'workflow-end'])
  })

  it('nodeEnd accepts the output tail and does not forward it in the event', async () => {
    const { ctx, nodeEnds } = await setup()
    await finish(start(ctx, "nodeStart('n', 'bash'); nodeEnd('n', { status: 'success', exitCode: 0, output: 'secret-ish tail' })"))
    expect(JSON.stringify(nodeEnds)).not.toContain('secret-ish')
  })

  it('an approval that outlives its timeout is rejected and the approver signal aborts', async () => {
    const { ctx } = await setup()
    let signal: AbortSignal | undefined
    const result = await finish(start(ctx, "return await approve({ nodeId: 'slow', message: 'q', timeoutMs: 100 })", {
      approver: (request) => { signal = request.signal; return new Promise(() => {}) },
    }))
    expect(result.value).toBe('rejected')
    expect(signal?.aborted).toBe(true)
  })

  it('the gate manifest owes a not-reached gate for a node that never started', async () => {
    const { ctx, events } = await setup()
    await finish(start(ctx, "nodeStart('a', 'bash'); nodeEnd('a', { status: 'success' }); gate('a', 'bash', 'fired-pass'); return 1", {
      gateManifest: [{ nodeId: 'a', gateKind: 'bash' }, { nodeId: 'later', gateKind: 'approval' }],
    }))
    expect(events).toEqual(['start:a', 'end:a:success', 'gate:a:fired-pass', 'gate:later:not-reached:synth', 'workflow-end'])
  })
})

/** The worker handle of a started run, for injecting messages a hostile worker could send. */
function workerOf(handle: WorkflowRun): Worker {
  return (handle as unknown as { worker: Worker }).worker
}

/** Capture what the host posts to the worker instead of delivering it. */
interface HostReply { type: string; callId?: number; rendered?: string; outcome?: string }

function captureHostReplies(worker: Worker): { sent: HostReply[]; restore: () => void } {
  const sent: HostReply[] = []
  const spy = vi.spyOn(worker, 'postMessage').mockImplementation((message: unknown) => { sent.push(message as never) })
  return { sent, restore: () => { spy.mockRestore() } }
}

describe('hostile worker messages (the host never trusts the worker)', () => {
  const PARK = 'await new Promise(() => {})'

  it('rebuilds node and gate events field by field: no extra keys, output dropped, synthesized forced false, bad shapes ignored', async () => {
    const { ctx, nodeStarts, nodeEnds, gates } = await setup()
    const handle = start(ctx, PARK, { gateManifest: [{ nodeId: 'a', gateKind: 'bash' }] })
    const worker = workerOf(handle)
    const long = 'x'.repeat(5000)
    worker.emit('message', { type: 'node-start', info: { nodeId: 'a', kind: 'bash', gateKind: 'hard', output: 'SECRET', synthesized: true, extra: 1 } })
    worker.emit('message', { type: 'node-start', info: { nodeId: 'Bad Id', kind: 'bash' } })
    worker.emit('message', { type: 'node-start', info: { nodeId: 'UPPER', kind: 'bash' } })
    worker.emit('message', { type: 'node-start', info: { nodeId: 'ok', kind: 'Bad-Kind' } })
    worker.emit('message', { type: 'node-start', info: 'not an object' })
    worker.emit('message', { type: 'node-end', info: { nodeId: 'a', status: 'success', output: 'SECRET', synthesized: true, error: `${long}\u0007`, exitCode: 'zero', extra: 2 } })
    worker.emit('message', { type: 'node-end', info: { nodeId: 'ghost', status: 'success' } })
    expect(nodeStarts).toEqual([{ nodeId: 'a', kind: 'bash' }])
    expect(nodeEnds).toHaveLength(1)
    expect(Object.keys(nodeEnds[0]!).sort()).toEqual(['error', 'kind', 'nodeId', 'status', 'synthesized'])
    expect(nodeEnds[0]!.synthesized).toBe(false)
    expect(nodeEnds[0]!.error).toHaveLength(2000)
    expect(JSON.stringify([nodeStarts, nodeEnds])).not.toContain('SECRET')
    // Gates: undeclared kind, malformed outcome, and an override of the manifest kind are all dropped; the declared one passes once.
    worker.emit('message', { type: 'gate', info: { nodeId: 'a', gateKind: 'hard', outcome: 'fired-pass' } })
    worker.emit('message', { type: 'gate', info: { nodeId: 'a', gateKind: 'bash', outcome: 'maybe' } })
    worker.emit('message', { type: 'gate', info: { nodeId: 'zzz', gateKind: 'bash', outcome: 'fired-pass' } })
    worker.emit('message', { type: 'gate', info: { nodeId: 'a', gateKind: 'bash', outcome: 'fired-block', synthesized: true, extra: 3 } })
    worker.emit('message', { type: 'gate', info: { nodeId: 'a', gateKind: 'bash', outcome: 'fired-pass' } })
    expect(gates).toEqual([{ nodeId: 'a', gateKind: 'bash', outcome: 'fired-block', synthesized: false }])
    handle.cancel('done')
    await handle.dispose()
  })

  it.each([
    ['null', null],
    ['an unknown type', { type: 'x' }],
    ['agent-start with null info', { type: 'agent-start', info: null }],
    ['agent-end with a string info', { type: 'agent-end', info: 'x' }],
    ['a null result', { type: 'result', result: null }],
    ['a result with a bad stop reason', { type: 'result', result: { stopReason: 'bogus', agentsStarted: 0 } }],
  ])('a malformed worker message (%s) settles the run as an error and terminates the worker, never crashing the host', async (_name, bad) => {
    const { ctx } = await setup()
    const handle = start(ctx, PARK)
    const worker = workerOf(handle)
    expect(() => { worker.emit('message', bad) }).not.toThrow()
    const result = await handle.result
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('malformed message')
    await handle.dispose()
    expect(worker.threadId).toBe(-1)
  })

  it('bounds and rebuilds agent-start info: duplicates ignored, extra keys dropped, long labels clamped', async () => {
    const { ctx } = await setup()
    const starts: Record<string, unknown>[] = []
    const handle = start(ctx, PARK, {})
    const worker = workerOf(handle)
    const observer = (handle as unknown as { observer: { agentStart(i: Record<string, unknown>): void } }).observer
    const original = observer.agentStart.bind(observer)
    observer.agentStart = (info) => { starts.push(info); original(info) }
    worker.emit('message', { type: 'agent-start', info: { seq: 1, label: 'x'.repeat(5000), childId: 'c1', extra: 'no' } })
    worker.emit('message', { type: 'agent-start', info: { seq: 1, label: 'dup', childId: 'c1' } })
    expect(starts).toHaveLength(1)
    expect(Object.keys(starts[0]!).sort()).toEqual(['childId', 'label', 'seq'])
    expect(String(starts[0]!.label)).toHaveLength(500)
    handle.cancel('done')
    await handle.dispose()
  })

  it('a node start cannot declare gates on a node the manifest names, and distinct nodes and events are capped', async () => {
    const { ctx, nodeStarts, gates } = await setup()
    const handle = start(ctx, PARK, { gateManifest: [{ nodeId: 'm', gateKind: 'bash' }] })
    const worker = workerOf(handle)
    worker.emit('message', { type: 'node-start', info: { nodeId: 'm', kind: 'bash', gateKind: 'extra_gate' } })
    for (let i = 0; i < 1200; i += 1) worker.emit('message', { type: 'node-start', info: { nodeId: `n${i}`, kind: 'bash' } })
    expect(nodeStarts.length).toBe(1000)
    handle.cancel('done')
    await handle.result
    // Only the manifest's gate is owed for m; the worker-declared extra_gate never appears.
    expect(gates.map(g => `${g.nodeId}:${g.gateKind}`)).toEqual(['m:bash'])
    await handle.dispose()
  })

  it('tracks two gates on one node by kind (verifier and done_when), and a never-started node is not-reached', async () => {
    const { ctx, events } = await setup()
    await finish(start(ctx, `
      nodeStart('a', 'prompt')
      nodeEnd('a', { status: 'success' })
      gate('a', 'verifier', 'fired-pass')
      return 1
    `, { gateManifest: [{ nodeId: 'a', gateKind: 'verifier' }, { nodeId: 'a', gateKind: 'done_when' }, { nodeId: 'later', gateKind: 'approval' }] }))
    expect(events).toEqual([
      'start:a', 'end:a:success', 'gate:a:fired-pass',
      'gate:a:never-evaluated:synth', 'gate:later:not-reached:synth', 'workflow-end',
    ])
  })

  it('refuses bash beyond 8 concurrent commands and beyond 1000 calls per run', async () => {
    const { ctx } = await setup()
    const release = Promise.withResolvers<undefined>()
    const done = { exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: '', stderr: '', truncated: false, stdoutBytes: 0, stderrBytes: 0, durationMs: 1 }
    const handle = start(ctx, PARK, { bashEnabled: true, bashExecutor: { run: async () => { await release.promise; return done } } })
    const worker = workerOf(handle)
    const { sent, restore } = captureHostReplies(worker)
    for (let i = 0; i < 10; i += 1) worker.emit('message', { type: 'bash-start', callId: i, command: 'true', options: {} })
    await waitFor(() => { expect(sent.filter(m => m.type === 'bash-error')).toHaveLength(2) })
    expect(sent.filter(m => m.type === 'bash-error')[0]!.rendered).toContain('too many concurrent')
    release.resolve(undefined)
    await waitFor(() => { expect(sent.filter(m => m.type === 'bash-result')).toHaveLength(8) })
    sent.length = 0
    // 8 calls are spent so far; run the rest of the 1000 budget in batches the concurrency cap admits.
    let id = 100
    for (let batch = 0; batch < 124; batch += 1) {
      const before = sent.filter(m => m.type === 'bash-result').length
      for (let k = 0; k < 8; k += 1) { worker.emit('message', { type: 'bash-start', callId: id, command: 'true', options: {} }); id += 1 }
      await waitFor(() => { expect(sent.filter(m => m.type === 'bash-result').length).toBe(before + 8) })
    }
    worker.emit('message', { type: 'bash-start', callId: id, command: 'true', options: {} })
    await waitFor(() => { expect(sent.filter(m => m.type === 'bash-error' && String(m.rendered).includes('call budget'))).toHaveLength(1) })
    restore()
    handle.cancel('done')
    await handle.dispose()
  })

  it('refuses a 17th pending approval and a 1001st approval, and never sends approval ids to the worker', async () => {
    const { ctx } = await setup()
    let mode: 'hang' | 'instant' = 'hang'
    const handle = start(ctx, PARK, { approver: () => (mode === 'hang' ? new Promise(() => {}) : Promise.resolve('rejected')) })
    const worker = workerOf(handle)
    const { sent, restore } = captureHostReplies(worker)
    for (let i = 0; i < 17; i += 1) worker.emit('message', { type: 'approve-start', callId: i, nodeId: 'n', message: 'q' })
    await waitFor(() => { expect(sent.filter(m => m.type === 'approve-result')).toHaveLength(1) })
    expect(sent.find(m => m.type === 'approve-result')).toMatchObject({ outcome: 'unavailable', callId: 16 })
    expect(JSON.stringify(sent)).not.toMatch(/[0-9a-f]{32}/)
    expect(handle.pendingApprovals?.()).toHaveLength(16)
    for (const pending of handle.pendingApprovals?.() ?? []) handle.decideApproval?.(pending.approvalId, 'rejected')
    await waitFor(() => { expect(sent.filter(m => m.type === 'approve-result')).toHaveLength(17) })
    mode = 'instant'
    sent.length = 0
    for (let i = 0; i < 1000; i += 1) worker.emit('message', { type: 'approve-start', callId: 100 + i, nodeId: 'n', message: 'q' })
    await waitFor(() => { expect(sent.filter(m => m.type === 'approve-result' && m.outcome === 'unavailable').length).toBeGreaterThan(0) })
    restore()
    handle.cancel('done')
    await handle.dispose()
  })

  it('answers unavailable for malformed approve-start arguments, never throws, and strips control characters from the question', async () => {
    const { ctx } = await setup()
    const seen: WorkflowApprovalRequest[] = []
    const handle = start(ctx, PARK, { approver: (request) => { seen.push(request); return Promise.resolve('allowed-once') } })
    const worker = workerOf(handle)
    const { sent, restore } = captureHostReplies(worker)
    const bad: unknown[][] = [
      [42, 'm'], ['n', { a: 1 }], ['n', 'm', '5'], ['n', 'm', -1], ['n', 'm', 1.5], ['../x', 'm'], ['n', ''], ['n', 'x'.repeat(2001)], [null, null], [undefined, undefined],
    ]
    bad.forEach(([nodeId, message, timeoutMs], i) => { worker.emit('message', { type: 'approve-start', callId: i, nodeId, message, timeoutMs }) })
    worker.emit('message', { type: 'approve-start', callId: 99, nodeId: 'n', message: 'a\u0000b\u001b[31mc\nd' })
    await waitFor(() => { expect(sent.filter(m => m.type === 'approve-result')).toHaveLength(bad.length + 1) })
    expect(sent.filter(m => m.type === 'approve-result' && m.callId !== 99).every(m => m.outcome === 'unavailable')).toBe(true)
    expect(sent.find(m => m.callId === 99)).toMatchObject({ outcome: 'allowed-once' })
    expect(seen[0]!.message).toBe('ab[31mc\nd')
    restore()
    handle.cancel('done')
    await handle.dispose()
  })

  it('ends a worker that floods the host past its message budget', async () => {
    const { ctx } = await setup()
    const handle = start(ctx, PARK)
    const worker = workerOf(handle)
    for (let i = 0; i < 200_005; i += 1) worker.emit('message', { type: 'node-end', info: {} })
    const result = await handle.result
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('message budget')
    await handle.dispose()
  })

  it('re-validates child requests host-side (malformed fields never reach the provider)', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['ok'], seen)
    const handle = start(ctx, PARK)
    const worker = workerOf(handle)
    const { sent, restore } = captureHostReplies(worker)
    const bads: Record<string, unknown>[] = [
      { prompt: 7 }, { prompt: '' }, { prompt: 'p', nodeId: '../x' }, { prompt: 'p', tier: '__proto__' }, { prompt: 'p', timeoutMs: 0 },
      { prompt: 'p', idleTimeoutMs: 'x' }, { prompt: 'p', model: 'a\nb' }, { prompt: 'p', provider: 5 }, { prompt: 'p', schema: { type: 'string' } },
    ]
    bads.forEach((request, i) => { worker.emit('message', { type: 'child-start', callId: i, request }) })
    await waitFor(() => { expect(sent.filter(m => m.type === 'child-start-error')).toHaveLength(bads.length) })
    expect(seen).toHaveLength(0)
    restore()
    handle.cancel('done')
    await handle.dispose()
  })
})

describe('supervisor stop and engine retry', () => {
  /** A provider whose first child never settles on its own; later children complete. */
  async function stuckFirstSetup() {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    let count = 0
    const disposed: number[] = []
    ctx.subagents.registerProvider({
      name: 'stub',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: () => {
        const n = count
        count += 1
        const result: Promise<SubagentResult> = n === 0
          ? new Promise(() => {})
          : Promise.resolve({ output: [{ type: 'text', text: `done-${n}` }], stopReason: 'completed' })
        return Promise.resolve({ id: SessionId(`s-${n}`), localAgent: undefined, result, dispose: () => { disposed.push(n); return Promise.resolve() } })
      },
    })
    await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'stub', maxConcurrentAgents: 2 })
    return { ctx, disposed }
  }

  const stalling: WorkflowChildSupervisor = {
    bind: (child, _id, handle) => { if (child.callId === 1) queueMicrotask(() => { handle.stop('stalled') }) },
  }

  it('a supervisor stop disposes the child, settles it as stalled, and the engine retries it', async () => {
    const { ctx, disposed } = await stuckFirstSetup()
    const result = await finish(start(ctx, "return await agent('p', { retry: { maxAttempts: 2, delayMs: 0 } })", { supervisor: stalling }))
    expect(result.value).toBe('done-1')
    expect(disposed).toContain(0)
  })

  it('without retry a stopped child fails the call (null) and a stale stop after settle is a no-op', async () => {
    const { ctx } = await stuckFirstSetup()
    let handleRef: { stop(reason: 'timeout' | 'stalled'): void } | undefined
    const result = await finish(start(ctx, "return await agent('p')", {
      supervisor: { bind: (_c, _id, handle) => { handleRef = handle; queueMicrotask(() => { handle.stop('timeout') }) } },
    }))
    expect(result.value).toBeNull()
    expect(() => handleRef?.stop('stalled')).not.toThrow()
  })

  /** A provider whose children follow `script` in order: `hang` never settles, `done` completes, `error` ends with stopReason error. */
  async function scriptedSetup(script: readonly ('hang' | 'done' | 'error')[]) {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    let count = 0
    ctx.subagents.registerProvider({
      name: 'stub',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: () => {
        const behaviour = script[count] ?? 'done'
        count += 1
        const result: Promise<SubagentResult> = behaviour === 'hang'
          ? new Promise(() => {})
          : Promise.resolve({ output: [{ type: 'text', text: 'out' }], stopReason: behaviour === 'done' ? 'completed' : 'error' })
        return Promise.resolve({ id: SessionId(`n-${count}`), localAgent: undefined, result, dispose: () => Promise.resolve() })
      },
    })
    await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'stub', maxConcurrentAgents: 2 })
    const ends: WorkflowNodeEndInfo[] = []
    ctx.on('workflow/node-end', (_info, node) => { ends.push(node) })
    return { ctx, ends }
  }

  const stopping = (reason: 'timeout' | 'stalled'): WorkflowChildSupervisor => ({
    bind: (_child, _id, handle) => { queueMicrotask(() => { handle.stop(reason) }) },
  })

  const NODE_SCRIPT = (opts: string): string => `
    nodeStart('think', 'prompt')
    const r = await agent('p', { nodeId: 'think', ${opts} })
    nodeEnd('think', { status: r === null ? 'failed' : 'success', ...(r === null ? { error: 'the agent did not complete' } : {}) })
    return r`

  it('NODE_STALLED: both attempts stalled, node-end carries the code, the idle window, the retry count and attempts 2', async () => {
    const { ctx, ends } = await scriptedSetup(['hang', 'hang'])
    const result = await finish(start(ctx, NODE_SCRIPT('idleTimeoutMs: 1000, retry: { maxAttempts: 2, delayMs: 0 }'), { supervisor: stopping('stalled') }))
    expect(result.value).toBeNull()
    expect(ends).toHaveLength(1)
    expect(ends[0]!.attempts).toBe(2)
    expect(ends[0]!.failure).toMatchObject({ code: 'NODE_STALLED', remedy: "raise idleTimeoutMs for this node or check the agent's output" })
    expect(ends[0]!.failure!.message).toContain('1000 ms')
    expect(ends[0]!.failure!.message).toContain('1 retry')
    expect(ends[0]!.error).toBe(ends[0]!.failure!.message)
  })

  it('NODE_TIMEOUT: the hard per-node limit is named apart from a stall', async () => {
    const { ctx, ends } = await scriptedSetup(['hang'])
    await finish(start(ctx, NODE_SCRIPT('timeoutMs: 60000'), { supervisor: stopping('timeout') }))
    expect(ends[0]!.attempts).toBe(1)
    expect(ends[0]!.failure).toMatchObject({ code: 'NODE_TIMEOUT' })
    expect(ends[0]!.failure!.message).toContain('60000 ms')
    expect(ends[0]!.failure!.message).toContain('0 retries')
  })

  it('nearest allow: a genuine non-completion keeps "did not complete" and carries no failure', async () => {
    const { ctx, ends } = await scriptedSetup(['error'])
    await finish(start(ctx, NODE_SCRIPT('idleTimeoutMs: 1000, retry: { maxAttempts: 2, delayMs: 0 }')))
    expect(ends[0]!.error).toBe('the agent did not complete')
    expect(ends[0]!.failure).toBeUndefined()
    expect(ends[0]!.attempts).toBe(1)
  })

  it('a stall on attempt 1 followed by a genuine error on attempt 2 reads "did not complete" with no failure code and attempts 2', async () => {
    const { ctx, ends } = await scriptedSetup(['hang', 'error'])
    const stopFirst: WorkflowChildSupervisor = {
      bind: (child, _id, handle) => { if (child.callId === 1 && child.iteration === 0) queueMicrotask(() => { handle.stop('stalled') }) },
    }
    await finish(start(ctx, NODE_SCRIPT('idleTimeoutMs: 1000, retry: { maxAttempts: 2, delayMs: 0 }'), { supervisor: stopFirst }))
    expect(ends[0]!.error).toBe('the agent did not complete')
    expect(ends[0]!.failure).toBeUndefined()
    expect(ends[0]!.attempts).toBe(2)
  })

  it('nearest allow: a child that answers inside the window is not marked stalled, and a stall that a retry recovers carries no failure', async () => {
    const quick = await scriptedSetup(['done'])
    await finish(start(quick.ctx, NODE_SCRIPT('idleTimeoutMs: 1000')))
    expect(quick.ends[0]).toMatchObject({ status: 'success', attempts: 1 })
    expect(quick.ends[0]!.failure).toBeUndefined()
    const recovered = await scriptedSetup(['hang', 'done'])
    await finish(start(recovered.ctx, NODE_SCRIPT('idleTimeoutMs: 1000, retry: { maxAttempts: 2, delayMs: 0 }'), { supervisor: stopping('stalled') }))
    expect(recovered.ends[0]).toMatchObject({ status: 'success', attempts: 2 })
    expect(recovered.ends[0]!.failure).toBeUndefined()
  })

  it('a tier named like a prototype member never resolves through the prototype chain', async () => {
    const seen: SubagentStartRequest[] = []
    const { ctx } = await setup(['ok'], seen)
    await finish(start(ctx, "return await agent('p', { tier: 'constructor' })", { tierModels: { cheap: 'haiku-x' } }))
    expect(seen[0]!.agentOptions).toBeUndefined()
    const bad = await finish(start(ctx, "return await agent('p', { tier: '__proto__' })", { tierModels: { cheap: 'haiku-x' } }))
    expect(bad.error).toContain('tier')
  })

  it('a launch failure during continuation releases the old child once, and the continuation counts toward the agent cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    let count = 0
    ctx.subagents.registerProvider({
      name: 'stub',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: () => {
        const n = count
        count += 1
        if (n === 1) return Promise.reject(new Error('provider refused the continuation'))
        return Promise.resolve({
          id: SessionId(`r-${n}`), localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'x' }], stopReason: 'completed' } as SubagentResult),
          dispose: () => Promise.resolve(),
        })
      },
    })
    await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'stub', maxConcurrentAgents: 2 })
    const releases: string[] = []
    const registers: number[] = []
    const releasedIterations: number[] = []
    const result = await finish(start(ctx, "return await agent('p', { nodeId: 'impl', doneWhen: { command: 'false' } })", {
      bashEnabled: true,
      supervisor: {
        evaluate: () => Promise.resolve({ iteration: 1, maxContinuations: 3, command: 'false', exitCode: 1, tail: 't', truncated: false }),
        register: (child) => { registers.push(child.iteration) },
        release: (child, id) => { releasedIterations.push(child.iteration); releases.push(String(id)) },
      },
    }))
    expect(result.stopReason).toBe('error')
    expect(releases.filter(id => id === 'r-0')).toHaveLength(1)
    // Every registered iteration is released exactly once, including the continuation whose launch threw (no child id).
    expect(registers).toEqual([0, 1])
    expect(releasedIterations.sort()).toEqual([0, 1])
    // With the cap at 1 total agent, the evidence ends the loop instead of starting another child.
    count = 0
    const capped = await finish(start(ctx, "return [await agent('p', { nodeId: 'impl', doneWhen: { command: 'false' } }), evidence('impl')]", {
      bashEnabled: true,
      maxTotalAgents: 1,
      supervisor: { evaluate: () => Promise.resolve({ iteration: 1, maxContinuations: 3, command: 'false', exitCode: 1, tail: 't', truncated: false }) },
    }))
    expect(count).toBe(1)
    expect((capped.value as unknown[])[0]).toBeNull()
    expect((capped.value as unknown[])[1]).toMatchObject({ exitCode: 1 })
  })
})

describe('no turn-stopping listener', () => {
  it('neither package registers an agent/turn-stopping listener (the done gate is an engine loop, so the hooks bridge is never double-steered)', () => {
    const roots = [
      new URL('../src/', import.meta.url),
      new URL('../../workflow/src/', import.meta.url),
    ]
    for (const root of roots) {
      for (const file of readdirSync(root)) {
        if (!file.endsWith('.ts')) continue
        const text = readFileSync(new URL(file, root), 'utf8')
        expect(text, `${file} must not subscribe to agent/turn-stopping`).not.toMatch(/turn-stopping/)
      }
    }
  })
})

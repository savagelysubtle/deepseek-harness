import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as toolWorkflowRun from '../src/index.ts'
import { StubShell } from './harness.ts'

const FLOW = `version: 1
name: real
description: real stack
nodes:
  - id: build
    kind: bash
    bash: echo built
    gate: true
  - id: think
    kind: prompt
    depends_on: [build]
    mutates_checkout: false
    prompt: Summarize the build
`

const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * Idle-parent VERIFY: a UI-started run has a parent agent that is NOT in a turn. The real
 * worker-thread engine, the real spawn provider and a real agent loop must still run it, and the
 * recorder must append its log-only events to the idle parent session without tripping the
 * session invariant.
 */
describe('workflow_run over the real stack with an idle parent', () => {
  it('runs a bash + agent workflow end to end and records events on the idle parent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'wfreal-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'wfreal-home-'))
    cleanups.push(workspace, home)
    await mkdir(join(workspace, '.workflows'))
    await writeFile(join(workspace, '.workflows', 'real.yaml'), FLOW)

    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(WorkerThreadWorkflowEngine, {})
    await ctx.plugin(StubShell)
    const shell = ctx.get('shell') as unknown as StubShell
    shell.handler = () => ({ stdout: { text: 'built\n', truncated: false } })
    await ctx.plugin(toolWorkflowRun, { dshHome: home })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('summary: all good')]))
    const parent = ctx.agentLoop.create(SessionId('idle-parent'), { provider: 'mock', model: 'mock' }, { cwd: workspace })

    const dry = await ctx.workflowRuns.dryRun(workspace, { name: 'real', caller: parent.session.id })
    if (!dry.ok) throw new Error(dry.message)
    const started = await ctx.workflowRuns.start({
      parent, name: 'real', trustHash: dry.trustKey, ...dry.trustChallenge === undefined ? {} : { trustChallenge: dry.trustChallenge },
    })
    if (!started.ok) throw new Error(`${started.error}: ${started.message}`)
    const outcome = await started.done

    expect(outcome.status).toBe('completed')
    expect(shell.runCalls).toEqual(['echo built'])
    const types = parent.session.events.map(e => e.type).filter(t => t.startsWith('tool-workflow/'))
    expect(types[0]).toBe('tool-workflow/run-start')
    expect(types).toContain('tool-workflow/agent-start')
    expect(types).toContain('tool-workflow/gate-report')
    expect(types).toContain('tool-workflow/node-start')
    const ends = parent.session.events.filter(e => e.type === 'tool-workflow/node-end').map(e => e.data as { nodeId: string; truncated: boolean })
    expect(ends.map(e => e.nodeId)).toContain('build')
    expect(ends.every(e => typeof e.truncated === 'boolean')).toBe(true)
    expect(types.at(-1)).toBe('tool-workflow/run-end')
    expect(parent.session.events.some(e => e.type === 'turn/start')).toBe(false)
  }, 30_000)
})

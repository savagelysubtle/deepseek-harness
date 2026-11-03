/**
 * Drill harness: the REAL stack (worker-thread engine, in-process spawn provider, agent loop,
 * run store, approval broker) with exactly two doubles: a scripted model (no keys, no network) and
 * a scripted shell (no real command runs). The two example workflows under `examples/workflows`
 * are copied into a temp workspace's `.workflows` directory, so the drill exercises the files that
 * ship, not a copy written for the test.
 */

import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { MockAdapter } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import * as toolWorkflowRun from '../../src/index.ts'
import type { Config, RunOutcome, StartedRun, WorkflowRunsEvent } from '../../src/index.ts'
import { StubShell } from '../harness.ts'

/** Script entries the scripted model consumes, one per model call. */
type ModelScript = ConstructorParameters<typeof MockAdapter>[0]

/** The shipped example workflows, read from the repository's `examples/workflows` directory. */
export const EXAMPLES_DIR = fileURLToPath(new URL('../../../../../examples/workflows/', import.meta.url))

/** What a scripted shell command answers. */
type ShellAnswer = Partial<ShellRunResult> & { stdoutText?: string; stderrText?: string }

export interface Drill {
  readonly ctx: Context
  readonly parent: Agent
  readonly adapter: MockAdapter
  readonly shell: StubShell
  readonly workspace: string
  readonly home: string
  /** Every service event, in order. */
  readonly events: WorkflowRunsEvent[]
  /** Commands the scripted shell was asked to run, in order. */
  readonly commands: string[]
  cleanup(): Promise<void>
  /** Write (or overwrite) `<workspace>/.workflows/<name>.yaml`. */
  writeWorkflow(name: string, text: string): Promise<void>
  /** Dry run, then start as a human-confirmed (trusted) run. */
  startTrusted(name: string, extra?: { inputs?: Record<string, unknown>; resume?: string }): Promise<StartedRun>
  /** Run the `workflow_run` tool as the model would. */
  execute(args: unknown): Promise<ToolExecutionResult>
  /** Wait for the first pending approval and return it. */
  nextApproval(runId: string): Promise<{ approvalId: string; nodeId: string; message: string }>
}

export interface DrillOptions {
  config?: Config
  script?: ModelScript
  /** Copy the two example workflows into the workspace (default true). */
  examples?: boolean
  /** Answer for each scripted shell command; the default is exit 0 with no output. */
  shell?: (spec: ShellExecSpec, count: number) => ShellAnswer
  /** Attach a Workflows UI so approvals can be answered (default true). */
  ui?: boolean
  /** Reuse an existing dsh home (a second process opening the same store). */
  home?: string
}

/** Boot the real stack with scripted model and shell. */
export async function bootDrill(options: DrillOptions = {}): Promise<Drill> {
  const workspace = await mkdtemp(join(tmpdir(), 'wfdrill-ws-'))
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'wfdrill-home-'))
  await mkdir(join(workspace, '.workflows'))
  if (options.examples !== false) {
    for (const file of await readdir(EXAMPLES_DIR)) {
      if (file.endsWith('.yaml')) await copyFile(join(EXAMPLES_DIR, file), join(workspace, '.workflows', file))
    }
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(WorkerThreadWorkflowEngine, {})
  await ctx.plugin(StubShell)
  const shell = ctx.get('shell') as unknown as StubShell
  const commands: string[] = []
  shell.handler = (spec) => {
    commands.push(spec.command)
    const answer = options.shell?.(spec, commands.length) ?? {}
    const { stdoutText, stderrText, ...rest } = answer
    return {
      ...stdoutText === undefined ? {} : { stdout: { text: stdoutText, truncated: false } },
      ...stderrText === undefined ? {} : { stderr: { text: stderrText, truncated: false } },
      ...rest,
    }
  }
  await ctx.plugin(toolWorkflowRun, Object.assign({ dshHome: home }, options.config))
  const adapter = new MockAdapter(options.script ?? [])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId(`drill-${Math.random().toString(36).slice(2)}`), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  if (options.ui !== false) ctx.workflowRuns.attachUi()
  const events: WorkflowRunsEvent[] = []
  ctx.workflowRuns.subscribe((event) => { events.push(event) })

  const drill: Drill = {
    ctx, parent, adapter, shell, workspace, home, events, commands,
    async cleanup() {
      for (const run of ctx.workflowRuns.activeRuns()) {
        await ctx.workflowRuns.cancel(run.runId, 'drill cleanup', { workspace: run.workspace })
      }
      await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })
      if (options.home === undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })
    },
    async writeWorkflow(name, text) {
      await writeFile(join(workspace, '.workflows', `${name}.yaml`), text)
    },
    async startTrusted(name, extra = {}) {
      const dryOptions = { name, caller: parent.session.id, ...extra.inputs === undefined ? {} : { inputs: extra.inputs } }
      const dry = extra.resume === undefined ? await ctx.workflowRuns.dryRun(workspace, dryOptions) : undefined
      if (dry !== undefined && !dry.ok) throw new Error(`dry run failed: ${dry.message}`)
      const result = await ctx.workflowRuns.start({
        parent,
        ...extra.resume === undefined ? { name } : { resume: extra.resume },
        ...dry?.ok ? { trustHash: dry.trustKey, ...dry.trustChallenge === undefined ? {} : { trustChallenge: dry.trustChallenge } } : {},
        ...extra.inputs === undefined ? {} : { inputs: extra.inputs },
      })
      if (!result.ok) throw new Error(`start refused: ${result.error}: ${result.message}`)
      return result
    },
    execute(args) {
      return ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`call-${Math.random().toString(36).slice(2)}`),
        name: 'workflow_run',
        arguments: args,
        agent: parent,
      })
    },
    async nextApproval(runId) {
      const deadline = Date.now() + 20_000
      for (;;) {
        const waiting = ctx.workflowRuns.pendingApprovals(runId)[0]
        if (waiting !== undefined) return waiting
        if (Date.now() > deadline) throw new Error(`no approval became pending for ${runId}`)
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    },
  }
  return drill
}

/** The text of a tool result. */
export function textOf(result: ToolExecutionResult): string {
  return (result.content as { text?: string }[]).map(part => part.text ?? '').join('\n')
}

/** Gate outcome of one node's gate in a finished run. */
export function gateOf(outcome: RunOutcome, nodeId: string): string | undefined {
  return outcome.report.find(row => row.nodeId === nodeId)?.outcome
}

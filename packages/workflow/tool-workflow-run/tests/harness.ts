/**
 * Test harness: a controllable workflow engine, a scripted shell, a controllable approval service,
 * and a temp workspace + dsh home, wired to the real `workflow_run` plugin.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { WorkflowEngine, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowGateInfo, WorkflowNodeEndInfo, WorkflowNodeInfo, WorkflowResult, WorkflowRun, WorkflowRunInfo, WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import * as toolWorkflowRun from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** One engine run the test controls. */
export class StubRun {
  readonly cancels: string[] = []
  disposed = 0
  readonly info: WorkflowRunInfo
  private settleResult!: (result: WorkflowResult) => void
  readonly result: Promise<WorkflowResult>

  constructor(readonly engine: StubEngine, readonly id: WorkflowRunId, readonly request: WorkflowStartRequest) {
    this.info = { id, meta: request.meta }
    this.result = new Promise((resolve) => { this.settleResult = resolve })
    request.signal?.addEventListener('abort', () => {
      this.settle({ value: null, stopReason: 'cancelled', error: 'signal', agentsStarted: 0 })
    }, { once: true })
  }

  settle(result: WorkflowResult): void { this.settleResult(result) }

  nodeStart(node: WorkflowNodeInfo): void { this.engine.fire('workflow/node-start', this.info, node) }
  nodeEnd(node: WorkflowNodeEndInfo): void { this.engine.fire('workflow/node-end', this.info, node) }
  gate(gate: WorkflowGateInfo): void { this.engine.fire('workflow/gate', this.info, gate) }

  asRun(): WorkflowRun {
    return {
      id: this.id,
      meta: this.request.meta,
      result: this.result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({ value: null, stopReason: 'cancelled', error: reason ?? 'cancelled', agentsStarted: 0 })
      },
      dispose: () => { this.disposed += 1; return Promise.resolve() },
    }
  }
}

/** Engine whose runs only do what the test says. */
export class StubEngine extends WorkflowEngine {
  readonly runs: StubRun[] = []
  startError: Error | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError) throw this.startError
    const run = new StubRun(this, WorkflowRunId(`eng-${this.runs.length + 1}`), request)
    this.runs.push(run)
    return run.asRun()
  }

  fire(name: 'workflow/node-start' | 'workflow/node-end' | 'workflow/gate', ...args: unknown[]): void {
    this.emitWorkflowEvent(name, ...args)
  }
}

/** Shell that records every call and answers from a handler. */
export class StubShell extends ShellExecutor {
  readonly specs: ShellExecSpec[] = []
  readonly runCalls: string[] = []
  handler: (spec: ShellExecSpec) => Partial<ShellRunResult> = () => ({})

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/',
      timeoutMs: request.timeoutMs ?? 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1000,
      sandboxPolicy: request.sandboxPolicy,
      ...request.env === undefined ? {} : { env: request.env },
      ...request.signal === undefined ? {} : { signal: request.signal },
    }
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.specs.push(spec)
    this.runCalls.push(spec.command)
    return Promise.resolve({
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
      ...this.handler(spec),
    })
  }

  start(): ShellProcess { throw new Error('not used') }
}

/** Approval service double: every `request` waits until the test answers it. */
class FakeApproval extends Service {
  config = { policy: 'ask' as 'ask' | 'never' }
  policyOverride: 'ask' | 'never' | undefined
  readonly requests: { toolName: string; reason?: string; signal?: AbortSignal; resolve: (o: string) => void }[] = []

  constructor(ctx: Context) { super(ctx, 'approval') }

  overrideOf(): 'ask' | 'never' | undefined { return this.policyOverride }

  request(req: { toolName: string; reason?: string; signal?: AbortSignal }): Promise<string> {
    return new Promise((resolve) => {
      const entry = {
        toolName: req.toolName,
        ...req.reason === undefined ? {} : { reason: req.reason },
        ...req.signal === undefined ? {} : { signal: req.signal },
        resolve,
      }
      this.requests.push(entry)
      req.signal?.addEventListener('abort', () => { resolve('cancelled') }, { once: true })
    })
  }
}

export interface Harness {
  ctx: Context
  engine: StubEngine
  shell: StubShell
  approval: FakeApproval | undefined
  workspace: string
  home: string
  session: Session
  parent: Agent
  cleanup(): Promise<void>
  writeWorkflow(name: string, text: string): Promise<void>
  /** Open a turn on the parent session so mirrored questions are allowed. */
  openTurn(): void
  execute(args: unknown, extra?: { signal?: AbortSignal }): Promise<ToolExecutionResult>
}

/** The smallest useful workflow: one bash gate then one approval. */
export const DEMO = `version: 1
name: demo
description: A demo workflow.
inputs:
  topic:
    type: string
    default: tests
nodes:
  - id: build
    kind: bash
    bash: echo building $inputs.topic
    gate: true
  - id: ask
    kind: approval
    depends_on: [build]
    message: Ship it?
`

export async function setup(
  options: { config?: Config; approval?: boolean; engine?: boolean; ui?: boolean } = {},
): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'wfrun-ws-'))
  const home = await mkdtemp(join(tmpdir(), 'wfrun-home-'))
  await mkdir(join(workspace, '.workflows'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubEngine)
  await ctx.plugin(StubShell)
  let approval: FakeApproval | undefined
  if (options.approval !== false) {
    await ctx.plugin(FakeApproval)
    approval = ctx.get('approval') as unknown as FakeApproval
  }
  await ctx.plugin(toolWorkflowRun, Object.assign({ dshHome: home }, options.config))
  // An attached Workflows UI can answer approvals; `ui: false` models a host where nobody can.
  if (options.ui !== false) ctx.workflowRuns.attachUi()
  const id = SessionId('parent')
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: workspace })
  const parent = { id, options: { model: 'test-model' }, session } as unknown as Agent
  const harness: Harness = {
    ctx,
    engine: ctx.workflowEngine as StubEngine,
    shell: ctx.get('shell') as unknown as StubShell,
    approval,
    workspace,
    home,
    session,
    parent,
    async cleanup() {
      await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })
    },
    async writeWorkflow(name, text) {
      await writeFile(join(workspace, '.workflows', `${name}.yaml`), text)
    },
    openTurn() {
      const turn = session.events.filter(e => e.type === 'turn/start').length + 1
      session.append('turn/start', { turn })
    },
    execute(args, extra = {}) {
      return ctx.tools.execute({
        signal: extra.signal ?? new AbortController().signal,
        callId: CallId(`call-${Math.random().toString(36).slice(2)}`),
        name: 'workflow_run',
        arguments: args,
        agent: parent,
      })
    },
  }
  return harness
}

/** Start `name` as a human-confirmed (trusted) run and return the started handle. */
export async function startTrusted(h: Harness, name = 'demo', extra: { inputs?: Record<string, unknown>; resume?: string } = {}) {
  const dry = extra.resume === undefined ? await h.ctx.workflowRuns.dryRun(h.workspace, { name, caller: h.parent.session.id }) : undefined
  if (dry !== undefined && !dry.ok) throw new Error(`dry run failed: ${dry.message}`)
  const result = await h.ctx.workflowRuns.start({
    parent: h.parent,
    ...extra.resume === undefined ? { name } : { resume: extra.resume },
    ...dry?.ok ? { trustHash: dry.trustKey, ...dry.trustChallenge === undefined ? {} : { trustChallenge: dry.trustChallenge } } : {},
    ...extra.inputs === undefined ? {} : { inputs: extra.inputs },
  })
  if (!result.ok) throw new Error(`start refused: ${result.error}: ${result.message}`)
  return result
}

/** A script result for a run whose nodes all succeeded. */
export const COMPLETED = { value: { status: 'completed', nodes: [] }, stopReason: 'completed' as const, agentsStarted: 0 }

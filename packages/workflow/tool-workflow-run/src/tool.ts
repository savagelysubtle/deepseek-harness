/**
 * The model-facing `workflow_run` tool definition: run, dry-run, resume or cancel a YAML workflow
 * through `ctx.workflowRuns`.
 * @module @deepseek-ai/dsh-tool-workflow-run/tool
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.ts'
import { renderOutcome } from './report.ts'
import { renderDiagnostics } from './runner.ts'
import type { StartRefused } from './types.ts'

/** The tool description: this is the whole model-facing contract. */
export const WORKFLOW_RUN_DESCRIPTION = `Run a workflow defined as a YAML file in the workspace workflows directory (default \`.workflows/<name>.yaml\`). A workflow is a graph of nodes (\`prompt\`, \`bash\`, \`loop\`, \`approval\`, \`cancel\`) with dependencies, optional \`when\` conditions, retries, and hard gates (verifier, bash, approval, done_when, until_bash). Use it only when the user asks to run a named workflow, or when a workflow file already exists for the task.

Exactly one of these selects what to do:
- \`name\`: the workflow file name without \`.yaml\` (lowercase words joined by hyphens). \`path\` is an alternative: a workspace-relative path to a \`<name>.yaml\` file inside the workflows directory.
- \`resume\`: a run id. Starts a new run from that run's pinned source and skips nodes that already succeeded with recoverable output. It refuses, with a reason, if a successful node that changes the workspace has no recoverable output, or depends on a node that has none.
- \`cancel\`: a run id owned by this process. Cancels it.

Other arguments: \`inputs\` (object, values for the workflow's declared inputs; unknown or missing required names are rejected before anything runs) and \`dryRun\` (true returns the graph, the gate manifest and every shell command the workflow would run, and starts nothing).

A run is foreground: the call returns when the whole workflow finished. The result is a status line, a node table and a gate report (one row per declared gate: fired-pass, fired-block, skipped, not-reached or never-evaluated). Only one run per workspace may be active; a second start is refused and names the holder. The first run of an unseen or edited workflow asks the user to confirm the shell commands. Approval nodes wait for a human answer (up to the configured cap) and are rejected at once when the session is headless or approvals are disabled, with a reason in the report. The run is pinned to the file content at start, so editing the file during a run changes nothing about that run. Compile or validation errors come back as located \`line:column\` diagnostics: fix the YAML and call again.`

interface Args {
  name?: string
  path?: string
  inputs?: Record<string, unknown>
  dryRun?: boolean
  resume?: string
  cancel?: string
}

/** Render a refusal for the model: message, remedy, holder facts. */
function renderRefusal(refusal: StartRefused): string {
  const lines = [refusal.message]
  if (refusal.holder !== undefined) {
    const h = refusal.holder
    lines.push(`Held by: workflow ${h.workflowName ?? '(unknown)'}, run ${h.runId ?? '(unknown)'}, started ${new Date(h.startedAt).toISOString()}.`)
  }
  if (refusal.remedy !== undefined) lines.push(refusal.remedy)
  return lines.join('\n')
}

/**
 * Register the `workflow_run` tool.
 * @param ctx - the plugin context.
 * @param config - resolved config.
 */
export function registerWorkflowRunTool(ctx: Context, config: ResolvedConfig): void {
  const present = (args: Args): ToolCallView => ({
    card: 'generic',
    title: `${config.toolName}: ${args.cancel !== undefined ? `cancel ${args.cancel}` : args.resume !== undefined ? `resume ${args.resume}` : args.name ?? args.path ?? ''}${args.dryRun === true ? ' (dry run)' : ''}`,
  })
  ctx.tools.register(defineTool({
    name: config.toolName,
    description: WORKFLOW_RUN_DESCRIPTION,
    parameters: {
      name: { type: 'string', description: 'Workflow file name without .yaml (lowercase words joined by hyphens).' },
      path: { type: 'string', description: 'Alternative to name: a workspace-relative path to a <name>.yaml file in the workflows directory.' },
      inputs: { type: 'object', additionalProperties: true, description: "Values for the workflow's declared inputs." },
      dryRun: { type: 'boolean', description: 'Return the graph, gate manifest and shell commands without running anything.' },
      resume: { type: 'string', description: 'A run id to resume from its pinned source, skipping nodes that already succeeded.' },
      cancel: { type: 'string', description: 'A run id owned by this process to cancel.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          text: { type: 'string', required: true },
          runId: { type: 'string' },
          status: { type: 'string' },
          data: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args: Args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${config.toolName} requires a calling agent (exec.agent was undefined)`)
      const selectors = [args.name, args.path, args.resume, args.cancel].filter(v => v !== undefined)
      if (selectors.length !== 1) throw new Error('give exactly one of name, path, resume or cancel')
      const runs = ctx.workflowRuns
      if (args.cancel !== undefined) {
        const result = await runs.cancel(args.cancel, 'cancelled by workflow_run')
        if (!result.found || result.outcome === undefined) {
          throw new Error(`run '${args.cancel.slice(0, 80)}' is not running in this process, so it cannot be cancelled here`)
        }
        return { kind: 'cancel', text: renderOutcome(result.outcome, config.maxResultChars), runId: result.outcome.runId, status: result.outcome.status, data: { status: result.outcome.status } as JsonValue }
      }
      if (args.dryRun === true) {
        if (args.resume !== undefined) throw new Error('dryRun applies to a name or path, not to resume')
        const workspace = await realpath(parent.session.header.cwd ?? process.cwd())
        const plan = await runs.dryRun(workspace, {
          ...args.name === undefined ? {} : { name: args.name },
          ...args.path === undefined ? {} : { path: args.path },
          ...args.inputs === undefined ? {} : { inputs: args.inputs },
        })
        if (!plan.ok) throw new Error(renderRefusal(plan))
        const lines = [
          `workflow "${plan.name}" dry run (hash ${plan.hash.slice(0, 12)}, ${plan.trusted ? 'trusted' : 'not yet trusted: the first real run asks you to confirm'}). Nothing was started.`,
          `Execution order: ${plan.plan.join(' -> ')}`,
          'Gates:',
          ...(plan.manifest.length === 0 ? ['- (none)'] : plan.manifest.map(g => `- ${g.nodeId} [${g.gateKind}]`)),
          'Shell commands it would run:',
          ...(plan.trust.bashCommands.length === 0 ? ['- (none)'] : plan.trust.bashCommands.map(c => `- ${c.nodeId} (${c.field}): ${c.command}`)),
        ]
        if (plan.warnings.length > 0) lines.push('Warnings:', renderDiagnostics(plan.warnings))
        return {
          kind: 'dry-run',
          text: lines.join('\n').slice(0, config.maxResultChars),
          data: {
            name: plan.name, hash: plan.hash, trusted: plan.trusted, graph: plan.graph,
            manifest: plan.manifest, trust: plan.trust, plan: plan.plan,
          } as unknown as JsonValue,
        }
      }
      const started = await runs.start({
        parent,
        ...args.name === undefined ? {} : { name: args.name },
        ...args.path === undefined ? {} : { path: args.path },
        ...args.resume === undefined ? {} : { resume: args.resume },
        ...args.inputs === undefined ? {} : { inputs: args.inputs },
        signal: exec.signal,
      })
      if (!started.ok) throw new Error(renderRefusal(started))
      const outcome = await started.done
      const text = renderOutcome(outcome, config.maxResultChars)
      if (outcome.status !== 'completed') throw new Error(text)
      return {
        kind: started.resumedFrom === undefined ? 'run' : 'resume',
        text,
        runId: outcome.runId,
        status: outcome.status,
        data: { report: outcome.report, nodes: outcome.nodes, hash: outcome.hash } as unknown as JsonValue,
      }
    },
    presentCall: args => present(args),
    presentResult: (): ToolResultView => ({ card: 'generic' }),
  }))
}

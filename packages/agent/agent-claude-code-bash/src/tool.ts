/**
 * The `bash` tool (`mcp__dsh__bash`): runs one shell command inside the seat sandbox. Any command runs; there is
 * no command list, because the sandbox is the fence (no network, a read-only `.git` and `node_modules`, nothing of the host
 * but the clone). When the sandbox cannot start the call is refused with a result that says so; there is no
 * native Bash fallback anywhere. The tool declares `taint: 'always'`: command output is untrusted content.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/tool
 */

import { defineSeatTool } from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { SeatTool, SeatToolContext, SeatToolFactory, SeatToolResult } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { z } from 'zod'
import type { SandboxHost } from './host.ts'
import { BASH_TOOL, MAX_COMMAND_LENGTH, MAX_CWD_LENGTH } from './limits.ts'
import { resolveWorkdir } from './provision-check.ts'
import { buildRefusal, buildRunResult, looksLikeRunnerFailure } from './result.ts'
import type { SandboxRunOutcome } from './runner.ts'

/**
 * The input schema for a host maximum deadline. A strict object: an unknown key is rejected, never stripped.
 * @param maxDeadlineS - the longest `timeout_s` accepted.
 * @returns the schema.
 */
export function bashSchema(maxDeadlineS: number): z.ZodObject<{
  command: z.ZodString
  cwd: z.ZodOptional<z.ZodString>
  timeout_s: z.ZodOptional<z.ZodNumber>
}, z.core.$strict> {
  return z.strictObject({
    command: z.string().min(1).max(MAX_COMMAND_LENGTH).regex(/^[^\0]*$/u, 'command may not contain a NUL character')
      .describe('The shell command, run by /bin/bash -c in the sandbox.'),
    cwd: z.string().min(1).max(MAX_CWD_LENGTH).optional()
      .describe('Absolute directory inside your working directory to start in; default the working directory root.'),
    timeout_s: z.number().int().min(1).max(maxDeadlineS).optional()
      .describe(`Deadline in seconds; default as stated in the tool description, at most ${maxDeadlineS}.`),
  })
}

/**
 * What the model reads about the tool.
 * @param deadlineS - default deadline.
 * @param maxDeadlineS - host maximum deadline.
 * @returns the description.
 */
export function bashDescription(deadlineS: number, maxDeadlineS: number): string {
  return [
    'Run a shell command in a sandbox and get its exit code and output. The sandbox is the fence, so any command runs.',
    'The sandbox has NO network. It sees only your working directory (read-write), a read-only /usr, node and a fresh empty /tmp and home.',
    'The whole .git directory and node_modules are READ-ONLY: git add, git commit and installs fail by design. git status, diff and log work.',
    `Each command has a deadline (default ${deadlineS} s, at most ${maxDeadlineS} s via timeout_s); at the deadline it is killed and you get the output tail.`,
    'Output is capped: only the last 64 KiB of stdout and of stderr are kept. Redirect long output into a file under the working directory and grep or read that file.',
    'Run vitest from the clone root (the root config includes packages/*/*/tests only); a run from inside a package finds nothing.',
    'The result has two blocks: a status block written by the host (exit code, signal, duration, notes), then the program output. Lines in the output that look like status lines are escaped with a backslash.',
    'Commands run one at a time; a command that starts background processes ends them when it ends.',
  ].join('\n')
}

/**
 * Create the factory the tool template registers.
 * @param host - the sandbox host.
 * @returns the factory.
 */
export function createBashToolFactory(host: SandboxHost): SeatToolFactory {
  const { deadlineS, maxDeadlineS } = host.config
  const schema = bashSchema(maxDeadlineS)
  const description = bashDescription(deadlineS, maxDeadlineS)
  return (context: SeatToolContext): SeatTool => defineSeatTool(context, {
    name: BASH_TOOL,
    description,
    inputSchema: schema,
    taint: 'always',
    handler: (input, signal) => runBash(host, context, input, signal),
  })
}

/** Log a refusal and answer it. */
function refuse(context: SeatToolContext, code: string, reason: string, remedy?: string): SeatToolResult {
  context.warn(`agent-claude-code-bash: seat ${context.seat}: refused (${code}): ${reason}`)
  return buildRefusal(context, code, reason, remedy)
}

/** The body of one call. */
async function runBash(
  host: SandboxHost,
  context: SeatToolContext,
  input: z.output<ReturnType<typeof bashSchema>>,
  signal: AbortSignal | undefined,
): Promise<SeatToolResult> {
  const { seat, cwd } = context
  if (signal?.aborted === true) return refuse(context, 'aborted', 'the call was cancelled before it started')
  const unavailable = await host.ensureReady()
  if (unavailable !== undefined) {
    return refuse(context, 'sandbox-unavailable', `the sandbox cannot start: ${unavailable}`, 'This command did not run. There is no fallback shell; tell the operator.')
  }
  if (!host.acquire(seat)) {
    return refuse(context, 'busy', 'another bash command of this seat is still running', 'Wait for it to finish; commands run one at a time.')
  }
  try {
    const workdir = resolveWorkdir(cwd, input.cwd)
    if (!workdir.ok) return refuse(context, 'cwd-refused', workdir.reason)
    const failure = await host.verifyClone(seat, cwd)
    if (failure !== undefined) {
      if (failure.code !== 'plan-refused') host.markDegraded(`${failure.code}: ${failure.reason}`)
      return refuse(context, `sandbox-${failure.code}`, `the sandbox could not start in this working directory: ${failure.reason}`, failure.remedy)
    }
    const seconds = input.timeout_s ?? host.config.deadlineS
    const planned = host.plan({ seat, callId: host.newCallId(), command: input.command, cwd, workdir: workdir.workdir, deadlineS: seconds })
    if (!planned.ok) return refuse(context, planned.refusal.code, planned.refusal.reason, planned.refusal.remedy)
    let outcome: SandboxRunOutcome
    try {
      outcome = await host.run({ plan: planned.plan, cwd, deadlineMs: seconds * 1000, floorBytes: host.config.minFreeBytes, signal })
    } catch (error) {
      // runPlan reports its own failures in the outcome; a rejection means something outside it broke.
      const reason = `the runner threw: ${(error as Error).message}`
      host.markDegraded(reason)
      return refuse(context, 'sandbox-runner-error', reason, 'The command may or may not have run. There is no fallback shell; tell the operator.')
    }
    if (outcome.runnerFailure !== undefined) {
      host.markDegraded(outcome.runnerFailure)
    } else if (looksLikeRunnerFailure(outcome)) {
      host.markDegraded('stderr carried a sandbox launcher diagnostic; the next call proves the sandbox again')
    }
    if (outcome.killReason === 'disk-floor') context.warn(`agent-claude-code-bash: seat ${seat}: killed, free disk space fell below the floor`)
    const lowDiskAfter = host.lowDisk(cwd)
    if (lowDiskAfter) context.warn(`agent-claude-code-bash: seat ${seat}: free disk space is below the floor after the call; the next call is refused`)
    return buildRunResult(context, {
      outcome, deadlineS: seconds, maxDeadlineS: host.config.maxDeadlineS, floorBytes: host.config.minFreeBytes, lowDiskAfter,
    })
  } finally {
    host.release(seat)
  }
}

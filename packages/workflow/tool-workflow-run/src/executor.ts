/**
 * The workflow `bash()` executor backed by the house shell (`ctx.shell`), so every workflow
 * command runs under the same sandbox policy and credential scrub as the model's own bash tool.
 * It is NOT the engine's local executor, which runs with host authority.
 * @module @deepseek-ai/dsh-tool-workflow-run/executor
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { WorkflowBashExecRequest, WorkflowBashExecutor, WorkflowBashResult } from '@deepseek-ai/dsh-workflow'

/** The most stdout the executor asks the shell to keep per command (the sink sees up to this much). */
export const SHELL_CAPTURE_BYTES = 8 * 1024 * 1024

/** What the executor needs from the composition. */
export interface ShellBashExecutorDeps {
  readonly shell: ShellExecutor
  /** Present when a confining executor is mounted; resolves the per-session sandbox policy. */
  readonly sandboxPolicy?: SandboxPolicyService
  /** The session whose sandbox mode and workspace root govern the commands. */
  readonly session: Session
}

/** Keep the last `max` bytes of `text` (cut on a UTF-8 boundary). */
function tailBytes(text: string, max: number): { text: string; clipped: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return { text, clipped: false }
  let start = buf.length - max
  // Skip continuation bytes so the tail starts on a character boundary.
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1
  return { text: buf.subarray(start).toString('utf8'), clipped: true }
}

/** Map the shell's run result onto the engine's bash result shape. */
function toBashResult(result: ShellRunResult, maxOutputBytes: number, durationMs: number): WorkflowBashResult {
  const out = tailBytes(result.stdout.text, maxOutputBytes)
  const err = tailBytes(result.stderr.text, maxOutputBytes)
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdout: out.text,
    stderr: err.text,
    truncated: out.clipped || err.clipped || result.stdout.truncated || result.stderr.truncated,
    stdoutBytes: Buffer.byteLength(result.stdout.text, 'utf8'),
    stderrBytes: Buffer.byteLength(result.stderr.text, 'utf8'),
    durationMs,
  }
}

/**
 * Create the sandboxed executor. Each command is resolved through `ctx.shell.resolve` with the
 * session's sandbox policy and run in the foreground; a zero-length stdout chunk is sent to the
 * output sink first so the sink can tell where a new run of the same node begins.
 * @param deps - the shell, optional sandbox policy service and the owning session.
 * @returns an executor with the engine's `{exitCode, stdout, stderr, timedOut, aborted}` shape and 64 KB tails.
 * @throws when the shell confines but no sandbox policy service is mounted.
 */
export function createShellBashExecutor(deps: ShellBashExecutorDeps): WorkflowBashExecutor {
  if (deps.shell.sandboxMode !== undefined && deps.sandboxPolicy === undefined) {
    throw new Error('workflow_run: the mounted shell executor confines but ctx.sandboxPolicy is missing')
  }
  return {
    async run(request: WorkflowBashExecRequest): Promise<WorkflowBashResult> {
      const started = Date.now()
      const policy = deps.sandboxPolicy?.resolve({ session: deps.session })
      const spec = deps.shell.resolve({
        command: request.command,
        workdir: request.cwd,
        timeoutMs: request.timeoutMs,
        stdoutMaxBytes: SHELL_CAPTURE_BYTES,
        signal: request.signal,
        env: { ...request.env },
        ...policy === undefined ? {} : { sandboxPolicy: policy },
      })
      request.onOutput?.('stdout', new Uint8Array(0))
      const result = await deps.shell.run(spec)
      if (request.onOutput !== undefined) {
        if (result.stdout.text.length > 0) request.onOutput('stdout', Buffer.from(result.stdout.text, 'utf8'))
        if (result.stderr.text.length > 0) request.onOutput('stderr', Buffer.from(result.stderr.text, 'utf8'))
      }
      return toBashResult(result, request.maxOutputBytes, Date.now() - started)
    },
  }
}

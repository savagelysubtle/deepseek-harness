/**
 * The built-in local {@link WorkflowBashExecutor}: `bash -c <command>` in its own process group,
 * the whole group tree-killed on abort or timeout, stdout and stderr each capped in memory at
 * {@link WORKFLOW_BASH_OUTPUT_CAP_BYTES} (tail kept, `truncated` flagged) while every chunk is
 * also handed to the caller's `onOutput` sink so it can spill what the cap dropped.
 *
 * It starts from the same credential scrub as the repository's subprocess helper
 * (credential-shaped names and every `DSH_*` name removed) so a workflow command never inherits
 * the harness's secrets. The dependency-free copy exists because this seam package may not
 * depend on the subprocess package; an owner that wants the sandboxed executor injects its own
 * through `WorkflowStartRequest.bashExecutor`.
 * @module @deepseek-ai/dsh-workflow
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { WorkflowBashExecRequest, WorkflowBashExecutor } from './runtime-types.ts'
import type { WorkflowBashResult } from './types.ts'

/** Credential-shaped environment names are never inherited (same heuristic as the subprocess helper). */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Options for {@link createLocalBashExecutor}. */
export interface LocalBashExecutorOptions {
  /** The shell program (default `bash`, found on the scrubbed PATH). */
  shell?: string
  /** Milliseconds between SIGTERM and SIGKILL on abort/timeout (default 2000). */
  killGraceMs?: number
  /** Milliseconds a closed process may keep inherited pipes open before they are cut (default 1000). */
  drainMs?: number
}

/** The ambient environment minus credential-shaped and `DSH_*` names. */
function scrubbedBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith('DSH_')) env[key] = value
  }
  return env
}

/** Tail-keeping byte collector: memory never exceeds roughly twice the cap. */
class TailBuffer {
  private chunks: Buffer[] = []
  private held = 0
  total = 0

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length
    this.chunks.push(chunk)
    this.held += chunk.length
    let first = this.chunks[0]
    while (first !== undefined && this.chunks.length > 1 && this.held - first.length >= this.cap) {
      this.held -= first.length
      this.chunks.shift()
      first = this.chunks[0]
    }
  }

  get truncated(): boolean {
    return this.total > this.cap
  }

  text(): string {
    const all = Buffer.concat(this.chunks)
    let start = Math.max(0, all.length - this.cap)
    // Do not begin mid-codepoint: skip UTF-8 continuation bytes of a character the cut split.
    if (start > 0) while (start < all.length && ((all[start] ?? 0) & 0xC0) === 0x80) start += 1
    return all.subarray(start).toString('utf8')
  }
}

/** Signal the whole process group (POSIX) or the process tree (Windows). */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => { /* best effort */ })
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    // ESRCH: the group already exited. Fall back to the lone child in case it never led a group.
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/**
 * Build the local executor.
 * @param options - shell program and kill/drain timings.
 * @returns an executor whose `run` rejects only for spawn-level failures.
 */
export function createLocalBashExecutor(options: LocalBashExecutorOptions = {}): WorkflowBashExecutor {
  const shell = options.shell ?? 'bash'
  const killGraceMs = options.killGraceMs ?? 2000
  const drainMs = options.drainMs ?? 1000
  return {
    run(request: WorkflowBashExecRequest): Promise<WorkflowBashResult> {
      const started = Date.now()
      const finishedResult = (partial: Partial<WorkflowBashResult>): WorkflowBashResult => ({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: '',
        truncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        durationMs: Date.now() - started,
        ...partial,
      })
      if (request.signal.aborted) return Promise.resolve(finishedResult({ aborted: true }))
      return new Promise<WorkflowBashResult>((resolve, reject) => {
        const child = spawn(shell, ['-c', request.command], {
          cwd: request.cwd,
          env: { ...scrubbedBaseEnv(), ...request.env },
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        const out = new TailBuffer(request.maxOutputBytes)
        const err = new TailBuffer(request.maxOutputBytes)
        let timedOut = false
        let aborted = false
        let settled = false
        let forced = false
        let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
        let escalation: NodeJS.Timeout | undefined
        let drain: NodeJS.Timeout | undefined

        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          clearTimeout(escalation)
          clearTimeout(drain)
          request.signal.removeEventListener('abort', onAbort)
          // After an abort, timeout or forced pipe cut, nothing in the group may survive. A command
          // that exited normally leaves any deliberately backgrounded descendant alone.
          if (aborted || timedOut || forced) killTree(child, 'SIGKILL')
          resolve(finishedResult({
            exitCode: exited?.code ?? null,
            signal: exited?.signal ?? null,
            timedOut,
            aborted,
            stdout: out.text(),
            stderr: err.text(),
            truncated: out.truncated || err.truncated,
            stdoutBytes: out.total,
            stderrBytes: err.total,
          }))
        }
        const terminate = (): void => {
          killTree(child, 'SIGTERM')
          escalation = setTimeout(() => { killTree(child, 'SIGKILL') }, killGraceMs)
          escalation.unref()
        }
        const onAbort = (): void => {
          if (settled || aborted) return
          aborted = true
          terminate()
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
        const timeout = setTimeout(() => {
          if (settled || timedOut) return
          timedOut = true
          terminate()
        }, request.timeoutMs)
        timeout.unref()

        child.stdout.on('data', (chunk: Buffer) => { out.push(chunk); request.onOutput?.('stdout', chunk) })
        child.stderr.on('data', (chunk: Buffer) => { err.push(chunk); request.onOutput?.('stderr', chunk) })
        child.once('error', (error) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          clearTimeout(escalation)
          request.signal.removeEventListener('abort', onAbort)
          reject(error)
        })
        child.once('exit', (code, signal) => {
          exited = { code, signal }
          // An inherited pipe held by a surviving descendant must not hold the result open forever.
          drain = setTimeout(() => {
            forced = true
            child.stdout.destroy()
            child.stderr.destroy()
            finish()
          }, drainMs)
          drain.unref()
        })
        child.once('close', () => { finish() })
      })
    },
  }
}

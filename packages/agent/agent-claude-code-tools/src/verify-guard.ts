/**
 * Proof that a generated hook command really runs and really denies: execute the exact command with
 * a payload the policy must refuse and require exit code 2 with the guard's own reason. The sync form
 * runs before a seat's first query; the async form and {@link assertProbeOutcome} are shared with the
 * boot probe (`guard-probe`) so both judge an outcome by the same rules. Every unexpected outcome
 * fails closed: only the exact expected exit code, an empty or matching stderr and no spawn error,
 * signal or timeout counts as a pass.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/verify-guard
 */

import { spawn, spawnSync } from 'node:child_process'

/** Tool name no policy grants; the guard's "not granted" reason proves the policy file loaded too. */
export const PROBE_TOOL = '__seat_guard_probe__'

/** Longest stderr or stdout kept from a hook run; the guard prints one short line. */
const MAX_STDERR = 4096

/** How long a run may keep waiting for its pipes to close after the process itself exited, in milliseconds. */
const EXIT_GRACE_MS = 300

/** Default timeout of one hook run, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000

/** Why a hook run did not match what was expected; the boot probe maps these onto its result codes. */
export type ProbeFailureCode = 'spawn' | 'timeout' | 'exit' | 'reason'

/** Thrown by {@link assertProbeOutcome} and the verifiers; `code` says which rule failed. */
export class ProbeOutcomeError extends Error {
  /** @param code which rule failed. @param message what happened, naming the exit code and a stderr excerpt. */
  constructor(readonly code: ProbeFailureCode, message: string) {
    super(message)
    this.name = 'ProbeOutcomeError'
  }
}

/** What one hook run produced. */
export interface HookProbeOutcome {
  /** Exit status, or null when the process did not exit normally. */
  readonly status: number | null
  /** Terminating signal, or null. */
  readonly signal: NodeJS.Signals | null
  /** Captured stderr (capped). */
  readonly stderr: string
  /** Captured stdout (capped); a granted call must leave it empty. */
  readonly stdout: string
  /** Set when the process could not be started (ENOENT, EACCES) or the run was aborted. */
  readonly error?: Error | undefined
  /** True when the run was killed for exceeding its timeout. */
  readonly timedOut?: boolean
}

/** What a hook run must have produced. */
export interface ProbeExpectation {
  /** `deny` is exit 2 with `seat-guard: denied: ` plus every `reasons` fragment; `allow` is exit 0 with empty stderr. */
  readonly kind: 'deny' | 'allow'
  /** Fragments the denial text must contain (deny only). */
  readonly reasons?: readonly string[]
}

/**
 * Judge one hook run. Passes only on the exact expected outcome.
 * @param outcome - what the run produced.
 * @param expected - what it had to produce.
 * @throws {ProbeOutcomeError} `spawn` when it could not start, `timeout` when it was killed for time, `exit` on any other exit
 *   code or signal, `reason` when a denial does not carry the guard's own text or an allow wrote to stderr.
 */
export function assertProbeOutcome(outcome: HookProbeOutcome, expected: ProbeExpectation): void {
  const excerpt = outcome.stderr.slice(0, 200)
  if (outcome.timedOut === true) throw new ProbeOutcomeError('timeout', 'agent-claude-code-tools: the seat guard probe timed out')
  if (outcome.error !== undefined) {
    throw new ProbeOutcomeError('spawn', `agent-claude-code-tools: the seat guard probe could not run (${outcome.error.message})`)
  }
  const want = expected.kind === 'deny' ? 2 : 0
  if (outcome.signal !== null || outcome.status !== want) {
    const what = expected.kind === 'deny' ? 'did not deny the probe' : 'did not allow the granted control'
    throw new ProbeOutcomeError('exit', `agent-claude-code-tools: the seat guard ${what} (exit ${String(outcome.status)}): ${excerpt}`)
  }
  if (expected.kind === 'allow') {
    if (outcome.stderr !== '' || outcome.stdout !== '') {
      throw new ProbeOutcomeError('reason', `agent-claude-code-tools: the seat guard wrote output on a granted control: ${excerpt}${outcome.stdout.slice(0, 200)}`)
    }
    return
  }
  if (!outcome.stderr.startsWith('seat-guard: denied: ') || !(expected.reasons ?? []).every(reason => outcome.stderr.includes(reason))) {
    throw new ProbeOutcomeError('reason', `agent-claude-code-tools: the seat guard denied the probe for the wrong reason: ${excerpt}`)
  }
}

/** The denial text the unknown probe tool must produce. */
const PROBE_DENIAL: ProbeExpectation = { kind: 'deny', reasons: [`tool ${PROBE_TOOL} is not granted`] }

/** The hook payload of the unknown probe tool. */
const PROBE_PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: PROBE_TOOL, tool_input: {} })

/**
 * Run the hook command with a known-denied payload. Call it before a seat's first query (and from the
 * boot canary): a guard that cannot start would otherwise fail open, because only exit code 2 blocks.
 * @param command - the exact string from `buildHookCommand` (run through `sh -c`).
 * @param timeoutMs - kill the run after this many milliseconds; default 15000.
 * @throws {ProbeOutcomeError} when the command does not exit 2 with the `seat-guard: denied` prefix and the not-granted reason.
 */
export function verifyGuardCommand(command: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): void {
  const result = spawnSync('/bin/sh', ['-c', command], {
    input: PROBE_PAYLOAD,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] },
    timeout: timeoutMs,
  })
  // A stdin write error (EPIPE) after the process already exited is not a failure to run; only a process that
  // did not exit (status null: timeout, buffer overflow, spawn failure) carries its error into the outcome.
  const error = result.status === null ? result.error : undefined
  const outcome: HookProbeOutcome = {
    status: result.status,
    signal: result.signal,
    stderr: result.stderr,
    stdout: result.stdout,
    error,
    timedOut: error?.message.endsWith('ETIMEDOUT') === true,
  }
  assertProbeOutcome(outcome, PROBE_DENIAL)
}

/** Options of {@link runGuardHook}. */
export interface GuardHookRunOptions {
  /** Kill the run after this many milliseconds; default 15000. */
  readonly timeoutMs?: number
  /** Abort the run; the outcome then carries the abort as its `error`. */
  readonly signal?: AbortSignal
  /** Working directory of the hook process; default the host's. The probe passes its scratch cwd, as the CLI does. */
  readonly cwd?: string
  /** The shell to run the command with; default `/bin/sh`. Tests point it at a missing or unusable file. */
  readonly shell?: string
}

/**
 * Run a hook command asynchronously through `sh -c` with the given payload on stdin and a minimal
 * environment. Never rejects: every failure comes back inside the outcome.
 * @param command - the exact hook command line.
 * @param payload - the JSON text to write to stdin.
 * @param options - timeout, abort signal and shell.
 * @returns the outcome to hand to {@link assertProbeOutcome}.
 */
export function runGuardHook(command: string, payload: string, options: GuardHookRunOptions = {}): Promise<HookProbeOutcome> {
  return new Promise((resolve) => {
    let stderr = ''
    let stdout = ''
    let timedOut = false
    let settled = false
    let grace: NodeJS.Timeout | undefined
    // Own process group, so a timeout, an abort or the exit of the shell takes down every descendant that could
    // otherwise keep the pipes open.
    const child = spawn(options.shell ?? '/bin/sh', ['-c', command], {
      env: { PATH: process.env['PATH'] },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
    })
    const killGroup = (): void => {
      try {
        // pid is undefined when the spawn failed, which makes this throw before anything is signalled.
        process.kill(-(child.pid as number), 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const onAbort = (): void => { killGroup() }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) onAbort()
    const finish = (outcome: HookProbeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(outcome)
    }
    const outcomeOf = (status: number | null, signal: NodeJS.Signals | null): HookProbeOutcome => ({
      status,
      signal,
      stderr,
      stdout,
      ...options.signal?.aborted === true ? { error: new Error('aborted') } : {},
      ...timedOut ? { timedOut: true } : {},
    })
    child.stderr.setEncoding('utf8')
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, MAX_STDERR) })
    child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(0, MAX_STDERR) })
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => { finish({ status: null, signal: null, stderr, stdout, error }) })
    // The process exited: kill leftovers in its group, give the pipes a moment to drain, then settle regardless,
    // so an escaped descendant holding a pipe cannot hang the probe.
    child.on('exit', (status, signal) => {
      killGroup()
      grace = setTimeout(() => { finish(outcomeOf(status, signal)) }, EXIT_GRACE_MS)
    })
    child.on('close', (status, signal) => { finish(outcomeOf(status, signal)) })
    child.stdin.end(payload)
  })
}

/**
 * Async form of {@link verifyGuardCommand}: same payload and judgement, no blocking of the event loop.
 * @param command - the exact hook command line.
 * @param options - timeout, abort signal and shell.
 * @throws {ProbeOutcomeError} on any outcome other than the guard's own denial of the unknown probe tool.
 */
export async function verifyGuardCommandAsync(command: string, options: GuardHookRunOptions = {}): Promise<void> {
  assertProbeOutcome(await runGuardHook(command, PROBE_PAYLOAD, options), PROBE_DENIAL)
}

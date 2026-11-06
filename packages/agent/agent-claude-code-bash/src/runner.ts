/**
 * The runner: starts one planned seat launch through the subprocess seam, watches it, and always ends it
 * through the one stop path. The launch is `systemd-run --user --scope ... bwrap ...`, so the leader is bwrap
 * (its own pid namespace); a scope does NOT kill its members when the leader dies, so after the process has
 * ended for any reason (exit, deadline, abort, disk floor) the runner stops the unit and reads the result
 * from the cgroup directory: the call succeeds only when that directory is gone.
 *
 * Why the main thread: `--die-with-parent` is PDEATHSIG, which the kernel fires when the parent THREAD
 * exits, not the process. The plugin mounts on the host's main thread and every spawn happens there; a worker
 * thread that spawned a sandbox and then ended would kill it mid-command.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/runner
 */

import { existsSync, readFileSync, statfsSync } from 'node:fs'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { oneLine } from './sanitize.ts'
import { classifyScopeStop } from '@deepseek-ai/dsh-sandbox-local'
import type { ScopeStopOutcome, SeatLaunchPlan } from '@deepseek-ai/dsh-sandbox-local'
import {
  CGROUP_GONE_WAIT_MS, CGROUP_POLL_MS, REAP_WAIT_MS, SPAWN_GRACE_MS, STOP_TIMEOUT_MS, TAIL_BYTES, WATCHDOG_INTERVAL_MS,
} from './limits.ts'

/** Why the runner ended a call before the command finished by itself. */
type KillReason = 'deadline' | 'abort' | 'disk-floor'

/** What one output stream held at the end. */
interface StreamTail {
  /** The last bytes of the stream, decoded as UTF-8. */
  readonly text: string
  /** True when earlier bytes were discarded. */
  readonly truncated: boolean
}

/** The facts of one finished (or never started) run. */
export interface SandboxRunOutcome {
  /** Exit code of the launch; `null` when it died from a signal or never started. */
  readonly exitCode: number | null
  /** Terminating signal; `null` on a normal exit or when never started. */
  readonly signal: NodeJS.Signals | null
  /** Set when the runner ended the call. */
  readonly killReason?: KillReason
  /** True when the launch never started (aborted before the spawn). */
  readonly notStarted: boolean
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs: number
  /** Tail of stdout. */
  readonly stdout: StreamTail
  /** Tail of stderr. */
  readonly stderr: StreamTail
  /** How the scope stop ended; `undefined` when no scope was started. */
  readonly stop?: ScopeStopOutcome
  /**
   * Set when the runner could not prove the sandbox gone or could not start it (spawn failure, unreachable
   * bus, a cgroup directory that survived the stop, a process that would not die). The host refuses every call
   * until a preflight passes again.
   */
  readonly runnerFailure?: string
}

/** One run's inputs. */
export interface RunRequest {
  /** The launch plan from the profile builder. */
  readonly plan: SeatLaunchPlan
  /** Directory the host process starts the launch in (the clone root). */
  readonly cwd: string
  /** Wall-clock deadline in milliseconds. */
  readonly deadlineMs: number
  /** Free bytes the clone's filesystem must keep; the watchdog kills the run below it. */
  readonly floorBytes: number
  /** The MCP call's abort signal. */
  readonly signal?: AbortSignal | undefined
}

/** Everything the runner touches outside itself; fakes stand in for it in tests. */
export interface RunnerDeps {
  /** Start a managed process. */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** SIGKILL the process group led by `pid`. */
  killGroup: (pid: number) => void
  /** Free bytes available to the user on the filesystem holding `path`. */
  freeBytes: (path: string) => number
  /** Whether a path exists. */
  exists: (path: string) => boolean
  /** Contents of `cgroup.procs`; empty when missing. */
  readProcs: (path: string) => string
  /** Whether the launch leader `pid` still exists (a signal-0 probe). */
  leaderAlive: (pid: number) => boolean
  /** Names of the host process's environment variables (they are tombstoned in the child). */
  hostEnvNames: () => string[]
  /** Monotonic milliseconds. */
  now: () => number
  /** Resolve after `ms`, or as soon as `signal` aborts (the timer is then cleared). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Host-side warning sink. */
  warn: (message: string) => void
}

/**
 * The child environment: exactly `spawnEnv`. The subprocess seam merges explicit entries onto a scrubbed copy of the
 * host environment, so every host variable `spawnEnv` does not set is removed with a tombstone.
 * @param spawnEnv - the plan's launch environment (`XDG_RUNTIME_DIR` and `PATH`).
 * @param hostNames - names in the host environment.
 * @returns the environment object for the spawn spec.
 */
export function exactEnv(spawnEnv: Readonly<Record<string, string>>, hostNames: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of hostNames) env[name] = undefined
  return { ...env, ...spawnEnv }
}

/**
 * Free bytes on the filesystem holding `path`, available to an unprivileged user.
 * @param path - any path on the filesystem.
 * @returns bytes.
 */
export function freeBytesOf(path: string): number {
  const stats = statfsSync(path)
  return stats.bavail * stats.bsize
}

/**
 * Production dependencies over the subprocess seam.
 * @param spawn - `ctx.subprocess.spawn`, bound.
 * @param warn - host-side warning sink.
 * @returns the dependencies.
 */
export function realRunnerDeps(spawn: RunnerDeps['spawn'], warn: (message: string) => void): RunnerDeps {
  return {
    spawn,
    killGroup: (pid) => {
      // pid -1 would signal pid 1 and pid 1 would signal every process: only a real child's group is ever signalled.
      if (!(pid > 1)) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (error) {
        // ESRCH: the group is already gone, which is the goal.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    },
    leaderAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
      }
    },
    freeBytes: freeBytesOf,
    exists: existsSync,
    readProcs: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    },
    hostEnvNames: () => Object.keys(process.env),
    now: () => performance.now(),
    sleep: sleepMs,
    warn,
  }
}

/**
 * A cancellable sleep.
 * @param ms - delay.
 * @param signal - aborting it ends the sleep early.
 * @returns a promise that resolves after `ms` or at the abort.
 */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** Resolve with the value when `promise` settles within `ms`, otherwise with `undefined`; the timer never outlives the call. */
async function within<T>(promise: Promise<T>, ms: number, deps: RunnerDeps): Promise<T | undefined> {
  const cancel = new AbortController()
  try {
    return await Promise.race([promise, deps.sleep(ms, cancel.signal).then(() => undefined)])
  } finally {
    cancel.abort()
  }
}

/** Read one collected stream; a missing reader is an empty stream. */
function tailOf(handle: SubprocessHandle | undefined, stream: 'stdout' | 'stderr'): StreamTail {
  const read = handle?.collected[stream]?.readFrom(0)
  return read === undefined ? { text: '', truncated: false } : { text: read.text, truncated: read.lossy }
}

/** How a short helper command ended. */
export interface ExecResult {
  /** Exit code; `null` when the command did not finish, was killed, or could not be spawned. */
  readonly exitCode: number | null
  /** Why `exitCode` is `null`, when it is. */
  readonly problem?: string
}

/**
 * Run a short helper command (`systemctl ...`) to its exit with exactly the launch environment.
 * @param argv - the command.
 * @param spawnEnv - the environment it gets, and nothing else.
 * @param deps - runner dependencies.
 * @param timeoutMs - how long to wait before terminating it.
 * @returns the exit code, or why there is none.
 */
export async function execToExit(
  argv: readonly string[],
  spawnEnv: Readonly<Record<string, string>>,
  deps: RunnerDeps,
  timeoutMs: number,
): Promise<ExecResult> {
  try {
    const handle = deps.spawn({
      argv,
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: SPAWN_GRACE_MS,
      env: exactEnv(spawnEnv, deps.hostEnvNames()),
    })
    const outcome = await within(handle.done, timeoutMs, deps)
    if (outcome !== undefined) return { exitCode: outcome.exitCode }
    handle.terminate()
    return { exitCode: null, problem: `${argv[0]} did not finish within ${timeoutMs} ms` }
  } catch (error) {
    return { exitCode: null, problem: `${argv[0]} could not run: ${oneLine((error as Error).message)}` }
  }
}

/** A finished stop. */
interface StopResult {
  readonly outcome: ScopeStopOutcome
  readonly detail: string | undefined
}

/** How many processes the scope's cgroup still holds, in words; an unreadable `cgroup.procs` is described, not thrown. */
function processCount(plan: SeatLaunchPlan, deps: RunnerDeps): string {
  try {
    return `${deps.readProcs(plan.cgroupProcsPath).split('\n').filter(line => line.trim() !== '').length} process(es)`
  } catch (error) {
    return `an unreadable process list (${oneLine((error as Error).message)})`
  }
}

/**
 * Stop the scope unit and judge the result: success only when the cgroup directory is gone afterwards.
 * @param plan - the launch plan (its `stopArgv`, `cgroupDir` and `cgroupProcsPath`).
 * @param deps - runner dependencies.
 * @returns the classification, plus a description when it is not a clean stop.
 */
async function stopScope(plan: SeatLaunchPlan, deps: RunnerDeps): Promise<StopResult> {
  const stopped = await execToExit(plan.stopArgv, plan.spawnEnv, deps, STOP_TIMEOUT_MS)
  let gone = !deps.exists(plan.cgroupDir)
  for (let waited = 0; !gone && stopped.exitCode === 0 && waited < CGROUP_GONE_WAIT_MS; waited += CGROUP_POLL_MS) {
    await deps.sleep(CGROUP_POLL_MS)
    gone = !deps.exists(plan.cgroupDir)
  }
  const outcome = classifyScopeStop(stopped.exitCode, gone)
  if (outcome === 'stopped' || outcome === 'absent') return { outcome, detail: undefined }
  const prefix = stopped.problem === undefined ? '' : `${stopped.problem}; `
  if (outcome === 'environment-failure') {
    return { outcome, detail: `${prefix}the user systemd bus was unreachable, so the state of the scope ${plan.unit} is unknown` }
  }
  const code = stopped.exitCode === null ? 'no exit code' : `exit ${stopped.exitCode}`
  const state = gone ? 'gone' : `still present with ${processCount(plan, deps)}`
  return { outcome, detail: `${prefix}the stop of ${plan.unit} did not end cleanly (${code}; its cgroup is ${state})` }
}

/** The body of {@link runPlan}; it may throw on a dependency failure the wrapper turns into a runner failure. */
async function execute(request: RunRequest, deps: RunnerDeps, launched: { started: boolean }): Promise<SandboxRunOutcome> {
  const { plan, signal } = request
  const started = deps.now()
  const none: StreamTail = { text: '', truncated: false }
  // A function, so the second check below is not narrowed away: the signal can fire at any time.
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) {
    return { exitCode: null, signal: null, killReason: 'abort', notStarted: true, durationMs: 0, stdout: none, stderr: none }
  }

  let handle: SubprocessHandle | undefined
  let runnerFailure: string | undefined
  let killReason: KillReason | undefined
  let exit: { exitCode: number | null; signal: NodeJS.Signals | null } = { exitCode: null, signal: null }

  try {
    handle = deps.spawn({
      argv: plan.argv,
      cwd: request.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: TAIL_BYTES }, stderr: { maxBytes: TAIL_BYTES } },
      graceMs: SPAWN_GRACE_MS,
      env: exactEnv(plan.spawnEnv, deps.hostEnvNames()),
    })
    launched.started = true
  } catch (error) {
    runnerFailure = `the launch could not be spawned: ${oneLine((error as Error).message)}`
  }

  if (handle !== undefined) {
    const live = handle
    const cancel = new AbortController()
    let startReap!: () => void
    const stuck = new Promise<'stuck'>((resolve) => {
      startReap = () => { void deps.sleep(REAP_WAIT_MS, cancel.signal).then(() => { resolve('stuck') }) }
    })
    const kill = (reason: KillReason): void => {
      if (killReason !== undefined) return
      if (!(live.pid > 1)) {
        // A failed spawn reports pid -1; signalling that (or pid 1) would hit unrelated processes.
        killReason = reason
        runnerFailure ??= `the launch has no valid process id (${live.pid}), so it cannot be signalled`
        startReap()
        return
      }
      // The leader already exited on its own and only the pipes are still draining: nothing to kill, and the
      // process group id may belong to someone else by now. The scope stop below removes any stragglers.
      if (!deps.leaderAlive(live.pid)) return
      killReason = reason
      try {
        deps.killGroup(live.pid)
      } catch (error) {
        runnerFailure ??= `could not kill the process group of pid ${live.pid}: ${oneLine((error as Error).message)}`
      }
      startReap()
    }
    const onAbort = (): void => { kill('abort') }
    const deadline = setTimeout(() => { kill('deadline') }, request.deadlineMs)
    const watchdog = setInterval(() => {
      let low: boolean
      try {
        low = deps.freeBytes(request.cwd) < request.floorBytes
      } catch (error) {
        deps.warn(`agent-claude-code-bash: cannot sample free space of ${request.cwd}: ${oneLine((error as Error).message)}`)
        low = true
      }
      if (low) kill('disk-floor')
    }, WATCHDOG_INTERVAL_MS)
    // The abort may have fired between the caller's check and the spawn: check again now that the process exists.
    if (aborted()) kill('abort')
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const settled = await Promise.race([live.done, stuck])
      if (settled === 'stuck') runnerFailure ??= `pid ${live.pid} did not exit within ${REAP_WAIT_MS} ms of SIGKILL`
      else exit = settled
    } catch (error) {
      runnerFailure ??= `the launch failed at the spawn level: ${oneLine((error as Error).message)}`
    } finally {
      clearTimeout(deadline)
      clearInterval(watchdog)
      cancel.abort()
      signal?.removeEventListener('abort', onAbort)
    }
  }

  let stop: ScopeStopOutcome | undefined
  if (handle !== undefined) {
    const stopped = await stopScope(plan, deps)
    stop = stopped.outcome
    if (stopped.detail !== undefined) runnerFailure ??= stopped.detail
  }
  return {
    exitCode: exit.exitCode,
    signal: exit.signal,
    notStarted: handle === undefined,
    durationMs: Math.round(deps.now() - started),
    stdout: tailOf(handle, 'stdout'),
    stderr: tailOf(handle, 'stderr'),
    ...killReason === undefined ? {} : { killReason },
    ...stop === undefined ? {} : { stop },
    ...runnerFailure === undefined ? {} : { runnerFailure },
  }
}

/**
 * Run one planned launch to the end. The returned promise never rejects: a failure of the runner's own
 * dependencies (an unreadable cgroup, a clock that throws) becomes a `runnerFailure` of the outcome, which
 * degrades the host.
 * @param request - plan, directory, deadline, free-space floor and abort signal.
 * @param deps - runner dependencies.
 * @returns the facts of the run; `runnerFailure` is set when the sandbox could not be proven gone.
 */
export async function runPlan(request: RunRequest, deps: RunnerDeps): Promise<SandboxRunOutcome> {
  const launched = { started: false }
  try {
    return await execute(request, deps, launched)
  } catch (error) {
    const none: StreamTail = { text: '', truncated: false }
    let failure = `the runner failed while running the launch: ${oneLine((error as Error).message)}`
    // The launch exists: stop its scope anyway, best effort, so a runner fault never leaves a sandbox running.
    if (launched.started) {
      try {
        const stopped = await stopScope(request.plan, deps)
        if (stopped.detail !== undefined) failure += `; ${stopped.detail}`
      } catch (stopError) {
        failure += `; the scope ${request.plan.unit} could not be stopped either: ${oneLine((stopError as Error).message)}`
      }
    }
    return { exitCode: null, signal: null, notStarted: false, durationMs: 0, stdout: none, stderr: none, runnerFailure: failure }
  }
}

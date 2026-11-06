/**
 * The sandbox host: the state shared by every call of every seat. It owns the preflight verdict, the
 * `degraded` flag that refuses every call until a preflight passes again, the per-seat busy flag, the clones
 * already re-tested with their real directory, and the environment fingerprint that makes the preflight run
 * again when bwrap, the kernel or the user-namespace sysctls change. There is no native Bash fallback anywhere:
 * when this host is not healthy, the tool refuses.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/host
 */

import { randomBytes } from 'node:crypto'
import type { SeatBwrapIdentity, SeatLaunchResult, SeatProfileSpec } from '@deepseek-ai/dsh-sandbox-local'
import { baseSpec } from './config.ts'
import type { CallFields, ResolvedConfig } from './config.ts'
import { RECHECK_MS } from './limits.ts'
import { oneLine } from './sanitize.ts'
import { fingerprintOf, probeLaunch, runPreflight } from './preflight.ts'
import type { PreflightDeps, PreflightFailure, PreflightResult } from './preflight.ts'
import { runPlan } from './runner.ts'
import type { SandboxRunOutcome, RunRequest } from './runner.ts'

/** An error's message on one line. */
const errorText = (error: unknown): string => oneLine(error instanceof Error ? error.message : String(error))

/** A preflight dependency threw: the same typed failure as any other, so the model gets a refusal block. */
function failureOf(error: unknown): PreflightResult {
  return {
    ok: false,
    failure: {
      code: 'preflight-error',
      reason: `the sandbox check could not complete: ${errorText(error)}`,
      remedy: 'fix the host condition named above (disk space, /proc access) and the next call checks again',
    },
  }
}

/** The shared state of the sandbox. */
export class SandboxHost {
  private bwrap: SeatBwrapIdentity | undefined
  private fingerprint: string | undefined
  private reason: string | undefined
  private lastFailureAt: number | undefined
  private pending: Promise<void> | undefined
  private unloaded = false
  /** Aborted at unload so no call outlives the plugin. */
  private readonly lifetime = new AbortController()
  private readonly busy = new Set<string>()
  private readonly verified = new Set<string>()

  constructor(
    readonly config: ResolvedConfig,
    private readonly deps: PreflightDeps,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Run the first preflight (at mount).
   * @returns the preflight result; the host is healthy exactly when it is `ok`.
   */
  async start(): Promise<PreflightResult> {
    const result = await this.preflight()
    this.apply(result)
    return result
  }

  /** Run the preflight; a dependency that throws (an unreadable sysctl, a full disk) becomes a typed failure. */
  private async preflight(): Promise<PreflightResult> {
    try {
      return await runPreflight(this.config, this.deps)
    } catch (error) {
      return failureOf(error)
    }
  }

  /** Record a preflight result. */
  private apply(result: PreflightResult): void {
    if (result.ok) {
      this.bwrap = result.bwrap
      this.fingerprint = result.fingerprint
      this.reason = undefined
      this.lastFailureAt = undefined
      // The environment is proven again; clones are re-tested against it.
      this.verified.clear()
      return
    }
    this.reason = `${result.failure.code}: ${result.failure.reason} (${result.failure.remedy})`
    this.lastFailureAt = this.deps.runner.now()
    this.warn(`agent-claude-code-bash: sandbox preflight failed, bash calls are refused: ${this.reason}`)
  }

  /**
   * Make sure the sandbox is proven healthy right now: runs the preflight again when the host is degraded or the
   * environment fingerprint changed. A failed preflight is not repeated for {@link RECHECK_MS}.
   * @returns undefined when calls may run, otherwise the reason they are refused.
   */
  async ensureReady(): Promise<string | undefined> {
    if (this.unloaded) return 'the sandbox plugin was unloaded'
    const recently = (): boolean => this.lastFailureAt !== undefined && this.deps.runner.now() - this.lastFailureAt < RECHECK_MS
    let changed: boolean
    try {
      changed = this.fingerprint !== fingerprintOf(this.deps.attest(this.config.bwrapPath), this.deps)
    } catch (error) {
      // Recorded like any failed preflight (reason, time, warning) and not repeated inside the recheck window.
      if (!recently()) this.apply(failureOf(error))
      return this.reason
    }
    if (this.reason === undefined && !changed) return undefined
    if (this.pending === undefined && !recently()) {
      this.pending = this.preflight()
        .then((result) => { this.apply(result) })
        .finally(() => { this.pending = undefined })
    }
    await this.pending
    return this.reason
  }

  /**
   * Refuse every call until a preflight passes again.
   * @param reason - why, for the refusal text and the log.
   */
  markDegraded(reason: string): void {
    this.reason ??= reason
    this.warn(`agent-claude-code-bash: sandbox marked degraded, calls are refused until a preflight passes: ${reason}`)
  }

  /**
   * Permanently refuse calls (the plugin was unloaded; the registries cannot unregister the tool) and abort every
   * call that is running, so the stop ladder ends its sandbox before the subprocess service goes away.
   */
  unload(): void {
    this.unloaded = true
    this.lifetime.abort()
  }

  /**
   * Take the seat's busy flag: one call at a time per seat.
   * @param seat - the seat.
   * @returns false when the seat already has a call running.
   */
  acquire(seat: string): boolean {
    if (this.busy.has(seat)) return false
    this.busy.add(seat)
    return true
  }

  /**
   * Clear the seat's busy flag.
   * @param seat - the seat.
   */
  release(seat: string): void {
    this.busy.delete(seat)
  }

  /**
   * Re-test the launch with a clone's real directory once per verdict (the preflight ran in a throwaway clone).
   * @param seat - the seat, for the unit name.
   * @param cwd - the clone root.
   * @returns undefined when the clone is known good (or was just proven), otherwise the failure.
   */
  async verifyClone(seat: string, cwd: string): Promise<PreflightFailure | undefined> {
    if (this.verified.has(cwd)) return undefined
    const failure = await probeLaunch(this.config, this.bwrap as SeatBwrapIdentity, cwd, this.deps, seat)
    if (failure === undefined) this.verified.add(cwd)
    return failure
  }

  /**
   * Build the launch plan for one command. Only host values and the command, deadline and directories enter the spec.
   * @param call - the per-call fields.
   * @returns the plan or the typed refusal.
   */
  plan(call: Pick<SeatProfileSpec, CallFields>): SeatLaunchResult {
    return this.deps.plan({ ...baseSpec(this.config, this.bwrap as SeatBwrapIdentity), ...call })
  }

  /**
   * Run a plan.
   * @param request - plan, directory, deadline, floor and abort signal.
   * @returns the outcome.
   */
  run(request: RunRequest): Promise<SandboxRunOutcome> {
    const signal = request.signal === undefined ? this.lifetime.signal : AbortSignal.any([request.signal, this.lifetime.signal])
    return runPlan({ ...request, signal }, this.deps.runner)
  }

  /**
   * Whether free space on the clone's filesystem is below the floor. A filesystem that cannot be sampled counts as low.
   * @param cwd - the clone root.
   * @returns true when below the floor or unreadable.
   */
  lowDisk(cwd: string): boolean {
    try {
      return this.deps.runner.freeBytes(cwd) < this.config.minFreeBytes
    } catch (error) {
      this.warn(`agent-claude-code-bash: cannot sample free space of ${cwd}: ${(error as Error).message}`)
      return true
    }
  }

  /**
   * A fresh call id (letters and digits; it becomes part of the scope unit name).
   * @returns the id.
   */
  newCallId(): string {
    return `c${randomBytes(6).toString('hex')}`
  }
}

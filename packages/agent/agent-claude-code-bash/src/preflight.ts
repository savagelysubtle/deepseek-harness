/**
 * Preflight of the sandbox: proves, on this host and now, that a seat launch can start and be stopped. It checks
 * the binaries and the user bus, then runs `true` through the exact production launch (scope, bwrap with every
 * flag the profile uses, prlimit) in a throwaway clone and requires the scope's cgroup directory gone
 * afterwards. A failure is typed and carries a remedy; the host warns, registers nothing and refuses calls.
 * The environment fingerprint (bwrap identity, kernel release, the two user-namespace sysctls) is recorded so a
 * later change makes the host run this again.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/preflight
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { release as osRelease } from 'node:os'
import { join } from 'node:path'
import { attestBwrap, planSeatLaunch } from '@deepseek-ai/dsh-sandbox-local'
import type { SeatBwrapIdentity, SeatLaunchResult, SeatProfileSpec } from '@deepseek-ai/dsh-sandbox-local'
import { baseSpec } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { BUS_PROBE_TIMEOUT_MS, PROBE_DEADLINE_S } from './limits.ts'
import { execToExit, runPlan } from './runner.ts'
import type { RunnerDeps, SandboxRunOutcome } from './runner.ts'

/** The sysctls whose change can turn unprivileged user namespaces on or off. */
export const USERNS_SYSCTLS: readonly string[] = ['kernel.unprivileged_userns_clone', 'kernel.apparmor_restrict_unprivileged_userns']

/** Directories the launch's `PATH` holds (`systemd-run` and `systemctl` are found there). */
const SYSTEM_PATH: readonly string[] = ['/usr/local/bin', '/usr/bin', '/bin']

/** Binaries the launch executes by absolute path. */
const REQUIRED_BINARIES: readonly string[] = ['/usr/bin/env', '/usr/bin/prlimit']

/** Machine-readable preflight failure codes. */
type PreflightFailureCode =
  | 'binary-missing' | 'xdg-runtime-dir' | 'user-bus' | 'plan-refused' | 'launch-failed' | 'cannot-stop' | 'preflight-error'

/** A typed preflight failure. */
export interface PreflightFailure {
  /** What failed. */
  readonly code: PreflightFailureCode
  /** Why, in one sentence. */
  readonly reason: string
  /** What the operator can do about it. */
  readonly remedy: string
}

/** The result of a preflight. */
export type PreflightResult =
  | { readonly ok: true; readonly bwrap: SeatBwrapIdentity; readonly fingerprint: string }
  | { readonly ok: false; readonly failure: PreflightFailure }

/** A throwaway clone the probe runs in. */
export interface Scratch {
  /** Canonical directory that looks like a seat clone to the profile builder. */
  readonly dir: string
  /** Remove it. */
  readonly dispose: () => void
}

/** Everything the preflight reads or runs; fakes stand in for it in tests. */
export interface PreflightDeps {
  /** The runner's dependencies (spawn, kill, cgroup reads, clock). */
  readonly runner: RunnerDeps
  /** Identity of the bwrap binary; `undefined` when missing. */
  attest: (path: string) => SeatBwrapIdentity | undefined
  /** The profile builder. */
  plan: (spec: SeatProfileSpec) => SeatLaunchResult
  /** Create a throwaway clone under `parent`. */
  makeScratch: (parent: string) => Scratch
  /** The kernel release (`uname -r`). */
  release: () => string
  /** A sysctl value, or `absent` when the file does not exist. */
  sysctl: (name: string) => string
}

/**
 * Create a directory that passes the profile builder's clone checks (`.git` with `HEAD`, `config`, `objects`).
 * @param parent - where to create it.
 * @returns the clone and its disposer.
 */
export function makeScratchClone(parent: string): Scratch {
  const dir = realpathSync(mkdtempSync(join(parent, 'dsh-bash-preflight-')))
  mkdirSync(join(dir, '.git', 'objects'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(dir, '.git', 'config'), '[core]\n')
  return { dir, dispose: () => { rmSync(dir, { recursive: true, force: true }) } }
}

/**
 * Read a sysctl.
 * @param name - dotted name, for example `kernel.unprivileged_userns_clone`.
 * @returns the trimmed value, or `absent` when the kernel has no such file.
 */
export function readSysctl(name: string): string {
  try {
    return readFileSync(join('/proc/sys', ...name.split('.')), 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}

/**
 * Production dependencies.
 * @param runner - the runner's production dependencies.
 * @returns the preflight dependencies.
 */
export function realPreflightDeps(runner: RunnerDeps): PreflightDeps {
  return { runner, attest: attestBwrap, plan: planSeatLaunch, makeScratch: makeScratchClone, release: osRelease, sysctl: readSysctl }
}

/**
 * The environment facts a cached verdict depends on.
 * @param bwrap - the attested bwrap identity.
 * @param deps - dependencies.
 * @returns a comparable string; a different string means the preflight must run again.
 */
export function fingerprintOf(bwrap: SeatBwrapIdentity | undefined, deps: PreflightDeps): string {
  const binary = bwrap === undefined ? 'missing' : `${bwrap.path}:${bwrap.ino}:${bwrap.mtimeNs}:${bwrap.size}`
  return [binary, deps.release(), ...USERNS_SYSCTLS.map(name => `${name}=${deps.sysctl(name)}`)].join('|')
}

/** Absolute paths of the binaries that must exist before anything is started. */
function missingBinary(config: ResolvedConfig, deps: PreflightDeps): string | undefined {
  const named = ['systemd-run', 'systemctl'].map((name) => {
    return SYSTEM_PATH.map(dir => join(dir, name)).find(path => deps.runner.exists(path)) ?? `${name} (not found in ${SYSTEM_PATH.join(':')})`
  })
  return [...REQUIRED_BINARIES, config.bwrapPath, ...named].find(path => !path.startsWith('/') || !deps.runner.exists(path))
}

/** Describe the output of a run that did not end cleanly. */
function describeRun(outcome: SandboxRunOutcome): string {
  const parts: string[] = []
  if (outcome.notStarted) parts.push('it did not start')
  else if (outcome.killReason !== undefined) parts.push(`it was killed (${outcome.killReason})`)
  else parts.push(`exit ${outcome.exitCode ?? 'none'}${outcome.signal === null ? '' : ` signal ${outcome.signal}`}`)
  const stderr = outcome.stderr.text.trim()
  if (stderr !== '') parts.push(`stderr: ${stderr.slice(-300)}`)
  if (outcome.runnerFailure !== undefined) parts.push(outcome.runnerFailure)
  return parts.join('; ')
}

/**
 * Run `true` through the full production launch in `cwd` and require a clean start and a clean stop. The preflight
 * calls it with a throwaway clone; the host calls it again with the real clone before a seat's first command.
 * @param config - resolved config.
 * @param bwrap - the attested bwrap identity.
 * @param cwd - the clone to bind.
 * @param deps - dependencies.
 * @param seat - the unit-name seat part.
 * @returns undefined when the probe passed, otherwise the failure.
 */
export async function probeLaunch(
  config: ResolvedConfig,
  bwrap: SeatBwrapIdentity,
  cwd: string,
  deps: PreflightDeps,
  seat: string,
): Promise<PreflightFailure | undefined> {
  const planned = deps.plan({
    ...baseSpec(config, bwrap),
    seat,
    callId: `p${randomBytes(6).toString('hex')}`,
    command: 'true',
    cwd,
    deadlineS: PROBE_DEADLINE_S,
  })
  if (!planned.ok) return { code: 'plan-refused', reason: `${planned.refusal.code}: ${planned.refusal.reason}`, remedy: planned.refusal.remedy }
  const request = { plan: planned.plan, cwd, deadlineMs: PROBE_DEADLINE_S * 1000, floorBytes: config.minFreeBytes }
  const outcome = await runPlan(request, deps.runner)
  if (outcome.runnerFailure !== undefined && outcome.stop !== undefined && outcome.stop !== 'stopped' && outcome.stop !== 'absent') {
    return { code: 'cannot-stop', reason: outcome.runnerFailure, remedy: 'check that the user systemd manager is running (`systemctl --user status`) and that the host process has XDG_RUNTIME_DIR' }
  }
  if (outcome.notStarted || outcome.killReason !== undefined || outcome.exitCode !== 0 || outcome.runnerFailure !== undefined) {
    return {
      code: 'launch-failed',
      reason: `the probe command \`true\` did not run cleanly through the seat launch: ${describeRun(outcome)}`,
      remedy: 'run the plan argv by hand to see the failing step; common causes are unprivileged user namespaces being disabled (kernel.unprivileged_userns_clone, kernel.apparmor_restrict_unprivileged_userns) or a bwrap too old for --size and --disable-userns',
    }
  }
  return undefined
}

/**
 * Run the whole preflight.
 * @param config - resolved config.
 * @param deps - dependencies.
 * @returns the attested bwrap identity and the environment fingerprint, or the first failure.
 */
export async function runPreflight(config: ResolvedConfig, deps: PreflightDeps): Promise<PreflightResult> {
  const missing = missingBinary(config, deps)
  if (missing !== undefined) {
    return { ok: false, failure: { code: 'binary-missing', reason: `${missing} is missing or not an absolute path`, remedy: 'install bubblewrap, coreutils (env), util-linux (prlimit) and systemd' } }
  }
  if (config.xdgRuntimeDir === undefined || !config.xdgRuntimeDir.startsWith('/')) {
    return {
      ok: false,
      failure: { code: 'xdg-runtime-dir', reason: 'XDG_RUNTIME_DIR is not set to an absolute path in the host process', remedy: 'start the host inside the user session (normally /run/user/<uid>)' },
    }
  }
  const bus = await execToExit(['systemctl', '--user', 'show-environment'], { XDG_RUNTIME_DIR: config.xdgRuntimeDir, PATH: SYSTEM_PATH.join(':') }, deps.runner, BUS_PROBE_TIMEOUT_MS)
  if (bus.exitCode !== 0) {
    return {
      ok: false,
      failure: { code: 'user-bus', reason: `\`systemctl --user show-environment\` ${bus.problem ?? `exited ${bus.exitCode}`}`, remedy: 'the user systemd manager must be reachable from the host process (loginctl enable-linger, XDG_RUNTIME_DIR)' },
    }
  }
  const bwrap = deps.attest(config.bwrapPath)
  if (bwrap === undefined) {
    return { ok: false, failure: { code: 'binary-missing', reason: `bwrap disappeared from ${config.bwrapPath}`, remedy: 'install bubblewrap' } }
  }
  const scratch = deps.makeScratch(config.scratchDir)
  try {
    const failure = await probeLaunch(config, bwrap, scratch.dir, deps, 'preflight')
    if (failure !== undefined) return { ok: false, failure }
  } finally {
    scratch.dispose()
  }
  return { ok: true, bwrap, fingerprint: fingerprintOf(bwrap, deps) }
}
